"""Exercise the deployable HTTP schema without importing OpenCV/ONNX/Torch."""

import base64
import importlib.util
from pathlib import Path

import pytest


def model():
    path = Path(__file__).resolve().parents[2] / "deployments/face/model/model.py"
    spec = importlib.util.spec_from_file_location("face_truss_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    service = module.Model(data_dir="unused")

    class Engine:
        def infer(self, jpeg, min_face_size):
            assert jpeg == b"image"
            assert min_face_size == 80
            return {
                "faces": [],
                "detected_count": 0,
                "accepted_count": 0,
                "model": "buffalo_l",
                "input_wh": [640, 480],
                "timings_ms": {},
            }

    service.engine = Engine()
    service.meta = {"providers": {"recognition": ["CUDAExecutionProvider"]}}
    return service


def test_existing_face_predict_payload_and_metadata():
    service = model()
    assert service.predict({"op": "metadata"})["providers"]
    result = service.predict({"image_b64": base64.b64encode(b"image").decode()})
    assert result["model"] == "buffalo_l"
    assert result["timings_ms"]["handler_total"] >= 0


def test_face_server_rejects_invalid_base64():
    with pytest.raises(ValueError):
        model().predict({"image_b64": "!!!"})
