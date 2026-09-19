"""Reproduce the previously proven pinned install, then a finite WS smoke."""
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

from model.windowed import CODE_REVISION, WEIGHT_SHA256

output = Path(os.environ.get("BT_CHECKPOINT_DIR", "/mnt/ckpts")) / "sam31-windowed"
output.mkdir(parents=True, exist_ok=True)
cache = Path(os.environ.get("BT_PROJECT_CACHE_DIR", "/root/.cache/user_artifacts"))
os.environ["HF_HOME"] = str(cache / "huggingface")
start = time.perf_counter()
subprocess.run([
    sys.executable, "-m", "pip", "install", "--break-system-packages",
    "huggingface_hub", "setuptools<81", "einops", "pillow", "decord", "pycocotools",
    "opencv-python-headless<4.12", "scipy", "fastapi", "uvicorn", "websockets>=15,<16",
], check=True)
from huggingface_hub import hf_hub_download  # noqa: E402

checkpoint = hf_hub_download("AEmotionStudio/sam3.1", "sam3.1_multiplex.pt",
                             revision="694239a1479aab8fd1317c87c433c58acd7c6eab")
digest = hashlib.sha256()
with open(checkpoint, "rb") as source:
    for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
        digest.update(block)
if digest.hexdigest() != WEIGHT_SHA256:
    raise RuntimeError("Checkpoint SHA256 mismatch")
archive = Path("sam3-source.tar.gz")
urllib.request.urlretrieve(f"https://codeload.github.com/facebookresearch/sam3/tar.gz/{CODE_REVISION}", archive)
with tarfile.open(archive) as package:
    package.extractall("upstream", filter="data")
repo = Path("upstream") / f"sam3-{CODE_REVISION}"
subprocess.run([sys.executable, "-m", "pip", "install", "--break-system-packages", "-e", str(repo)], check=True)
(output / "setup.json").write_text(json.dumps({
    "setup_seconds": time.perf_counter() - start, "code_revision": CODE_REVISION,
    "checkpoint_sha256": digest.hexdigest(), "checkpoint_bytes": os.path.getsize(checkpoint),
    "checkpoint_source": "user-supplied public mirror AEmotionStudio/sam3.1; exact Meta digest",
}, indent=2))
(output / "pip-freeze.txt").write_text(subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True))
subprocess.run([sys.executable, "-u", "cloud_smoke.py", "--checkpoint", checkpoint,
                "--frames", str(repo / "assets/videos/0001"), "--output", str(output)],
               check=True, timeout=900)
