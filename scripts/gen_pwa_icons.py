"""Generate the PWA icons (solid rounded 'R' tile) with stdlib only — no PIL.

Writes devices/pwa/icons/icon-{192,512}.png. Committed output; rerun on rebrand.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

BG = (0x0B, 0x0E, 0x14)
FG = (0x89, 0xB4, 0xFA)  # accent from the shared palette


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def _glyph_r(x: float, y: float) -> bool:
    """A chunky 'R' on a 0..1 x 0..1 cell (stem, bowl, leg)."""
    if 0.16 <= x <= 0.38 and 0.10 <= y <= 0.90:  # stem
        return True
    if 0.10 <= y <= 0.52 and 0.38 <= x <= 0.80:  # bowl ring
        cx, cy = 0.52, 0.31
        r = ((x - cx) / 0.30) ** 2 + ((y - cy) / 0.21) ** 2
        return 0.35 <= r <= 1.0 or x <= 0.5
    if 0.52 <= y <= 0.90 and abs((x - 0.38) - (y - 0.52) * 0.75) <= 0.11:  # leg
        return True
    return False


def make_icon(size: int, out: Path) -> None:
    corner = size * 0.20
    rows = []
    for j in range(size):
        row = bytearray(b"\x00")  # filter type 0
        for i in range(size):
            # rounded-rect mask
            dx = max(corner - i, i - (size - 1 - corner), 0)
            dy = max(corner - j, j - (size - 1 - corner), 0)
            if dx * dx + dy * dy > corner * corner:
                row += bytes((0, 0, 0, 0))
                continue
            u, v = i / size, j / size
            inset = 0.18  # glyph margin
            gx = (u - inset) / (1 - 2 * inset)
            gy = (v - inset) / (1 - 2 * inset)
            color = FG if 0 <= gx <= 1 and 0 <= gy <= 1 and _glyph_r(gx, gy) else BG
            row += bytes((*color, 255))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    out.write_bytes(
        b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", raw) + _chunk(b"IEND", b"")
    )
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    icons = Path(__file__).resolve().parents[1] / "devices" / "pwa" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        make_icon(size, icons / f"icon-{size}.png")
