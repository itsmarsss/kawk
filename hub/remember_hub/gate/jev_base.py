"""Jev gate interface (AGENTS.md §7). FROZEN after m0.

Backends: jev_mock.py (Lane A) · jev_typesafe.py (Lane D — the ONE file allowed
to import the vendor SDK). The full question bank goes out in ONE call per tick.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..contracts.decisions import Answer, Question


class JevBackend(ABC):
    @abstractmethod
    async def ask(self, state: str, questions: list[Question]) -> dict[str, Answer]: ...
