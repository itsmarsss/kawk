"""Verified Baseten streaming Whisper metadata and PCM framing.

The input carries no capture timestamps: hub anchors use chunk arrival/send time.
Service word offsets are connection-relative; normalize to the hub utterance anchor.
Partials share IDs; reconnects never reuse IDs.
No deployment creation or mutation occurs here.
"""

import asyncio
import contextlib
import json
import math
import time
import uuid
from collections import deque
from collections.abc import AsyncIterable, AsyncIterator
from typing import Any

from remember_hub.contracts.percepts import TranscriptSegment, TranscriptWord
from remember_hub.perception.baseten_common import endpoint

METADATA = {
    "streaming_vad_config": {"threshold": 0.5, "min_silence_duration_ms": 300, "speech_pad_ms": 30},
    "streaming_params": {
        "encoding": "pcm_s16le",
        "sample_rate": 16000,
        "enable_partial_transcripts": True,
        "partial_transcript_interval_s": 0.5,
        "final_transcript_max_duration_s": 30,
    },
    "whisper_params": {"audio_language": "en", "show_word_timestamps": True},
}


def parse_transcript(
    data: dict, namespace: str, anchor: float, audio_offset: float | None = None
) -> TranscriptSegment | None:
    if data.get("type") != "transcription":
        if data.get("type") == "error":
            raise ValueError("Whisper returned a service error")
        return None
    number = data["transcription_num"]
    if not isinstance(number, (int, str)) or isinstance(number, bool):
        raise ValueError("Invalid Whisper transcription number")
    if not isinstance(data["is_final"], bool):
        raise ValueError("Whisper is_final must be boolean")
    segments = data["segments"]
    if audio_offset is None:
        audio_offset = float(segments[0].get("start_time", 0)) if segments else 0.0
    if not math.isfinite(audio_offset) or audio_offset < 0:
        raise ValueError("Invalid Whisper segment start")
    words = []
    for segment in segments:
        for word in segment.get("word_timestamps", []):
            start = float(word["start_time"]) - audio_offset
            end = float(word["end_time"]) - audio_offset
            if not (math.isfinite(start) and math.isfinite(end) and 0 <= start <= end):
                raise ValueError("Invalid Whisper word timing")
            words.append(
                TranscriptWord(w=word["word"], t0=start, t1=end, probability=word.get("prob"))
            )
    return TranscriptSegment(
        seg_id=f"{namespace}:{number}",
        text=" ".join(s["text"].strip() for s in segments).strip(),
        is_final=data["is_final"],
        words=words,
        t_start_hub=anchor,
        t_percept=time.monotonic(),
    )


class BasetenWhisperBackend:
    def __init__(
        self,
        model_id: str,
        api_key: str,
        *,
        connector: Any = None,
        open_timeout_s: float = 120,
        send_timeout_s: float = 1.5,
        drain_timeout_s: float = 2,
        max_reconnects: int = 3,
        reconnect_delay_s: float = 0.25,
        final_silence_frames: int = 16,
    ):
        self.url = endpoint(model_id, api_key, websocket=True)
        self._key, self._connector = api_key, connector
        self.open_timeout_s, self.send_timeout_s = open_timeout_s, send_timeout_s
        self.drain_timeout_s, self.max_reconnects = drain_timeout_s, max_reconnects
        self.reconnect_delay_s = reconnect_delay_s
        self.final_silence_frames = final_silence_frames
        self.last_timings_ms: dict[str, float] = {}
        self.connection_generation = 0
        self.recovering = False
        self.dropped_audio_frames = 0
        self.timestamp_mode = (
            "service connection offsets normalized to utterance; estimated hub PCM anchor"
        )
        self._active = False

    async def stream(self, pcm16_chunks: AsyncIterable[bytes]) -> AsyncIterator[TranscriptSegment]:
        if self._active:
            raise RuntimeError("Use one Whisper stream per backend instance")
        self._active = True
        output: asyncio.Queue[Any] = asyncio.Queue(maxsize=16)
        task = asyncio.create_task(self._run(pcm16_chunks, output))
        try:
            while True:
                item = await output.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self._active = False

    async def _run(self, chunks: AsyncIterable[bytes], output: asyncio.Queue) -> None:
        audio: asyncio.Queue[Any] = asyncio.Queue(maxsize=8)
        producer_error: list[Exception] = []
        finished = asyncio.Event()
        connected = asyncio.Event()

        async def produce():
            buffer = bytearray()
            try:
                # Do not advance a microphone/fixture source during connection
                # startup. Otherwise a cold endpoint loses the first words.
                await connected.wait()
                async for chunk in chunks:
                    if not isinstance(chunk, bytes) or len(chunk) % 2:
                        raise ValueError("Audio must be PCM16 bytes with whole samples")
                    buffer.extend(chunk)
                    now = time.monotonic()
                    while len(buffer) >= 1024:
                        frame = bytes(buffer[:1024])
                        del buffer[:1024]
                        captured = now - (len(buffer) + 1024) / 32000
                        try:
                            await asyncio.wait_for(
                                audio.put((frame, captured)), self.send_timeout_s
                            )
                        except TimeoutError:
                            raise ValueError(
                                "Whisper audio backpressure exceeded the bounded buffer; restart the stream"
                            ) from None
                if buffer:
                    await audio.put(
                        (bytes(buffer).ljust(1024, b"\0"), time.monotonic() - len(buffer) / 32000)
                    )
            except Exception as exc:
                producer_error.append(exc)
            finally:
                finished.set()
                current = asyncio.current_task()
                if current is None or not current.cancelling():
                    await audio.put(None)

        producer = asyncio.create_task(produce())
        try:
            import websockets

            connector = self._connector or websockets.connect
            namespace = uuid.uuid4().hex
            retries = 0
            while True:
                ws = None
                tasks = []
                timeline: deque[tuple[float, float]] = deque(maxlen=4096)
                anchors: dict[str, float] = {}
                anchor_offsets: dict[str, float] = {}
                eof = False
                sent_seconds = 0.0
                first_audio: float | None = None
                try:
                    started = time.perf_counter()
                    ws = await connector(
                        self.url,
                        additional_headers={"Authorization": "Bearer " + self._key},
                        open_timeout=self.open_timeout_s,
                        close_timeout=2,
                        compression=None,
                        max_size=2_000_000,
                        max_queue=4,
                    )
                    self.last_timings_ms = {"connect": (time.perf_counter() - started) * 1000}
                    self.connection_generation += 1
                    connection_id = f"{namespace}:{self.connection_generation}"
                    await asyncio.wait_for(ws.send(json.dumps(METADATA)), self.send_timeout_s)
                    connection: Any = ws
                    connected.set()

                    async def send():
                        nonlocal sent_seconds, eof, first_audio
                        while True:
                            item = await audio.get()
                            if item is None:
                                eof = True
                                if producer_error:
                                    raise producer_error[0]
                                for _ in range(self.final_silence_frames):
                                    await asyncio.wait_for(
                                        connection.send(bytes(1024)), self.send_timeout_s
                                    )
                                    await asyncio.sleep(0.032)
                                return
                            frame, captured = item
                            timeline.append((sent_seconds, captured))
                            sent_seconds += 0.032
                            if first_audio is None:
                                first_audio = time.monotonic()
                            await asyncio.wait_for(connection.send(frame), self.send_timeout_s)

                    async def receive():
                        async for raw in connection:
                            data = json.loads(raw)
                            if data.get("type") == "transcription":
                                number = str(data["transcription_num"])
                                if number not in anchors:
                                    # Segment and raw word starts are connection offsets,
                                    # verified on two consecutive real-service utterances.
                                    offset = (
                                        float(data["segments"][0].get("start_time", 0))
                                        if data["segments"]
                                        else 0
                                    )
                                    preceding = [row for row in timeline if row[0] <= offset]
                                    origin = (
                                        preceding[-1]
                                        if preceding
                                        else (timeline[0] if timeline else (0.0, time.monotonic()))
                                    )
                                    anchors[number] = origin[1] + offset - origin[0]
                                    anchor_offsets[number] = offset
                                item = parse_transcript(
                                    data, connection_id, anchors[number], anchor_offsets[number]
                                )
                                if item is not None:
                                    self.recovering = False
                                    if first_audio is not None:
                                        self.last_timings_ms.setdefault(
                                            "first_transcript_from_first_send",
                                            (time.monotonic() - first_audio) * 1000,
                                        )
                                    await output.put(item)
                                    if item.is_final:
                                        # Bound retained timing state in long sessions.
                                        if len(anchors) > 64:
                                            oldest = next(iter(anchors))
                                            del anchors[oldest]
                                            del anchor_offsets[oldest]
                            elif data.get("type") == "error":
                                raise ValueError("Whisper returned a service error")
                        if not eof:
                            raise ConnectionError("Whisper disconnected")

                    sender = asyncio.create_task(send())
                    receiver = asyncio.create_task(receive())
                    tasks = [sender, receiver]
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for ended in done:
                        await ended
                    if sender in done:
                        with contextlib.suppress(asyncio.TimeoutError):
                            await asyncio.wait_for(asyncio.shield(receiver), self.drain_timeout_s)
                        break
                    raise ConnectionError("Whisper disconnected")
                except (ValueError, KeyError, TypeError):
                    raise
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if (
                        eof
                        or (finished.is_set() and audio.empty())
                        or retries >= self.max_reconnects
                    ):
                        raise RuntimeError(
                            "Whisper stream interrupted; check deployment and reconnect"
                        ) from None
                    retries += 1
                    self.recovering = True
                finally:
                    for child in tasks:
                        child.cancel()
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                    if ws is not None:
                        with contextlib.suppress(Exception):
                            await asyncio.wait_for(ws.close(), 3)
                await asyncio.sleep(min(2, self.reconnect_delay_s * 2 ** (retries - 1)))
        except Exception as exc:
            await output.put(exc)
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            current = asyncio.current_task()
            if current is None or not current.cancelling():
                await output.put(None)
