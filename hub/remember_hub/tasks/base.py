"""Task handler protocol (AGENTS.md §9). Handlers read world/memory and RETURN
display actions — no side channels (the enroll manager's async completion is the
one specced exception; it publishes on display.action like the router does)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from ..bus import EventBus
from ..contracts.decisions import GateResult, Intent
from ..memory.faces import FaceGallery
from ..memory.store import MemoryStore
from ..world.model import WorldModel


@dataclass
class TaskContext:
    world: WorldModel
    memory: MemoryStore
    gallery: FaceGallery
    gate_result: GateResult
    bus: EventBus
    device_id: str | None = None


@runtime_checkable
class TaskHandler(Protocol):
    intent: Intent

    async def run(self, ctx: TaskContext) -> object | None:  # -> DisplayAction | None
        ...


def format_ago(seconds: float) -> str:
    if seconds < 60:
        return f"{max(1, int(seconds))} s ago"
    if seconds < 3600:
        return f"{int(seconds // 60)} min ago"
    return f"{int(seconds // 3600)} h ago"
