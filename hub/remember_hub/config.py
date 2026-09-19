"""Read non-secret model settings; selecting a backend does not import its runtime."""
from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SamSettings(Settings):
    backend: Literal["mock", "local", "baseten"] = "mock"
    vocabulary: list[str] = Field(default_factory=lambda: ["person", "keys", "phone"], min_length=1, max_length=20)
    model_path: str = "data/models/yolov8s-worldv2.pt"
    device: str = "cpu"
    allow_windowed: bool = False


class FaceSettings(Settings):
    backend: Literal["mock", "local", "baseten"] = "mock"
    model: Literal["buffalo_l"] = "buffalo_l"
    model_root: str = "data/models"
    provider: str = "CoreMLExecutionProvider"
    threshold: float = Field(default=.4, ge=0, le=1)
    min_face_size: int = Field(default=80, ge=1)
    max_fps: float = Field(default=5, gt=0, le=5)


class SpeechSettings(Settings):
    backend: Literal["mock", "local", "baseten"] = "mock"
    model: str = "small"
    model_path: str = "data/models/faster-whisper-small"
    vad_model_path: str = "data/models/silero_vad.onnx"
    sample_rate: Literal[16000] = 16000
    chunk_samples: Literal[512] = 512


class JevSettings(Settings):
    backend: Literal["mock", "typesafe"] = "mock"
    model: str = "jev-1.13.0"


class BackendSettings(Settings):
    sam: SamSettings = Field(default_factory=SamSettings)
    face: FaceSettings = Field(default_factory=FaceSettings)
    stt: SpeechSettings = Field(default_factory=SpeechSettings)
    jev: JevSettings = Field(default_factory=JevSettings)


def load_settings(path: str | Path = "remember.toml") -> BackendSettings:
    path = Path(path).resolve()
    with path.open("rb") as file:
        settings = BackendSettings.model_validate(tomllib.load(file))
    for section, attr in ((settings.sam, "model_path"), (settings.face, "model_root"),
                          (settings.stt, "model_path"), (settings.stt, "vad_model_path")):
        value = Path(getattr(section, attr))
        if not value.is_absolute():
            setattr(section, attr, str(path.parent / value))
    return settings
