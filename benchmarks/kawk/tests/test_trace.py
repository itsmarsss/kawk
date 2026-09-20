import json

import pytest

from benchmarks.kawk.record import TraceRecorder
from benchmarks.kawk.trace import distribution, evaluate_trace


def manifest():
    return {"type": "manifest", "schema_version": "1.0", "mode": "system_replay",
            "clock": "mapped_hub_monotonic_ms", "clock_mapping_uncertainty_ms": 2,
            "synthetic": True, "run_id": "unit", "pipeline_revision": "test-only",
            "input_sha256": "0" * 64, "annotation_source": "unit assertions",
            "hardware": {"device": "injected"}, "runtime": {"python": "test"},
            "models": {"all": "none"},
            "trials": [{"trace_id": "one", "warmth": "warm", "expected_action": True,
                        "required_terminal_stage": "memory_commit"}]}


def stage(name, stamp, trace="one", warmth="warm"):
    return {"type": "stage", "trace_id": trace, "warmth": warmth,
            "stage": name, "at_ms": stamp}


def outcome(result, trace="one", warmth="warm"):
    return {"type": "outcome", "trace_id": trace, "warmth": warmth, "result": result,
            "expected_action": True, "required_terminal_stage": "memory_commit"}


def report(tmp_path, *events, header=None):
    path = tmp_path / "trace.jsonl"
    if header is None:
        header = manifest()
        planned = {row["trace_id"]: {"trace_id": row["trace_id"], "warmth": row["warmth"],
                                    "expected_action": True, "required_terminal_stage": "memory_commit"}
                   for row in events}
        header["trials"] = list(planned.values())
    path.write_text("\n".join(json.dumps(x) for x in [header, *events]))
    return evaluate_trace(path)


def test_failures_stay_in_denominator_and_missing_stages_are_not_zero(tmp_path):
    value = report(tmp_path, stage("capture", 10), stage("memory_commit", 60),
                   outcome("correct"), stage("capture", 70, "two"), outcome("timeout", "two"))
    assert value["correct_fraction_of_all_traces"] == .5
    assert value["missing_span_counts"]["capture_to_memory"] == 1
    assert value["latency_by_warmth_outcome_span"]["warm/correct/capture_to_memory"]["p50_ms"] == 50
    assert value["traces"][1]["measured_spans_ms"] == {}


def test_cold_and_warm_are_separate(tmp_path):
    value = report(tmp_path, stage("capture", 0), stage("memory_commit", 50), outcome("correct"),
                   stage("capture", 0, "cold", "cold"), stage("memory_commit", 5000, "cold", "cold"),
                   outcome("correct", "cold", "cold"))
    assert value["latency_by_warmth_outcome_span"]["cold/correct/capture_to_memory"]["p50_ms"] == 5000
    assert value["latency_by_warmth_outcome_span"]["warm/correct/capture_to_memory"]["p50_ms"] == 50


def test_success_without_completion_is_incomplete(tmp_path):
    value = report(tmp_path, stage("capture", 10), outcome("correct"))
    assert value["outcomes"] == {"incomplete": 1}
    assert value["correct_fraction_of_all_traces"] == 0


def test_unlabelled_is_visible(tmp_path):
    value = report(tmp_path, stage("capture", 10))
    assert value["outcomes"] == {"unlabelled": 1}


@pytest.mark.parametrize("bad", [float("nan"), -1, True, "12"])
def test_invalid_timestamps_fail(tmp_path, bad):
    with pytest.raises(ValueError):
        report(tmp_path, stage("capture", bad))


def test_reversed_timestamps_fail(tmp_path):
    with pytest.raises(ValueError, match="Reversed"):
        report(tmp_path, stage("capture", 100), stage("memory_commit", 50))


def test_duplicate_stages_fail(tmp_path):
    with pytest.raises(ValueError, match="repeated stage"):
        report(tmp_path, stage("capture", 10), stage("capture", 20))


def test_unmapped_clocks_fail(tmp_path):
    header = {**manifest(), "clock": "browser_plus_server_wall_clock"}
    with pytest.raises(ValueError, match="one hub"):
        report(tmp_path, stage("capture", 10), header=header)


def test_tail_statistics_do_not_overstate_tiny_samples():
    assert distribution([1, 2, 3])["p95_ms"] is None
    assert distribution(list(range(100)))["p99_ms"] == 98


def test_recorder_round_trip_and_no_overwrite(tmp_path):
    path = tmp_path / "recorded.jsonl"
    with TraceRecorder(path, manifest()) as recorder:
        recorder.stage("one", "capture", warmth="warm", at_ms=100)
        recorder.stage("one", "memory_commit", warmth="warm", at_ms=135)
        recorder.outcome("one", "correct", warmth="warm", expected_action=True,
                         required_terminal_stage="memory_commit")
    assert evaluate_trace(path)["traces"][0]["measured_spans_ms"]["capture_to_memory"] == 35
    assert path.stat().st_mode & 0o077 == 0
    with pytest.raises(FileExistsError):
        TraceRecorder(path, manifest())


def test_unobserved_planned_trials_stay_in_denominator(tmp_path):
    header = manifest()
    header["trials"].append({**header["trials"][0], "trace_id": "never_received"})
    value = report(tmp_path, stage("capture", 1), stage("memory_commit", 2),
                   outcome("correct"), header=header)
    assert value["correct_fraction_of_all_traces"] == .5
    assert value["outcomes"] == {"correct": 1, "missing": 1}


def no_action_header():
    header = manifest()
    header["trials"][0].update(expected_action=False, required_terminal_stage=None)
    return header


def no_action_outcome():
    return {**outcome("correct"), "expected_action": False, "required_terminal_stage": None}


def test_no_action_requires_execution_evidence(tmp_path):
    value = report(tmp_path, no_action_outcome(), header=no_action_header())
    assert value["outcomes"] == {"incomplete": 1}


def test_unexpected_memory_write_overrides_correct_label(tmp_path):
    value = report(tmp_path, stage("capture", 1), stage("memory_commit", 2),
                   no_action_outcome(), header=no_action_header())
    assert value["outcomes"] == {"incorrect": 1}


def test_evidenced_no_action_can_pass(tmp_path):
    value = report(tmp_path, stage("capture", 1), stage("observation_complete", 2),
                   no_action_outcome(), header=no_action_header())
    assert value["outcomes"] == {"correct": 1}


def test_revised_partials_keep_one_trial_and_first_partial_latency(tmp_path):
    value = report(tmp_path, stage("speech_start", 10), stage("speech_partial", 50),
                   stage("speech_partial", 70), stage("speech_end", 100),
                   stage("speech_final", 140), stage("memory_commit", 200), outcome("correct"))
    assert value["trace_count"] == 1
    assert value["traces"][0]["partial_updates"] == 2
    assert value["traces"][0]["measured_spans_ms"]["speech_onset_to_partial"] == 40
