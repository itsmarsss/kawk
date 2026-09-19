"""Actual timing/resource/lifecycle guarantees for the temporary live clip service."""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tools.perception_lab.clips import (
    FFmpegClipEncoder,
    SessionClipBuffer,
)

# A dimension-bearing JPEG header is sufficient for fake-encoder unit tests.
# The encoder integration test below generates and decodes an actual JPEG.
JPEG = bytes.fromhex("ffd8ffc0000b080010001001011100ffd9")


class Clock:
    def __init__(self, now=100.0):
        self.now = now
        self.sleepers = []

    def __call__(self):
        return self.now

    async def sleep(self, delay):
        future = asyncio.get_running_loop().create_future()
        self.sleepers.append((self.now + delay, future))
        await future

    async def wake(self):
        for deadline, future in self.sleepers:
            if deadline <= self.now and not future.done():
                future.set_result(None)
        await asyncio.sleep(0)


class Encoder:
    def __init__(self):
        self.calls = []

    async def __call__(self, frames, audio, target, duration_s):
        self.calls.append((frames, audio, duration_s))
        await asyncio.to_thread(target.write_bytes, b"test-mp4")
        return duration_s


def feed(service, clock, start, end, jpeg=JPEG):
    for step in range(round((end - start) * 5) + 1):
        clock.now = round(start + step / 5, 4)
        service.add_frame(jpeg, clock.now)


async def finish(service, clock, clip_id, end):
    await asyncio.sleep(0)  # start the deadline waiter
    clock.now = end
    await clock.wake()
    return await asyncio.wait_for(service.wait(clip_id), 2)


@pytest.mark.asyncio
async def test_full_clip_cannot_save_until_postroll_is_complete():
    clock, encoder, events = Clock(), Encoder(), []
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder,
                                on_update=events.append)
    try:
        feed(service, clock, 95, 100)
        initial = service.trigger(100, "moment-1")
        assert initial.status == "recording"
        assert service.trigger(100, "moment-1") == initial
        await asyncio.sleep(0)
        feed(service, clock, 100.2, 104.8)
        await clock.wake()
        assert service.get("moment-1").status == "recording"
        assert not encoder.calls
        feed(service, clock, 105, 105)
        result = await finish(service, clock, "moment-1", 105)
        assert result.status == "saved"
        clip = result.clip
        assert clip.coverage == "complete"
        assert clip.duration_s == 10
        assert clip.start_at.timestamp() == 95
        assert clip.end_at.timestamp() == 105
        assert clip.frame_count == 51
        assert clip.audio.present is False
        assert clip.to_clip("/api/clips/moment-1")["provenance"]["kind"] == "live-ring-buffer"
        assert [e.status for e in events] == ["recording", "encoding", "saved"]
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_short_preroll_is_truthfully_partial_and_contains_only_requested_frames():
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        feed(service, clock, 98, 100)
        service.trigger(100, "short")
        feed(service, clock, 100.2, 105)
        result = await finish(service, clock, "short", 105)
        assert result.clip.coverage == "partial"
        assert result.clip.requested_start_at.timestamp() == 95
        assert result.clip.start_at.timestamp() == 98
        assert result.clip.duration_s == 7
        assert all(95 <= frame.captured_at <= 105 for frame in encoder.calls[0][0])
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_delayed_disappearance_trigger_keeps_original_event_preroll_and_audio():
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        # The object was last observed at 100; confirmed absence triggers only at 102.
        feed(service, clock, 90, 102)
        for second in range(95, 102):
            service.add_audio(b"\x01\x00" * 16000, second)
        initial = service.trigger(100, "last-seen")
        assert initial.requested_start_at.timestamp() == 95
        assert initial.requested_end_at.timestamp() == 105
        await asyncio.sleep(0)
        for second in range(102, 105):
            clock.now = second
            service.add_audio(b"\x01\x00" * 16000, second)
        feed(service, clock, 102.2, 104.8)
        await clock.wake()
        assert service.get("last-seen").status == "recording"
        assert not encoder.calls
        feed(service, clock, 105, 105)
        result = await finish(service, clock, "last-seen", 105)
        assert result.status == "saved"
        assert result.clip.coverage == "complete"
        assert result.clip.start_at.timestamp() == 95
        assert result.clip.end_at.timestamp() == 105
        assert result.clip.duration_s == 10
        assert result.clip.audio.coverage == "complete"
        assert result.clip.audio.captured_duration_s == 10
        assert len(encoder.calls[0][1]) == 10 * 32000
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_audio_is_cropped_and_muxed_only_when_really_received():
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        feed(service, clock, 98, 100)
        # Audio covers only 99–101; the video covers 98–105. Remaining audio is silent.
        service.add_audio(b"\x01\x00" * 16000, 99)
        service.trigger(100, "audio")
        clock.now = 101
        service.add_audio(b"\x02\x00" * 16000, 100)
        feed(service, clock, 100.2, 105)
        result = await finish(service, clock, "audio", 105)
        assert result.clip.audio.model_dump() == {
            "present": True, "coverage": "partial", "captured_duration_s": 2.0,
        }
        audio = encoder.calls[0][1]
        assert len(audio) == 7 * 32000
        assert audio[:32000] == bytes(32000)
        assert audio[32000:64000] == b"\x01\x00" * 16000
        assert audio[64000:96000] == b"\x02\x00" * 16000
        assert audio[96000:] == bytes(4 * 32000)
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_stop_keeps_saved_media_cancels_pending_and_close_removes_everything():
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    feed(service, clock, 95, 100)
    service.trigger(100, "saved")
    feed(service, clock, 100.2, 105)
    saved = await finish(service, clock, "saved", 105)
    service.trigger(105, "pending")
    path, directory = saved.clip.path, service.storage_path
    await service.stop()
    assert (await service.wait("pending")).status == "cancelled"
    assert path.is_file()
    assert service.get("saved").status == "saved"
    assert not service.add_frame(JPEG, 105)
    assert not service.add_audio(bytes(640), 105)
    with pytest.raises(RuntimeError, match="stopped"):
        service.trigger(105)
    service.start()
    assert service.buffered_frame_count == 0
    assert service.add_frame(JPEG, 105)
    await service.close()
    assert not directory.exists()
    await service.close()


@pytest.mark.asyncio
async def test_reset_drops_old_session_and_pending_callback_cannot_resurrect_it():
    clock, events = Clock(), []
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=Encoder(),
                                on_update=events.append)
    try:
        old_directory, old_session = service.storage_path, service.session_id
        service.trigger(100, "old")
        await service.reset()
        assert not old_directory.exists()
        assert service.session_id != old_session
        assert service.get("old") is None
        clock.now = 106
        await clock.wake()
        assert [event.status for event in events] == ["recording", "cancelled"]
        assert list(service.storage_path.iterdir()) == []
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_empty_capture_and_stalled_capture_fail_explicitly():
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        service.trigger(100, "empty")
        result = await finish(service, clock, "empty", 105)
        assert result.status == "failed"
        assert "Not enough" in result.error
        clock.now = 110
        service.add_frame(JPEG, 110)
        service.trigger(110, "gap")
        clock.now = 113
        service.add_frame(JPEG, 113)
        result = await finish(service, clock, "gap", 115)
        assert result.status == "failed"
        assert "stalled" in result.error
        assert not encoder.calls
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_byte_dimensions_timestamp_rate_and_active_work_limits():
    clock = Clock()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=Encoder(),
                                max_frame_bytes=100, max_pending=1)
    try:
        with pytest.raises(ValueError, match="byte limit"):
            service.add_frame(bytes(101), 100)
        with pytest.raises(ValueError, match="complete JPEG"):
            service.add_frame(b"invalid", 100)
        too_wide = JPEG[:9] + b"\x02\x81" + JPEG[11:]
        with pytest.raises(ValueError, match="dimensions"):
            service.add_frame(too_wide, 100)
        with pytest.raises(ValueError, match="finite"):
            service.add_frame(JPEG, float("nan"))
        with pytest.raises(ValueError, match="future"):
            service.add_frame(JPEG, 101)
        with pytest.raises(ValueError, match="complete samples"):
            service.add_audio(b"x", 100)
        assert service.add_frame(JPEG, 100)
        assert not service.add_frame(JPEG, 100.01)
        assert not service.add_frame(JPEG, 99)
        assert not service.add_frame(JPEG, 84)
        service.trigger(100, "one")
        with pytest.raises(RuntimeError, match="capacity"):
            service.trigger(100, "two")
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_ring_and_completed_retention_are_bounded_and_eviction_is_announced():
    clock, events = Clock(), []
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=Encoder(),
                                max_completed=1, on_update=events.append)
    try:
        feed(service, clock, 80, 100)
        assert service.buffered_frame_count == 76
        assert service.buffered_frame_count <= 90
        service.trigger(100, "old")
        feed(service, clock, 100.2, 105)
        first = await finish(service, clock, "old", 105)
        service.trigger(105, "new")
        feed(service, clock, 105.2, 110)
        await finish(service, clock, "new", 110)
        # The asynchronous cleanup follows completion, without delaying the saved event.
        await asyncio.gather(*service._workers)
        if service._maintenance:
            await service._maintenance
        assert service.get("old") is None
        assert not first.clip.path.exists()
        assert service.get("new").status == "saved"
        assert any(e.id == "old" and e.status == "expired" for e in events)
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_delete_saved_clip_removes_file_and_is_retryable_on_disk_error(monkeypatch):
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        feed(service, clock, 95, 100)
        service.trigger(100, "delete-saved")
        feed(service, clock, 100.2, 105)
        result = await finish(service, clock, "delete-saved", 105)
        path = result.clip.path
        original_unlink = Path.unlink

        def fail(target, *args, **kwargs):
            if target == path:
                raise OSError("disk unavailable")
            return original_unlink(target, *args, **kwargs)

        with monkeypatch.context() as patch:
            patch.setattr(Path, "unlink", fail)
            with pytest.raises(OSError):
                await service.delete("delete-saved")
        assert service.get("delete-saved").status == "saved" and path.exists()
        assert await service.delete("delete-saved")
        assert service.get("delete-saved") is None and not path.exists()
        assert not await service.delete("delete-saved")
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_delete_during_recording_cannot_create_a_late_file():
    clock, encoder = Clock(), Encoder()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        feed(service, clock, 95, 100)
        service.trigger(100, "delete")
        assert await service.delete("delete")
        clock.now = 106
        await clock.wake()
        assert service.get("delete") is None
        assert not encoder.calls
        assert list(service.storage_path.iterdir()) == []
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_stop_during_encoding_cleans_partial_file_and_never_announces_saved():
    clock, events, entered = Clock(), [], asyncio.Event()

    async def blocked_encoder(frames, audio, target, duration_s):
        await asyncio.to_thread(target.write_bytes, b"unfinished")
        entered.set()
        await asyncio.Event().wait()
        return duration_s

    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=blocked_encoder,
                                on_update=events.append)
    try:
        feed(service, clock, 95, 100)
        service.trigger(100, "encoding")
        feed(service, clock, 100.2, 105)
        await asyncio.wait_for(entered.wait(), 2)
        assert service.get("encoding").status == "encoding"
        await service.stop()
        assert (await service.wait("encoding")).status == "cancelled"
        assert list(service.storage_path.iterdir()) == []
        assert not any(event.status == "saved" for event in events)
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_simultaneous_completion_respects_media_byte_retention():
    clock = Clock()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=Encoder(),
                                max_completed_bytes=12)
    try:
        feed(service, clock, 95, 100)
        for index in range(3):
            service.trigger(100, f"clip-{index}")
        feed(service, clock, 100.2, 105)
        await asyncio.gather(*service._workers)
        if service._maintenance:
            await service._maintenance
        files = list(service.storage_path.glob("*.mp4"))
        assert len(files) == 1
        assert sum(path.stat().st_size for path in files) <= 12
        assert service.get("clip-2").status == "saved"
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_missing_encoder_is_an_explicit_failed_clip():
    clock = Clock()
    encoder = FFmpegClipEncoder(ffmpeg="remember-nonexistent-ffmpeg")
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep, encoder=encoder)
    try:
        feed(service, clock, 95, 100)
        service.trigger(100, "unavailable")
        feed(service, clock, 100.2, 105)
        result = await finish(service, clock, "unavailable", 105)
        assert result.status == "failed"
        assert "ffmpeg and ffprobe" in result.error
    finally:
        await service.close()


@pytest.mark.asyncio
@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
                    reason="Optional installed ffmpeg/ffprobe integration")
async def test_actual_mp4_has_decodable_video_and_audio(tmp_path: Path):
    image = tmp_path / "camera.jpg"
    await asyncio.to_thread(subprocess.run, [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "color=c=blue:s=64x48:r=5", "-frames:v", "1", "-update", "1", str(image),
    ], check=True, capture_output=True)
    clock = Clock()
    service = SessionClipBuffer(clock=clock, sleep=clock.sleep)
    try:
        feed(service, clock, 99, 100, image.read_bytes())
        service.add_audio(b"\x02\x00" * 16000, 99)
        service.trigger(100, "encoded")
        feed(service, clock, 100.2, 101, image.read_bytes())
        result = await finish(service, clock, "encoded", 105)
        assert result.status == "saved", result.error
        assert result.clip.coverage == "partial"
        probe = await asyncio.to_thread(subprocess.run, [
            "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json",
            str(result.clip.path),
        ], check=True, capture_output=True)
        metadata = json.loads(probe.stdout)
        assert {stream["codec_name"] for stream in metadata["streams"]} == {"h264", "aac"}
        assert float(metadata["format"]["duration"]) == pytest.approx(2, abs=0.1)
        await asyncio.to_thread(subprocess.run, [
            "ffmpeg", "-v", "error", "-i", str(result.clip.path), "-f", "null", "-",
        ], check=True, capture_output=True)
    finally:
        await service.close()
