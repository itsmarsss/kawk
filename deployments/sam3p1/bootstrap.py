"""Find the image's PyTorch interpreter instead of Baseten's system Python."""
import os
import subprocess
import sys
from pathlib import Path

candidates = [Path(x) for x in ["/opt/conda/bin/python", "/opt/venv/bin/python", "/venv/bin/python", "/usr/local/bin/python", sys.executable]]
candidates += sorted(Path("/opt").glob("*/bin/python"))
for candidate in dict.fromkeys(candidates):
    if not candidate.exists():
        continue
    check = subprocess.run([str(candidate), "-c", "import torch,sys; print(sys.executable, torch.__version__)"], capture_output=True, text=True)
    if check.returncode == 0:
        print("Using PyTorch interpreter:", check.stdout.strip(), flush=True)
        os.execv(str(candidate), [str(candidate), "-u", "cloud_run.py"])
raise RuntimeError("No PyTorch interpreter found in the configured PyTorch image")
