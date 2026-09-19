"""Contract tests do not load models, open devices, or call the cloud."""
import json

import numpy as np
import pytest

from .faces import FaceSession, Gallery, unit
from .speech import transcript_event


def vector(index=0):
    v = np.zeros(512, dtype=np.float32)
    v[index] = 1
    return v


def frame(v, count=1):
    return {"detected_count": count, "faces": [{"box": [0, 0, 100, 100], "detection_score": 0.95, "embedding": v}]}


def test_enrollment_persistence_and_unknown(tmp_path):
    path = tmp_path / "gallery.npz"
    gallery = Gallery(path)
    entry = gallery.enroll("Tester", [vector()] * 5)
    gallery = Gallery(path)
    assert gallery.match(vector())["id"] == entry["id"]
    assert gallery.match(vector(1))["id"] is None
    assert gallery.delete(entry["id"])
    assert Gallery(path).list() == []


def test_invalid_enrollment_rejected(tmp_path):
    gallery = Gallery(tmp_path / "gallery.npz")
    with pytest.raises(ValueError, match="5–10"):
        gallery.enroll("Tester", [vector()])
    with pytest.raises(ValueError, match="Faces changed"):
        gallery.enroll("Tester", [vector()] * 4 + [vector(1)])
    with pytest.raises(ValueError):
        unit(np.zeros(512))


def test_cross_model_gallery_fails(tmp_path):
    path = tmp_path / "gallery.npz"
    np.savez(path, model="buffalo_s")
    with pytest.raises(ValueError, match="mismatch"):
        Gallery(path)


def test_enrollment_resets_on_multiple_faces_and_stabilizes(tmp_path):
    session = FaceSession(Gallery(tmp_path / "gallery.npz"))
    session.begin_enrollment("Tester")
    for _ in range(3):
        session.process(frame(vector()))
    assert session.process(frame(vector(), count=2))["enrollment"]["collected"] == 0
    for _ in range(5):
        result = session.process(frame(vector()))
    assert result["enrollment"]["status"] == "complete"
    for _ in range(2):
        assert session.process(frame(vector()))["faces"][0]["stable_name"] is None
    assert session.process(frame(vector()))["faces"][0]["stable_name"] == "Tester"
    for _ in range(3):
        result = session.process(frame(vector(1)))
    assert result["faces"][0]["stable_name"] is None


def test_whisper_revision_keeps_same_id():
    payload = {"type": "transcription", "transcription_num": 8, "is_final": False,
               "segments": [{"text": " Where is", "word_timestamps": []}]}
    partial = transcript_event(json.dumps(payload))
    payload.update(is_final=True, segments=[{"text": "Where are my keys?", "word_timestamps": [{"word": "Where"}]}])
    final = transcript_event(json.dumps(payload))
    assert partial["segment_id"] == final["segment_id"] == "8"
    assert final["is_final"] and final["text"] == "Where are my keys?"
    assert final["words"] == [{"word": "Where"}]


async def test_local_speech_socket_failure_closes_generator_before_restart(monkeypatch):
    import asyncio

    from remember_hub.contracts.percepts import TranscriptSegment

    from . import experiments

    class Backend:
        active = False
        load_ms = 1
        last_timings_ms = {}

        async def load(self):
            assert not self.active

        async def stream(self, chunks):
            assert not self.active
            self.active = True
            try:
                yield TranscriptSegment(seg_id="fixture", text="keys", is_final=False)
                await asyncio.Future()
            finally:
                self.active = False

    class Socket:
        closed = False

        async def receive(self):
            await asyncio.Future()

        async def send_json(self, event):
            if event["type"] == "transcript":
                raise RuntimeError("Disconnected while receiving text")

        async def close(self):
            self.closed = True

    backend = Backend()
    monkeypatch.setattr(experiments, "_local_speech", backend)
    monkeypatch.setattr(experiments, "speech_local_lock", asyncio.Lock())
    for _ in range(2):
        socket = Socket()
        await experiments.local_speech_socket(socket)
        assert socket.closed and not backend.active
        assert not experiments.speech_local_lock.locked()


async def test_invalid_object_vocabulary_does_not_load_a_model():
    from .experiments import objects_socket

    class Socket:
        query_params = {"backend": "local", "vocabulary": ",".join(f"item{i}" for i in range(21))}
        events = []
        closed = False

        async def send_json(self, event):
            self.events.append(event)

        async def close(self):
            self.closed = True

    socket = Socket()
    await objects_socket(socket)
    assert socket.closed
    assert socket.events[0]["type"] == "error"
    assert "1–20" in socket.events[0]["message"]
