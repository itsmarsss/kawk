"""Scenario-driven face mock (AGENTS.md §6.2).

Derives a DETERMINISTIC 512-d unit vector from the scenario's person_tag
(seeded RNG + small per-observation noise, re-normalized) so the real gallery
enroll/match code runs unmodified in mock demos.
"""

from __future__ import annotations

import zlib
from typing import TYPE_CHECKING

import numpy as np

from ...contracts.percepts import FaceObservation
from .base import FaceBackend

if TYPE_CHECKING:
    from ...scenario import Scenario, ScenarioClock

MODEL_TAG = "mock"


def tag_vector(person_tag: str) -> np.ndarray:
    rng = np.random.default_rng(zlib.crc32(person_tag.encode()))
    v = rng.standard_normal(512).astype(np.float32)
    return v / np.linalg.norm(v)


class MockFace(FaceBackend):
    def __init__(self, scenario: Scenario | None = None, clock: ScenarioClock | None = None):
        self.scenario = scenario
        self.clock = clock
        self._calls = 0

    async def embed_faces(self, jpeg: bytes, wh: tuple[int, int]) -> list[FaceObservation]:
        if self.scenario is None or self.clock is None:
            return []
        t = self.clock.now()
        self._calls += 1
        out: list[FaceObservation] = []
        for event in self.scenario.face_events:
            if not (event.t <= t <= event.t + event.dur):
                continue
            base = tag_vector(event.person_tag)
            noise_rng = np.random.default_rng(
                zlib.crc32(f"{event.person_tag}:{self._calls}".encode())
            )
            noisy = base + 0.03 * noise_rng.standard_normal(512).astype(np.float32)
            noisy /= np.linalg.norm(noisy)
            out.append(
                FaceObservation(
                    box_xyxy=event.box,
                    det_score=event.det_score,
                    embedding=noisy.tolist(),
                    model_tag=MODEL_TAG,
                    frame_wh=wh,
                    track_id=event.track,
                )
            )
        return out
