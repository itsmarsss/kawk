"""Record -> replay round trip: a hand-built percept recording replayed through
scripts/replay.py (real subprocess, 1x speed) must reproduce the keys answer.
This is the stage-fallback path (AGENTS.md §10/§14) — it has to actually work."""

import json
import subprocess
import sys
import time
from pathlib import Path

from remember_hub.contracts.percepts import Detection, TranscriptSegment

REPO = Path(__file__).resolve().parents[2]


def _write_recording(path: Path) -> None:
    t0 = time.time()
    events = []

    def det(track: str, label: str, box) -> dict:
        return Detection(
            track_id=track, label=label, box_xyxy=box, score=0.9, frame_wh=(1, 1)
        ).model_dump(mode="json")

    # desk visible t=0..4.0; keys only t=0..1.2 -> keys track ends ~3.2 with desk
    # co-visible (coast window), so LastSeen context = [desk].
    t = 0.0
    while t <= 4.0:
        batch = [det("d1", "desk", (0.1, 0.55, 0.95, 0.98))]
        if t <= 1.2:
            batch.append(det("k1", "keys", (0.6, 0.7, 0.75, 0.85)))
        events.append({"t": t0 + t, "topic": "percepts.detections", "data": batch})
        t += 0.3
    events.append(
        {
            "t": t0 + 4.5,
            "topic": "percepts.stt",
            "data": TranscriptSegment(
                seg_id="q1", text="where are my keys", is_final=True
            ).model_dump(mode="json"),
        }
    )
    (path / "percepts.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")


def test_replay_reproduces_keys_answer(tmp_path):
    _write_recording(tmp_path)
    proc = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "replay.py"), str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=30,
        cwd=REPO,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    out = proc.stdout.lower()
    assert "answer" in out and "keys" in out and "desk" in out, proc.stdout
