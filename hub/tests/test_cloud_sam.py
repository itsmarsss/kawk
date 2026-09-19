import asyncio
import json

import pytest
from remember_hub.perception.sam.baseten_ws import BasetenSamBackend


class Socket:
    def __init__(self, *, version="sam3.1", block=False):
        self.messages = asyncio.Queue()
        self.messages.put_nowait(
            json.dumps(
                {
                    "type": "ready",
                    "model_version": version,
                    "streaming_mode": "windowed_reinitialization",
                    "tracking_persistent": False,
                }
            )
        )
        self.sent = []
        self.closed = False
        self.block = block
        self.window = 0
        self.header = None

    async def send(self, value):
        self.sent.append(value)
        if isinstance(value, str):
            message = json.loads(value)
            if message["type"] == "frame":
                self.header = message
        elif not self.block:
            self.window += 1
            self.messages.put_nowait(
                json.dumps(
                    {
                        "type": "frame",
                        "frame_id": self.header["frame_id"],
                        "wh": self.header["wh"],
                        "tracker_generation": self.window,
                        "objects": [
                            {
                                "track_id": "0",
                                "label": "person",
                                "box_xyxy": [1, 2, 40, 80],
                                "score": 0.9,
                            }
                        ],
                    }
                )
            )

    async def recv(self):
        return await self.messages.get()

    async def close(self):
        self.closed = True


class Connector:
    def __init__(self, *sockets):
        self.sockets = list(sockets)
        self.calls = []

    async def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.sockets.pop(0)


async def test_sam_window_optin_and_real_version_required():
    socket = Socket()
    backend = BasetenSamBackend("test", "test", connector=Connector(socket))
    with pytest.raises(ValueError, match="opt|windowed"):
        await backend.start_session(["person"])
    assert socket.closed
    backend = BasetenSamBackend(
        "test", "test", allow_windowed=True, connector=Connector(Socket(version="sam3.0"))
    )
    with pytest.raises(ValueError, match="SAM3.1"):
        await backend.start_session(["person"])


async def test_sam_ids_and_recovery_acknowledgement():
    connector = Connector(Socket())
    backend = BasetenSamBackend("test", "test", allow_windowed=True, connector=connector)
    await backend.start_session(["person"])
    assert backend.recovering
    first = await backend.push_frame("f1", b"jpeg1", (640, 480))
    assert backend.recovering and backend.last_frame_accepted
    backend.acknowledge_reassociation()
    assert not backend.recovering
    generation = backend.generation
    second = await backend.push_frame("f2", b"jpeg2", (640, 480))
    assert first[0].track_id != second[0].track_id
    assert backend.generation > generation
    assert not backend.tracking_persistent
    assert connector.calls[0][1]["additional_headers"]["Authorization"] == "Bearer test"
    await backend.end_session()


async def test_sam_timeout_closes_socket_and_next_frame_reconnects():
    stalled = Socket(block=True)
    fresh = Socket()
    backend = BasetenSamBackend(
        "test",
        "test",
        allow_windowed=True,
        response_timeout_s=0.01,
        connector=Connector(stalled, fresh),
    )
    await backend.start_session(["person"])
    with pytest.raises(RuntimeError, match="recovery"):
        await backend.push_frame("lost", b"jpeg", (640, 480))
    assert stalled.closed and backend.recovering and backend.last_drop_reason == "timeout"
    assert await backend.push_frame("new", b"jpeg2", (640, 480))
    assert backend.connection_generation == 2
    await backend.end_session()


async def test_sam_busy_drop_and_cancel_cleanup():
    socket = Socket(block=True)
    backend = BasetenSamBackend("test", "test", allow_windowed=True, connector=Connector(socket))
    await backend.start_session(["person"])
    task = asyncio.create_task(backend.push_frame("one", b"jpeg", (640, 480)))
    await asyncio.sleep(0)
    assert await backend.push_frame("two", b"jpeg", (640, 480)) == []
    assert backend.last_drop_reason == "busy"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert socket.closed and backend.recovering
    await backend.end_session()
