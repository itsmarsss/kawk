"""Verify benchmark truthfulness, determinism and observable current product gaps."""
import copy
import json
import socket
from unittest.mock import patch

import pytest

from benchmarks.kawk.policy import (
    DEFAULT_SCENARIOS,
    load_scenarios,
    policy_exit_code,
    run_policy_suite,
)


@pytest.fixture
async def report():
    # Accidental hosted inference in this offline suite must fail immediately.
    with patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden")):
        return await run_policy_suite()


def test_report_separates_simulated_policy_from_model_performance(report):
    assert report["mode"] == "policy_replay"
    assert report["model_inference"] is False
    assert report["simulated_time_only"] is True
    assert "injected" in report["decision_source"]
    assert not any("latency" in key for case in report["cases"] for key in case)
    assert all(case["evidence"] for case in report["cases"])


def test_targets_drive_status_without_requiring_known_bugs_to_persist(report):
    results = {case["id"]: case for case in report["cases"]}
    gaps = {"delayed_final_partner_switch", "implied_need_agent_handoff", "pending_finals_overload"}
    assert all(results[key]["known_gap"] for key in gaps)
    assert all(case["status"] == "pass" for key, case in results.items() if key not in gaps)
    for case in results.values():
        assert case["checks"] and "runner_error" not in case
        assert (case["status"] == "pass") == all(check["passed"] for check in case["checks"])
    failures = [case for case in results.values() if case["status"] == "fail"]
    assert report["summary"] == {"total": len(results), "passed": len(results) - len(failures),
                                 "failed": len(failures), "known_gap_failures": len(failures),
                                 "unexpected_failures": 0}
    assert policy_exit_code(report) == int(bool(failures))
    assert policy_exit_code(report, allow_known_gaps=True) == 0


def test_actual_bridge_reports_delivery_or_loss_for_every_final(report):
    case = next(case for case in report["cases"] if case["id"] == "pending_finals_overload")
    submitted = {event["segment_id"] for event in case["evidence"]
                 if event["event"] == "bridge_submitted" and event["accepted"]}
    resolved = set(case["observed"]["resolved_segments"])
    dropped = {event["segment_id"] for event in case["observed"]["dropped"]}
    assert submitted == {"fact-a", "fact-b", "fact-c"}
    assert resolved <= submitted
    assert submitted - resolved <= dropped
    assert all(event.get("reason") for event in case["observed"]["dropped"])
    if case["status"] == "pass":
        assert resolved == submitted and case["observed"]["note_count"] == len(submitted)
    else:
        assert case["known_gap"] and any(not check["passed"] for check in case["checks"])


def test_temporal_target_keeps_source_times_and_accepts_correct_binding_or_abstention(report):
    case = next(case for case in report["cases"] if case["id"] == "delayed_final_partner_switch")
    final = next(event for event in case["evidence"]
                 if event["event"] == "transcript_input" and event["is_final"])
    assert final["source_end_ms"] == 600
    assert final["simulated_ms"] == 2000
    profiles = case["observed"]["note_profiles"]
    assert (case["status"] == "pass") == ("alice" not in profiles)
    assert all(speaker == "unknown" for speaker in case["observed"]["speaker_claims"])
    if "alice" in profiles:
        assert case["known_gap"] and any(not check["passed"] for check in case["checks"])


def test_allow_known_gaps_never_hides_unexpected_failures(report):
    changed = copy.deepcopy(report)
    changed["cases"][0]["status"] = "fail"
    assert not changed["cases"][0]["known_gap"]
    assert policy_exit_code(changed, allow_known_gaps=True) == 1


async def test_actual_face_policy_regression_fails_the_target():
    def broken_process(self, result):
        return {"faces": [{"match": {"id": None}, "stable_id": None, "track_id": 1}]}
    with patch("tools.perception_lab.faces.FaceSession.process", broken_process):
        report = await run_policy_suite()
    face = next(case for case in report["cases"] if case["id"] == "face_unknown_blip")
    assert face["status"] == "fail" and not face["known_gap"]
    assert policy_exit_code(report, allow_known_gaps=True) == 1


async def test_runner_error_is_not_excused_as_a_known_gap():
    with patch("benchmarks.kawk.speech_policy.observe_people", side_effect=RuntimeError("broken fixture")):
        report = await run_policy_suite()
    gap = next(case for case in report["cases"] if case["id"] == "delayed_final_partner_switch")
    assert gap["status"] == "fail" and not gap["known_gap"]
    assert gap["runner_error"] == "RuntimeError"
    assert policy_exit_code(report, allow_known_gaps=True) == 1


def test_replay_rejects_unbounded_or_out_of_order_fixtures(tmp_path):
    fixture = json.loads(DEFAULT_SCENARIOS.read_text())
    fixture["cases"][0]["events"][0]["at_ms"] = 70_000
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(fixture))
    with pytest.raises(ValueError, match="receipt times"):
        load_scenarios(path)
