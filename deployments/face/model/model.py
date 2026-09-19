import base64
import importlib.metadata
import json
import subprocess
import time


class Model:
    def __init__(self, **kwargs):
        self.data_dir = kwargs["data_dir"]

    def load(self):
        # Import Torch first so the image's CUDA/cuDNN shared libraries are loaded.
        import torch  # noqa: F401 - loads CUDA libraries before ONNX Runtime
        from model.engine import FaceEngine

        self.engine = FaceEngine(self.data_dir, "CUDAExecutionProvider")
        self.meta = {
            "providers": self.engine.providers,
            "load_ms": self.engine.load_ms,
            "gpu": subprocess.check_output(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], text=True
            ).strip(),
            "versions": {
                k: importlib.metadata.version(k)
                for k in ["insightface", "onnxruntime-gpu", "numpy"]
            },
        }
        print("FACE_READY " + json.dumps(self.meta), flush=True)

    def predict(self, request):
        if request.get("op") == "metadata":
            return self.meta
        start = time.perf_counter()
        jpg = base64.b64decode(request["image_b64"], validate=True)
        decoded = time.perf_counter()
        result = self.engine.infer(jpg, min_face_size=int(request.get("min_face_size", 80)))
        result["timings_ms"]["base64_decode"] = (decoded - start) * 1000
        result["timings_ms"]["handler_total"] = (time.perf_counter() - start) * 1000
        return result
