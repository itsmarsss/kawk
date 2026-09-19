"""Percept contracts — what perception backends emit (AGENTS.md §6). FROZEN after m0."""

from __future__ import annotations

from pydantic import BaseModel, Field

Box = tuple[float, float, float, float]  # x1, y1, x2, y2 — absolute in SENT resolution


class Detection(BaseModel):
    track_id: str
    label: str
    box_xyxy: Box
    score: float
    frame_wh: tuple[int, int]  # resolution the frame was sent at; boxes are in this space
    t_percept: float = 0.0  # wall epoch seconds, stamped hub-side


class FaceObservation(BaseModel):
    box_xyxy: Box
    det_score: float
    embedding: list[float]  # 512-d, L2-normalized (dot == cosine)
    model_tag: str  # "buffalo_l" | "mock" — gallery hard-fails on mismatch (§6.2)
    frame_wh: tuple[int, int] = (1, 1)
    track_id: str | None = None  # person track this face belongs to (mock provides; live=IoU)
    t_percept: float = 0.0


class Word(BaseModel):
    w: str
    t0: float
    t1: float


class TranscriptSegment(BaseModel):
    seg_id: str
    text: str
    is_final: bool
    words: list[Word] = Field(default_factory=list)
    t_start_hub: float = 0.0
    speaker: str = "user"


class AudioState(BaseModel):
    speech_active: bool
    level_db: float = -60.0
