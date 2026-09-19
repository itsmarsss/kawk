"""M1 e2e: headless fixture sim streams into the hub over the real wire protocol,
and a display action round-trips back as a card."""

import asyncio
import sys
import time
from pathlib import Path

from remember_hub.bus import EventBus
from remember_hub.config import DeviceLinkCfg
from remember_hub.contracts.display import PRIO_ANSWER, Card, CardTemplate, DisplayAction
from remember_hub.devicelink.server import DeviceLinkServer

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "devices" / "sim"))
import sim_device  # noqa: E402


async def test_headless_sim_streams_and_receives_card():
    bus = EventBus()
    audio_seen = []
    bus.subscribe("av.audio", lambda msg: _collect(audio_seen, msg))
    link = DeviceLinkServer(
        bus,
        DeviceLinkCfg(host="127.0.0.1", port=0),
        {
            "laptop": {
                "video": {"w": 640, "h": 480, "fps": 15, "quality": 70},
                "audio": {"chunk_ms": 40},
            }
        },
    )
    port = await link.start()

    stats = sim_device.Stats()
    sim = asyncio.create_task(
        sim_device.run_headless(
            f"ws://127.0.0.1:{port}", None, None, fps=10, seconds=1.6, stats=stats
        )
    )

    # wait for the device to register and stream a bit
    for _ in range(40):
        await asyncio.sleep(0.05)
        if link.devices and link.any_frame() is not None:
            break
    assert link.devices, "device never registered"
    session = next(iter(link.devices.values()))
    assert link.any_frame() is not None, "no video frame landed in the newest-wins slot"

    # push a display action down the wire mid-stream
    await bus.publish(
        "display.current",
        DisplayAction(
            card=Card(template=CardTemplate.ANSWER, title="Keys", body="Last seen near desk."),
            ttl_ms=5000,
            priority=PRIO_ANSWER,
            t_created=time.time(),
        ),
    )

    await sim
    assert stats.frames_tx >= 5
    assert stats.audio_tx >= 20
    assert session.frames_rx >= 5
    assert len(audio_seen) >= 20, "audio chunks were not published on av.audio"
    assert any(c["title"] == "Keys" for c in stats.cards_rx), "card never reached the device"
    await link.stop()


async def _collect(sink: list, item) -> None:
    sink.append(item)
