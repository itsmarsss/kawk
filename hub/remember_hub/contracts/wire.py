"""Binary wire codec + JSON control messages (AGENTS.md §5). FROZEN after m0.

Header is little-endian and TYPE-CONDITIONAL: 8 bytes for AV frames (0x01/0x02),
16 bytes for display blits (0x10/0x11 — geometry prefix follows the 8-byte header).
WebSocket preserves message boundaries, so decode() switches on the first byte.

seq is u16 and wraps ~27 min at 40 msg/s — ALL ordering math uses seq_delta().
ts_ms: device->hub = device millis() (NOT epoch); hub->device = hub's projection of
device time from the hello mapping (devices may ignore it).
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any

_HDR = struct.Struct("<BBHI")  # type, flags, seq, ts_ms
_GEO = struct.Struct("<HHHH")  # x, y, w, h

T_VIDEO = 0x01  # device->hub JPEG frame
T_AUDIO = 0x02  # device->hub 16 kHz mono PCM16-LE, 40 ms chunks (640 samples = 1280 B)
T_BLIT_JPEG = 0x10  # hub->device JPEG blit + geometry
T_BLIT_RGB565 = 0x11  # hub->device RGB565 blit + geometry

GEOMETRY_TYPES = frozenset({T_BLIT_JPEG, T_BLIT_RGB565})
AUDIO_CHUNK_BYTES = 1280


@dataclass(frozen=True)
class WireFrame:
    type: int
    flags: int
    seq: int
    ts_ms: int
    payload: bytes
    geometry: tuple[int, int, int, int] | None = None  # only for 0x10/0x11


def encode(frame: WireFrame) -> bytes:
    head = _HDR.pack(frame.type, frame.flags, frame.seq & 0xFFFF, frame.ts_ms & 0xFFFFFFFF)
    if frame.type in GEOMETRY_TYPES:
        if frame.geometry is None:
            raise ValueError(f"type 0x{frame.type:02x} requires geometry")
        return head + _GEO.pack(*frame.geometry) + frame.payload
    return head + frame.payload


def decode(buf: bytes) -> WireFrame:
    if len(buf) < _HDR.size:
        raise ValueError(f"short frame: {len(buf)} bytes")
    ftype, flags, seq, ts_ms = _HDR.unpack_from(buf, 0)
    if ftype in GEOMETRY_TYPES:
        if len(buf) < _HDR.size + _GEO.size:
            raise ValueError(f"short geometry frame: {len(buf)} bytes")
        geometry = _GEO.unpack_from(buf, _HDR.size)
        return WireFrame(ftype, flags, seq, ts_ms, buf[_HDR.size + _GEO.size :], geometry)
    return WireFrame(ftype, flags, seq, ts_ms, buf[_HDR.size :])


def seq_delta(a: int, b: int) -> int:
    """Signed modular distance b-a in u16 space (positive => b is newer)."""
    return ((b - a + 0x8000) & 0xFFFF) - 0x8000


# ---- JSON control plane -----------------------------------------------------

CONTROL_TYPES = {"hello", "config", "card", "ping", "pong"}


def parse_control(text: str) -> dict[str, Any]:
    msg = json.loads(text)
    if not isinstance(msg, dict) or msg.get("type") not in CONTROL_TYPES:
        raise ValueError(f"bad control message: {text[:80]}")
    return msg


def make_hello(
    device_id: str, cls: str, display_wh: tuple[int, int], video: bool, audio: bool
) -> str:
    return json.dumps(
        {
            "type": "hello",
            "device_id": device_id,
            "class": cls,
            "display": {"w": display_wh[0], "h": display_wh[1]},
            "caps": {"video": video, "audio": audio},
        }
    )


def make_config(video: dict[str, Any], audio: dict[str, Any]) -> str:
    return json.dumps({"type": "config", "video": video, "audio": audio})


def make_card(template: str, title: str, body: str, image_ref: int | None, ttl_ms: int) -> str:
    return json.dumps(
        {
            "type": "card",
            "template": template,
            "title": title,
            "body": body,
            "image_ref": image_ref,
            "ttl_ms": ttl_ms,
        }
    )
