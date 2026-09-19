"""DeviceLink — the WS server every device speaks to (AGENTS.md §5).

One WebSocket per device; binary AV frames + JSON control. permessage-deflate is
DISABLED (JPEG/PCM don't compress; it burns ESP32 CPU). Video lands in a per-device
depth-1 newest-wins slot that perception drivers poll (§3.1: no growable queues);
audio chunks are published to av.audio for the STT driver. Display: subscribes
display.current and pushes semantic cards (+ 0x10 blits when present) to all
connected devices — single-wearer demo, one display state.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection, serve

from ..bus import EventBus
from ..config import DeviceLinkCfg
from ..contracts import wire
from ..contracts.display import DisplayAction

log = logging.getLogger(__name__)


@dataclass
class LatestFrame:
    jpeg: bytes
    wh: tuple[int, int]
    seq: int
    ts_ms: int
    t_hub: float


@dataclass
class DeviceSession:
    device_id: str
    cls: str
    display_wh: tuple[int, int]
    ws: ServerConnection
    config: dict[str, Any] = field(default_factory=dict)
    latest_frame: LatestFrame | None = None  # depth-1 newest-wins slot
    hello_mono: float = 0.0
    first_device_ts: int | None = None
    frames_rx: int = 0
    audio_rx: int = 0
    _seq_out: int = 0

    def next_seq(self) -> int:
        self._seq_out = (self._seq_out + 1) & 0xFFFF
        return self._seq_out

    def device_ts_to_hub(self, ts_ms: int) -> float:
        """Map device millis() to hub wall time via the hello-time anchor (§5)."""
        if self.first_device_ts is None:
            return time.time()
        return self.hello_mono + (ts_ms - self.first_device_ts) / 1000.0


class DeviceLinkServer:
    def __init__(self, bus: EventBus, cfg: DeviceLinkCfg, device_defaults: dict[str, dict]) -> None:
        self.bus = bus
        self.cfg = cfg
        self.device_defaults = device_defaults
        self.devices: dict[str, DeviceSession] = {}
        self._server: websockets.asyncio.server.Server | None = None
        bus.subscribe("display.current", self.on_display)

    async def start(self, port: int | None = None) -> int:
        self._server = await serve(
            self._handle,
            self.cfg.host,
            self.cfg.port if port is None else port,
            compression=None,  # §5: disable permessage-deflate
            max_size=8 * 1024 * 1024,
        )
        actual = self._server.sockets[0].getsockname()[1]
        log.info("devicelink listening on %s:%s", self.cfg.host, actual)
        return actual

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, ws: ServerConnection) -> None:
        session: DeviceSession | None = None
        try:
            raw = await ws.recv()
            if isinstance(raw, bytes):
                log.warning("device sent binary before hello; closing")
                return
            hello = wire.parse_control(raw)
            if hello["type"] != "hello":
                log.warning("first message was %s, not hello; closing", hello["type"])
                return
            session = DeviceSession(
                device_id=hello["device_id"],
                cls=hello.get("class", "laptop"),
                display_wh=(hello["display"]["w"], hello["display"]["h"]),
                ws=ws,
                hello_mono=time.time(),
            )
            # Reconnect = same device (§5): replace any prior session.
            self.devices[session.device_id] = session
            defaults = self.device_defaults.get(session.cls, self.device_defaults.get("laptop", {}))
            session.config = defaults
            await ws.send(
                wire.make_config(
                    defaults.get("video", {"w": 640, "h": 480, "fps": 15, "quality": 70}),
                    defaults.get("audio", {"chunk_ms": 40}),
                )
            )
            log.info("device %s (%s) connected", session.device_id, session.cls)
            async for message in ws:
                if isinstance(message, bytes):
                    await self._on_binary(session, message)
                else:
                    await self._on_text(session, message)
        except websockets.ConnectionClosed:
            pass
        finally:
            if session is not None and self.devices.get(session.device_id) is session:
                del self.devices[session.device_id]
                log.info("device %s disconnected", session.device_id)

    async def _on_binary(self, session: DeviceSession, buf: bytes) -> None:
        frame = wire.decode(buf)
        if session.first_device_ts is None:
            session.first_device_ts = frame.ts_ms
        if frame.type == wire.T_VIDEO:
            video = session.config.get("video", {})
            session.latest_frame = LatestFrame(
                jpeg=frame.payload,
                wh=(video.get("w", 640), video.get("h", 480)),
                seq=frame.seq,
                ts_ms=frame.ts_ms,
                t_hub=time.time(),
            )
            session.frames_rx += 1
        elif frame.type == wire.T_AUDIO:
            session.audio_rx += 1
            await self.bus.publish(
                "av.audio", {"device_id": session.device_id, "pcm": frame.payload}
            )

    async def _on_text(self, session: DeviceSession, text: str) -> None:
        msg = wire.parse_control(text)
        if msg["type"] == "ping":
            await session.ws.send(json.dumps({"type": "pong"}))

    # ---- display fan-out -------------------------------------------------------

    async def on_display(self, action: DisplayAction) -> None:
        for session in list(self.devices.values()):
            try:
                if action.card is not None:
                    image_ref = None
                    if action.blit is not None:
                        image_ref = session.next_seq()
                        await session.ws.send(
                            wire.encode(
                                wire.WireFrame(
                                    type=wire.T_BLIT_JPEG,
                                    flags=0,
                                    seq=image_ref,
                                    ts_ms=int(time.time() * 1000) & 0xFFFFFFFF,
                                    payload=action.blit.data,
                                    geometry=(
                                        action.blit.x,
                                        action.blit.y,
                                        action.blit.w,
                                        action.blit.h,
                                    ),
                                )
                            )
                        )
                    await session.ws.send(
                        wire.make_card(
                            action.card.template.value,
                            action.card.title,
                            action.card.body,
                            image_ref,
                            action.card.ttl_ms,
                        )
                    )
                elif action.blit is not None:
                    await session.ws.send(
                        wire.encode(
                            wire.WireFrame(
                                type=wire.T_BLIT_JPEG,
                                flags=0,
                                seq=session.next_seq(),
                                ts_ms=int(time.time() * 1000) & 0xFFFFFFFF,
                                payload=action.blit.data,
                                geometry=(
                                    action.blit.x,
                                    action.blit.y,
                                    action.blit.w,
                                    action.blit.h,
                                ),
                            )
                        )
                    )
            except websockets.ConnectionClosed:
                continue

    def any_frame(self) -> tuple[str, LatestFrame] | None:
        """Newest frame across devices (single-wearer demo: first device wins)."""
        best: tuple[str, LatestFrame] | None = None
        for device_id, session in self.devices.items():
            lf = session.latest_frame
            if lf is not None and (best is None or lf.t_hub > best[1].t_hub):
                best = (device_id, lf)
        return best
