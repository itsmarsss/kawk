"""Torch-free Silero ONNX, exact PCM framing and a bounded speech gate.

Model contract: https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py
The gate forwards original samples; it never manufactures silence for server VAD.
"""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from collections.abc import AsyncIterable, AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from remember_hub.contracts.percepts import AudioState

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE


class PcmReframer:
    """640-sample device packets become 512-sample frames without sample loss."""

    def __init__(self, max_chunk_bytes: int = 32000):
        self.max_chunk_bytes = max_chunk_bytes
        self._pending = bytearray()

    @property
    def pending_bytes(self) -> int:
        return len(self._pending)

    def push(self, chunk: bytes) -> list[bytes]:
        if len(chunk) % 2:
            raise ValueError("PCM16 chunks must contain complete 16-bit samples")
        if len(chunk) > self.max_chunk_bytes:
            raise ValueError("Audio packet exceeds the 1-second buffering limit")
        self._pending.extend(chunk)
        frames = []
        while len(self._pending) >= FRAME_BYTES:
            frames.append(bytes(self._pending[:FRAME_BYTES]))
            del self._pending[:FRAME_BYTES]
        return frames

    def finish(self) -> bytes:
        """Return the unpadded (<32 ms) real tail for local finalization only."""
        tail = bytes(self._pending)
        self._pending.clear()
        return tail


class SileroOnnxVad:
    """One stateful CPU ONNX session per audio stream; no torch import."""

    def __init__(self, model_path: str | Path = "data/models/silero_vad.onnx", *, session: Any = None):
        if session is None:
            path = Path(model_path)
            if not path.is_file():
                raise FileNotFoundError(f"Missing {path}; run: make fetch-local-models")
            try:
                import onnxruntime as ort
            except ImportError as exc:
                raise RuntimeError("Silero VAD requires: uv sync --extra local") from exc
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"], sess_options=opts)
        self.session = session
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, 64), dtype=np.float32)

    def __call__(self, pcm: bytes) -> float:
        if len(pcm) != FRAME_BYTES:
            raise ValueError("Silero requires exactly 512 samples / 1024 bytes at 16 kHz")
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32)[None, :] / 32768.0
        values = np.concatenate((self._context, audio), axis=1)
        output, state = self.session.run(None, {
            "input": values, "state": self._state, "sr": np.array(SAMPLE_RATE, dtype=np.int64),
        })
        self._state = np.asarray(state, dtype=np.float32)
        self._context = audio[:, -64:].copy()
        return float(np.asarray(output).reshape(-1)[0])


@dataclass(frozen=True)
class GatedFrame:
    pcm: bytes
    sample_index: int
    speech_active: bool
    utterance_start: bool = False
    utterance_end: bool = False


class VadGate:
    """A maximum 320 ms pre-roll and 512 ms real-silence hangover by default.

    ``AudioState.speech_active`` describes speech, not the hangover transport state.
    Feed exact 512-sample frames. ``sample_index`` preserves gaps during long silence.
    """

    def __init__(self, detector: Callable[[bytes], float], *, threshold: float = .5,
                 pre_roll_ms: int = 300, hangover_ms: int = 500):
        if not 0 < threshold < 1 or not 0 <= pre_roll_ms <= 1000 or not 500 <= hangover_ms <= 3000:
            raise ValueError("Invalid VAD threshold/pre-roll; hangover must be 500–3000 ms")
        self.detector = detector
        self.threshold = threshold
        self.pre_roll_frames = math.ceil(pre_roll_ms / 32)
        self.hangover_frames = math.ceil(hangover_ms / 32)
        self._pre: deque[GatedFrame] = deque(maxlen=self.pre_roll_frames)
        self._index = 0
        self._open = False
        self._silent = 0
        self.last_state = AudioState(speech_active=False, level_db=-96)

    @property
    def active(self) -> bool:
        return self._open

    def process(self, pcm: bytes, *, t_start_hub: float = 0) -> list[GatedFrame]:
        if len(pcm) != FRAME_BYTES:
            raise ValueError("VadGate accepts exactly 512 samples")
        probability = self.detector(pcm)
        speech = probability >= self.threshold
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(samples * samples)))
        self.last_state = AudioState(speech_active=speech, level_db=max(-96, 20 * math.log10(max(rms, 1e-8))),
                                     t_hub=t_start_hub + self._index / SAMPLE_RATE)
        frame = GatedFrame(pcm, self._index, speech)
        self._index += FRAME_SAMPLES
        if not self._open:
            if not speech:
                self._pre.append(frame)
                return []
            self._open = True
            self._silent = 0
            frames = list(self._pre) + [frame]
            self._pre.clear()
            first = frames[0]
            frames[0] = GatedFrame(first.pcm, first.sample_index, first.speech_active, utterance_start=True)
            return frames
        self._silent = 0 if speech else self._silent + 1
        if self._silent >= self.hangover_frames:
            self._open = False
            self._silent = 0
            return [GatedFrame(pcm, frame.sample_index, False, utterance_end=True)]
        return [frame]


async def gated_pcm_stream(chunks: AsyncIterable[bytes], *, gate: VadGate,
                           on_state: Callable[[AudioState], None] | None = None,
                           t_start_hub: float | None = None) -> AsyncIterator[bytes]:
    """Cloud helper: bounded re-framing, ONNX work off the event loop, no padded tail."""
    reframer = PcmReframer()
    origin = t_start_hub if t_start_hub is not None else time.monotonic()
    async for chunk in chunks:
        for pcm in reframer.push(chunk):
            frames = await asyncio.to_thread(gate.process, pcm, t_start_hub=origin)
            if on_state is not None:
                on_state(gate.last_state)
            for frame in frames:
                yield frame.pcm
