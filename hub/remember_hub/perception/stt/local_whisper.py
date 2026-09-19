"""Bounded local small/int8 Whisper with revisable ~1-second partials.

Whisper itself is not a streaming acoustic model: each partial decodes the current
utterance again. Long utterances split at a configured cap; CPU latency is measured,
not represented as the Baseten service's latency.
"""
from __future__ import annotations

import asyncio
import gc
import time
import uuid
from collections.abc import AsyncIterable, AsyncIterator, Callable
from pathlib import Path
from typing import Any

import numpy as np

from remember_hub.contracts.percepts import AudioState, TranscriptSegment, TranscriptWord
from remember_hub.perception.stt.vad import (
    SAMPLE_RATE,
    PcmReframer,
    SileroOnnxVad,
    VadGate,
)


class LocalWhisperBackend:
    def __init__(self, model_path: str | Path = "data/models/faster-whisper-small", *,
                 vad_model_path: str | Path = "data/models/silero_vad.onnx", language: str = "en",
                 window_seconds: float = 1.0, max_utterance_seconds: float = 30,
                 engine: Any = None, vad_factory: Callable[[], VadGate] | None = None,
                 on_audio_state: Callable[[AudioState], None] | None = None):
        if not .25 <= window_seconds <= 5 or not 1 <= max_utterance_seconds <= 30:
            raise ValueError("Use a .25–5 s partial window and 1–30 s utterance cap")
        self.model_path, self.vad_model_path = Path(model_path), Path(vad_model_path)
        self.language = language
        self.window_seconds, self.max_utterance_seconds = window_seconds, max_utterance_seconds
        self._engine, self._vad_factory = engine, vad_factory
        self.on_audio_state = on_audio_state
        self._active = False
        self._prepared_gate: VadGate | None = None
        self._load_lock = asyncio.Lock()
        self.load_ms: float | None = None
        self.last_timings_ms: dict[str, float] = {}

    def _load(self):
        if self._engine is None:
            if not (self.model_path / "model.bin").is_file():
                raise FileNotFoundError(f"Missing {self.model_path}; run: make fetch-local-models")
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError("Local Whisper requires: uv sync --extra local") from exc
            started = time.perf_counter()
            self._engine = WhisperModel(str(self.model_path), device="cpu", compute_type="int8",
                                        cpu_threads=4, num_workers=1, local_files_only=True)
            self.load_ms = (time.perf_counter() - started) * 1000
        return self._vad_factory() if self._vad_factory else VadGate(SileroOnnxVad(self.vad_model_path))

    async def load(self) -> None:
        """Warm model and ONNX state before accepting microphone input."""
        async with self._load_lock:
            if self._active:
                raise RuntimeError("Cannot load while a stream is active")
            if self._prepared_gate is None:
                task = asyncio.create_task(asyncio.to_thread(self._load))
                try:
                    self._prepared_gate = await asyncio.shield(task)
                except asyncio.CancelledError:
                    await task
                    raise

    async def close(self) -> None:
        async with self._load_lock:
            if self._active:
                raise RuntimeError("Close the audio stream before closing its backend")
            def release():
                if self._engine is not None and hasattr(self._engine, "model"):
                    self._engine.model.unload_model()
                self._engine = None
                self._prepared_gate = None
                gc.collect()
            await asyncio.to_thread(release)

    def _decode(self, pcm: bytes):
        started = time.perf_counter()
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        segments, _ = self._engine.transcribe(audio, language=self.language, beam_size=1,
                                             word_timestamps=True, vad_filter=False,
                                             condition_on_previous_text=False)
        words, texts = [], []
        for segment in segments:  # generator performs native inference here, in the worker
            texts.append(segment.text.strip())
            for word in segment.words or []:
                words.append(TranscriptWord(w=word.word.strip(), t0=max(0, word.start),
                                            t1=max(word.start, word.end, 0), probability=word.probability))
        return " ".join(texts).strip(), words, (time.perf_counter() - started) * 1000

    async def stream(self, pcm16_chunks: AsyncIterable[bytes]) -> AsyncIterator[TranscriptSegment]:
        if self._active:
            raise RuntimeError("Each LocalWhisperBackend supports one audio stream")
        self._active = True
        task: asyncio.Task | None = None
        # A bounded capture queue decouples reads from CPU decoding. Overflow fails
        # loudly rather than accumulating seconds of stale audio or dropping words.
        queue: asyncio.Queue[bytes | BaseException | None] = asyncio.Queue(maxsize=64)
        overflow = False

        async def receive():
            nonlocal overflow
            try:
                async for chunk in pcm16_chunks:
                    if len(chunk) > 32000 or len(chunk) % 2:
                        raise ValueError("Audio chunks must be complete PCM16 samples and <=1 s")
                    # Split to <=40 ms so the queue cap means <=2.56 s, even for
                    # callers supplying larger file chunks.
                    for offset in range(0, len(chunk), 1280):
                        if queue.full():
                            overflow = True
                            return
                        queue.put_nowait(chunk[offset:offset+1280])
                await queue.put(None)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(exc)

        async def work(function, *args):
            nonlocal task
            task = asyncio.create_task(asyncio.to_thread(function, *args))
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                await task
                raise
            finally:
                task = None

        receiver: asyncio.Task | None = None
        try:
            async with self._load_lock:
                gate = self._prepared_gate or await work(self._load)
                self._prepared_gate = None
            reframer = PcmReframer()
            origin = time.monotonic()
            namespace = uuid.uuid4().hex[:12]
            number = 0
            utterance = bytearray()
            start_sample = 0
            next_partial = self.window_seconds
            receiver = asyncio.create_task(receive())
            while True:
                if overflow:
                    raise RuntimeError("Local Whisper audio queue exceeded 2.56 s; use cloud STT or longer partial intervals")
                chunk = await queue.get()
                if isinstance(chunk, BaseException):
                    raise chunk
                if chunk is None:
                    if utterance:
                        utterance.extend(reframer.finish())
                        text, words, elapsed = await work(self._decode, bytes(utterance))
                        self.last_timings_ms = {"decode": elapsed}
                        yield TranscriptSegment(seg_id=f"local-{namespace}-{number}", text=text, words=words,
                                                is_final=True, t_start_hub=origin+start_sample/SAMPLE_RATE,
                                                t_percept=time.monotonic())
                    break
                for pcm in reframer.push(chunk):
                    frames = await work(gate.process, pcm)
                    if self.on_audio_state:
                        state = gate.last_state.model_copy(update={"t_hub": origin+gate.last_state.t_hub})
                        self.on_audio_state(state)
                    for frame in frames:
                        if not utterance:
                            start_sample = frame.sample_index
                        utterance.extend(frame.pcm)
                        duration = len(utterance) / (SAMPLE_RATE*2)
                        final = frame.utterance_end or duration >= self.max_utterance_seconds
                        if final or duration >= next_partial:
                            text, words, elapsed = await work(self._decode, bytes(utterance))
                            self.last_timings_ms = {"decode": elapsed, "buffer_seconds": duration}
                            if text or final:
                                yield TranscriptSegment(seg_id=f"local-{namespace}-{number}", text=text, words=words,
                                                        is_final=final, t_start_hub=origin+start_sample/SAMPLE_RATE,
                                                        t_percept=time.monotonic())
                            next_partial = duration + self.window_seconds
                        if final:
                            utterance.clear()
                            number += 1
                            next_partial = self.window_seconds
        finally:
            if receiver is not None:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            self._active = False
