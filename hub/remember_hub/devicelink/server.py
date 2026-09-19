"""DeviceLink — the WS server every device speaks to (AGENTS.md §5).

One WebSocket per device; binary AV frames + JSON control. permessage-deflate is
DISABLED (JPEG/PCM don't compress; it burns ESP32 CPU). Video lands in a per-device
depth-1 newest-wins slot that perception drivers poll (§3.1: no growable queues);
audio chunks are published to av.audio for the STT driver.

Robustness rules (audit-hardened):
- A malformed binary frame or unknown control message is logged and DROPPED —
  it must never cost the device its connection.
- Display sends go through a per-device depth-1 outbox drained by a sender task,
  so a slow device can never stall the decision cascade (drop-when-behind).
- frame_wh comes from the JPEG's own SOF header, not from the config we pushed —
  devices may ignore config, and §8 geometry depends on the true resolution.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.asyncio.server import Server, ServerConnection, serve

from ..bus import EventBus
from ..config import DeviceLinkCfg
from ..contracts import wire
from ..contracts.display import DisplayAction, RasterBlit

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
    latest_frame: LatestFrame | None = None  # depth-1 newest-wins slot (inbound video)
    first_device_ts: int | None = None
    first_frame_wall: float | None = None
    frames_rx: int = 0
    audio_rx: int = 0
    _seq_out: int = 0
    _outbox: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1))

    def next_seq(self) -> int:
        self._seq_out = (self._seq_out + 1) & 0xFFFF
        return self._seq_out

    def device_ts_to_hub(self, ts_ms: int) -> float:
        """Map device millis() to hub wall time, anchored at the FIRST FRAME
        (hello-time anchoring would bake camera warm-up into every timestamp)."""
        if self.first_device_ts is None or self.first_frame_wall is None:
            return time.time()
        return self.first_frame_wall + (ts_ms - self.first_device_ts) / 1000.0

    def offer_display(self, action: DisplayAction) -> None:
        """Newest-wins: replace any queued action instead of ever backing up."""
        if self._outbox.full():
            try:
                self._outbox.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self._outbox.put_nowait(action)

    async def next_display(self) -> DisplayAction:
        return await self._outbox.get()


class DeviceLinkServer:
    def __init__(self, bus: EventBus, cfg: DeviceLinkCfg, device_defaults: dict[str, dict]) -> None:
        self.bus = bus
        self.cfg = cfg
        self.device_defaults = device_defaults
        self.devices: dict[str, DeviceSession] = {}
        self._server: Server | None = None
        bus.subscribe("display.current", self.on_display)

    async def start(self, port: int | None = None) -> int:
        server = await serve(
            self._handle,
            self.cfg.host,
            self.cfg.port if port is None else port,
            compression=None,  # §5: disable permessage-deflate
            max_size=8 * 1024 * 1024,
        )
        self._server = server
        actual = server.sockets[0].getsockname()[1]
        log.info("devicelink listening on %s:%s", self.cfg.host, actual)
        return actual

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, ws: ServerConnection) -> None:
        session: DeviceSession | None = None
        sender: asyncio.Task | None = None
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
            sender = asyncio.create_task(self._sender_loop(session))
            log.info("device %s (%s) connected", session.device_id, session.cls)
            async for message in ws:
                try:
                    if isinstance(message, bytes):
                        await self._on_binary(session, message)
                    else:
                        await self._on_text(session, message)
                except ValueError as e:
                    # Malformed frame / unknown control type: drop, never disconnect.
                    log.warning("dropping bad message from %s: %s", session.device_id, e)
        except websockets.ConnectionClosed:
            pass
        finally:
            if sender is not None:
                sender.cancel()
            if session is not None and self.devices.get(session.device_id) is session:
                del self.devices[session.device_id]
                log.info("device %s disconnected", session.device_id)

    async def _on_binary(self, session: DeviceSession, buf: bytes) -> None:
        frame = wire.decode(buf)
        if session.first_device_ts is None:
            session.first_device_ts = frame.ts_ms
            session.first_frame_wall = time.time()
        if frame.type == wire.T_VIDEO:
            wh = wire.jpeg_dimensions(frame.payload)
            if wh is None:  # unparseable JPEG: fall back to the config'd resolution
                video = session.config.get("video", {})
                wh = (video.get("w", 640), video.get("h", 480))
            session.latest_frame = LatestFrame(
                jpeg=frame.payload,
                wh=wh,
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

    # ---- display fan-out (decoupled from the decision cascade) -----------------

    async def on_display(self, action: DisplayAction) -> None:
        for session in list(self.devices.values()):
            session.offer_display(action)

    async def _sender_loop(self, session: DeviceSession) -> None:
        try:
            while True:
                action = await session.next_display()
                try:
                    await self._send_action(session, action)
                except websockets.ConnectionClosed:
                    return
        except asyncio.CancelledError:
            return

    async def _send_action(self, session: DeviceSession, action: DisplayAction) -> None:
        image_ref = None
        if action.blit is not None:
            image_ref = await self._send_blit(session, action.blit)
        if action.card is not None:
            await session.ws.send(
                wire.make_card(
                    action.card.template.value,
                    action.card.title,
                    action.card.body,
                    image_ref,
                    action.card.ttl_ms,
                )
            )

    async def _send_blit(self, session: DeviceSession, blit: RasterBlit) -> int:
        seq = session.next_seq()
        blit_type = wire.T_BLIT_RGB565 if blit.fmt == "rgb565" else wire.T_BLIT_JPEG
        await session.ws.send(
            wire.encode(
                wire.WireFrame(
                    type=blit_type,
                    flags=0,
                    seq=seq,
                    ts_ms=int(time.time() * 1000) & 0xFFFFFFFF,
                    payload=blit.data,
                    geometry=(blit.x, blit.y, blit.w, blit.h),
                )
            )
        )
        return seq

    def any_frame(self) -> tuple[str, LatestFrame] | None:
        """Newest frame across devices (single-wearer demo: newest wins)."""
        best: tuple[str, LatestFrame] | None = None
        for device_id, session in self.devices.items():
            lf = session.latest_frame
            if lf is not None and (best is None or lf.t_hub > best[1].t_hub):
                best = (device_id, lf)
        return best
