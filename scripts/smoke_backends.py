"""Smoke entrypoint: choose an explicit live service and fixture before making a request."""

import argparse
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", nargs="?", choices=("face", "sam", "stt", "jev"))
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.service is None:
        print("No live requests made. Select face/sam/stt/jev and pass its fixture options.")
        print("Example: uv run --extra cloud python scripts/smoke_backends.py stt --help")
        print("Status and bounded verification evidence: deployments/README.md")
        return
    command = Path(__file__).with_name(f"smoke_{args.service}.py")
    raise SystemExit(subprocess.call([sys.executable, str(command), *args.args]))


if __name__ == "__main__":
    main()
