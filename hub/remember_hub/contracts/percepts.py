"""Perception outputs use absolute pixels in the SENT frame's resolution."""
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator

Box = tuple[float, float, float, float]
Dimensions = tuple[Annotated[int, Field(gt=0)], Annotated[int, Field(gt=0)]]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Detection(Contract):
    track_id: str
    label: str
    box_xyxy: Box
    score: float = Field(ge=0, le=1)
    frame_id: str = ""
    wh: Dimensions = (640, 480)
    t_captured: float = 0
    t_percept: float = 0

    @field_validator("box_xyxy")
    @classmethod
    def ordered_box(cls, value: Box) -> Box:
        import math
        if not all(math.isfinite(v) for v in value) or value[2] < value[0] or value[3] < value[1]:
            raise ValueError("Expected finite ordered xyxy coordinates")
        return value


class FaceObservation(Contract):
    box: Box
    det_score: float = Field(ge=0, le=1)
    embedding_512: list[float] = Field(min_length=512, max_length=512)
    model: str = "buffalo_l"
    person_track: str | None = None
    wh: Dimensions = (640, 480)
    t_captured: float = 0
    t_percept: float = 0

    @field_validator("embedding_512")
    @classmethod
    def normalized(cls, value: list[float]) -> list[float]:
        import math
        norm = math.sqrt(sum(v * v for v in value))
        if not all(math.isfinite(v) for v in value) or abs(norm - 1) > 0.01:
            raise ValueError("Face embeddings must be finite and L2-normalized")
        return value


class TranscriptWord(Contract):
    w: str
    t0: float = Field(ge=0)
    t1: float = Field(ge=0)
    probability: float | None = Field(default=None, ge=0, le=1)


class TranscriptSegment(Contract):
    seg_id: str
    text: str
    is_final: bool
    words: list[TranscriptWord] = Field(default_factory=list)
    t_start_hub: float = 0
    t_percept: float = 0


class AudioState(Contract):
    speech_active: bool
    level_db: float
    t_hub: float = 0
