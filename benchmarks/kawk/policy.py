"""Bounded offline acceptance replay; unmet product targets stay failed."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from .face_policy import run_face_case
from .object_policy import run_object_case
from .speech_policy import run_overload_case, run_speech_case

DEFAULT_SCENARIOS = Path(__file__).parent / "fixtures" / "scenarios.json"
RUNNERS = {"face": run_face_case, "speech": run_speech_case,
           "overload": run_overload_case, "objects": run_object_case}


def load_scenarios(path: Path | None = None) -> list[dict]:
    payload = json.loads((path or DEFAULT_SCENARIOS).read_text())
    if payload.get("schema_version") != "1.0":
        raise ValueError("Expected policy fixture schema_version 1.0")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 50:
        raise ValueError("A policy fixture needs 1–50 cases")
    seen = set()
    for case in cases:
        if case["id"] in seen or case["runner"] not in RUNNERS:
            raise ValueError("Duplicate case ID or unsupported runner")
        seen.add(case["id"])
        events = case.get("events", [])
        if not 1 <= len(events) <= 100:
            raise ValueError("A policy case needs 1–100 events")
        times = [event["at_ms"] for event in events]
        if any(not isinstance(t, (int, float)) or isinstance(t, bool) or not 0 <= t <= 60_000
               for t in times) or times != sorted(times):
            raise ValueError("Case receipt times must be ordered within one simulated minute")
        if not case.get("checks"):
            raise ValueError("A case must assert at least one product target")
        for check in case["checks"]:
            if check["op"] not in {"eq", "at_least", "not_contains"}:
                raise ValueError("Unsupported expectation operation")
    return cases


def evaluate(check: dict, observed: dict) -> dict:
    actual, expected = observed[check["field"]], check["value"]
    if check["op"] == "eq":
        passed = actual == expected
    elif check["op"] == "at_least":
        passed = actual >= expected
    else:
        passed = all(item not in actual for item in expected)
    return {"name": check["name"], "field": check["field"], "operation": check["op"],
            "passed": passed, "expected": expected, "actual": actual}


async def run_policy_suite(scenario_path: Path | None = None) -> dict:
    """Run serially with zero network, AV input, inference engines or real galleries.

    The app's real policy code receives synthetic embeddings, observations and
    injected gate decisions. A simulated duration describes the fixture timeline;
    it is neither model latency nor wall-clock end-to-end performance.
    """
    cases = []
    for fixture in load_scenarios(scenario_path):
        base = {"id": fixture["id"], "title": fixture["title"],
                "expectation": fixture["expectation"],
                "known_gap": bool(fixture.get("known_gap")),
                "known_gap_reason": fixture.get("known_gap")}
        try:
            result = await asyncio.wait_for(RUNNERS[fixture["runner"]](fixture), timeout=5)
            checks = [evaluate(check, result["observed"]) for check in fixture["checks"]]
            cases.append({**base, **result, "checks": checks,
                          "status": "pass" if all(c["passed"] for c in checks) else "fail"})
        except Exception as exc:
            # A runner failure is not the documented behavioral gap and must not
            # be hidden by --allow-known-gaps. No hosted errors can be included.
            cases.append({**base, "status": "fail", "known_gap": False,
                          "runner_error": type(exc).__name__, "observed": {},
                          "checks": [], "evidence": [], "simulated_duration_ms": None})
    failed = [case for case in cases if case["status"] == "fail"]
    gaps = sum(case["known_gap"] for case in failed)
    return {
        "schema_version": "1.0", "mode": "policy_replay",
        "simulated_time_only": True, "model_inference": False,
        "decision_source": "injected fixture decisions, not Jev inference",
        "limitations": ["Synthetic embeddings do not measure face recognition accuracy.",
                        "Synthetic transcripts do not measure Whisper or speaker attribution accuracy.",
                        "No camera, media replay, cloud, network, real gallery or database is used.",
                        "Simulated durations are scenario time, not inference or end-to-end latency."],
        "summary": {"total": len(cases), "passed": len(cases) - len(failed),
                    "failed": len(failed), "known_gap_failures": gaps,
                    "unexpected_failures": len(failed) - gaps},
        "cases": cases,
    }


def policy_exit_code(report: dict, *, allow_known_gaps: bool = False) -> int:
    return int(any(case["status"] != "pass" and not (allow_known_gaps and case["known_gap"])
                   for case in report["cases"]))
