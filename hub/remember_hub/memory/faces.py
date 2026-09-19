"""Face gallery — pure hub code (AGENTS.md §6.2).

float32 N x 512 matrix + names, persisted .npz. Matching is dot product == cosine
(embeddings are L2-normalized). Every entry is tagged with its embedding model;
match() HARD-FAILS on a tag mismatch — silent cross-model matching degrades to
noise below threshold.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class Match:
    person_id: str
    name: str
    sim: float


class ModelTagMismatch(RuntimeError):
    pass


class FaceGallery:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else None
        self.person_ids: list[str] = []
        self.names: list[str] = []
        self.model_tags: list[str] = []
        self._enrolled_ts: list[float] = []
        self.matrix = np.zeros((0, 512), dtype=np.float32)
        if self.path and self.path.exists():
            self.load(self.path)

    def __len__(self) -> int:
        return len(self.names)

    def enroll(
        self, person_id: str, name: str, embeddings: list[list[float]], model_tag: str
    ) -> None:
        if not embeddings:
            raise ValueError("enroll needs at least one embedding")
        arr = np.asarray(embeddings, dtype=np.float32)
        centroid = arr.mean(axis=0)
        norm = float(np.linalg.norm(centroid))
        if norm == 0:
            raise ValueError("degenerate embeddings")
        centroid /= norm  # mean then re-L2-normalize (§6.2)
        self.person_ids.append(person_id)
        self.names.append(name)
        self.model_tags.append(model_tag)
        self._enrolled_ts.append(time.time())
        self.matrix = np.vstack([self.matrix, centroid[None, :]])
        if self.path:
            self.save(self.path)

    def enrolled_at(self, person_id: str) -> float | None:
        try:
            return self._enrolled_ts[self.person_ids.index(person_id)]
        except ValueError:
            return None

    def match(self, embedding: list[float], model_tag: str, threshold: float) -> Match | None:
        if len(self) == 0:
            return None
        bad = {t for t in self.model_tags if t != model_tag}
        if bad:
            raise ModelTagMismatch(
                f"gallery holds embeddings from {sorted(bad)} but query is '{model_tag}' — "
                f"re-enroll (scripts/enroll.py) after switching face backends"
            )
        q = np.asarray(embedding, dtype=np.float32)
        sims = self.matrix @ q
        idx = int(np.argmax(sims))
        sim = float(sims[idx])
        if sim < threshold:
            return None
        return Match(person_id=self.person_ids[idx], name=self.names[idx], sim=sim)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path,
            matrix=self.matrix,
            person_ids=np.array(self.person_ids),
            names=np.array(self.names),
            model_tags=np.array(self.model_tags),
            enrolled_ts=np.array(self._enrolled_ts, dtype=np.float64),
        )

    def load(self, path: str | Path) -> None:
        data = np.load(path, allow_pickle=False)
        self.matrix = data["matrix"].astype(np.float32)
        self.person_ids = [str(x) for x in data["person_ids"]]
        self.names = [str(x) for x in data["names"]]
        self.model_tags = [str(x) for x in data["model_tags"]]
        self._enrolled_ts = [float(x) for x in data["enrolled_ts"]]
