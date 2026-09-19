"""Track-bound introductions cannot silently enroll a different visible person."""

import numpy as np
import pytest

from tools.perception_lab.faces import FaceSession, Gallery


def embedding(index=0):
    value = np.zeros(512, dtype=np.float32)
    value[index] = 1
    return value


def frame(index=0, *, box=None, detected_count=1, visible=True):
    faces = []
    if visible:
        faces.append({"box": box or [0, 0, 100, 100], "detection_score": 0.95,
                      "embedding": embedding(index)})
    return {"faces": faces, "detected_count": detected_count}


@pytest.fixture
def session(tmp_path, monkeypatch):
    clock = {"now": 100.0}
    monkeypatch.setattr("tools.perception_lab.faces.time.monotonic", lambda: clock["now"])
    value = FaceSession(Gallery(tmp_path / "gallery.npz"))
    return value, clock


def start_bound(value):
    track_id = value.process(frame())["faces"][0]["track_id"]
    value.begin_enrollment("Alex", target_track_id=track_id)
    return track_id


def assert_aborted(value, result, reason):
    assert result["enrollment"]["status"] == "error"
    assert result["enrollment"]["reason"] == reason
    assert result["enrollment"]["message"]
    assert value.enrolling is None
    assert value.gallery.list() == []
    assert not value.gallery.path.exists()
    assert value.process(frame())["enrollment"] is None


def test_bound_enrollment_saves_only_five_samples_of_the_chosen_track(session):
    value, _ = session
    target = start_bound(value)
    for expected in range(1, 6):
        result = value.process(frame())["enrollment"]
        assert result["target_track_id"] == target
        assert result["collected"] == expected
        assert result["status"] == ("complete" if expected == 5 else "collecting")
    assert result["reason"] == "enrollment_complete"
    restored = Gallery(value.gallery.path)
    assert restored.match(embedding())["name"] == "Alex"
    assert restored.match(embedding(1))["id"] is None
    assert value.enrolling is None


@pytest.mark.parametrize("target", [True, 0, -1, "0", "01", "-1", "1.0", " 1", "1 ", "+1", "١", 1.0, 99])
def test_invalid_or_unobserved_binding_is_rejected_without_starting(session, target):
    value, _ = session
    value.process(frame())
    with pytest.raises(ValueError):
        value.begin_enrollment("Alex", target_track_id=target)
    assert value.enrolling is None


def test_disappeared_coasting_track_cannot_start_an_introduction(session):
    value, _ = session
    target = value.process(frame())["faces"][0]["track_id"]
    value.process(frame(visible=False, detected_count=0))
    assert value.tracks  # It still exists for recognition's normal one-second coasting.
    with pytest.raises(ValueError, match="no longer in view"):
        value.begin_enrollment("Alex", target_track_id=target)


def test_stale_track_cannot_start_an_introduction(session):
    value, clock = session
    target = value.process(frame())["faces"][0]["track_id"]
    clock["now"] += 1.1
    with pytest.raises(ValueError, match="no longer in view"):
        value.begin_enrollment("Alex", target_track_id=target)


def test_even_a_small_second_detected_face_blocks_the_initial_binding(session):
    value, _ = session
    target = value.process(frame(detected_count=2))["faces"][0]["track_id"]
    with pytest.raises(ValueError, match="only the introduced person"):
        value.begin_enrollment("Alex", target_track_id=target)


def test_raw_known_match_blocks_binding_before_stable_votes(session):
    value, _ = session
    value.gallery.enroll("Existing", [embedding()] * 5)
    observed = value.process(frame())["faces"][0]
    assert observed["stable_id"] is None
    with pytest.raises(ValueError, match="already recognized"):
        value.begin_enrollment("Alex", target_track_id=observed["track_id"])
    assert len(value.gallery.list()) == 1


def test_bound_target_disappearance_aborts_instead_of_collecting_a_replacement(session):
    value, _ = session
    start_bound(value)
    value.process(frame())
    result = value.process(frame(visible=False, detected_count=0))
    assert_aborted(value, result, "target_missing")


def test_another_detected_face_aborts_even_when_it_is_too_small_to_embed(session):
    value, _ = session
    start_bound(value)
    value.process(frame())
    assert_aborted(value, value.process(frame(detected_count=2)), "ambiguous_faces")


def test_changed_track_aborts_even_if_embedding_is_the_same(session):
    value, _ = session
    target = start_bound(value)
    result = value.process(frame(box=[300, 300, 400, 400]))
    assert result["faces"][0]["track_id"] != target
    assert_aborted(value, result, "target_changed")


@pytest.mark.parametrize("collected", [0, 2])
def test_same_box_replacement_cannot_take_over_a_bound_introduction(session, collected):
    value, _ = session
    target = start_bound(value)
    for _ in range(collected):
        value.process(frame())
    result = value.process(frame(index=1))
    assert result["faces"][0]["track_id"] != target  # Embedding continuity overrides IoU.
    assert result["enrollment"]["collected"] == collected
    assert_aborted(value, result, "target_changed")


def test_becoming_known_aborts_without_overwriting_the_existing_enrollment(session):
    value, _ = session
    start_bound(value)
    value.process(frame())
    person = value.gallery.enroll("Existing", [embedding()] * 5)
    result = value.process(frame())["enrollment"]
    assert result["status"] == "error"
    assert result["reason"] == "target_known"
    assert value.enrolling is None
    assert value.gallery.list() == [person]
    assert Gallery(value.gallery.path).list() == [person]


def test_bound_introduction_times_out_without_saving_partial_samples(session):
    value, clock = session
    start_bound(value)
    value.process(frame())
    clock["now"] += 31
    assert_aborted(value, value.process(frame()), "enrollment_timeout")


def test_manual_enrollment_keeps_existing_reset_and_retry_behavior(session):
    value, _ = session
    value.begin_enrollment("Manual")
    for _ in range(3):
        value.process(frame())
    assert value.process(frame(detected_count=2))["enrollment"]["collected"] == 0
    assert value.enrolling is not None
    for _ in range(5):
        result = value.process(frame(index=1))["enrollment"]
    assert result["status"] == "complete"
    assert value.gallery.match(embedding(1))["name"] == "Manual"
    assert value.gallery.match(embedding())["id"] is None


def test_product_introduction_control_binds_actual_face_session_and_completes(session):
    from tools.perception_lab.product import ProductSession

    faces, clock = session
    events, controls = [], []
    product = ProductSession("bound-contract", events.append, lambda: clock["now"],
                             control=controls.append)
    product.set_capture(camera="live")
    product.stream_state("faces", True, stream_id="faces-connection")

    def ingest():
        result = faces.process(frame())
        product.ingest_faces({**result, "input_wh": [640, 480], "detected_count": 1,
                              "observed_at": clock["now"]}, stream_id="faces-connection")
        return result

    for _ in range(3):
        ingest()
        clock["now"] += .2
    product.dispatch({"type": "enrollment.introduction", "payload": {"name": "Alex"}})
    control = controls[-1]
    assert control["type"] == "enroll"
    assert control["target_track_id"] == "1"
    faces.begin_enrollment(control["name"], target_track_id=control["target_track_id"])
    assert faces.enrolling["target_track_id"] == 1
    for _ in range(5):
        result = ingest()
        clock["now"] += .2
    person = result["enrollment"]["person"]
    assert product.profiles[person["id"]]["name"] == "Alex"
    assert faces.gallery.list() == [person]
    assert faces.enrolling is None
    assert product.enrollment is None


def test_replacement_before_enrollment_start_cannot_inherit_the_introduced_track(session):
    value, _ = session
    introduced = value.process(frame())["faces"][0]["track_id"]
    replacement = value.process(frame(index=1))["faces"][0]["track_id"]
    assert replacement != introduced
    with pytest.raises(ValueError, match="no longer in view"):
        value.begin_enrollment("Maya", target_track_id=introduced)
    assert value.enrolling is None
    assert value.gallery.list() == []


def test_gate_wait_cannot_bind_a_name_to_an_unknown_same_box_replacement(session):
    from tools.perception_lab.product import ProductSession

    faces, clock = session
    controls = []
    product = ProductSession("pending-intro", lambda event: None, lambda: clock["now"],
                             control=controls.append)
    product.set_capture(camera="live", microphone="live")
    product.stream_state("faces", True, stream_id="f")
    product.stream_state("speech", True, stream_id="s")

    def ingest(index):
        result = faces.process(frame(index=index))
        product.ingest_faces({**result, "input_wh": [640, 480], "detected_count": 1,
                              "observed_at": clock["now"]}, stream_id="f")

    for _ in range(3):
        ingest(0)
        clock["now"] += .2
    product.ingest_transcript({"segment_id": "intro", "text": "I'm Maya", "is_final": True},
                              stream_id="s", execute_rules=False)
    token = product.pending_transcript_decision("intro", stream_id="s")
    for _ in range(3):
        ingest(1)
        clock["now"] += .2
    assert not product.apply_transcript_decision(token, {
        "directed": False, "allow_introduction": True, "intent": "introduction"})
    assert not controls
    assert faces.gallery.list() == []
