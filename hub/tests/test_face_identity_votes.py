"""Identity voting regressions use synthetic unit vectors, never camera/gallery data."""

import numpy as np
import pytest

from tools.perception_lab.faces import FaceSession, Gallery


def vector(index=0, score=1.0):
    value = np.zeros(512, dtype=np.float32)
    value[index] = score
    value[2] = (1 - score**2) ** .5
    return value


def row(index=0, score=1.0, box=None):
    return {"box": box or [0, 0, 100, 100], "detection_score": .95,
            "embedding": vector(index, score)}


@pytest.fixture
def rig(tmp_path, monkeypatch):
    clock = {"now": 100.0}
    monkeypatch.setattr("tools.perception_lab.faces.time.monotonic", lambda: clock["now"])
    gallery = Gallery(tmp_path / "gallery.npz")
    first = gallery.enroll("Synthetic A", [vector()] * 5)["id"]
    second = gallery.enroll("Synthetic B", [vector(1)] * 5)["id"]
    return FaceSession(gallery), clock, first, second


def process(rig, rows=None, *, after=.2):
    session, clock, _, _ = rig
    clock["now"] += after
    rows = [row()] if rows is None else rows
    return session.process({"faces": rows, "detected_count": len(rows)})["faces"]


def test_repeated_mild_angle_score_dips_acquire_without_lowering_threshold(rig):
    _, _, first, _ = rig
    observed = [process(rig, [row(score=.39 if i % 3 == 2 else .60)])[0]
                for i in range(12)]
    assert sum(face["match"]["id"] == first for face in observed) == 8
    assert sum(face["stable_id"] == first for face in observed) == 11
    assert observed[0]["stable_id"] is None
    assert observed[2]["match"]["id"] is None  # .39 remains below the unchanged .40 cutoff.


def test_two_matching_observations_can_straddle_one_unknown_frame(rig):
    assert process(rig)[0]["stable_id"] is None
    assert process(rig, [row(score=.39)])[0]["stable_id"] is None
    assert process(rig)[0]["stable_id"] == rig[2]


def test_unknown_frames_do_not_count_as_confirming_votes(rig):
    process(rig)
    process(rig, [row(score=.39)])
    observed = process(rig, [row(score=.39)])[0]
    assert observed["stable_id"] is None


def test_alternating_people_never_accumulate_each_others_votes(rig):
    for index in [0, 1] * 8:
        observed = process(rig, [row(index)])[0]
        assert observed["match"]["id"] == rig[2 + index]
        assert observed["stable_id"] is None


def test_positive_contradiction_clears_old_name_before_new_confirmation(rig):
    process(rig)
    assert process(rig)[0]["stable_id"] == rig[2]
    assert process(rig, [row(1)])[0]["stable_id"] is None
    assert process(rig, [row(1)])[0]["stable_id"] == rig[3]


def test_old_name_cannot_survive_alternating_other_person_and_unknown(rig):
    process(rig)
    process(rig)
    observed = [process(rig, [row(1, .39 if i % 2 else .60)])[0] for i in range(10)]
    assert all(face["stable_id"] != rig[2] for face in observed)
    assert observed[-2]["stable_id"] == rig[3]


def test_three_unknown_observations_expire_a_confirmed_identity(rig):
    process(rig)
    process(rig)
    assert process(rig, [row(score=.39)])[0]["stable_id"] == rig[2]
    assert process(rig, [row(score=.39)])[0]["stable_id"] == rig[2]
    assert process(rig, [row(score=.39)])[0]["stable_id"] is None


def test_unknown_retention_also_expires_by_elapsed_time_without_track_loss(rig):
    process(rig)
    last = process(rig)[0]
    assert process(rig, [row(score=.39)], after=.8)[0]["stable_id"] == rig[2]
    expired = process(rig, [row(score=.39)], after=.4)[0]
    assert expired["track_id"] == last["track_id"]
    assert expired["stable_id"] is None


def test_track_loss_still_requires_fresh_confirmation(rig):
    process(rig)
    old = process(rig)[0]
    process(rig, [], after=.5)
    returned = process(rig, after=.6)[0]
    assert returned["track_id"] != old["track_id"]
    assert returned["stable_id"] is None
    assert process(rig)[0]["stable_id"] == rig[2]


def test_crossing_people_do_not_inherit_each_others_displayed_name(rig):
    left, right = [0, 0, 100, 100], [300, 0, 400, 100]
    process(rig, [row(0, box=left), row(1, box=right)])
    confirmed = process(rig, [row(0, box=left), row(1, box=right)])
    assert [face["stable_id"] for face in confirmed] == [rig[2], rig[3]]
    crossing = process(rig, [row(1, box=left), row(0, box=right)])
    assert all(face["stable_id"] is None for face in crossing)
    settled = process(rig, [row(1, box=left), row(0, box=right)])
    assert [face["stable_id"] for face in settled] == [rig[3], rig[2]]
