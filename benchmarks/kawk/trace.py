"""Evaluate timestamped system traces without inventing missing measurements.

All times must use one mapped hub monotonic clock. The caller supplies outcome
labels from independent annotations; this module does not judge model quality.
No raw audio, frames, face embeddings, or transcripts are needed in this format.
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median
from typing import Any

STAGES = {
    "capture", "speech_start", "speech_end", "speech_partial", "speech_final",
    "percept", "stable_event", "jev_start", "jev_end", "agent_start", "agent_end",
    "memory_commit", "display_received", "observation_complete",
}
SPANS = {
    "capture_to_percept": ("capture", "percept"),
    "percept_to_stable_event": ("percept", "stable_event"),
    "speech_onset_to_partial": ("speech_start", "speech_partial"),
    "speech_offset_to_final": ("speech_end", "speech_final"),
    "final_to_jev_start": ("speech_final", "jev_start"),
    "stable_event_to_jev_start": ("stable_event", "jev_start"),
    "jev_request": ("jev_start", "jev_end"),
    "agent_execution": ("agent_start", "agent_end"),
    "capture_to_memory": ("capture", "memory_commit"),
    "speech_offset_to_memory": ("speech_end", "memory_commit"),
    "final_to_display": ("speech_final", "display_received"),
}
RESULTS = {"correct", "incorrect", "timeout", "dropped", "abstained"}
WARMTH = {"cold", "first_call", "warm"}


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite nonnegative number")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} must be a finite nonnegative number")
    return float(value)


def _name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def validate_manifest(row: dict) -> None:
    if row.get("type") != "manifest" or row.get("schema_version") != "1.0":
        raise ValueError("The first line must be a version 1.0 manifest")
    if row.get("mode") not in {"system_replay", "model_replay"}:
        raise ValueError("Trace mode must be system_replay or model_replay")
    if row.get("clock") != "mapped_hub_monotonic_ms":
        raise ValueError("Map all source/host timestamps to one hub monotonic clock")
    if not isinstance(row.get("synthetic"), bool):
        raise ValueError("Declare whether inputs are synthetic")
    for field in ("run_id", "pipeline_revision", "input_sha256", "annotation_source"):
        _name(row.get(field), field)
    digest = row["input_sha256"]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("input_sha256 must be the actual input manifest's SHA-256")
    for field in ("hardware", "models", "runtime"):
        if not isinstance(row.get(field), dict) or not row[field]:
            raise ValueError(f"Declare nonempty {field} metadata")
    _number(row.get("clock_mapping_uncertainty_ms"), "clock_mapping_uncertainty_ms")
    trials = row.get("trials")
    if not isinstance(trials, list) or not trials:
        raise ValueError("Declare every planned trace in the independently annotated trials inventory")
    seen = set()
    for trial in trials:
        ident = _name(trial.get("trace_id"), "trace_id")
        if ident in seen or trial.get("warmth") not in WARMTH:
            raise ValueError("Planned traces require unique IDs and explicit warmth")
        seen.add(ident)
        if not isinstance(trial.get("expected_action"), bool):
            raise ValueError("Every planned trace requires expected_action ground truth")
        terminal = trial.get("required_terminal_stage")
        if trial["expected_action"] and terminal not in {"agent_end", "memory_commit", "display_received"}:
            raise ValueError("Every planned action requires its terminal stage")
        if not trial["expected_action"] and terminal is not None:
            raise ValueError("A planned no-action trace has no required terminal stage")


def distribution(values: list[float]) -> dict:
    ordered = sorted(values)

    def nearest_rank(percentile: float) -> float:
        return ordered[max(0, math.ceil(percentile * len(ordered)) - 1)]

    return {
        "n": len(ordered), "p50_ms": median(ordered) if ordered else None,
        "p95_ms": nearest_rank(.95) if len(ordered) >= 20 else None,
        "p99_ms": nearest_rank(.99) if len(ordered) >= 100 else None,
        "max_ms": max(ordered) if ordered else None,
        "tail_note": "p95 withheld below 20 samples; p99 below 100; descriptive, not an SLA guarantee",
    }


def evaluate_trace(path: Path) -> dict:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not rows or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Expected JSON objects in a nonempty JSONL file")
    manifest = rows[0]
    validate_manifest(manifest)
    traces = {trial["trace_id"]: {**trial, "stages": {}, "outcome": None, "partial_updates": 0}
              for trial in manifest["trials"]}
    for row in rows[1:]:
        ident = _name(row.get("trace_id"), "trace_id")
        warmth = row.get("warmth")
        if warmth not in WARMTH:
            raise ValueError("Every record must declare cold, first_call, or warm")
        if ident not in traces:
            raise ValueError(f"Trace {ident} is absent from the planned inventory")
        trace = traces[ident]
        if trace["warmth"] != warmth:
            raise ValueError(f"Warmth changed within trace {ident}")
        if row.get("type") == "stage":
            stage = row.get("stage")
            if stage not in STAGES or (stage in trace["stages"] and stage != "speech_partial"):
                raise ValueError(f"Unknown or repeated stage for {ident}; only speech_partial may repeat")
            stamp = _number(row.get("at_ms"), "at_ms")
            if stage == "speech_partial":
                trace["partial_updates"] += 1
                stamp = min(stamp, trace["stages"].get(stage, stamp))
            trace["stages"][stage] = stamp
        elif row.get("type") == "outcome":
            if trace["outcome"] is not None or row.get("result") not in RESULTS:
                raise ValueError(f"Invalid or repeated outcome for {ident}")
            if not isinstance(row.get("expected_action"), bool):
                raise ValueError("Outcomes require independently labeled expected_action")
            terminal = row.get("required_terminal_stage")
            if row["expected_action"] and terminal not in {"agent_end", "memory_commit", "display_received"}:
                raise ValueError("Action outcomes must declare the required completion stage")
            if not row["expected_action"] and terminal is not None:
                raise ValueError("A no-action outcome has no required completion stage")
            if (row["expected_action"] != trace["expected_action"] or
                    terminal != trace.get("required_terminal_stage")):
                raise ValueError("Outcome expectations must agree with the independent inventory")
            trace["outcome"] = row
        else:
            raise ValueError("Records after the manifest must be stage or outcome")

    samples: dict[str, list[float]] = defaultdict(list)
    outcomes: Counter = Counter()
    missing: Counter = Counter()
    details = []
    for ident, trace in traces.items():
        outcome = trace["outcome"]
        result = outcome["result"] if outcome else "unlabelled" if trace["stages"] else "missing"
        terminal = trace.get("required_terminal_stage")
        input_seen = "capture" in trace["stages"] or "speech_start" in trace["stages"]
        complete = input_seen and (terminal in trace["stages"] if terminal else
                                   "observation_complete" in trace["stages"])
        if not trace["expected_action"] and any(stage in trace["stages"] for stage in
                                               ("agent_end", "memory_commit", "display_received")):
            result = "incorrect"
        if result == "correct" and not complete:
            result = "incomplete"
        outcomes[result] += 1
        spans = {}
        for name, (start, end) in SPANS.items():
            if start not in trace["stages"] or end not in trace["stages"]:
                missing[name] += 1
                continue
            elapsed = trace["stages"][end] - trace["stages"][start]
            if elapsed < 0:
                raise ValueError(f"Reversed {name} timestamps in {ident}")
            spans[name] = elapsed
            samples[f"{trace['warmth']}/{result}/{name}"].append(elapsed)
        details.append({"trace_id": ident, "warmth": trace["warmth"],
                        "result": result, "partial_updates": trace["partial_updates"],
                        "measured_spans_ms": spans})
    return {
        "schema_version": "1.0", "mode": manifest["mode"], "manifest": manifest,
        "trace_count": len(traces), "outcomes": dict(outcomes),
        "correct_fraction_of_all_traces": outcomes["correct"] / len(traces) if traces else None,
        "latency_by_warmth_outcome_span": {k: distribution(v) for k, v in sorted(samples.items())},
        "missing_span_counts": dict(missing), "traces": details,
        "limitations": [
            "Outcome quality is supplied by independent annotations, not inferred from latency.",
            "Missing stages are unmeasured, never zero. Failed/dropped/unlabelled traces stay in the denominator.",
            "A trace report does not establish actual GPU compute or pure network latency.",
        ],
    }
