"""Small opt-in recorder for the upcoming agent harness and replay drivers."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from .trace import RESULTS, STAGES, WARMTH, _number, validate_manifest


class TraceRecorder:
    """Record real spans without automatically starting capture or cloud work.

    Caller-owned source times must be mapped to this process's perf_counter clock.
    Browser performance.now() and server perf_counter() cannot be subtracted raw.
    Outcome labels should be attached from a separate annotated replay manifest.
    """

    def __init__(self, path: Path, manifest: dict):
        validate_manifest(manifest)
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self._file = os.fdopen(descriptor, "w")
        self._lock = threading.Lock()
        self._write(manifest)

    def _write(self, record: dict) -> None:
        encoded = json.dumps(record, allow_nan=False)
        with self._lock:
            self._file.write(encoded + "\n")
            self._file.flush()

    def stage(self, trace_id: str, stage: str, *, warmth: str, at_ms: float | None = None) -> None:
        if stage not in STAGES or warmth not in WARMTH or not trace_id:
            raise ValueError("Expected a trace ID, supported stage, and explicit warmth")
        stamp = _number(time.perf_counter() * 1000 if at_ms is None else at_ms, "at_ms")
        self._write({"type": "stage", "trace_id": trace_id, "stage": stage,
                     "warmth": warmth, "at_ms": stamp})

    def outcome(self, trace_id: str, result: str, *, warmth: str,
                expected_action: bool, required_terminal_stage: str | None = None) -> None:
        if not trace_id or result not in RESULTS or warmth not in WARMTH:
            raise ValueError("Expected a trace ID, supported outcome, and explicit warmth")
        if not isinstance(expected_action, bool):
            raise ValueError("expected_action must come from a boolean ground-truth label")
        if expected_action and required_terminal_stage not in {"agent_end", "memory_commit", "display_received"}:
            raise ValueError("Action outcomes require a terminal stage")
        if not expected_action and required_terminal_stage is not None:
            raise ValueError("No-action outcomes cannot require a terminal stage")
        self._write({"type": "outcome", "trace_id": trace_id, "result": result,
                     "warmth": warmth, "expected_action": expected_action,
                     "required_terminal_stage": required_terminal_stage})

    def close(self) -> None:
        with self._lock:
            self._file.close()

    def __enter__(self) -> TraceRecorder:
        return self

    def __exit__(self, *_args) -> None:
        self.close()
