"""Track table: IoU dedup, coasting, track-end detection (AGENTS.md §6.1 hygiene, §8 timing).

Streaming SAM disables hotstart heuristics -> duplicate tracks happen; we alias a new
track_id onto an existing same-label entity when IoU >= 0.5. During SAM session
recycles/reconnects the table is FROZEN: no track-ends, coasting extended (§6.1/§8).
"""

from __future__ import annotations

import time

from ..config import WorldCfg
from ..contracts.percepts import Box, Detection
from ..contracts.world import Entity, PersonAttrs


def iou(a: Box, b: Box) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


class TrackTable:
    def __init__(self, cfg: WorldCfg, score_threshold: float) -> None:
        self.cfg = cfg
        self.score_threshold = score_threshold
        self.entities: dict[str, Entity] = {}
        self._alias: dict[str, str] = {}  # duplicate track_id -> canonical track_id
        self.frozen = False  # set during SAM recycle/reconnect

    def freeze(self) -> None:
        self.frozen = True

    def thaw(self) -> None:
        self.frozen = False

    def update(
        self, detections: list[Detection], now: float | None = None
    ) -> tuple[list[Entity], list[Entity]]:
        """Apply one detection batch. Returns (appeared_entities, ended_entities)."""
        now = now if now is not None else time.time()
        appeared: list[Entity] = []

        for det in detections:
            if det.score < self.score_threshold:
                continue
            tid = self._alias.get(det.track_id, det.track_id)
            ent = self.entities.get(tid)
            if ent is None:
                dup = self._find_duplicate(det)
                if dup is not None:
                    self._alias[det.track_id] = dup.track_id
                    ent = dup
            if ent is not None:
                ent.box_xyxy = det.box_xyxy
                ent.frame_wh = det.frame_wh
                ent.score = det.score
                ent.last_seen = now
            else:
                ent = Entity(
                    track_id=det.track_id,
                    label=det.label,
                    box_xyxy=det.box_xyxy,
                    frame_wh=det.frame_wh,
                    score=det.score,
                    first_seen=now,
                    last_seen=now,
                    person=PersonAttrs() if det.label == "person" else None,
                )
                self.entities[ent.track_id] = ent
                appeared.append(ent)

        ended: list[Entity] = []
        if not self.frozen:
            for tid, ent in list(self.entities.items()):
                if now - ent.last_seen > self.cfg.track_end_s:
                    del self.entities[tid]
                    self._alias = {a: c for a, c in self._alias.items() if c != tid}
                    ended.append(ent)
        return appeared, ended

    def _find_duplicate(self, det: Detection) -> Entity | None:
        best, best_iou = None, 0.5
        for ent in self.entities.values():
            if ent.label != det.label:
                continue
            score = iou(ent.box_xyxy, det.box_xyxy)
            if score >= best_iou:
                best, best_iou = ent, score
        return best

    def in_view(self, now: float | None = None) -> list[Entity]:
        """Entities seen within the coast window (§8: coast 1 s through gaps)."""
        now = now if now is not None else time.time()
        return [e for e in self.entities.values() if now - e.last_seen <= self.cfg.coast_s]
