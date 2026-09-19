"""SAM object-perception interface (AGENTS.md §6.1). FROZEN after m0.

Backends: mock.py (Lane A) · local_yolo.py (Lane C) · baseten_ws.py (Lane D).
Boxes are absolute in the SENT resolution — consumers divide by frame_wh.
Masks are never returned; the hub only needs boxes + labels + stable track IDs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ...contracts.percepts import Detection


class SamBackend(ABC):
    @abstractmethod
    async def start_session(self, vocabulary: list[str]) -> None: ...

    @abstractmethod
    async def push_frame(
        self, frame_id: str, jpeg: bytes, wh: tuple[int, int]
    ) -> list[Detection]: ...

    @abstractmethod
    async def add_concept(self, noun: str) -> None: ...

    @abstractmethod
    async def end_session(self) -> None: ...
