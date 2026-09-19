"""ScenarioRunner — drives the mock backends on wall-clock (AGENTS.md §10).

`make demo` connects NO device: a ticker calls the mock backends through their
normal interfaces with synthetic inputs (1x1 JPEG, zeroed PCM) so the real
contracts are exercised; mocks answer from scenario time. Scenarios cap ~20 s;
`by:` is a deadline with +0.5 s tolerance; `expect` asserts on the hub's
display.action bus topic (never a device render), matching case-insensitive
substrings over card title+body. Also the main pytest e2e.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from .bus import EventBus
from .config import AppConfig, load_config
from .contracts.display import DisplayAction
from .display.compositor import Compositor
from .gate.jev_mock import JevMock
from .gate.policy import GatePolicy
from .memory.faces import FaceGallery
from .memory.store import MemoryStore
from .tasks import TaskRouter
from .world.model import WorldModel

SYNTH_JPEG = b"\xff\xd8\xff\xd9"  # 1x1 placeholder; mocks never decode it
SYNTH_PCM = b"\x00" * 1280  # one zeroed 40 ms chunk


# ---- scenario DSL (§10 — these event kinds are the whole DSL) -----------------


class SamAppear(BaseModel):
    t: float
    label: str
    track: str
    box: tuple[float, float, float, float]


class SamDisappear(BaseModel):
    t: float
    track: str


class SttEvent(BaseModel):
    t: float
    final: str
    words: bool = False  # true = synthesize evenly spaced word timestamps


class FaceEvent(BaseModel):
    t: float
    track: str
    person_tag: str
    det_score: float = 0.9
    box: tuple[float, float, float, float] = (0.4, 0.1, 0.6, 0.5)
    dur: float = Field(default=2.0, alias="for")  # observations emitted for this long

    model_config = {"populate_by_name": True}


class DisplayExpect(BaseModel):
    by: float
    template: str
    contains: str = ""
    not_contains: str | None = None


class GalleryExpect(BaseModel):
    contains: str


@dataclass
class Scenario:
    name: str
    appears: list[SamAppear] = field(default_factory=list)
    disappears: list[SamDisappear] = field(default_factory=list)
    stt_events: list[SttEvent] = field(default_factory=list)
    face_events: list[FaceEvent] = field(default_factory=list)
    display_expects: list[DisplayExpect] = field(default_factory=list)
    gallery_expects: list[GalleryExpect] = field(default_factory=list)

    @classmethod
    def load(cls, path: str | Path) -> Scenario:
        raw = yaml.safe_load(Path(path).read_text())
        sc = cls(name=raw.get("name", Path(path).stem))
        for item in raw.get("timeline", []):
            t = item["t"]
            if "sam" in item:
                body = item["sam"]
                if "appear" in body:
                    sc.appears.append(SamAppear(t=t, **body["appear"]))
                elif "disappear" in body:
                    sc.disappears.append(SamDisappear(t=t, **body["disappear"]))
            elif "stt" in item:
                sc.stt_events.append(SttEvent(t=t, **item["stt"]))
            elif "face" in item:
                sc.face_events.append(FaceEvent(t=t, **item["face"]["observe"]))
        for item in raw.get("expect", []):
            if "display" in item:
                sc.display_expects.append(DisplayExpect(by=item["by"], **item["display"]))
            elif "gallery" in item:
                sc.gallery_expects.append(GalleryExpect(**item["gallery"]))
        sc.stt_events.sort(key=lambda e: e.t)
        return sc

    def end_time(self) -> float:
        ts = (
            [e.t for e in self.appears + self.disappears + self.stt_events]
            + [e.t + e.dur for e in self.face_events]
            + [e.by for e in self.display_expects]
        )
        return max(ts, default=1.0) + 0.8


class ScenarioClock:
    def __init__(self) -> None:
        self._t0: float | None = None

    def start(self) -> None:
        self._t0 = asyncio.get_running_loop().time()

    def now(self) -> float:
        assert self._t0 is not None, "clock not started"
        return asyncio.get_running_loop().time() - self._t0

    async def sleep_until(self, t: float) -> None:
        delay = t - self.now()
        if delay > 0:
            await asyncio.sleep(delay)


# ---- runner --------------------------------------------------------------------


@dataclass
class Report:
    name: str
    passed: bool
    lines: list[str]


class ScenarioRunner:
    def __init__(self, scenario: Scenario, config: AppConfig, data_dir: str | Path) -> None:
        from .perception.face.mock import MockFace
        from .perception.sam.mock import MockSam
        from .perception.stt.mock import MockStt

        self.scenario = scenario
        self.config = config
        self.clock = ScenarioClock()
        self.bus = EventBus()
        data = Path(data_dir)
        self.memory = MemoryStore(data / "remember.sqlite3")
        self.gallery = FaceGallery(data / "faces.npz")
        self.sam = MockSam(scenario, self.clock)
        self.face = MockFace(scenario, self.clock)
        self.stt = MockStt(scenario, self.clock)
        self.world = WorldModel(
            self.bus,
            config.world,
            config.services.face,
            self.memory,
            self.gallery,
            score_threshold=config.services.sam.score_threshold,
        )
        self.compositor = Compositor(self.bus)
        self.policy = GatePolicy(
            self.bus,
            JevMock(),
            self.world,
            self.compositor,
            config.gate,
            config.services.face,
            heartbeat_ms=config.hub.heartbeat_ms,
        )
        self.router = TaskRouter(self.bus, self.world, self.memory, self.gallery)
        self.actions: list[tuple[float, DisplayAction]] = []
        self.bus.subscribe("display.action", self._collect)

    async def _collect(self, action: DisplayAction) -> None:
        self.actions.append((self.clock.now(), action))

    async def run(self) -> Report:
        self.clock.start()
        self.policy.start()
        await self.sam.start_session(self.config.services.sam.vocabulary)
        loops = [
            asyncio.create_task(self._sam_loop()),
            asyncio.create_task(self._face_loop()),
            asyncio.create_task(self._stt_loop()),
        ]
        await self.clock.sleep_until(self.scenario.end_time())
        for task in loops:
            task.cancel()
        self.policy.stop()
        await asyncio.sleep(0)  # let cancellations land
        report = self._evaluate()
        self.memory.close()  # WAL files must be closed before the tempdir goes away
        return report

    async def _sam_loop(self) -> None:
        interval = 1.0 / self.config.services.sam.poll_fps
        i = 0
        while True:
            detections = await self.sam.push_frame(f"f{i}", SYNTH_JPEG, (1, 1))
            now = time.time()
            for d in detections:
                d.t_percept = now
            await self.bus.publish("percepts.detections", detections)
            i += 1
            await asyncio.sleep(interval)

    async def _face_loop(self) -> None:
        interval = 1.0 / self.config.services.face.poll_fps
        while True:
            observations = await self.face.embed_faces(SYNTH_JPEG, (1, 1))
            if observations:
                await self.bus.publish("percepts.face", observations)
            await asyncio.sleep(interval)

    async def _stt_loop(self) -> None:
        async def silence():
            while True:
                yield SYNTH_PCM
                await asyncio.sleep(0.04)

        async for seg in self.stt.stream(silence()):
            await self.bus.publish("percepts.stt", seg)

    def _evaluate(self) -> Report:
        lines: list[str] = []
        ok = True
        for exp in self.scenario.display_expects:
            hit = None
            for t, action in self.actions:
                if action.card is None or t > exp.by + 0.5:
                    continue
                text = f"{action.card.title} {action.card.body}".lower()
                if (
                    action.card.template.value == exp.template
                    and exp.contains.lower() in text
                    and (exp.not_contains is None or exp.not_contains.lower() not in text)
                ):
                    hit = (t, action)
                    break
            if hit:
                card = hit[1].card
                assert card is not None
                lines.append(
                    f"  PASS display[{exp.template}] contains '{exp.contains}' "
                    f"@ {hit[0]:.2f}s: {card.title} — {card.body}"
                )
            else:
                ok = False
                lines.append(
                    f"  FAIL display[{exp.template}] contains '{exp.contains}' by {exp.by}s "
                    f"(saw: {[(round(t, 2), a.card.template.value if a.card else 'blit') for t, a in self.actions]})"
                )
        for gexp in self.scenario.gallery_expects:
            names = [n.lower() for n in self.gallery.names]
            if any(gexp.contains.lower() in n for n in names):
                lines.append(f"  PASS gallery contains '{gexp.contains}'")
            else:
                ok = False
                lines.append(f"  FAIL gallery contains '{gexp.contains}' (gallery: {names})")
        return Report(name=self.scenario.name, passed=ok, lines=lines)


def _find_config(start: Path) -> Path:
    for parent in [start, *start.parents]:
        candidate = parent / "remember.toml"
        if candidate.exists():
            return candidate
    fallback = Path("remember.toml")
    if fallback.exists():
        return fallback
    raise SystemExit(
        f"remember.toml not found walking up from {start} — pass config_path explicitly"
    )


async def run_scenario(path: str | Path, config_path: str | Path | None = None) -> Report:
    scenario = Scenario.load(path)
    config = load_config(config_path or _find_config(Path(path).resolve().parent))
    with tempfile.TemporaryDirectory(prefix="remember-scenario-") as tmp:
        runner = ScenarioRunner(scenario, config, tmp)
        return await runner.run()


def main() -> None:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    if len(sys.argv) < 2:
        print("usage: python -m remember_hub.scenario scenarios/keys.yaml")
        raise SystemExit(2)
    report = asyncio.run(run_scenario(sys.argv[1]))
    print(f"scenario '{report.name}': {'PASS' if report.passed else 'FAIL'}")
    for line in report.lines:
        print(line)
    raise SystemExit(0 if report.passed else 1)


if __name__ == "__main__":
    main()
