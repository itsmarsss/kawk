"""Exercise the live identity voting code with synthetic embeddings, not images."""
from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from tools.perception_lab.faces import FaceSession, Gallery

from .support import Evidence, ReplayClock


def embedding(person: str, similarity: float = 1) -> np.ndarray:
    vector = np.zeros(512, dtype=np.float32)
    vector[0 if person == "bob" else 1] = similarity
    vector[2] = (1 - similarity ** 2) ** .5
    return vector


async def run_face_case(case: dict) -> dict:
    clock = ReplayClock()
    evidence = Evidence(clock)
    identities = []
    with TemporaryDirectory(prefix="kawk-policy-") as directory:
        gallery = Gallery(Path(directory) / "synthetic-gallery.npz")
        gallery.entries = {name: (name.title(), embedding(name)) for name in ("bob", "alice")}
        session = FaceSession(gallery)
        # Patch only this module's time object; leave asyncio's real clock alone.
        with patch("tools.perception_lab.faces.time", SimpleNamespace(monotonic=clock)):
            for event in case["events"]:
                clock.advance_to(event["at_ms"])
                result = session.process({"faces": [{
                    "box": [100, 70, 280, 270], "detection_score": .95,
                    "embedding": embedding(event["person"], event["similarity"]),
                }], "detected_count": 1})
                face = result["faces"][0]
                identities.append(face["stable_id"])
                evidence.add("face_observation", candidate=face["match"]["id"],
                             stable_id=face["stable_id"], track_id=face["track_id"],
                             synthetic_person=event["person"], similarity=event["similarity"])
    return {"observed": {"stable_ids": identities}, "evidence": evidence.rows,
            "simulated_duration_ms": clock.simulated_ms}
