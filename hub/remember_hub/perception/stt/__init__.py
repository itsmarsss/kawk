"""Factory for STT backends — lazy imports keep core deps clean (AGENTS.md §11)."""

from __future__ import annotations

from ...config import SttCfg
from .base import SttBackend


def create_stt_backend(cfg: SttCfg) -> SttBackend:
    if cfg.backend == "mock":
        from .mock import MockStt

        return MockStt()
    if cfg.backend == "local":
        try:
            from .local_whisper import (
                LocalWhisper,  # Lane C  # pyright: ignore[reportMissingImports]
            )
        except ImportError as e:
            raise SystemExit(
                f"stt backend 'local' unavailable ({e}). Run: uv sync --extra local "
                "(and ensure Lane C's local_whisper.py is merged)."
            ) from e
        return LocalWhisper(cfg)
    if cfg.backend == "baseten":
        try:
            from .baseten_ws import BasetenStt  # Lane D  # pyright: ignore[reportMissingImports]
        except ImportError as e:
            raise SystemExit(
                f"stt backend 'baseten' unavailable ({e}). Ensure Lane D's baseten_ws.py "
                "is merged and BASETEN_* env vars are set."
            ) from e
        return BasetenStt(cfg)
    raise SystemExit(f"unknown stt backend: {cfg.backend!r}")
