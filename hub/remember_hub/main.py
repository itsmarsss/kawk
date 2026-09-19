"""Hub entrypoint: load config, wire everything, run (AGENTS.md §4).

`make hub` runs this. Devices connect over WS (§5); backends come from
remember.toml (§11) — with everything on "mock" this runs with zero keys and
waits for a device (the mocks emit nothing without a scenario, so it's a wire/
display test bench until local/baseten backends are flipped on).

build_hub() returns the fully wired Hub without starting it — tests boot the
real thing on an ephemeral port.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from .branding import PRODUCT_NAME
from .bus import EventBus
from .config import AppConfig, load_config
from .devicelink.server import DeviceLinkServer
from .display.compositor import Compositor
from .gate import create_jev_backend
from .gate.policy import GatePolicy
from .memory.faces import FaceGallery
from .memory.store import MemoryStore
from .perception.drivers import FaceDriver, SamDriver, SttDriver
from .perception.face import create_face_backend
from .perception.sam import create_sam_backend
from .perception.stt import create_stt_backend
from .tasks import TaskRouter
from .world.model import WorldModel

log = logging.getLogger(__name__)


def install_recorder(bus: EventBus, out: Path) -> None:
    """Percept tap for scripts/record.py -> scripts/replay.py (AGENTS.md §10)."""
    out.mkdir(parents=True, exist_ok=True)
    sink = (out / "percepts.jsonl").open("a")

    def writer(topic: str):
        async def write(payload) -> None:
            data = (
                [p.model_dump(mode="json") for p in payload]
                if isinstance(payload, list)
                else payload.model_dump(mode="json")
            )
            sink.write(json.dumps({"t": time.time(), "topic": topic, "data": data}) + "\n")
            sink.flush()

        return write

    for topic in ("percepts.detections", "percepts.face", "percepts.stt"):
        bus.subscribe(topic, writer(topic))


@dataclass
class Hub:
    config: AppConfig
    bus: EventBus
    memory: MemoryStore
    gallery: FaceGallery
    world: WorldModel
    compositor: Compositor
    policy: GatePolicy
    router: TaskRouter
    link: DeviceLinkServer
    sam_driver: SamDriver
    face_driver: FaceDriver
    stt_driver: SttDriver
    port: int | None = None

    async def start(self, port: int | None = None) -> int:
        self.port = await self.link.start(port)
        self.policy.start()
        self.sam_driver.start()
        self.face_driver.start()
        self.stt_driver.start()
        log.info(
            "%s hub up on ws://%s:%s (sam=%s face=%s stt=%s jev=%s)",
            PRODUCT_NAME,
            self.config.devicelink.host,
            self.port,
            self.config.services.sam.backend,
            self.config.services.face.backend,
            self.config.services.stt.backend,
            self.config.services.jev.backend,
        )
        return self.port

    async def stop(self) -> None:
        for driver in (self.sam_driver, self.face_driver, self.stt_driver):
            driver.stop()
        self.policy.stop()
        await self.link.stop()
        self.memory.close()


def build_hub(config: AppConfig) -> Hub:
    data = Path(config.hub.data_dir)
    bus = EventBus()
    memory = MemoryStore(data / "remember.sqlite3")
    gallery = FaceGallery(data / "faces.npz")
    world = WorldModel(
        bus,
        config.world,
        config.services.face,
        memory,
        gallery,
        score_threshold=config.services.sam.score_threshold,
    )
    compositor = Compositor(bus)
    policy = GatePolicy(
        bus,
        create_jev_backend(config.services.jev),
        world,
        compositor,
        config.gate,
        config.services.face,
        heartbeat_ms=config.hub.heartbeat_ms,
    )
    router = TaskRouter(bus, world, memory, gallery)
    link = DeviceLinkServer(bus, config.devicelink, config.devices)
    return Hub(
        config=config,
        bus=bus,
        memory=memory,
        gallery=gallery,
        world=world,
        compositor=compositor,
        policy=policy,
        router=router,
        link=link,
        sam_driver=SamDriver(
            bus, link, create_sam_backend(config.services.sam), config.services.sam
        ),
        face_driver=FaceDriver(
            bus, link, create_face_backend(config.services.face), config.services.face, world
        ),
        stt_driver=SttDriver(bus, create_stt_backend(config.services.stt)),
    )


async def run(config_path: str = "remember.toml") -> None:
    config = load_config(config_path)
    hub = build_hub(config)
    record_dir = os.environ.get("REMEMBER_RECORD")
    if record_dir:
        install_recorder(hub.bus, Path(record_dir))
    await hub.start()
    try:
        await asyncio.Event().wait()
    finally:
        await hub.stop()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
