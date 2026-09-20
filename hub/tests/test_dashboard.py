"""Dashboard e2e: page, stats, and an actual MJPEG frame over raw HTTP."""

import asyncio
import json
import sys
from pathlib import Path

from remember_hub.config import DashboardCfg, load_config
from remember_hub.dashboard import Dashboard
from remember_hub.main import build_hub

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "devices" / "sim"))
import sim_device  # noqa: E402


async def _http_get(port: int, path: str, max_bytes: int = 1 << 16) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
    await writer.drain()
    data = await asyncio.wait_for(reader.read(max_bytes), timeout=5)
    writer.close()
    return data


async def _read_stream_until(port: int, markers: list[bytes], timeout: float = 5.0) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"GET /stream HTTP/1.1\r\nHost: x\r\n\r\n")
    await writer.drain()
    buf = b""
    async with asyncio.timeout(timeout):
        while not all(m in buf for m in markers):
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf += chunk
    writer.close()
    return buf


async def test_dashboard_serves_page_stats_and_mjpeg(tmp_path):
    config = load_config(REPO / "remember.toml")
    config.hub.data_dir = str(tmp_path)
    config.devicelink.host = "127.0.0.1"
    config.dashboard.enabled = False  # we start our own on an ephemeral port
    hub = build_hub(config)
    ws_port = await hub.start(port=0)
    dash = Dashboard(hub.bus, hub.link, hub.compositor, DashboardCfg(host="127.0.0.1", port=0))
    dash_port = await dash.start()

    sim = asyncio.create_task(
        sim_device.run_headless(f"ws://127.0.0.1:{ws_port}", None, None, fps=10, seconds=1.5)
    )
    for _ in range(40):
        await asyncio.sleep(0.05)
        if hub.link.any_frame() is not None:
            break
    assert hub.link.any_frame() is not None

    page = await _http_get(dash_port, "/")
    assert b"200 OK" in page and b"dashboard" in page

    stats_raw = await _http_get(dash_port, "/stats.json")
    stats = json.loads(stats_raw.split(b"\r\n\r\n", 1)[1])
    assert stats["devices"] and stats["devices"][0]["id"] == "sim-headless"
    assert stats["devices"][0]["wh"] == [1, 1]
    assert stats["display"]["template"] == "idle"

    stream = await _read_stream_until(
        dash_port, [b"multipart/x-mixed-replace", b"--frame", b"\xff\xd8"]
    )
    assert b"--frame" in stream and b"\xff\xd8" in stream, "no MJPEG frame delivered"

    await sim
    await dash.stop()
    await hub.stop()
