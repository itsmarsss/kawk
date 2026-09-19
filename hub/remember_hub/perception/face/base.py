"""Face-perception interface (AGENTS.md §6.2). FROZEN after m0.

Backends: mock.py (Lane A) · local_insight.py (Lane C, buffalo_l) ·
baseten_http.py (Lane D, buffalo_l). The gallery itself is pure hub code in
memory/faces.py — backends only produce embeddings.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ...contracts.percepts import FaceObservation


class FaceBackend(ABC):
    @abstractmethod
    async def embed_faces(self, jpeg: bytes, wh: tuple[int, int]) -> list[FaceObservation]: ...
