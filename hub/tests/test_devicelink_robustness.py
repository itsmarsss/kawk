"""Audit regressions: bad messages must not disconnect a device, and frame_wh
must come from the JPEG itself, not the config."""

import asyncio
import json
import sys
from pathlib import Path

import websockets
from remember_hub.bus import EventBus
from remember_hub.config import DeviceLinkCfg
from remember_hub.contracts import wire
from remember_hub.devicelink.server import DeviceLinkServer

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "devices" / "sim"))
from sim_device import FALLBACK_JPEG  # noqa: E402


def test_jpeg_dimensions_sof_parse():
    assert wire.jpeg_dimensions(FALLBACK_JPEG) == (1, 1)
    assert wire.jpeg_dimensions(b"\x00\x01\x02") is None
    assert wire.jpeg_dimensions(b"\xff\xd8\xff\xd9") is None  # no SOF


async def test_bad_messages_do_not_disconnect():
    bus = EventBus()
    link = DeviceLinkServer(bus, DeviceLinkCfg(host="127.0.0.1", port=0), {"laptop": {}})
    port = await link.start()
    async with websockets.connect(f"ws://127.0.0.1:{port}", compression=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "device_id": "d1",
                    "class": "laptop",
                    "display": {"w": 240, "h": 240},
                    "caps": {"video": True, "audio": True},
                }
            )
        )
        await ws.recv()  # config
        await ws.send(b"\x01\x00")  # truncated binary frame -> ValueError path
        await ws.send(json.dumps({"type": "status", "battery": 99}))  # unknown control
        # a valid video frame must still land after the garbage
        frame = wire.encode(
            wire.WireFrame(type=wire.T_VIDEO, flags=0, seq=1, ts_ms=5, payload=FALLBACK_JPEG)
        )
        await ws.send(frame)
        for _ in range(20):
            await asyncio.sleep(0.05)
            if link.any_frame() is not None:
                break
        got = link.any_frame()
        assert got is not None, "connection died on malformed input"
        assert got[1].wh == (1, 1), "frame_wh must come from the JPEG SOF, not config"
    await link.stop()
