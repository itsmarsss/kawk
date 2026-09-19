"""Replay a recorded session's percepts through the real brain, offline
(AGENTS.md §10). Recording comes from `make hub` + REMEMBER_RECORD=dir (or
scripts/record.py). The stage-fallback path: what was recorded replays exactly."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "hub"))

from remember_hub.bus import EventBus  # noqa: E402
from remember_hub.config import load_config  # noqa: E402
from remember_hub.contracts.percepts import (  # noqa: E402
    AudioState,
    Detection,
    FaceObservation,
    TranscriptSegment,
)
from remember_hub.display.compositor import Compositor  # noqa: E402
from remember_hub.gate.jev_mock import JevMock  # noqa: E402
from remember_hub.gate.policy import GatePolicy  # noqa: E402
from remember_hub.memory.faces import FaceGallery  # noqa: E402
from remember_hub.memory.store import MemoryStore  # noqa: E402
from remember_hub.tasks import TaskRouter  # noqa: E402
from remember_hub.world.model import WorldModel  # noqa: E402

_DECODERS = {
    "percepts.detections": lambda d: [Detection.model_validate(x) for x in d],
    "percepts.face": lambda d: [FaceObservation.model_validate(x) for x in d],
    "percepts.stt": lambda d: TranscriptSegment.model_validate(d),
    "percepts.audio": lambda d: AudioState.model_validate(d),
}


async def main(recording: Path, speed: float = 1.0) -> None:
    config = load_config(REPO / "remember.toml")
    bus = EventBus()
    with tempfile.TemporaryDirectory() as tmp:
        memory = MemoryStore(Path(tmp) / "replay.sqlite3")
        gallery = FaceGallery(Path(tmp) / "faces.npz")
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
            JevMock(),
            world,
            compositor,
            config.gate,
            config.services.face,
            heartbeat_ms=config.hub.heartbeat_ms,
        )
        TaskRouter(bus, world, memory, gallery)
        bus.subscribe("display.action", _print_action)

        events = [
            json.loads(line) for line in (recording / "percepts.jsonl").read_text().splitlines()
        ]
        if not events:
            print("empty recording")
            return
        policy.start()
        t0_rec = events[0]["t"]
        t0 = time.monotonic()
        for ev in events:
            delay = (ev["t"] - t0_rec) / speed - (time.monotonic() - t0)
            if delay > 0:
                await asyncio.sleep(delay)
            decode = _DECODERS.get(ev["topic"])
            if decode:
                await bus.publish(ev["topic"], decode(ev["data"]))
        await asyncio.sleep(1.0)
        policy.stop()
        memory.close()


async def _print_action(action) -> None:
    if action.card:
        print(f"[display] {action.card.template.value}: {action.card.title} — {action.card.body}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python scripts/replay.py <recording-dir> [speed]")
        raise SystemExit(2)
    asyncio.run(main(Path(sys.argv[1]), float(sys.argv[2]) if len(sys.argv) > 2 else 1.0))
