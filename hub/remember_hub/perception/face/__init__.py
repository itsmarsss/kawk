"""Factory for face backends — lazy imports keep core deps clean (AGENTS.md §11)."""

from __future__ import annotations

from ...config import FaceCfg
from .base import FaceBackend


def create_face_backend(cfg: FaceCfg) -> FaceBackend:
    if cfg.backend == "mock":
        from .mock import MockFace

        return MockFace()
    if cfg.backend == "local":
        try:
            from .local_insight import (  # Lane C  # pyright: ignore[reportMissingImports]
                LocalInsightFace,
            )
        except ImportError as e:
            raise SystemExit(
                f"face backend 'local' unavailable ({e}). Run: uv sync --extra local "
                "(and ensure Lane C's local_insight.py is merged)."
            ) from e
        return LocalInsightFace(cfg)
    if cfg.backend == "baseten":
        try:
            from .baseten_http import BasetenFace  # Lane D  # pyright: ignore[reportMissingImports]
        except ImportError as e:
            raise SystemExit(
                f"face backend 'baseten' unavailable ({e}). Ensure Lane D's baseten_http.py "
                "is merged and BASETEN_* env vars are set."
            ) from e
        return BasetenFace(cfg)
    raise SystemExit(f"unknown face backend: {cfg.backend!r}")
