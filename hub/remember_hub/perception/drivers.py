"""Live-mode perception drivers: devicelink -> backends -> percept topics.

The scenario runner replaces these in mock demos; in live mode they poll the
devicelink's newest-wins frame slot (at-most-one-in-flight per backend, §3.1).
Lane C's vad.py slots in front of the STT feed when it lands (INTEGRATION.md).
"""

from __future__ import annotations

import asyncio
import logging
import time

from ..bus import EventBus
from ..config import FaceCfg, SamCfg
from ..devicelink.server import DeviceLinkServer
from .face.base import FaceBackend
from .sam.base import SamBackend
from .stt.base import SttBackend

log = logging.getLogger(__name__)


class SamDriver:
    def __init__(
        self, bus: EventBus, link: DeviceLinkServer, backend: SamBackend, cfg: SamCfg
    ) -> None:
        self.bus = bus
        self.link = link
        self.backend = backend
        self.cfg = cfg
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        await self.backend.start_session(self.cfg.vocabulary)
        interval = 1.0 / self.cfg.poll_fps
        last_seq: int | None = None
        i = 0
        while True:
            got = self.link.any_frame()
            if got is not None:
                _, lf = got
                if lf.seq != last_seq:  # newest-wins; skip if nothing new
                    last_seq = lf.seq
                    try:
                        detections = await self.backend.push_frame(f"f{i}", lf.jpeg, lf.wh)
                    except Exception:
                        log.exception("sam push_frame failed; continuing")
                        detections = []
                    now = time.time()
                    for d in detections:
                        d.t_percept = now
                    await self.bus.publish("percepts.detections", detections)
                    i += 1
            await asyncio.sleep(interval)


class FaceDriver:
    def __init__(
        self, bus: EventBus, link: DeviceLinkServer, backend: FaceBackend, cfg: FaceCfg, world
    ) -> None:
        self.bus = bus
        self.link = link
        self.backend = backend
        self.cfg = cfg
        self.world = world
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        interval = 1.0 / self.cfg.poll_fps
        while True:
            # §6.2: only run when the world has a live person track.
            has_person = any(e.label == "person" for e in self.world.in_view())
            got = self.link.any_frame() if has_person else None
            if got is not None:
                _, lf = got
                # TODO(M3, Lane C lands cv2 path): downscale to <=640px before sending.
                try:
                    observations = await self.backend.embed_faces(lf.jpeg, lf.wh)
                except Exception:
                    log.exception("face embed failed; continuing")
                    observations = []
                if observations:
                    await self.bus.publish("percepts.face", observations)
            await asyncio.sleep(interval)


class SttDriver:
    """Bridges av.audio chunks into the backend's stream() and republishes segments."""

    def __init__(self, bus: EventBus, backend: SttBackend) -> None:
        self.bus = bus
        self.backend = backend
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=64)
        self._task: asyncio.Task | None = None
        bus.subscribe("av.audio", self._on_audio)

    async def _on_audio(self, msg: dict) -> None:
        try:
            self._queue.put_nowait(msg["pcm"])
        except asyncio.QueueFull:
            _ = self._queue.get_nowait()  # drop oldest — audio must never back up (§3.1)
            self._queue.put_nowait(msg["pcm"])

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        async def chunks():
            while True:
                yield await self._queue.get()

        async for seg in self.backend.stream(chunks()):
            await self.bus.publish("percepts.stt", seg)
