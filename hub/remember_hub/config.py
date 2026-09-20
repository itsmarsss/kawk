"""Typed loader for remember.toml (checked in, no secrets — AGENTS.md §11)."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field


class HubCfg(BaseModel):
    heartbeat_ms: int = 1000
    data_dir: str = "data"


class DeviceLinkCfg(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8765


class DashboardCfg(BaseModel):
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 8090


class PwaCfg(BaseModel):
    """PWA notification tier (§9): the primary output surface, replacing the LCD."""

    enabled: bool = True
    host: str = "0.0.0.0"  # the phone connects over LAN
    port: int = 8092  # 8091 is taken by chud3's TS-agent PWA (docs/PWA_CONTRACT.md)
    certfile: str = ""  # mkcert cert; iOS needs TLS for SW + push (devices/pwa/README.md)
    keyfile: str = ""
    vapid_sub: str = "mailto:demo@example.com"
    min_priority: int = 10  # profile and above buzz the phone; idle never does
    cooldown_s: float = 3.0


class SamCfg(BaseModel):
    backend: str = "mock"
    vocabulary: list[str] = Field(default_factory=list)
    score_threshold: float = 0.35
    poll_fps: float = 10


class FaceCfg(BaseModel):
    backend: str = "mock"
    match_threshold: float = 0.40
    min_bbox_px: int = 80
    poll_fps: float = 5
    vote_n: int = 3


class SttCfg(BaseModel):
    backend: str = "mock"


class JevCfg(BaseModel):
    backend: str = "mock"
    model: str = "jev-1.13.0"


class GateCfg(BaseModel):
    addressed_threshold: float = 0.65
    intent_min_prob: float = 0.5
    profile_threshold: float = 0.70
    enroll_threshold: float = 0.70
    enroll_debounce: int = 3
    clear_threshold: float = 0.75


class WorldCfg(BaseModel):
    coast_s: float = 1.0
    track_end_s: float = 2.0
    transcript_window_s: float = 60.0


class ServicesCfg(BaseModel):
    sam: SamCfg = SamCfg()
    face: FaceCfg = FaceCfg()
    stt: SttCfg = SttCfg()
    jev: JevCfg = JevCfg()


class AppConfig(BaseModel):
    hub: HubCfg = HubCfg()
    devicelink: DeviceLinkCfg = DeviceLinkCfg()
    dashboard: DashboardCfg = DashboardCfg()
    pwa: PwaCfg = PwaCfg()
    services: ServicesCfg = ServicesCfg()
    gate: GateCfg = GateCfg()
    world: WorldCfg = WorldCfg()
    devices: dict[str, dict] = Field(default_factory=dict)


def load_config(path: str | Path = "remember.toml") -> AppConfig:
    with open(path, "rb") as f:
        raw = tomllib.load(f)
    return AppConfig.model_validate(raw)


def require_env(name: str, why: str) -> str:
    """Loud actionable startup error, not a crash mid-demo (AGENTS.md §11)."""
    val = os.environ.get(name, "")
    if not val:
        raise SystemExit(
            f"Missing env var {name} (needed for {why}). "
            f"Copy .env.example to .env and fill it, or flip the backend to 'mock' "
            f"in remember.toml."
        )
    return val
