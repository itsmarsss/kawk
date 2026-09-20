"""Non-secret reproduction metadata for opt-in component measurements."""
from __future__ import annotations

import importlib.metadata
import platform
import subprocess
from pathlib import Path

from remember_hub.config import load_settings


def _command(*arguments: str) -> str | None:
    try:
        return subprocess.check_output(arguments, text=True, stderr=subprocess.DEVNULL,
                                       timeout=3).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def component_metadata(args) -> dict:
    settings = load_settings(args.config)
    versions = {}
    for package in ("numpy", "onnxruntime", "ultralytics", "faster-whisper", "websockets"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    repository = str(Path(__file__).resolve().parents[2])
    dirty = _command("git", "-C", repository, "status", "--porcelain")
    chip = (_command("/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string")
            if platform.system() == "Darwin" else platform.processor())
    configurations = {
        "face": {"model": settings.face.model, "local_provider": settings.face.provider,
                 "min_face_size": settings.face.min_face_size},
        "objects": {"local_model": "YOLO-World small", "cloud_model": "SAM 3.1",
                    "vocabulary": settings.sam.vocabulary},
        "speech": {"local_model": settings.stt.model, "cloud_model": "Whisper Large v3 Streaming",
                   "sample_rate": settings.stt.sample_rate, "chunk_samples": settings.stt.chunk_samples},
    }
    return {
        "schema_version": "1.0", "mode": "model_replay", "real_model_inference": True,
        "pipeline_revision": _command("git", "-C", repository, "rev-parse", "HEAD"),
        "working_tree_dirty": dirty is not None and bool(dirty),
        "host_hardware": {"chip": chip, "machine": platform.machine(), "platform": platform.platform()},
        "runtime": {"python": platform.python_version(), "packages": versions},
        "configuration": configurations[args.component],
        "requested_backends": args.backends, "warm_runs_per_backend": args.runs,
        "cloud_hardware": None,
        "limitations": ["Cloud hardware must be verified separately for the measured endpoint.",
                        "Model names are configuration labels, not weight hashes or correctness scores.",
                        "Local and cloud models differ for objects and speech."],
    }
