"""Memory-page introductions: final speech, temporal binding and reset races."""

import asyncio

import numpy as np
import pytest
from remember_hub.contracts.decisions import GateAnswer

from tools.perception_lab.faces import FaceSession, Gallery
from tools.perception_lab.introductions import IntroductionController, name_choices


class Backend:
    def __init__(self, *, allowed=True, name="Maya Chen", wait=None):
        self.allowed, self.name, self.wait = allowed, name, wait
        self.calls = 0

    async def decide(self, state, questions):
        self.calls += 1
        assert self.name in questions[1].choices
        if self.wait:
            await self.wait.wait()
        return [
            GateAnswer(key="introduction", kind="noul", probability=0.99 if self.allowed else 0.01),
            GateAnswer(key="name", kind="choice", choice=self.name, probability=0.99),
        ]

    async def aclose(self):
        pass


@pytest.fixture
def rig(tmp_path, monkeypatch):
    now = [100.0]
    monkeypatch.setattr("tools.perception_lab.faces.time.monotonic", lambda: now[0])
    faces = FaceSession(Gallery(tmp_path / "gallery.npz"))
    backend, messages = Backend(), []

    async def send(m):
        messages.append(m)

    controller = IntroductionController(
        faces, backend, send, faces.gallery.rename, clock=lambda: now[0]
    )

    def frame(index=0, count=1):
        now[0] += 0.2
        vector = np.zeros(512, dtype=np.float32)
        vector[index] = 1
        result = faces.process(
            {
                "faces": [{"box": [0, 0, 100, 100], "detection_score": 0.99, "embedding": vector}]
                if count
                else [],
                "detected_count": count,
            }
        )
        controller.observe()
        return result

    for _ in range(5):
        frame()

    def speech(**extra):
        return {
            "type": "introduction",
            "text": "Hello, my name is Maya Chen and I build robots.",
            "is_final": True,
            "stream_id": "speech-one",
            "segment_id": "one",
            "revision": 2,
            "start_at": 100200,
            "end_at": 101000,
            **extra,
        }

    return faces, controller, backend, messages, frame, speech, now


@pytest.mark.asyncio
async def test_final_name_requires_jev_then_five_samples_and_updates_recognition(rig):
    faces, c, b, m, frame, speech, _ = rig
    await c.receive(speech())
    await c.task
    assert m[-1]["status"] == "collecting"
    for _ in range(5):
        result = frame()
    assert result["enrollment"]["status"] == "complete"
    frame()
    result = frame()
    assert result["faces"][0]["stable_name"] == "Maya Chen"
    assert Gallery(faces.gallery.path).list()[0]["name"] == "Maya Chen"
    await c.close()


@pytest.mark.asyncio
async def test_partials_and_duplicate_or_corrected_final_cannot_rename_twice(rig):
    faces, c, b, m, _, speech, _ = rig
    await c.receive(speech(is_final=False))
    assert b.calls == 0
    await c.receive(speech())
    await c.task
    await c.receive(speech(revision=3, text="My name is Someone Else."))
    assert b.calls == 1 and faces.enrolling["name"] == "Maya Chen"
    await c.close()


@pytest.mark.asyncio
async def test_rejected_name_mention_does_not_enroll(rig):
    faces, c, b, m, _, speech, _ = rig
    b.allowed = False
    await c.receive(speech(text="My friend Maya Chen is elsewhere."))
    await c.task
    assert m[-1]["status"] == "ignored" and faces.enrolling is None
    await c.close()


@pytest.mark.asyncio
async def test_rename_retains_gallery_id(rig):
    faces, c, b, m, frame, speech, _ = rig
    person = faces.gallery.enroll("Old Name", [faces.tracks[0]["embedding"]] * 5)
    for _ in range(3):
        frame()
    await c.receive(speech())
    await c.task
    assert m[-1]["person_id"] == person["id"]
    assert faces.gallery.list() == [{"id": person["id"], "name": "Maya Chen"}]
    await c.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["replacement", "second_face", "missing", "reset"])
async def test_changed_target_or_delete_during_jev_cannot_save_name(rig, change):
    faces, c, b, m, frame, speech, _ = rig
    release = asyncio.Event()
    b.wait = release
    await c.receive(speech())
    await asyncio.sleep(0)
    if change == "reset":
        c.invalidate()
    else:
        frame(
            index=1 if change == "replacement" else 0,
            count=2 if change == "second_face" else 0 if change == "missing" else 1,
        )
    release.set()
    await asyncio.gather(c.task, return_exceptions=True)
    assert not faces.gallery.list() and faces.enrolling is None
    await c.close()


@pytest.mark.asyncio
async def test_two_faces_during_utterance_and_stale_speech_are_rejected_before_model(rig):
    faces, c, b, m, frame, speech, now = rig
    frame(count=2)
    frame()
    await c.receive(speech(end_at=now[0] * 1000))
    assert b.calls == 0
    await c.receive(speech(segment_id="old", start_at=1000, end_at=2000))
    assert b.calls == 0
    await c.close()


@pytest.mark.asyncio
async def test_known_person_replaced_by_unknown_at_same_geometry_cannot_inherit_intro(rig):
    faces, c, b, m, frame, speech, now = rig
    faces.gallery.enroll("Original", [faces.tracks[0]["embedding"]] * 5)
    for _ in range(3):
        frame()
    old_track = faces.tracks[0]["track_id"]
    for _ in range(3):
        frame(index=1)
    assert faces.tracks[0]["track_id"] == old_track  # IoU/coasting alone is insufficient.
    await c.receive(speech(end_at=now[0] * 1000))
    assert b.calls == 0 and faces.enrolling is None
    await c.close()


def test_candidate_names_are_exact_spans_bounded_and_not_prefix_grammar():
    text = "Nice to meet you, Maya Chen here. People call me Jean-Luc."
    choices = name_choices(text)
    assert "Maya Chen" in choices and "Jean-Luc" in choices
    assert all(v == "(none)" or v in text for v in choices)
    assert len(name_choices(" ".join("Name" for _ in range(1000)))) <= 255
