"""Bounded, temporary clips from this session's real camera/microphone samples.

This is deliberately not the production memory store. Timestamps are epoch seconds
already mapped to the hub clock by the caller. Audio timestamps identify the FIRST
sample of a 16 kHz mono PCM16 chunk. No inference, fixture substitution, or downloads.

    clips = SessionClipBuffer(on_update=handle_clip_status)
    clips.add_frame(jpeg, captured_at=time.time())
    clips.add_audio(pcm16, captured_at=first_sample_time)
    status = clips.trigger(event_at=time.time(), clip_id=moment_id)
    result = await clips.wait(status.id)  # never saved before event_at + 5 seconds
    # Serve result.clip.path; send result.clip.to_clip(same_origin_url) to the UI.
    await clips.stop()  # cancels pending tails; saved clips stay playable
    await clips.close()  # kills owned encoders and removes owned files

Methods must be called on one asyncio event loop. Frame/audio ingestion does not
perform disk I/O. Encoding, probing and cleanup never block that loop.
"""

from __future__ import annotations

import asyncio
import logging
import math
import shutil
import tempfile
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict

_LOG = logging.getLogger(__name__)
_AUDIO_RATE = 16000
_AUDIO_BYTES = _AUDIO_RATE * 2
_PREBUFFER_SECONDS = 15
_PREBUFFER_FRAMES = 90
_PREBUFFER_AUDIO_BYTES = 17 * _AUDIO_BYTES
_PREBUFFER_AUDIO_CHUNKS = 2048


def _date(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


class AudioCoverage(BaseModel):
    model_config = ConfigDict(frozen=True)
    present: bool
    coverage: Literal["complete", "partial", "none"]
    captured_duration_s: float


class RecordedClip(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str
    path: Path
    requested_start_at: datetime
    requested_end_at: datetime
    start_at: datetime
    end_at: datetime
    duration_s: float
    coverage: Literal["complete", "partial"]
    audio: AudioCoverage
    frame_count: int
    max_frame_gap_s: float
    session_id: str

    def to_clip(self, url: str) -> dict:
        """Frontend Clip DTO. The caller supplies a same-origin serving route."""
        if not url.startswith("/") or url.startswith("//"):
            raise ValueError("Clip URL must be a same-origin absolute path")
        data = self.model_dump(mode="json", exclude={
            "path", "frame_count", "max_frame_gap_s", "session_id",
        })
        data.update(url=url, mime="video/mp4", provenance={
            "kind": "live-ring-buffer",
            "detail": f"Session {self.session_id}; {self.frame_count} real camera frames",
        })
        return data


class ClipStatus(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str
    status: Literal["recording", "encoding", "saved", "failed", "cancelled", "expired"]
    event_at: datetime
    requested_start_at: datetime
    requested_end_at: datetime
    clip: RecordedClip | None = None
    error: str | None = None


@dataclass(frozen=True)
class JPEGFrame:
    captured_at: float
    jpeg: bytes


@dataclass(frozen=True)
class AudioChunk:
    captured_at: float
    pcm16: bytes

    @property
    def end_at(self) -> float:
        return self.captured_at + len(self.pcm16) / _AUDIO_BYTES


class ClipEncoder(Protocol):
    async def __call__(
        self, frames: tuple[JPEGFrame, ...], audio: bytes | None, target: Path,
        duration_s: float,
    ) -> float:
        """Encode to target and return the actual playable media duration."""
        ...


@dataclass
class _Recording:
    status: ClipStatus
    future: asyncio.Future[ClipStatus]
    frames: list[JPEGFrame] = field(default_factory=list)
    audio: list[AudioChunk] = field(default_factory=list)
    task: asyncio.Task | None = None


async def _io(function: Callable, *args):
    """Wait for owned disk work even on cancellation, so cleanup cannot race it."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def _process(*command: str, timeout: float = 20) -> bytes:
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    if process.returncode:
        reason = stderr.decode(errors="replace")[-1200:].strip()
        raise RuntimeError(f"Clip encoder failed: {reason or process.returncode}")
    return stdout


class FFmpegClipEncoder:
    """CPU H.264/AAC encoder; requires existing ffmpeg and ffprobe executables."""

    def __init__(self, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe"):
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe

    async def __call__(self, frames, audio, target, duration_s) -> float:
        ffmpeg, ffprobe = shutil.which(self.ffmpeg), shutil.which(self.ffprobe)
        if not ffmpeg or not ffprobe:
            raise RuntimeError("Live clips need ffmpeg and ffprobe installed on the hub")
        work = target.parent / f"encode-{target.stem}"

        def prepare():
            work.mkdir(mode=0o700)
            lines = ["ffconcat version 1.0"]
            for index, frame in enumerate(frames):
                name = f"frame-{index:04d}.jpg"
                (work / name).write_bytes(frame.jpeg)
                lines.append(f"file '{name}'")
                if index < len(frames) - 1:
                    lines.append(f"duration {frames[index + 1].captured_at - frame.captured_at:.8f}")
            (work / "frames.txt").write_text("\n".join(lines) + "\n")
            if audio is not None:
                (work / "audio.pcm").write_bytes(audio)

        try:
            await _io(prepare)
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                       "-f", "concat", "-safe", "1", "-i", str(work / "frames.txt")]
            if audio is not None:
                command += ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i",
                            str(work / "audio.pcm"), "-map", "0:v:0", "-map", "1:a:0",
                            "-c:a", "aac", "-b:a", "64k"]
            else:
                command += ["-an"]
            command += ["-vf", "fps=10,scale=trunc(iw/2)*2:trunc(ih/2)*2",
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25",
                        "-pix_fmt", "yuv420p", "-threads", "1", "-movflags", "+faststart",
                        "-t", f"{duration_s:.8f}", str(target)]
            await _process(*command)
            measured = await _process(ffprobe, "-v", "error", "-show_entries",
                                      "format=duration", "-of", "default=nw=1:nk=1", str(target))
            return float(measured.decode().strip())
        finally:
            await _io(shutil.rmtree, work, True)


def _jpeg_dimensions(jpeg: bytes) -> tuple[int, int]:
    """Read JPEG SOF dimensions without installing an image/ML dependency."""
    if not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
        raise ValueError("Expected a complete JPEG frame")
    cursor = 2
    while cursor + 4 <= len(jpeg):
        if jpeg[cursor] != 0xFF:
            break
        while cursor < len(jpeg) and jpeg[cursor] == 0xFF:
            cursor += 1
        if cursor >= len(jpeg):
            break
        marker = jpeg[cursor]
        cursor += 1
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xDA or cursor + 2 > len(jpeg):
            break
        length = int.from_bytes(jpeg[cursor:cursor + 2])
        if length < 2 or cursor + length > len(jpeg):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 8:
            return (int.from_bytes(jpeg[cursor + 5:cursor + 7]),
                    int.from_bytes(jpeg[cursor + 3:cursor + 5]))
        cursor += length
    raise ValueError("JPEG frame has no valid image dimensions")


def _audio_track(chunks: list[AudioChunk], start: float, end: float):
    """Crop samples to video time; explicitly account for silence in capture gaps."""
    sample_count = round((end - start) * _AUDIO_RATE)
    pcm = bytearray(sample_count * 2)
    covered = bytearray(sample_count)
    for chunk in chunks:
        offset = round((chunk.captured_at - start) * _AUDIO_RATE)
        source_start = max(0, -offset)
        target_start = max(0, offset)
        count = min(len(chunk.pcm16) // 2 - source_start, sample_count - target_start)
        if count > 0:
            pcm[target_start * 2:(target_start + count) * 2] = \
                chunk.pcm16[source_start * 2:(source_start + count) * 2]
            covered[target_start:target_start + count] = b"\x01" * count
    captured = sum(covered)
    coverage = AudioCoverage(
        present=bool(captured),
        coverage="none" if not captured else "complete" if captured == sample_count else "partial",
        captured_duration_s=captured / _AUDIO_RATE,
    )
    return bytes(pcm) if captured else None, coverage


class SessionClipBuffer:
    """One bounded, ephemeral capture session. No disk persistence after close/reset.

    A 15-second rolling prebuffer allows delayed decisions (such as confirmed
    object disappearance) to retain the event's original five-second pre-roll.
    Defaults bound raw frame references to (90 + 3*64)*256 KiB, audio to
    (17 + 3*12)*32000 bytes, active work to three clips, and completed media to 12/64 MiB.
    The normal 5 fps / small PCM chunk stream consumes much less. Out-of-order,
    excess-rate or old samples are dropped; malformed samples raise ValueError.
    A camera gap >1 second fails the clip instead of fabricating continuous video.
    """

    def __init__(
        self, *, on_update: Callable[[ClipStatus], None] | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        encoder: ClipEncoder | None = None,
        max_pending: int = 3, max_completed: int = 12,
        max_completed_bytes: int = 64 * 1024 * 1024,
        max_frame_bytes: int = 256 * 1024,
    ):
        if min(max_pending, max_completed, max_completed_bytes, max_frame_bytes) <= 0:
            raise ValueError("Clip resource limits must be positive")
        self.clock, self.sleep = clock, sleep
        self.encoder = encoder or FFmpegClipEncoder()
        self.on_update = on_update
        self.max_pending, self.max_completed = max_pending, max_completed
        self.max_completed_bytes, self.max_frame_bytes = max_completed_bytes, max_frame_bytes
        self._frames: deque[JPEGFrame] = deque(maxlen=_PREBUFFER_FRAMES)
        self._audio: deque[AudioChunk] = deque()
        self._records: OrderedDict[str, _Recording] = OrderedDict()
        self._workers: set[asyncio.Task] = set()
        self._encode_slot = asyncio.Semaphore(1)
        self._maintenance: asyncio.Task | None = None
        self._prune_dirty = False
        self._closed = False
        self._accepting = True
        self._storage = Path(tempfile.mkdtemp(prefix="remember-clips-"))
        self.session_id = uuid.uuid4().hex

    @property
    def storage_path(self) -> Path:
        return self._storage

    @property
    def buffered_frame_count(self) -> int:
        return len(self._frames)

    def _timestamp(self, value: float | None) -> float:
        timestamp = self.clock() if value is None else float(value)
        if not math.isfinite(timestamp) or abs(timestamp - self.clock()) > 30:
            raise ValueError("Capture timestamp must be finite and within 30s of the hub clock")
        if timestamp > self.clock() + 0.5:
            raise ValueError("Capture timestamp cannot be in the future")
        return timestamp

    def add_frame(self, jpeg: bytes, captured_at: float | None = None) -> bool:
        if self._closed or not self._accepting:
            return False
        if not isinstance(jpeg, bytes) or not 0 < len(jpeg) <= self.max_frame_bytes:
            raise ValueError("JPEG exceeds the frame byte limit or is empty")
        width, height = _jpeg_dimensions(jpeg)
        if min(width, height) < 2 or max(width, height) > 640:
            raise ValueError("JPEG dimensions must be 2–640 pixels per side")
        timestamp = self._timestamp(captured_at)
        if timestamp < self.clock() - _PREBUFFER_SECONDS:
            return False
        if self._frames and timestamp - self._frames[-1].captured_at < 0.18:
            return False  # bounded ~5 fps, newest accepted frame wins
        frame = JPEGFrame(timestamp, jpeg)
        self._frames.append(frame)
        while self._frames and self._frames[0].captured_at < timestamp - _PREBUFFER_SECONDS:
            self._frames.popleft()
        for record in list(self._records.values()):
            if record.status.status == "recording" and (
                record.status.requested_start_at.timestamp() <= timestamp
                <= record.status.requested_end_at.timestamp()
            ):
                if len(record.frames) >= 64:
                    self._fail(record, "Camera frame limit exceeded")
                else:
                    record.frames.append(frame)
        return True

    def add_audio(self, pcm16: bytes, captured_at: float | None = None) -> bool:
        if self._closed or not self._accepting:
            return False
        if not isinstance(pcm16, bytes) or not 0 < len(pcm16) <= _AUDIO_BYTES or len(pcm16) % 2:
            raise ValueError("Audio must be at most 1s of 16 kHz mono PCM16 with complete samples")
        timestamp = self._timestamp(captured_at)
        chunk = AudioChunk(timestamp, pcm16)
        if chunk.end_at < self.clock() - _PREBUFFER_SECONDS:
            return False
        if self._audio and timestamp <= self._audio[-1].captured_at:
            return False
        self._audio.append(chunk)
        while self._audio and (self._audio[0].end_at < timestamp - _PREBUFFER_SECONDS
                               or sum(len(c.pcm16) for c in self._audio) > _PREBUFFER_AUDIO_BYTES
                               or len(self._audio) > _PREBUFFER_AUDIO_CHUNKS):
            self._audio.popleft()
        for record in list(self._records.values()):
            if record.status.status == "recording" and (
                chunk.end_at > record.status.requested_start_at.timestamp()
                and timestamp < record.status.requested_end_at.timestamp()
            ):
                if sum(len(c.pcm16) for c in record.audio) + len(pcm16) > 12 * _AUDIO_BYTES \
                        or len(record.audio) >= 1024:
                    self._fail(record, "Microphone sample limit exceeded")
                else:
                    record.audio.append(chunk)
        return True

    def trigger(self, event_at: float | None = None, clip_id: str | None = None) -> ClipStatus:
        if self._closed or not self._accepting:
            raise RuntimeError("Clip session is stopped")
        timestamp = self._timestamp(event_at)
        clip_id = clip_id or uuid.uuid4().hex
        if not isinstance(clip_id, str) or not 1 <= len(clip_id) <= 160:
            raise ValueError("Clip id must be 1–160 characters")
        if clip_id in self._records:
            return self._records[clip_id].status  # retry is idempotent
        pending = sum(r.status.status in {"recording", "encoding"} for r in self._records.values())
        if pending >= self.max_pending or len(self._records) >= self.max_pending + self.max_completed:
            raise RuntimeError("Clip capacity reached; wait for an active clip to finish")
        status = ClipStatus(id=clip_id, status="recording", event_at=_date(timestamp),
                            requested_start_at=_date(timestamp - 5),
                            requested_end_at=_date(timestamp + 5))
        record = _Recording(status, asyncio.get_running_loop().create_future())
        record.frames = [f for f in self._frames if timestamp - 5 <= f.captured_at <= timestamp + 5]
        record.audio = [c for c in self._audio if c.end_at > timestamp - 5
                        and c.captured_at < timestamp + 5]
        if len(record.audio) > 1024 or sum(len(c.pcm16) for c in record.audio) > 12 * _AUDIO_BYTES:
            raise RuntimeError("Microphone sample limit exceeded")
        self._records[clip_id] = record
        self._notify(status)
        task = asyncio.create_task(self._record(record), name=f"clip-{clip_id[:32]}")
        record.task = task
        self._workers.add(task)
        task.add_done_callback(self._workers.discard)
        return status

    def get(self, clip_id: str) -> ClipStatus | None:
        record = self._records.get(clip_id)
        return record.status if record else None

    async def wait(self, clip_id: str) -> ClipStatus:
        record = self._records.get(clip_id)
        if record is None:
            raise KeyError(clip_id)
        return await asyncio.shield(record.future)

    def _notify(self, status: ClipStatus):
        if self.on_update:
            try:
                self.on_update(status)
            except Exception:
                _LOG.exception("Clip status consumer failed")

    def _set(self, record: _Recording, status: str, **updates):
        record.status = record.status.model_copy(update={"status": status, **updates})
        if status not in {"recording", "encoding"}:
            record.frames.clear()
            record.audio.clear()
            if not record.future.done():
                record.future.set_result(record.status)
        self._notify(record.status)
        if status not in {"recording", "encoding", "expired"} and not self._closed:
            self._prune_dirty = True
            if self._maintenance is None or self._maintenance.done():
                self._maintenance = asyncio.create_task(self._prune())

    def _fail(self, record: _Recording, reason: str):
        self._set(record, "failed", error=reason)
        if record.task and record.task is not asyncio.current_task():
            record.task.cancel()

    async def _record(self, record: _Recording):
        target = self._storage / f"{uuid.uuid4().hex}.mp4"
        try:
            deadline = record.status.requested_end_at.timestamp()
            while self.clock() < deadline:
                await self.sleep(deadline - self.clock())
            if record.status.status != "recording":
                return
            self._set(record, "encoding")
            frames = tuple(record.frames)
            if len(frames) < 2 or frames[-1].captured_at - frames[0].captured_at < 0.2:
                raise RuntimeError("Not enough camera footage to make a playable clip")
            max_gap = max(b.captured_at - a.captured_at for a, b in zip(frames, frames[1:]))
            if max_gap > 1.0 + 1e-6:
                raise RuntimeError("Camera capture stalled for more than 1s inside the clip")
            start, end = frames[0].captured_at, frames[-1].captured_at
            audio, audio_coverage = _audio_track(record.audio, start, end)
            async with self._encode_slot:
                duration = await self.encoder(frames, audio, target, end - start)
            if not math.isfinite(duration) or duration <= 0 or abs(duration - (end - start)) > 0.25:
                raise RuntimeError("Encoded media duration does not match captured camera timestamps")
            size = (await _io(target.stat)).st_size
            if not size or size > min(16 * 1024 * 1024, self.max_completed_bytes):
                raise RuntimeError("Encoded clip exceeds the media storage limit or is empty")
            complete = abs(start - record.status.requested_start_at.timestamp()) < 0.001 \
                and abs(end - deadline) < 0.001
            clip = RecordedClip(
                id=record.status.id, path=target,
                requested_start_at=record.status.requested_start_at,
                requested_end_at=record.status.requested_end_at,
                start_at=_date(start), end_at=_date(end), duration_s=duration,
                coverage="complete" if complete else "partial", audio=audio_coverage,
                frame_count=len(frames), max_frame_gap_s=max_gap, session_id=self.session_id,
            )
            self._set(record, "saved", clip=clip)
        except asyncio.CancelledError:
            if record.status.status in {"recording", "encoding"}:
                self._set(record, "cancelled", error="Clip capture cancelled")
        except Exception as error:
            self._fail(record, str(error))
        finally:
            if record.status.status != "saved":
                await _io(target.unlink, True)

    async def _prune(self):
        while self._prune_dirty:
            self._prune_dirty = False
            await self._prune_once()

    async def _prune_once(self):
        completed = [r for r in self._records.values()
                     if r.status.status not in {"recording", "encoding"}]
        # Failed/cancelled metadata must not evict a playable saved clip merely
        # because Stop cancelled several tails at once.
        completed.sort(key=lambda record: record.status.clip is not None)
        sizes = {}
        for record in completed:
            if record.status.clip:
                try:
                    sizes[record.status.id] = (await _io(record.status.clip.path.stat)).st_size
                except FileNotFoundError:  # an explicit delete may race this disk operation
                    pass
        while completed and (len(completed) > self.max_completed
                             or sum(sizes.values()) > self.max_completed_bytes):
            record = completed.pop(0)
            clip = record.status.clip
            sizes.pop(record.status.id, None)
            if self._records.get(record.status.id) is not record:
                continue
            self._records.pop(record.status.id)
            self._set(record, "expired", clip=None, error="Temporary clip retention limit reached")
            if clip:
                await _io(clip.path.unlink, True)

    async def delete(self, clip_id: str) -> bool:
        record = self._records.get(clip_id)
        if record is None:
            return False
        clip = record.status.clip
        # Keep a saved record available for retry if disk deletion fails.
        if clip:
            await _io(clip.path.unlink, True)
        self._records.pop(clip_id, None)
        if record.task and not record.task.done():
            self._set(record, "cancelled", clip=None, error="Clip deleted")
            record.task.cancel()
            await asyncio.gather(record.task, return_exceptions=True)
        return True

    async def stop(self):
        """Stop capture and cancel pending work, keeping saved clips playable."""
        self._accepting = False
        for record in list(self._records.values()):
            if record.status.status in {"recording", "encoding"}:
                self._set(record, "cancelled", error="Capture session stopped")
        for task in self._workers:
            task.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        if self._maintenance:
            await asyncio.gather(self._maintenance, return_exceptions=True)
        self._frames.clear()
        self._audio.clear()

    def start(self):
        """Resume this session; pre-roll begins anew after a stopped capture."""
        if self._closed:
            raise RuntimeError("Clip session is closed; reset or create a new one")
        self._accepting = True

    async def close(self):
        """Release this session and all of its files on Reset, expiry or shutdown."""
        if self._closed:
            return
        self._closed = True
        await self.stop()
        await _io(shutil.rmtree, self._storage, True)
        self._records.clear()

    async def reset(self):
        await self.close()
        self._storage = Path(tempfile.mkdtemp(prefix="remember-clips-"))
        self.session_id = uuid.uuid4().hex
        self._closed = False
        self._accepting = True
