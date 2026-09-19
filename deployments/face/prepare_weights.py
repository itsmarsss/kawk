"""Copy already-obtained buffalo_l weights into the Truss image after hash verification.

No download, model substitution, or license acceptance is performed automatically.
"""

import argparse
import hashlib
import shutil
from pathlib import Path

FILES = {
    "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
}


def prepare(source: Path, destination: Path) -> None:
    for name, expected in FILES.items():
        path = source / name
        with path.open("rb") as source_file:
            digest = hashlib.file_digest(source_file, "sha256").hexdigest()
        if digest != expected:
            raise ValueError(f"Wrong buffalo_l bytes: {name}")
    destination.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        shutil.copy2(source / name, destination / name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Directory containing the two ONNX files")
    args = parser.parse_args()
    prepare(args.source, Path(__file__).parent / "data/models/buffalo_l")
