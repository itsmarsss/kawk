"""Factory for the Jev gate backend."""

from __future__ import annotations

from ..config import JevCfg
from .jev_base import JevBackend


def create_jev_backend(cfg: JevCfg) -> JevBackend:
    if cfg.backend == "mock":
        from .jev_mock import JevMock

        return JevMock()
    if cfg.backend == "typesafe":
        try:
            from .jev_typesafe import JevTypeSafe  # Lane D  # pyright: ignore[reportMissingImports]
        except ImportError as e:
            raise SystemExit(
                f"jev backend 'typesafe' unavailable ({e}). Ensure Lane D's jev_typesafe.py "
                "is merged and TYPESAFE_API_KEY is set."
            ) from e
        return JevTypeSafe(cfg)
    raise SystemExit(f"unknown jev backend: {cfg.backend!r}")
