"""Explicit, resumable local-model fetch. Never called by tests or import paths."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

URLS = {
    "yolov8s-worldv2.pt": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8s-worldv2.pt",
    "silero_vad.onnx": "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx",
    "buffalo_l.zip": "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
}
FACE_HASHES = {
    "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
}


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download(url: str, path: Path) -> None:
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    print(f"Fetching {path.name}", flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Remember-local-model-fetch"})
    with urllib.request.urlopen(request, timeout=120) as source, temporary.open("wb") as target:
        shutil.copyfileobj(source, target)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("data/models"))
    parser.add_argument("--face-cache", type=Path, help="Optional existing buffalo_l directory")
    parser.add_argument("--only", choices=["all", "yolo", "face", "whisper", "vad"], default="all")
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    selected = {"yolo", "face", "whisper", "vad"} if args.only == "all" else {args.only}
    if "yolo" in selected:
        name = "yolov8s-worldv2.pt"
        download(URLS[name], root / name)
        import clip
        # Official CLIP downloader verifies SHA256 embedded in its upstream URL.
        clip.load("ViT-B/32", device="cpu", download_root=str(root / "clip"))
        manifest[name] = {"source": URLS[name], "sha256": digest(root / name)}
        manifest["clip/ViT-B-32.pt"] = {"source": "https://github.com/openai/CLIP/blob/main/clip/clip.py", "sha256": digest(root / "clip/ViT-B-32.pt")}
    if "vad" in selected:
        name = "silero_vad.onnx"
        download(URLS[name], root / name)
        manifest[name] = {"source": URLS[name], "sha256": digest(root / name)}
    if "face" in selected:
        face_dir = root / "buffalo_l"
        face_dir.mkdir(exist_ok=True)
        if args.face_cache:
            for name in FACE_HASHES:
                shutil.copyfile(args.face_cache / name, face_dir / name)
        if not all((face_dir / name).is_file() for name in FACE_HASHES):
            download(URLS["buffalo_l.zip"], root / "buffalo_l.zip")
            with zipfile.ZipFile(root / "buffalo_l.zip") as archive:
                # Extract only explicit model files, never arbitrary archive paths.
                for name in FACE_HASHES:
                    member = next(item for item in archive.namelist() if Path(item).name == name)
                    with archive.open(member) as source, (face_dir / name).open("wb") as target:
                        shutil.copyfileobj(source, target)
        for name, expected in FACE_HASHES.items():
            actual = digest(face_dir / name)
            if actual != expected:
                raise RuntimeError(f"SHA256 mismatch for buffalo_l/{name}")
            manifest[f"buffalo_l/{name}"] = {"source": URLS["buffalo_l.zip"], "sha256": actual}
    if "whisper" in selected:
        from huggingface_hub import snapshot_download
        snapshot_download("Systran/faster-whisper-small", local_dir=root / "faster-whisper-small",
                          allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"])
        manifest["faster-whisper-small"] = {"source": "https://huggingface.co/Systran/faster-whisper-small",
                                          "sha256_model": digest(root / "faster-whisper-small/model.bin")}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Models ready at {root}. Source/hash manifest: {manifest_path}")


if __name__ == "__main__":
    main()
