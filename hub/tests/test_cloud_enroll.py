import subprocess
import sys
from pathlib import Path


def test_enrollment_cannot_open_camera_without_explicit_consent():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(root / "scripts/enroll.py"), "--name", "Synthetic", "--camera", "0"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 2
    assert "Explicit --consent is required" in result.stderr
