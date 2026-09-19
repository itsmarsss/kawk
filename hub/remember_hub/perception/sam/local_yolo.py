"""YOLO-World open-vocabulary detection with bounded same-label IoU tracking."""
from __future__ import annotations

import asyncio
import gc
import os
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from remember_hub.contracts.percepts import Detection, Dimensions


def _vocabulary(words: list[str]) -> list[str]:
    words = list(dict.fromkeys(word.strip() for word in words))
    if not words or len(words) > 20 or any(not 1 <= len(word.split()) <= 3 for word in words):
        raise ValueError("YOLO-World needs 1–20 unique concepts of 1–3 words")
    return words


def _iou(a, b) -> float:
    overlap = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - overlap
    return overlap / area if area > 0 else 0


class _WorldEngine:
    def __init__(self, model_path: Path, device: str):
        if not model_path.is_file():
            raise FileNotFoundError(f"Missing {model_path}; run: make fetch-local-models")
        os.environ.setdefault("YOLO_AUTOINSTALL", "false")
        try:
            import clip  # noqa: F401 -- fail before Ultralytics can auto-install it
            import cv2
            from ultralytics import YOLOWorld
        except ImportError as exc:
            raise RuntimeError("YOLO-World requires: uv sync --extra local --extra sim") from exc
        self.cv2, self.device = cv2, device
        self.model = YOLOWorld(str(model_path))
        self.clip_path = model_path.parent / "clip" / "ViT-B-32.pt"

    def set_classes(self, vocabulary: list[str]) -> None:
        # Preload the CLIP tower from a verified local path. The normal Ultralytics
        # set_classes() helper otherwise downloads missing CLIP weights at runtime.
        if not self.clip_path.is_file():
            raise FileNotFoundError(f"Missing {self.clip_path}; run: make fetch-local-models")
        import torch
        from ultralytics.nn.tasks import WorldModel
        from ultralytics.nn.text_model import CLIP
        core = self.model.model
        if not isinstance(core, WorldModel):
            raise RuntimeError("Expected a YOLO-World checkpoint, not another YOLO architecture")
        if not getattr(core, "clip_model", None):
            core.clip_model = CLIP(str(self.clip_path), torch.device("cpu"))
        self.model.set_classes(vocabulary)

    def infer(self, jpeg: bytes, wh: Dimensions, confidence: float):
        image = self.cv2.imdecode(np.frombuffer(jpeg, np.uint8), self.cv2.IMREAD_COLOR)
        if image is None or (image.shape[1], image.shape[0]) != tuple(wh):
            raise ValueError("JPEG dimensions must match the SENT wh")
        import torch
        from ultralytics.engine.results import Results
        results = self.model.predict(image, conf=confidence, device=self.device, verbose=False,
                                     imgsz=640, max_det=64, stream=False)
        if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], Results):
            raise RuntimeError("YOLO-World returned an unexpected single-image result")
        result = results[0]
        if result.boxes is None:
            return []
        def as_numpy(value):
            # Ultralytics Results supports both tensor-backed and NumPy-backed boxes.
            return np.asarray(value.cpu().numpy() if isinstance(value, torch.Tensor) else value)
        boxes = as_numpy(result.boxes.xyxy)
        scores = as_numpy(result.boxes.conf)
        labels = as_numpy(result.boxes.cls)
        return [(result.names[int(label)], box.tolist(), float(score))
                for box, score, label in zip(boxes, scores, labels, strict=True)]


class LocalYoloBackend:
    def __init__(self, model_path: str | Path = "data/models/yolov8s-worldv2.pt", *,
                 device: str = "cpu", confidence: float = .25, engine: Any = None):
        if not 0 <= confidence <= 1:
            raise ValueError("confidence must be in [0, 1]")
        self.model_path, self.device, self.confidence = Path(model_path), device, confidence
        self._engine = engine
        self._lock = asyncio.Lock()
        self._vocab: list[str] = []
        self._tracks: dict[str, tuple[str, list[float], float]] = {}
        self._namespace = ""
        self._next_id = 0
        self.load_ms: float | None = None
        self.last_timings_ms: dict[str, float] = {}

    async def _work(self, function, *args):
        task = asyncio.create_task(asyncio.to_thread(function, *args))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

    def _load(self, vocabulary: list[str]):
        started = time.perf_counter()
        if self._engine is None:
            self._engine = _WorldEngine(self.model_path, self.device)
        self._engine.set_classes(vocabulary)
        self.load_ms = (time.perf_counter() - started) * 1000

    async def start_session(self, vocabulary: list[str]) -> None:
        vocabulary = _vocabulary(vocabulary)
        async with self._lock:
            await self._work(self._load, vocabulary)
            self._vocab = vocabulary
            self._namespace, self._next_id = uuid.uuid4().hex[:12], 0
            self._tracks.clear()

    async def add_concept(self, noun: str) -> None:
        async with self._lock:
            if not self._vocab:
                raise RuntimeError("Call start_session before add_concept")
            vocabulary = _vocabulary(self._vocab + [noun])
            await self._work(self._engine.set_classes, vocabulary)
            self._vocab = vocabulary

    async def push_frame(self, frame_id: str, jpeg: bytes, wh: Dimensions) -> list[Detection]:
        if not self._vocab:
            raise RuntimeError("Call start_session before push_frame")
        if not jpeg or len(jpeg) > 8_000_000 or min(wh) <= 0 or max(wh) > 4096:
            raise ValueError("Invalid JPEG or SENT dimensions")
        if self._lock.locked():
            return []
        async with self._lock:
            captured = time.monotonic()
            started = time.perf_counter()
            rows = await self._work(self._engine.infer, jpeg, wh, self.confidence)
            self.last_timings_ms = {"total": (time.perf_counter() - started) * 1000}
            now = time.monotonic()
            # Age by arrival time, not inference completion: a slow first prediction
            # must not discard a track before its own next frame is processed.
            self._tracks = {key: value for key, value in self._tracks.items() if captured-value[2] <= 2}
            available = set(self._tracks)
            detections = []
            for label, box, score in sorted(rows, key=lambda row: row[2], reverse=True)[:64]:
                if label not in self._vocab or score < self.confidence:
                    continue
                box = [max(0.0, min(float(v), float(wh[i % 2]))) for i, v in enumerate(box)]
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                # Same-frame duplicates would otherwise get separate stable IDs.
                if any(d.label == label and _iou(d.box_xyxy, box) > .7 for d in detections):
                    continue
                candidates = [(key, _iou(value[1], box)) for key, value in self._tracks.items()
                              if key in available and value[0] == label]
                best = max(candidates, key=lambda item: item[1], default=("", 0))
                if best[1] >= .3:
                    track_id = best[0]
                    available.remove(track_id)
                else:
                    track_id = f"yolo-{self._namespace}-{self._next_id}"
                    self._next_id += 1
                self._tracks[track_id] = (label, box, now)
                detections.append(Detection(track_id=track_id, label=label, box_xyxy=(box[0], box[1], box[2], box[3]),
                                            score=score, frame_id=frame_id, wh=wh,
                                            t_captured=captured, t_percept=now))
            if len(self._tracks) > 128:
                self._tracks = dict(sorted(self._tracks.items(), key=lambda item: item[1][2], reverse=True)[:128])
            return detections

    async def end_session(self) -> None:
        async with self._lock:
            self._vocab.clear()
            self._tracks.clear()

    async def close(self) -> None:
        await self.end_session()
        async with self._lock:
            def release():
                self._engine = None
                gc.collect()
            await self._work(release)
