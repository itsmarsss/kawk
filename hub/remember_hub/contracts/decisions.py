"""Gate contracts (AGENTS.md §7). FROZEN after m0."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel


class Intent(StrEnum):
    NONE = "NONE"
    FIND_OBJECT = "FIND_OBJECT"
    IDENTIFY_PERSON = "IDENTIFY_PERSON"
    ENROLL_PERSON = "ENROLL_PERSON"
    REMEMBER_NOTE = "REMEMBER_NOTE"
    RECALL_NOTE = "RECALL_NOTE"
    CLEAR_DISPLAY = "CLEAR_DISPLAY"


class GateResult(BaseModel):
    intent: Intent
    source_question: str
    target_label: str | None = None
    person_track: str | None = None
    confidence: float = 0.0


class Question(BaseModel):
    """One entry of the question bank; the full bank goes to Jev in ONE call (§7)."""

    key: str
    kind: Literal["noul", "choice", "score"]
    instructions: str
    intent: Intent | None = None  # ambient Nouls route through this — the gate->task wiring
    choices: list[str] | None = None  # resolved per tick for dynamic questions
    fire_threshold: float = 0.65
    debounce_ticks: int = 1


class Answer(BaseModel):
    noul: float | None = None
    choice: str | None = None
    probabilities: dict[str, float] | None = None
    score: float | None = None
