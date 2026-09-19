"""Boot the REAL hub (build_hub -> start) on an ephemeral port and stream the
headless sim into it — this is `make hub` + `make sim-headless` as a test."""

import asyncio
import sys
import time
from pathlib import Path

from remember_hub.config import load_config
from remember_hub.contracts.display import PRIO_ANSWER, Card, CardTemplate, DisplayAction
from remember_hub.main import build_hub

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "devices" / "sim"))
import sim_device  # noqa: E402


async def test_hub_boots_and_serves_headless_sim(tmp_path):
    config = load_config(REPO / "remember.toml")
    config.hub.data_dir = str(tmp_path)
    config.devicelink.host = "127.0.0.1"
    hub = build_hub(config)
    port = await hub.start(port=0)

    stats = sim_device.Stats()
    sim = asyncio.create_task(
        sim_device.run_headless(
            f"ws://127.0.0.1:{port}", None, None, fps=10, seconds=1.5, stats=stats
        )
    )
    for _ in range(40):
        await asyncio.sleep(0.05)
        if hub.link.devices and hub.link.any_frame() is not None:
            break
    assert hub.link.devices, "device never registered with the booted hub"
    assert hub.link.any_frame() is not None

    await hub.bus.publish(
        "display.current",
        DisplayAction(
            card=Card(template=CardTemplate.ANSWER, title="Boot", body="ok"),
            ttl_ms=3000,
            priority=PRIO_ANSWER,
            t_created=time.time(),
        ),
    )
    await sim
    assert any(c["title"] == "Boot" for c in stats.cards_rx)
    await hub.stop()
    assert not hub.link.devices
