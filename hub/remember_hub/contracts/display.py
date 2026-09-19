"""Display contracts (AGENTS.md §9). FROZEN after m0."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel

# Priorities: answer/alert > enroll > profile > idle (§9)
PRIO_ANSWER = 30
PRIO_ALERT = 30
PRIO_ENROLL = 25
PRIO_PROFILE = 10
PRIO_IDLE = 0


class CardTemplate(StrEnum):
    PROFILE = "profile"
    ANSWER = "answer"
    ALERT = "alert"
    ENROLL_PROMPT = "enroll_prompt"
    IDLE = "idle"


class Card(BaseModel):
    template: CardTemplate
    title: str = ""
    body: str = ""
    image_ref: int | None = None  # seq of the paired 0x10 blit; None = text-only
    ttl_ms: int = 8000


class RasterBlit(BaseModel):
    seq: int
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0
    fmt: Literal["jpeg", "rgb565"] = "jpeg"
    data: bytes = b""


class DisplayAction(BaseModel):
    card: Card | None = None
    blit: RasterBlit | None = None
    ttl_ms: int = 8000
    priority: int = 0
    t_created: float = 0.0
