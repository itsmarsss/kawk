"""Factories for the selected C/D backend; no model imports until requested."""
from __future__ import annotations

import os

from .config import BackendSettings
from .gate.jev_base import JevBackend
from .perception.face.base import FaceBackend
from .perception.sam.base import SamBackend
from .perception.stt.base import SttBackend


def required_environment(name: str) -> str:
    value = os.getenv(name, "")
    if not value:
        raise RuntimeError(f"Set {name} in the server environment for this backend")
    return value


def create_sam(settings: BackendSettings) -> SamBackend:
    config = settings.sam
    if config.backend == "mock":
        from .perception.fixture_backends import FixtureSamBackend
        return FixtureSamBackend()
    if config.backend == "local":
        from .perception.sam.local_yolo import LocalYoloBackend
        return LocalYoloBackend(model_path=config.model_path, device=config.device)
    key, model_id = required_environment("BASETEN_API_KEY"), required_environment("BASETEN_SAM_MODEL_ID")
    from .perception.sam.baseten_ws import BasetenSamBackend
    return BasetenSamBackend(model_id=model_id, api_key=key, allow_windowed=config.allow_windowed,
                             response_timeout_s=10 if config.allow_windowed else 1)


def create_face(settings: BackendSettings) -> FaceBackend:
    config = settings.face
    if config.backend == "mock":
        from .perception.fixture_backends import FixtureFaceBackend
        return FixtureFaceBackend()
    if config.backend == "local":
        from .perception.face.local_insight import LocalInsightFaceBackend
        return LocalInsightFaceBackend(model_root=config.model_root, provider=config.provider,
                                       min_face_size=config.min_face_size)
    key, model_id = required_environment("BASETEN_API_KEY"), required_environment("BASETEN_FACE_MODEL_ID")
    from .perception.face.baseten_http import BasetenFaceBackend
    return BasetenFaceBackend(model_id=model_id, api_key=key)


def create_stt(settings: BackendSettings) -> SttBackend:
    config = settings.stt
    if config.backend == "mock":
        from .perception.fixture_backends import FixtureSttBackend
        return FixtureSttBackend()
    if config.backend == "local":
        from .perception.stt.local_whisper import LocalWhisperBackend
        return LocalWhisperBackend(model_path=config.model_path, vad_model_path=config.vad_model_path)
    key, model_id = required_environment("BASETEN_API_KEY"), required_environment("BASETEN_STT_MODEL_ID")
    from .perception.stt.baseten_ws import BasetenWhisperBackend
    return BasetenWhisperBackend(model_id=model_id, api_key=key)


def create_jev(settings: BackendSettings) -> JevBackend:
    if settings.jev.backend == "mock":
        from .perception.fixture_backends import FixtureJevBackend
        return FixtureJevBackend()
    key = required_environment("TYPESAFE_API_KEY")
    from .gate.jev_typesafe import TypeSafeJevBackend
    return TypeSafeJevBackend(api_key=key, model=settings.jev.model)
