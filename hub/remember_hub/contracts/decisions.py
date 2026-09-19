from enum import StrEnum
from typing import Literal

from pydantic import Field

from .percepts import Contract


class Intent(StrEnum):
    NONE = "NONE"
    FIND_OBJECT = "FIND_OBJECT"
    IDENTIFY_PERSON = "IDENTIFY_PERSON"
    ENROLL_PERSON = "ENROLL_PERSON"
    REMEMBER_NOTE = "REMEMBER_NOTE"
    RECALL_NOTE = "RECALL_NOTE"
    CLEAR_DISPLAY = "CLEAR_DISPLAY"


class GateQuestion(Contract):
    key: str
    kind: Literal["noul", "choice", "score"]
    instructions: str
    choices: list[str] = Field(default_factory=list)
    intent: Intent | None = None
    fire_threshold: float = Field(default=0.65, ge=0, le=1)
    debounce_ticks: int = Field(default=1, ge=1)


class GateAnswer(Contract):
    key: str
    kind: Literal["noul", "choice", "score"]
    probability: float | None = Field(default=None, ge=0, le=1)
    choice: str | None = None
    probabilities: dict[str, float] = Field(default_factory=dict)
    score: float | None = None


class GateResult(Contract):
    intent: Intent
    source_question: str
    target_label: str | None = None
    person_track: str | None = None
    confidence: float = Field(ge=0, le=1)
