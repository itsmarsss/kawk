"""World-model contracts (AGENTS.md §8). FROZEN after m0."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

from .percepts import Box


class PersonAttrs(BaseModel):
    person_id: str | None = None
    name: str | None = None
    sim: float = 0.0
    stable_votes: int = 0


class Entity(BaseModel):
    track_id: str
    label: str
    attributes: dict[str, str] = Field(default_factory=dict)  # derived per §8, box-geometry only
    box_xyxy: Box
    frame_wh: tuple[int, int]
    score: float
    first_seen: float
    last_seen: float
    keyframe_ref: str | None = None  # handlers must tolerate None (§9)
    person: PersonAttrs | None = None  # set only for label == "person"


class LastSeen(BaseModel):
    label: str
    ts: float  # wall epoch — track end time
    keyframe_ref: str | None = None
    context_labels: list[str] = Field(default_factory=list)


class DeltaKind(StrEnum):
    APPEARED = "appeared"
    DISAPPEARED = "disappeared"
    IDENTITY_CHANGED = "identity_changed"
    LAST_SEEN_WRITTEN = "last_seen_written"


class WorldDelta(BaseModel):
    kind: DeltaKind
    entity_id: str
    label: str | None = None
