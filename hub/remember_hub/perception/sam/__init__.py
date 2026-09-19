"""Factory for SAM backends — lazy imports keep core deps clean (AGENTS.md §11)."""

from __future__ import annotations

from ...config import SamCfg
from .base import SamBackend


def create_sam_backend(cfg: SamCfg) -> SamBackend:
    if cfg.backend == "mock":
        from .mock import MockSam

        return MockSam()
    if cfg.backend == "local":
        try:
            from .local_yolo import LocalYoloSam  # Lane C
        except ImportError as e:
            raise SystemExit(
                f"sam backend 'local' unavailable ({e}). Run: uv sync --extra local "
                "(and ensure Lane C's local_yolo.py is merged)."
            ) from e
        return LocalYoloSam(cfg)
    if cfg.backend == "baseten":
        try:
            from .baseten_ws import BasetenSam  # Lane D
        except ImportError as e:
            raise SystemExit(
                f"sam backend 'baseten' unavailable ({e}). Ensure Lane D's baseten_ws.py "
                "is merged and BASETEN_* env vars are set."
            ) from e
        return BasetenSam(cfg)
    raise SystemExit(f"unknown sam backend: {cfg.backend!r}")
