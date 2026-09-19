import asyncio
import json
import time

import pytest
from remember_hub.perception.stt.baseten_ws import METADATA, BasetenWhisperBackend, parse_transcript


def event(final=False, number=0):
    return {
        "type": "transcription",
        "transcription_num": number,
        "is_final": final,
        "segments": [
            {
                "text": "where are my keys",
                "start_time": 0.0,
                "word_timestamps": [
                    {"word": "where", "start_time": 0.1, "end_time": 0.4, "prob": 0.9}
                ],
            }
        ],
    }


class Socket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.sent = []
        self.closed = False

    async def send(self, value):
        self.sent.append(value)
        if isinstance(value, bytes) and len([x for x in self.sent if isinstance(x, bytes)]) == 1:
            await self.messages.put(json.dumps(event()))
            await self.messages.put(json.dumps(event(True)))

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.messages.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self):
        self.closed = True


class Connector:
    def __init__(self, *sockets):
        self.sockets = list(sockets)
        self.calls = []

    async def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.sockets.pop(0)


async def chunks():
    yield bytes(1280)
    await asyncio.sleep(0.001)
    yield bytes(768)


async def test_whisper_verified_metadata_framing_revisions_and_cleanup():
    socket = Socket()
    connector = Connector(socket)
    backend = BasetenWhisperBackend(
        "wdlg2oe3", "test", connector=connector, drain_timeout_s=0.01, final_silence_frames=0
    )
    results = [item async for item in backend.stream(chunks())]
    assert socket.closed
    assert json.loads(socket.sent[0]) == METADATA
    assert [len(x) for x in socket.sent if isinstance(x, bytes)] == [1024, 1024]
    assert connector.calls[0][1]["additional_headers"] == {"Authorization": "Bearer test"}
    assert len(results) == 2 and results[0].seg_id == results[1].seg_id
    assert not results[0].is_final and results[1].is_final
    assert results[0].words[0].t0 == 0.1
    assert results[0].t_start_hub == results[1].t_start_hub
    assert results[0].t_start_hub <= time.monotonic()


async def test_whisper_restarted_stream_never_reuses_segment_id():
    backend = BasetenWhisperBackend(
        "test",
        "test",
        connector=Connector(Socket(), Socket()),
        drain_timeout_s=0.001,
        final_silence_frames=0,
    )
    first = [item async for item in backend.stream(chunks())]
    second = [item async for item in backend.stream(chunks())]
    assert first[0].seg_id != second[0].seg_id


async def test_whisper_cancel_closes_socket_and_source():
    closed = asyncio.Event()

    async def endless():
        try:
            while True:
                yield bytes(1024)
                await asyncio.sleep(0.001)
        finally:
            closed.set()

    socket = Socket()
    backend = BasetenWhisperBackend("test", "test", connector=Connector(socket))
    generator = backend.stream(endless())
    await anext(generator)
    await asyncio.wait_for(generator.aclose(), 1)
    assert socket.closed and closed.is_set() and not backend._active


async def test_whisper_reconnects_and_namespaces_restarted_number():
    first = Socket()
    second = Socket()
    connector = Connector(first, second)
    backend = BasetenWhisperBackend(
        "test",
        "test",
        connector=connector,
        reconnect_delay_s=0,
        drain_timeout_s=0.01,
        final_silence_frames=0,
    )

    async def live():
        yield bytes(1024)
        await asyncio.sleep(0.01)
        first.messages.put_nowait(ConnectionError("lost"))
        await asyncio.sleep(0.01)
        yield bytes(1024)
        await asyncio.sleep(0.01)

    results = [item async for item in backend.stream(live())]
    assert len(results) == 4
    assert results[0].seg_id != results[2].seg_id
    assert backend.connection_generation == 2
    assert first.closed and second.closed


async def test_whisper_bad_audio_fails_and_cleans_up():
    async def bad():
        yield b"odd"

    socket = Socket()
    backend = BasetenWhisperBackend("test", "test", connector=Connector(socket))
    with pytest.raises(ValueError, match="whole samples"):
        _ = [item async for item in backend.stream(bad())]
    assert socket.closed


@pytest.mark.parametrize("bad", [-1, float("nan"), 0.8])
def test_whisper_rejects_invalid_word_intervals(bad):
    data = event()
    data["segments"][0]["word_timestamps"][0]["start_time"] = bad
    with pytest.raises(ValueError):
        parse_transcript(data, "stream", 10.0)


def test_whisper_unknown_control_ignored_and_errors_not_silent():
    assert parse_transcript({"type": "ready"}, "stream", 10.0) is None
    with pytest.raises(ValueError):
        parse_transcript({"type": "error"}, "stream", 10.0)
