"""Scenario-driven SAM mock — the reference implementation of the interface (§3.2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...contracts.percepts import Detection
from .base import SamBackend

if TYPE_CHECKING:
    from ...scenario import Scenario, ScenarioClock


class MockSam(SamBackend):
    def __init__(self, scenario: Scenario | None = None, clock: ScenarioClock | None = None):
        self.scenario = scenario
        self.clock = clock
        self.vocabulary: list[str] = []

    async def start_session(self, vocabulary: list[str]) -> None:
        self.vocabulary = list(vocabulary)

    async def push_frame(self, frame_id: str, jpeg: bytes, wh: tuple[int, int]) -> list[Detection]:
        if self.scenario is None or self.clock is None:
            return []
        t = self.clock.now()
        gone = {d.track for d in self.scenario.disappears if d.t <= t}
        return [
            Detection(
                track_id=a.track,
                label=a.label,
                box_xyxy=a.box,
                score=0.9,
                frame_wh=wh,
            )
            for a in self.scenario.appears
            if a.t <= t and a.track not in gone
        ]

    async def add_concept(self, noun: str) -> None:
        if noun not in self.vocabulary:
            self.vocabulary.append(noun)

    async def end_session(self) -> None:
        pass
