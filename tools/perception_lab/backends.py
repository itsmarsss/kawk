"""Backend selection for the R&D lab; imports and model loading stay lazy."""
from __future__ import annotations

import os
from pathlib import Path

from .speech import MODEL_ID, read_key


def model_directory():
    return Path(os.getenv("REMEMBER_MODEL_DIR", "data/models")).resolve()


def selection(value, default):
    name = value or default
    if name not in ("local", "baseten"):
        raise ValueError("Backend must be local or baseten")
    return name


def configured_backends(face_ready=False, face_error=None):
    root = model_directory()
    face_root = Path(os.getenv("REMEMBER_FACE_MODEL_ROOT", "data"))
    try:
        cloud_key = bool(read_key())
    except RuntimeError:
        cloud_key = False

    def local(ready, model):
        return {"configured": bool(ready), "detail": model if ready else f"{model}: run make fetch-local-models first"}

    def cloud(env_name, model, default=""):
        model_id = os.getenv(env_name, default)
        return {"configured": bool(cloud_key and model_id),
                "detail": f"{model} · {model_id} · may wake from zero; first Start can time out, then retry once warm" if cloud_key and model_id
                else f"{model}: configure {env_name} and the h100-permanent profile",
                "model_id": model_id}

    faces = face_ready or all((face_root / "models/buffalo_l" / file).is_file()
                             for file in ("det_10g.onnx", "w600k_r50.onnx"))
    face_local = local(faces, "buffalo_l · " + os.getenv("REMEMBER_FACE_PROVIDER", "CoreMLExecutionProvider"))
    if face_error:
        face_local = {"configured": False, "detail": face_error}
    return {
        "face": {"local": face_local, "baseten": cloud("BASETEN_FACE_MODEL_ID", "buffalo_l")},
        "speech": {"local": local((root / "faster-whisper-small/model.bin").is_file()
                                     and (root / "silero_vad.onnx").is_file(), "Whisper Small · int8 CPU"),
                   "baseten": cloud("BASETEN_STT_MODEL_ID", "Whisper Large v3 streaming", MODEL_ID)},
        "objects": {"local": local((root / "yolov8s-worldv2.pt").is_file()
                                      and (root / "clip/ViT-B-32.pt").is_file(), "YOLO-World · " + os.getenv("REMEMBER_YOLO_DEVICE", "cpu")),
                    "baseten": cloud("BASETEN_SAM_MODEL_ID", "SAM 3.1 · windowed, IDs reset" if os.getenv("REMEMBER_SAM_ALLOW_WINDOWED") == "1" else "SAM 3.1 Multiplex")},
    }


def cloud_model_id(service):
    name = f"BASETEN_{service.upper()}_MODEL_ID"
    value = os.getenv(name, MODEL_ID if service == "stt" else "")
    if not value:
        raise RuntimeError(f"Configure {name} on the Mac server before starting this cloud test")
    return value


def object_backend(name):
    if name == "local":
        from remember_hub.perception.sam.local_yolo import LocalYoloBackend
        return LocalYoloBackend(model_path=str(model_directory() / "yolov8s-worldv2.pt"),
                                device=os.getenv("REMEMBER_YOLO_DEVICE", "cpu"))
    from remember_hub.perception.sam.baseten_ws import BasetenSamBackend
    return BasetenSamBackend(model_id=cloud_model_id("sam"), api_key=read_key(),
                             allow_windowed=os.getenv("REMEMBER_SAM_ALLOW_WINDOWED") == "1",
                             response_timeout_s=10 if os.getenv("REMEMBER_SAM_ALLOW_WINDOWED") == "1" else 1)


def cloud_face_backend():
    from remember_hub.perception.face.baseten_http import BasetenFaceBackend
    return BasetenFaceBackend(model_id=cloud_model_id("face"), api_key=read_key(), timeout_s=4)


def local_speech_backend():
    from remember_hub.perception.stt.local_whisper import LocalWhisperBackend
    root = model_directory()
    return LocalWhisperBackend(model_path=str(root / "faster-whisper-small"),
                              vad_model_path=str(root / "silero_vad.onnx"))


def jpeg_dimensions(jpeg, max_side):
    import cv2
    import numpy as np
    frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None or max(frame.shape[:2]) > max_side:
        raise ValueError(f"Send a valid JPEG with longest side at most {max_side} pixels")
    return (int(frame.shape[1]), int(frame.shape[0]))
