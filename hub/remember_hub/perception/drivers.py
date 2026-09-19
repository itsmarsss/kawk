"""Live-mode perception drivers: devicelink -> backends -> percept topics.

The scenario runner replaces these in mock demos; in live mode they poll the
devicelink's newest-wins frame slot (at-most-one-in-flight per backend, §3.1).

Supervision (audit-hardened): every loop survives backend failures with logged
retry + backoff — a transient Baseten error must degrade one subsystem for
seconds, never kill it for the session. STT auto-reconnects (§6.3: connections
are only guaranteed ≥1 h) and publishes a cheap RMS-based AudioState until
Lane C's vad.py replaces it.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time

import numpy as np

from ..bus import EventBus
from ..config import FaceCfg, SamCfg
from ..contracts.percepts import AudioState
from ..devicelink.server import DeviceLinkServer
from .face.base import FaceBackend
from .sam.base import SamBackend
from .stt.base import SttBackend

log = logging.getLogger(__name__)

_BACKOFF_S = (1, 2, 5, 10)


def _backoff(attempt: int) -> float:
    return _BACKOFF_S[min(attempt, len(_BACKOFF_S) - 1)]


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
        self._task = asyncio.create_task(self._supervised())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _supervised(self) -> None:
        attempt = 0
        while True:
            try:
                await self.backend.start_session(self.cfg.vocabulary)
                attempt = 0
                await self._loop()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("sam driver failed; retrying in %ss", _backoff(attempt))
                await asyncio.sleep(_backoff(attempt))
                attempt += 1

    async def _loop(self) -> None:
        interval = 1.0 / self.cfg.poll_fps
        last_key: tuple[str, int] | None = None  # (device_id, seq) — never cross-device
        failures = 0
        i = 0
        while True:
            got = self.link.any_frame()
            if got is not None:
                device_id, lf = got
                key = (device_id, lf.seq)
                if key != last_key:
                    last_key = key
                    try:
                        detections = await self.backend.push_frame(f"f{i}", lf.jpeg, lf.wh)
                        failures = 0
                    except Exception:
                        failures += 1
                        log.exception("sam push_frame failed (%s consecutive)", failures)
                        if failures >= 3:
                            raise  # supervisor restarts the session
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
        self._task = asyncio.create_task(self._supervised())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _supervised(self) -> None:
        attempt = 0
        while True:
            try:
                await self._loop()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("face driver failed; retrying in %ss", _backoff(attempt))
                await asyncio.sleep(_backoff(attempt))
                attempt += 1

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
    """Bridges av.audio chunks into the backend's stream() and republishes segments.

    Also publishes AudioState (RMS level + naive activity) so the snapshot's
    SPEECH flag works before/while the user is talking — a stopgap until Lane
    C's Silero vad.py owns this.
    """

    def __init__(self, bus: EventBus, backend: SttBackend) -> None:
        self.bus = bus
        self.backend = backend
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=64)
        self._task: asyncio.Task | None = None
        self._last_state_pub = 0.0
        bus.subscribe("av.audio", self._on_audio)

    async def _on_audio(self, msg: dict) -> None:
        pcm: bytes = msg["pcm"]
        try:
            self._queue.put_nowait(pcm)
        except asyncio.QueueFull:
            _ = self._queue.get_nowait()  # drop oldest — audio must never back up (§3.1)
            self._queue.put_nowait(pcm)
        now = time.time()
        if now - self._last_state_pub >= 0.2:
            self._last_state_pub = now
            samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
            rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0.0
            level_db = 20 * math.log10(rms / 32768.0) if rms > 0 else -90.0
            await self.bus.publish(
                "percepts.audio",
                AudioState(speech_active=level_db > -35.0, level_db=level_db),
            )

    def start(self) -> None:
        self._task = asyncio.create_task(self._supervised())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _supervised(self) -> None:
        attempt = 0
        while True:
            try:
                await self._loop()
                # Clean stream end (server closed / mock exhausted): reconnect calmly.
                log.info("stt stream ended; reconnecting in 2s")
                await asyncio.sleep(2)
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("stt driver failed; retrying in %ss", _backoff(attempt))
                await asyncio.sleep(_backoff(attempt))
                attempt += 1

    async def _loop(self) -> None:
        async def chunks():
            while True:
                yield await self._queue.get()

        async for seg in self.backend.stream(chunks()):
            await self.bus.publish("percepts.stt", seg)
