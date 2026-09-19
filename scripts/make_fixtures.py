"""Generate deterministic fixture media; explicitly download upstream bus.jpg."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import urllib.request
import wave
import zlib
from pathlib import Path

import numpy as np

BUS_URL = "https://raw.githubusercontent.com/ultralytics/ultralytics/v8.4.155/ultralytics/assets/bus.jpg"


def png(path: Path, pixels: np.ndarray):
    height, width, _ = pixels.shape
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))
    scanlines = b"".join(b"\0" + row.tobytes() for row in pixels)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("data/fixtures"))
    parser.add_argument("--speech-wav", type=Path, help="16 kHz mono PCM16 WAV when macOS say is unavailable")
    args = parser.parse_args()
    root = args.root
    root.mkdir(parents=True, exist_ok=True)
    bus = root / "bus.jpg"
    if not bus.exists():
        with urllib.request.urlopen(BUS_URL, timeout=60) as source:
            bus.write_bytes(source.read())
    png(root / "noise.png", np.random.default_rng(193).integers(0, 256, (480, 640, 3), dtype=np.uint8))
    speech = root / "where_keys.wav"
    if args.speech_wav:
        shutil.copyfile(args.speech_wav, speech)
    elif shutil.which("say"):
        subprocess.run(["say", "-v", "Samantha", "-o", str(speech), "--data-format=LEI16@16000", "Where are my keys?"], check=True)
    else:
        raise RuntimeError("Supply --speech-wav with a 16 kHz mono PCM16 'where are my keys' recording; no fake tone substituted")
    with wave.open(str(speech)) as audio:
        if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 16000, 2):
            raise ValueError("Speech fixture must be 16 kHz mono PCM16")
        duration = audio.getnframes() / 16000
    manifest = {"bus.jpg": {"source": BUS_URL, "sha256": hashlib.sha256(bus.read_bytes()).hexdigest()},
                "noise.png": {"source": "NumPy default_rng seed 193", "wh": [640, 480]},
                "where_keys.wav": {"source": str(args.speech_wav) if args.speech_wav else "macOS say / Samantha",
                                   "text": "Where are my keys?", "sample_rate": 16000, "duration_s": duration}}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
    print(f"Fixtures ready at {root}; sources recorded in manifest.json")


if __name__ == "__main__":
    main()
