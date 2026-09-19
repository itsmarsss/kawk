"""Instrumented buffalo_l detection + ArcFace; no identity enrollment."""

import json
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from insightface.app import FaceAnalysis
from insightface.utils import face_align


class FaceEngine:
    def __init__(self, root, provider, detector_size=640, profile=False):
        for name in ("det_10g.onnx", "w600k_r50.onnx"):
            if not (Path(root) / "models/buffalo_l" / name).is_file():
                raise RuntimeError(
                    "Bundle verified buffalo_l weights before deployment; no startup download"
                )
        cv2.setNumThreads(1)
        started = time.perf_counter()
        self.app = FaceAnalysis(
            name="buffalo_l",
            root=str(root),
            allowed_modules=["detection", "recognition"],
            providers=[provider],
        )
        # InsightFace 0.7.3's public factory drops sess_options. Default ORT
        # threading is used for the timed runs. Explicitly rebuild sessions only
        # for the separate, untimed operator-placement audit.
        if profile:
            directory = Path(root).resolve().parent / "profiles"
            directory.mkdir(exist_ok=True)
            for name, model in self.app.models.items():
                opts = ort.SessionOptions()
                opts.enable_profiling = True
                opts.profile_file_prefix = str(directory / name)
                model.session = ort.InferenceSession(
                    model.model_file, sess_options=opts, providers=[provider]
                )
        self.app.prepare(
            ctx_id=-1 if provider == "CPUExecutionProvider" else 0,
            det_size=(detector_size, detector_size),
            det_thresh=0.5,
        )
        self.providers = {k: v.session.get_providers() for k, v in self.app.models.items()}
        if any(v[0] != provider for v in self.providers.values()):
            raise RuntimeError(f"Requested {provider}, got {self.providers}")
        self.load_ms = (time.perf_counter() - started) * 1000
        self.detector_size = detector_size

    def infer(self, jpg, min_face_size=80):
        start = time.perf_counter()
        image = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Invalid JPEG")
        decoded = time.perf_counter()
        if max(image.shape[:2]) > 640:
            raise ValueError("Benchmark expects inputs with longest side <=640")
        bboxes, keypoints = self.app.det_model.detect(image, max_num=0, metric="default")
        detected = time.perf_counter()
        alignment_ms = embedding_ms = normalize_ms = 0.0
        faces = []
        for bbox, kps in zip(bboxes, keypoints if keypoints is not None else []):
            if min(bbox[2] - bbox[0], bbox[3] - bbox[1]) < min_face_size:
                continue
            t0 = time.perf_counter()
            aligned = face_align.norm_crop(image, landmark=kps, image_size=112)
            t1 = time.perf_counter()
            embedding = self.app.models["recognition"].get_feat(aligned).reshape(-1)
            t2 = time.perf_counter()
            embedding = embedding / np.linalg.norm(embedding)
            t3 = time.perf_counter()
            alignment_ms += (t1 - t0) * 1000
            embedding_ms += (t2 - t1) * 1000
            normalize_ms += (t3 - t2) * 1000
            faces.append(
                {
                    "box": bbox[:4].tolist(),
                    "det_score": float(bbox[4]),
                    "embedding_512": embedding.tolist(),
                }
            )
        end = time.perf_counter()
        return {
            "faces": faces,
            "detected_count": len(bboxes),
            "accepted_count": len(faces),
            "input_wh": [image.shape[1], image.shape[0]],
            "providers": self.providers,
            "model": "buffalo_l",
            "detector_size": self.detector_size,
            "timings_ms": {
                "jpeg_decode": (decoded - start) * 1000,
                "detect_including_pre_post": (detected - decoded) * 1000,
                "align_total": alignment_ms,
                "embedding_total": embedding_ms,
                "normalize_total": normalize_ms,
                "pipeline_total": (end - start) * 1000,
            },
        }

    def finish_profile(self):
        counts = {}
        for name, model in self.app.models.items():
            path = model.session.end_profiling()
            if not path:
                continue
            events = json.load(open(path))
            providers = {}
            for event in events:
                p = event.get("args", {}).get("provider")
                if p:
                    providers[p] = providers.get(p, 0) + 1
            counts[name] = providers
        return counts
