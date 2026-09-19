"""Record a live session's percepts to a directory (AGENTS.md §10).

Thin wrapper: runs the hub with REMEMBER_RECORD set. Stop with Ctrl-C; replay
with scripts/replay.py <dir>. (AV frame recording is a morning extension —
percept replay is what drives the brain deterministically.)"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "hub"))

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "data/recording"
    os.environ["REMEMBER_RECORD"] = out
    from remember_hub.main import main

    print(f"recording percepts to {out}/percepts.jsonl — Ctrl-C to stop")
    main()
