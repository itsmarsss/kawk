"""Local SCRFD + ArcFace using only the buffalo_l detection/recognition models."""
from __future__ import annotations

import asyncio
import gc
import os
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol, cast

import numpy as np

from remember_hub.contracts.percepts import Dimensions, FaceObservation


class _OrtSession(Protocol):
    def get_providers(self) -> Sequence[str]: ...


class _Detector(Protocol):
    session: _OrtSession
    def prepare(self, *, ctx_id: int, input_size: tuple[int, int], det_thresh: float) -> None: ...
    def detect(self, image: Any, *, max_num: int, metric: str) -> tuple[Any, Any]: ...


class _Recognizer(Protocol):
    session: _OrtSession
    def prepare(self, *, ctx_id: int) -> None: ...
    def get_feat(self, aligned: Any) -> Any: ...


class _InsightEngine:
    def __init__(self, model_root: Path, provider: str):
        files = [model_root / "buffalo_l" / name for name in ("det_10g.onnx", "w600k_r50.onnx")]
        for path in files:
            if not path.is_file():
                raise FileNotFoundError(f"Missing {path}; run: make fetch-local-models")
        os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")
        try:
            import cv2
            import onnxruntime as ort
            from insightface.model_zoo import get_model
            from insightface.utils import face_align
        except ImportError as exc:
            raise RuntimeError("InsightFace requires: uv sync --extra local --extra sim") from exc
        if provider not in ort.get_available_providers():
            raise RuntimeError(f"Requested {provider}; available: {ort.get_available_providers()}")
        cv2.setNumThreads(1)
        self.cv2, self.face_align = cv2, face_align
        detector = get_model(str(files[0]), providers=[provider])
        recognizer = get_model(str(files[1]), providers=[provider])
        # InsightFace's dynamic factory also returns landmarks, swap models or None.
        # Validate the two selected ONNX tasks before narrowing the SDK boundary.
        if (detector is None or getattr(detector, "taskname", None) != "detection"
                or getattr(detector, "session", None) is None):
            raise RuntimeError("det_10g.onnx did not load as a face detector")
        if (recognizer is None or getattr(recognizer, "taskname", None) != "recognition"
                or getattr(recognizer, "session", None) is None):
            raise RuntimeError("w600k_r50.onnx did not load as an ArcFace recognizer")
        self.detector = cast(_Detector, detector)
        self.recognizer = cast(_Recognizer, recognizer)
        ctx_id = -1 if provider == "CPUExecutionProvider" else 0
        self.detector.prepare(ctx_id=ctx_id, input_size=(640, 640), det_thresh=.5)
        self.recognizer.prepare(ctx_id=ctx_id)
        self.providers = {"detection": list(self.detector.session.get_providers()),
                          "recognition": list(self.recognizer.session.get_providers())}
        if any(providers[0] != provider for providers in self.providers.values()):
            raise RuntimeError(f"Provider initialization fell back: {self.providers}")

    def infer(self, jpeg: bytes, wh: Dimensions, min_face_size: int, threshold: float):
        start = time.perf_counter()
        image = self.cv2.imdecode(np.frombuffer(jpeg, np.uint8), self.cv2.IMREAD_COLOR)
        if image is None or (image.shape[1], image.shape[0]) != tuple(wh):
            raise ValueError("JPEG dimensions must match the SENT wh")
        if max(wh) > 640:
            raise ValueError("Face input must be resized to at most 640 px before sending")
        decoded = time.perf_counter()
        boxes, landmarks = self.detector.detect(image, max_num=0, metric="default")
        detected = time.perf_counter()
        faces = []
        for i, box in enumerate(boxes):
            if box[4] < threshold or min(box[2] - box[0], box[3] - box[1]) < min_face_size:
                continue
            if landmarks is None:
                continue
            aligned = self.face_align.norm_crop(image, landmark=landmarks[i], image_size=112)
            vector = np.asarray(self.recognizer.get_feat(aligned), dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(vector))
            if vector.size != 512 or not np.isfinite(vector).all() or norm <= 0:
                raise RuntimeError("buffalo_l returned an invalid embedding")
            faces.append((box[:4].tolist(), float(box[4]), (vector / norm).tolist()))
        end = time.perf_counter()
        return faces, {"decode": (decoded-start)*1000, "detection": (detected-decoded)*1000,
                       "embedding": (end-detected)*1000, "total": (end-start)*1000}


class LocalInsightFaceBackend:
    def __init__(self, model_root: str | Path = "data/models", *,
                 provider: str = "CPUExecutionProvider", min_face_size: int = 80,
                 det_threshold: float = .5, engine: Any = None):
        if min_face_size < 1 or not 0 <= det_threshold <= 1:
            raise ValueError("Invalid face filtering configuration")
        self.model_root = Path(model_root)
        self.provider = provider
        self.min_face_size = min_face_size
        self.det_threshold = det_threshold
        self._engine = engine
        self._lock = asyncio.Lock()
        self.load_ms: float | None = None
        self.last_timings_ms: dict[str, float] = {}
        self.providers: dict[str, list[str]] = {}

    def _load_engine(self):
        if self._engine is None:
            started = time.perf_counter()
            self._engine = _InsightEngine(self.model_root, self.provider)
            self.load_ms = (time.perf_counter() - started) * 1000
            self.providers = self._engine.providers

    async def load(self) -> None:
        async with self._lock:
            task = asyncio.create_task(asyncio.to_thread(self._load_engine))
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                await task
                raise

    def _infer(self, jpeg: bytes, wh: Dimensions):
        self._load_engine()
        return self._engine.infer(jpeg, wh, self.min_face_size, self.det_threshold)

    async def close(self) -> None:
        async with self._lock:
            def release():
                self._engine = None
                gc.collect()
            await asyncio.to_thread(release)

    async def embed_faces(self, jpeg: bytes, wh: Dimensions) -> list[FaceObservation]:
        if not jpeg or len(jpeg) > 8_000_000 or min(wh) <= 0 or max(wh) > 640:
            raise ValueError("Expected JPEG <=8 MB with positive SENT dimensions <=640 px")
        if self._lock.locked():
            return []  # newest-frame caller must retry; never build an inference backlog
        async with self._lock:
            captured = time.monotonic()
            task = asyncio.create_task(asyncio.to_thread(self._infer, jpeg, wh))
            try:
                rows, timings = await asyncio.shield(task)
            except asyncio.CancelledError:
                await task  # protect the shared ORT session until its native call completes
                raise
            self.last_timings_ms = timings
            now = time.monotonic()
            return [FaceObservation(box=(float(box[0]), float(box[1]), float(box[2]), float(box[3])), det_score=score, embedding_512=vector,
                                    wh=wh, t_captured=captured, t_percept=now)
                    for box, score, vector in rows]
