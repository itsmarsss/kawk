"""Deletion uses isolated galleries, note stores and capture sessions."""
import time
from contextlib import asynccontextmanager

import numpy as np
import pytest

from tools.perception_lab.faces import Gallery
from tools.perception_lab.product import ProductSession, iso
from tools.perception_lab.product_memory import NoteMemory


def command(session, kind, **payload):
    return session.dispatch({"type": kind, "payload": payload})


def observe_person(session, ident="person-a"):
    session.set_capture(camera="live")
    session.stream_state("faces", True, stream_id="faces-1")
    session.ingest_faces({"faces": [{"track_id": 1, "box": [100, 70, 280, 270],
                                    "stable_id": ident, "detection_score": .95}],
                          "input_wh": [640, 480]}, stream_id="faces-1")


def test_person_deletion_cascades_but_keeps_other_people_and_moments():
    events = []
    session = ProductSession("delete-test", events.append,
                             gallery_people=[{"id": "person-a", "name": "Alex"},
                                             {"id": "person-b", "name": "Alex"}],
                             trigger_clip=lambda _: None)
    for ident in session.profiles:
        command(session, "note.save", note={"profile_id": ident, "text": "Likes tea"})
        command(session, "reminder.save", reminder={"profile_id": ident, "text": "Return book"})
    observe_person(session)
    moment = command(session, "moment.mark", profile_ids=["person-a", "person-b"])["moment_id"]
    session.ask("Who is this?")
    assert session._last_answer["profile_id"] == "person-a"

    command(session, "profile.delete", profile_id="person-a")
    assert set(session.profiles) == {"person-b"}
    assert {n["profile_id"] for n in session.notes.values()} == {"person-b"}
    assert {r["profile_id"] for r in session.reminders.values()} == {"person-b"}
    assert session.encounters == session.active == {}
    assert session.foreground is None and session._last_answer is None
    assert session.display["card"]["template"] == "idle"
    assert session.moments[moment]["profile_ids"] == ["person-b"]
    assert any(e["type"] == "profile.deleted" for e in events)
    observe_person(session)  # A delayed old face result cannot restore the identity.
    assert session.foreground is None and "person-a" not in session.profiles
    command(session, "profile.delete", profile_id="person-a")  # Safe retry.
    assert session.moments[moment]["profile_ids"] == ["person-b"]
    with pytest.raises(ValueError, match="deleted"):
        session._gallery_profile({"id": "person-a", "name": "Alex"})


def test_person_delete_rejects_objects_and_invalid_ids():
    session = ProductSession("delete-test", lambda _: None)
    session.profiles["object:keys"] = {"id": "object:keys", "kind": "object"}
    for ident in ("", None, 42, "object:keys"):
        with pytest.raises(ValueError):
            command(session, "profile.delete", profile_id=ident)
    assert "object:keys" in session.profiles


def test_moment_delete_clears_playback_and_late_completion():
    session = ProductSession("delete-test", lambda _: None, trigger_clip=lambda _: None)
    session.set_capture(camera="live")
    ident = command(session, "moment.mark")["moment_id"]
    session._last_answer = {"moment_id": ident}
    session.display["card"]["clip_id"] = ident
    command(session, "moment.delete", moment_id=ident)
    assert ident not in session.moments
    assert "clip_id" not in session.display["card"]
    assert "moment_id" not in session._last_answer
    assert not session.clip_completed(ident, {})
    assert not session.clip_failed(ident, "late error")


@pytest.mark.asyncio
async def test_moment_delete_disk_failure_does_not_publish_deleted(monkeypatch):
    from tools.perception_lab.product_routes import BrowserSession

    session = BrowserSession([])
    try:
        session.product.moments["saved-moment"] = {"id": "saved-moment", "status": "saved"}

        async def fail(_):
            raise OSError("disk unavailable")

        monkeypatch.setattr(session.clips, "delete", fail)
        with pytest.raises(RuntimeError, match="please retry"):
            await session.receive_json({"type": "command", "request_id": "delete",
                "command": {"type": "moment.delete", "payload": {"moment_id": "saved-moment"}}})
        assert "saved-moment" in session.product.moments
        assert not any(item.get("type") == "moment.deleted" for item in session.queue._queue)
    finally:
        await session.close()


def test_gallery_failed_save_restores_in_memory_identity(tmp_path, monkeypatch):
    gallery = Gallery(tmp_path / "gallery.npz")
    gallery.entries["person-a"] = ("Alex", np.ones(512, dtype=np.float32) / np.sqrt(512))
    gallery.save()

    def fail():
        raise OSError("disk unavailable")

    monkeypatch.setattr(gallery, "save", fail)
    with pytest.raises(OSError):
        gallery.delete("person-a")
    assert gallery.list() == Gallery(gallery.path).list()


def test_delete_all_person_notes_beyond_session_load_limit(tmp_path):
    memory = NoteMemory(tmp_path / "notes.sqlite3")
    stamp = iso(time.time())
    try:
        for index in range(260):
            memory.upsert_note({"schema_version": "1.0", "id": str(index),
                                "profile_id": "person-a", "text": "A note",
                                "created_at": stamp, "updated_at": stamp, "source": "user"})
        session = ProductSession("delete-test", lambda _: None,
                                 gallery_people=[{"id": "person-a", "name": "Alex"}],
                                 note_memory=memory)
        assert len(session.notes) == 256
        command(session, "profile.delete", profile_id="person-a")
        assert memory.list_notes(["person-a"]) == []
        assert memory._db().execute("SELECT count(*) FROM personal_notes").fetchone()[0] == 0
    finally:
        memory.close()


def test_socket_deletion_updates_other_sessions_and_survives_reload(tmp_path):
    pytest.importorskip("httpx")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from tools.perception_lab.product_routes import ProductSessions

    gallery = Gallery(tmp_path / "gallery.npz")
    gallery.entries["person-a"] = ("Alex", np.ones(512, dtype=np.float32) / np.sqrt(512))
    gallery.save()
    memory = NoteMemory(tmp_path / "notes.sqlite3")
    manager = ProductSessions(gallery, lambda _: True, note_memory=memory)

    @asynccontextmanager
    async def lifespan(_):
        yield
        await manager.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(manager.router)
    with TestClient(app) as client:
        first = client.post("/api/v1/sessions").json()
        second = client.post("/api/v1/sessions").json()
        for session in manager.sessions.values():
            command(session.product, "note.save", note={"profile_id": "person-a", "text": "Likes tea"})
            command(session.product, "reminder.save", reminder={"profile_id": "person-a", "text": "Return book"})
            observe_person(session.product)
        with client.websocket_connect(first["websocket_url"]) as ws:
            ws.send_json({"type": "command", "request_id": "delete",
                          "command": {"type": "profile.delete", "payload": {"profile_id": "person-a"}}})
            for _ in range(20):
                message = ws.receive_json()
                if message.get("request_id") == "delete":
                    assert message["type"] == "v1.ack", message
                    break
            else:
                pytest.fail("Deletion acknowledgement missing")
        for result in (first, second, client.post("/api/v1/sessions").json()):
            snapshot = client.get("/api/v1/sessions/" + result["session_id"]).json()
            assert snapshot["profiles"] == snapshot["notes"] == snapshot["reminders"] == []
            assert snapshot["encounters"] == []
        assert Gallery(gallery.path).list() == []
        assert memory.list_notes(["person-a"]) == []
