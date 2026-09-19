"""Fast unit tests: gallery, snapshot buckets, name extraction, jev_mock rules."""

import numpy as np
import pytest
from remember_hub.contracts.decisions import Intent, Question
from remember_hub.gate.jev_mock import JevMock
from remember_hub.memory.faces import FaceGallery, ModelTagMismatch
from remember_hub.perception.face.mock import tag_vector
from remember_hub.tasks.enroll_person import extract_name
from remember_hub.world.snapshot import (
    display_age_bucket,
    dwell_bucket,
    proximity_bucket,
)


def test_gallery_enroll_and_match_roundtrip():
    g = FaceGallery()
    base = tag_vector("sarah")
    samples = []
    rng = np.random.default_rng(7)
    for _ in range(5):
        v = base + 0.03 * rng.standard_normal(512).astype(np.float32)
        samples.append((v / np.linalg.norm(v)).tolist())
    g.enroll("p-1", "Sarah", samples, "mock")
    query = base + 0.03 * rng.standard_normal(512).astype(np.float32)
    query = (query / np.linalg.norm(query)).tolist()
    m = g.match(query, "mock", threshold=0.40)
    assert m is not None and m.name == "Sarah" and m.sim > 0.6
    # a different person does not match
    other = tag_vector("bob").tolist()
    assert g.match(other, "mock", threshold=0.40) is None


def test_gallery_hard_fails_on_model_tag_mismatch():
    g = FaceGallery()
    g.enroll("p-1", "Sarah", [tag_vector("sarah").tolist()], "mock")
    with pytest.raises(ModelTagMismatch):
        g.match(tag_vector("sarah").tolist(), "buffalo_l", threshold=0.40)


def test_gallery_persistence_roundtrip(tmp_path):
    path = tmp_path / "faces.npz"
    g = FaceGallery(path)
    g.enroll("p-1", "Sarah", [tag_vector("sarah").tolist()], "mock")
    g2 = FaceGallery(path)
    assert g2.names == ["Sarah"] and len(g2) == 1
    assert g2.enrolled_at("p-1") is not None


def test_snapshot_buckets():
    assert dwell_bucket(1) == "brief"
    assert dwell_bucket(10) == "short"
    assert dwell_bucket(20) == "long"
    assert proximity_bucket(0.2) == "near"
    assert proximity_bucket(0.05) == "mid"
    assert proximity_bucket(0.01) == "far"
    assert display_age_bucket(2) == "fresh"
    assert display_age_bucket(10) == "aging"
    assert display_age_bucket(20) == "stale"


def test_extract_name():
    assert extract_name("this is Sarah") == "Sarah"
    assert extract_name("Their name is jordan lee") == "Jordan Lee"
    assert extract_name("sarah") == "Sarah"
    assert extract_name("um so this is my very good friend from waterloo") is None


async def test_jev_mock_keys_flow():
    jev = JevMock()
    state = (
        "TIME 21:47:03  SPEECH yes  DISPLAY idle(fresh)\n"
        "OBJECTS: desk#d1 center-lower near dwell=long\n"
        "PEOPLE: none. user_in_conversation=no\n"
        "LAST_SEEN: keys@21:46 near[desk]\n"
        "EVENTS_30S: keys last-seen recorded\n"
        'TRANSCRIPT_15S: [user] "where are my keys"'
    )
    bank = [
        Question(key="addressed", kind="noul", instructions="."),
        Question(key="intent", kind="choice", instructions=".", choices=[i.value for i in Intent]),
        Question(
            key="find_target",
            kind="choice",
            instructions=".",
            choices=["desk", "keys", "none of these"],
        ),
    ]
    answers = await jev.ask(state, bank)
    assert answers["addressed"].noul >= 0.65
    assert answers["intent"].choice == Intent.FIND_OBJECT.value
    assert answers["find_target"].choice == "keys"


async def test_jev_mock_not_addressed_smalltalk():
    jev = JevMock()
    state = 'TRANSCRIPT_15S: [user] "yeah I keep losing stuff"'
    bank = [Question(key="addressed", kind="noul", instructions=".")]
    answers = await jev.ask(state, bank)
    assert answers["addressed"].noul < 0.5
