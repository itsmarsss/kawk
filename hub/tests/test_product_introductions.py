"""Spoken names keep a stable person UUID, persistence and visible labels together."""
import copy

import numpy as np
import pytest

from tools.perception_lab.faces import FaceSession, Gallery
from tools.perception_lab.product import ProductSession
from tools.perception_lab.product_routes import ProductSessions


@pytest.fixture
def names(tmp_path):
    gallery = Gallery(tmp_path / "gallery.npz")
    embedding = np.eye(1, 512, dtype=np.float32)[0]
    person = gallery.enroll("Old Name", [embedding] * 5)
    manager = ProductSessions(gallery, lambda _: True)
    return gallery, embedding, person, manager


def observe(product, ident, *, track=1, count=3, multiple=False):
    for i in range(count):
        rows = [{"track_id": track, "stable_id": ident, "box": [100, 70, 280, 270]}]
        if multiple:
            rows.append({"track_id": 9, "stable_id": None, "box": [350, 70, 540, 270]})
        product.ingest_faces({"type": "frame", "faces": rows, "input_wh": [640, 480],
                              "detected_count": len(rows)}, stream_id="faces-1")


def speaking(product):
    product.set_capture(camera="live", microphone="live")
    for kind in ("faces", "speech"):
        product.stream_state(kind, True, stream_id=kind + "-1")


def pending(product, value):
    product.ingest_transcript({"segment_id": "intro", "text": value, "is_final": True},
                              stream_id="speech-1", execute_rules=False)
    return product.pending_transcript_decision("intro", stream_id="speech-1")


def decide(product, token, allowed=True):
    return product.apply_transcript_decision(token, {"intent": "introduction", "directed": False,
                                                     "allow_introduction": allowed})


@pytest.mark.parametrize(("spoken", "expected"), [
    ("Hi there, my name is William and I build robots.", "William"),
    ("Actually, my name's Maya Chen. Nice to meet you.", "Maya Chen"),
    ("I'm María-José and I like coffee.", "María-José"),
    ("You can call me Jean Luc.", "Jean Luc"),
    ("Hey, this is Jamie O'Neill from work.", "Jamie O'Neill"),
])
def test_name_candidate_is_exact_spoken_text_for_jev_to_validate(spoken, expected):
    assert ProductSession._parse(spoken) == ("introduction", expected)


@pytest.mark.asyncio
async def test_spoken_correction_keeps_profile_notes_encounter_and_updates_every_label(names):
    gallery, embedding, person, manager = names
    created = await manager.create()
    observer = manager.get((await manager.create())["session_id"])
    product = manager.get(created["session_id"]).product
    speaking(product)
    observe(product, person["id"])
    product.dispatch({"type": "note.save", "payload": {"note": {"profile_id": person["id"], "text": "Likes tea"}}})
    notes, encounters = copy.deepcopy(product.notes), copy.deepcopy(product.encounters)
    faces = FaceSession(gallery)
    frame = {"faces": [{"box": [100, 70, 280, 270], "detection_score": .95, "embedding": embedding}], "detected_count": 1}
    faces.process(frame)
    assert faces.process(frame)["faces"][0]["stable_name"] == "Old Name"
    token = pending(product, "Actually, my name is William and I build robots.")
    assert 'INTRODUCTION_NAME_CANDIDATE "William"' in product.decision_state()
    assert "INTRODUCTION_TARGET=single_stable_known" in product.decision_state()
    assert decide(product, token)
    assert product.profiles[person["id"]]["name"] == "William"
    assert observer.product.profiles[person["id"]]["name"] == "William"
    assert product.display["card"]["title"] == "William"
    assert product.notes == notes and product.encounters == encounters
    assert Gallery(gallery.path).list() == [{"id": person["id"], "name": "William"}]
    assert faces.process(frame)["faces"][0]["stable_name"] == "William"
    assert not decide(product, token)  # one final cannot be applied twice
    await manager.close()


@pytest.mark.parametrize("change", ["gate_rejected", "replacement", "identity", "multiple", "stream", "stale", "no_initial_face"])
def test_name_cannot_transfer_to_another_person_or_bypass_jev(change):
    now = [100.0]
    renamed = []
    product = ProductSession("test", lambda _: None, clock=lambda: now[0],
                             gallery_people=[{"id": "a", "name": "Alex"}, {"id": "b", "name": "Bob"}],
                             rename_person=lambda pid, name: renamed.append((pid, name)))
    speaking(product)
    if change != "no_initial_face":
        observe(product, "a")
    token = pending(product, "My name is William")
    if change == "replacement":
        observe(product, "a", track=2)
    elif change == "identity":
        observe(product, "b")
    elif change == "multiple":
        observe(product, "a", multiple=True)
    elif change == "stream":
        product.stream_state("faces", True, stream_id="faces-2")
    elif change == "stale":
        now[0] += 1.1
    elif change == "no_initial_face":
        observe(product, "a")
    assert not decide(product, token, change != "gate_rejected")
    assert not renamed


def test_new_face_introduction_enrolls_specific_track_after_jev_accepts():
    controls = []
    product = ProductSession("test", lambda _: None, control=controls.append)
    speaking(product)
    observe(product, None, track=7)
    token = pending(product, "Hello everyone, I'm Maya Chen and I work on robotics")
    assert decide(product, token)
    assert controls[-1]["name"] == "Maya Chen"
    assert controls[-1]["target_track_id"] == "7"
    observe(product, None, track=7, count=1)
    product._enrollment_frame({"status": "complete", "target_track_id": "7",
                               "person": {"id": "real-new-uuid", "name": "Maya Chen"}})
    assert product.profiles["real-new-uuid"]["name"] == "Maya Chen"


def test_gallery_rename_failure_keeps_original_name_and_vector(names, monkeypatch):
    gallery, embedding, person, _ = names
    def fail():
        raise OSError("read only")
    monkeypatch.setattr(gallery, "save", fail)
    with pytest.raises(OSError):
        gallery.rename(person["id"], "Maya")
    assert gallery.list() == [person]
    assert np.array_equal(gallery.entries[person["id"]][1], embedding)


@pytest.mark.parametrize(("spoken", "intent"), [
    ("Remember that my name is William", "note"),
    ("Remind me to ask Maya what her name is", "reminder"),
])
def test_introduction_candidate_does_not_replace_explicit_command(spoken, intent):
    assert ProductSession._parse(spoken)[0] == intent
