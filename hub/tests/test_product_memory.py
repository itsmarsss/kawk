"""Durability tests use temporary SQLite files and synthetic enrolled-person IDs."""
import copy
import stat
from datetime import UTC, datetime, timedelta

import pytest

from tools.perception_lab.product_memory import NoteMemory, memory_path_for_gallery


def note(ident="note-1", person="enrolled-a", *, index=0, **extra):
    stamp = (datetime(2026, 9, 19, tzinfo=UTC) + timedelta(seconds=index)).isoformat()
    return {"schema_version": "1.0", "id": ident, "profile_id": person,
            "text": "Works on hardware", "created_at": stamp, "updated_at": stamp,
            "source": "user", **extra}


def conversation_note(**extra):
    return note(source="live-agent", attribution="conversation_context", speaker="unknown",
                source_segment_id="speech:final:1", source_session_id="session-a",
                source_encounter_id="encounter-a", decision_model="jev-1.13.0",
                text="I’m meeting my sister for dinner tomorrow.",
                source_text="I’m meeting my sister for dinner tomorrow.", **extra)


def test_provenance_survives_reopen_edit_and_delete_without_reappearing(tmp_path):
    path = tmp_path / "gallery.memory.sqlite3"
    original = conversation_note()
    store = NoteMemory(path)
    store.upsert_note(original)
    assert store.list_notes(["enrolled-a"]) == [original]
    store.close()
    reopened = NoteMemory(path)
    try:
        assert reopened.list_notes(["enrolled-a"]) == [original]
        normalized_variant = "  I'M meeting  my sister for DINNER tomorrow?!  "
        assert reopened.conversation_seen("enrolled-a", normalized_variant)
        assert not reopened.conversation_seen("enrolled-b", normalized_variant)
        edited = {**original, "text": "Dinner with their sister tomorrow", "edited_by_user": True}
        reopened.upsert_note(edited)
        assert reopened.list_notes(["enrolled-a"]) == [edited]
        reopened.delete_note(original["id"])
        assert reopened.list_notes(["enrolled-a"]) == []
        assert reopened.conversation_seen("enrolled-a", normalized_variant)
    finally:
        reopened.close()
    final = NoteMemory(path)
    try:
        assert final.list_notes(["enrolled-a"]) == []
        assert final.conversation_seen("enrolled-a", original["source_text"])
        assert original["source_text"].encode() not in path.read_bytes()
        fingerprints = final._db().execute("SELECT profile_id, digest FROM conversation_fingerprints").fetchall()
        assert len(fingerprints) == 1
        assert len(fingerprints[0]["digest"]) == 64
    finally:
        final.close()


def test_person_scoped_bounded_load_retains_older_rows(tmp_path):
    store = NoteMemory(tmp_path / "notes.sqlite3")
    try:
        for index in range(260):
            store.upsert_note(note(f"note-{index}", index=index))
        store.upsert_note(note("other", person="enrolled-b", index=300))
        latest = store.list_notes(["enrolled-a"], limit=1000)
        assert len(latest) == 256
        assert latest[0]["id"] == "note-259"
        assert latest[-1]["id"] == "note-4"
        assert len(store.list_notes(["enrolled-b"])) == 1
        assert store.list_notes(["absent", "object:keys"]) == []
        assert store.list_notes(["enrolled-a"], limit=0) == []
        assert store._db().execute("SELECT count(*) FROM personal_notes").fetchone()[0] == 261
        for record in latest:
            store.delete_note(record["id"])
        assert {row["id"] for row in store.list_notes(["enrolled-a"])} == {f"note-{i}" for i in range(4)}
    finally:
        store.close()


def test_parameterized_queries_do_not_interpret_note_or_person_ids_as_sql(tmp_path):
    store = NoteMemory(tmp_path / "notes.sqlite3")
    malicious_id = "x'); DROP TABLE personal_notes; --"
    record = note(malicious_id, person=malicious_id, text="Question marks ? and quotes ' stay text")
    try:
        store.upsert_note(record)
        assert store.list_notes([malicious_id]) == [record]
        store.delete_note(malicious_id)
        assert store.list_notes([malicious_id]) == []
        store.upsert_note(note())
        assert len(store.list_notes(["enrolled-a"])) == 1
    finally:
        store.close()


@pytest.mark.parametrize("change", [
    {"profile_id": "object:keys"}, {"embedding": [0.0]}, {"text": "x" * 1001},
    {"source_text": "x" * 1001}, {"source_segment_id": "x" * 301},
    {"edited_by_user": "yes"}, {"updated_at": "yesterday"}, {"schema_version": "2.0"},
])
def test_unsupported_or_unbounded_data_is_rejected_before_persistence(tmp_path, change):
    store = NoteMemory(tmp_path / "notes.sqlite3")
    try:
        with pytest.raises(ValueError):
            store.upsert_note({**note(), **change})
        assert store.list_notes(["enrolled-a"]) == []
    finally:
        store.close()


def test_note_and_fingerprint_write_are_atomic_and_failure_is_explicit(tmp_path):
    store = NoteMemory(tmp_path / "notes.sqlite3")
    try:
        store._db().execute("""CREATE TRIGGER deny_fingerprint BEFORE INSERT ON conversation_fingerprints
                               BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END""")
        with pytest.raises(RuntimeError, match="Cannot save personal note"):
            store.upsert_note(conversation_note())
        assert store.list_notes(["enrolled-a"]) == []
        assert not store.conversation_seen("enrolled-a", conversation_note()["source_text"])
    finally:
        store.close()
    with pytest.raises(RuntimeError, match="closed"):
        store.list_notes(["enrolled-a"])
    with pytest.raises(RuntimeError, match="closed"):
        store.upsert_note(note())


def test_files_are_private_and_corrupt_store_is_not_replaced(tmp_path):
    path = tmp_path / "notes.sqlite3"
    store = NoteMemory(path)
    try:
        store.upsert_note(note())
        for filename in (path, tmp_path / "notes.sqlite3-wal", tmp_path / "notes.sqlite3-shm"):
            assert filename.exists()
            assert stat.S_IMODE(filename.stat().st_mode) == 0o600
    finally:
        store.close()
    invalid = tmp_path / "invalid.sqlite3"
    invalid.write_bytes(b"not a database")
    with pytest.raises(RuntimeError, match="Cannot open personal note memory"):
        NoteMemory(invalid)
    assert invalid.read_bytes() == b"not a database"


def test_memory_path_follows_actual_gallery_and_explicit_override(tmp_path):
    production = tmp_path / "gallery.npz"
    fixture = tmp_path / "fixture-gallery.npz"
    assert memory_path_for_gallery(production) == tmp_path / "gallery.memory.sqlite3"
    assert memory_path_for_gallery(fixture) == tmp_path / "fixture-gallery.memory.sqlite3"
    assert memory_path_for_gallery(fixture, str(tmp_path / "override.sqlite3")) == tmp_path / "override.sqlite3"
    with pytest.raises(ValueError, match="REMEMBER_MEMORY_PATH"):
        memory_path_for_gallery(fixture, "")
    assert list(tmp_path.iterdir()) == []


async def test_routes_restore_edit_and_delete_person_notes_across_sessions_and_reopen(tmp_path):
    pytest.importorskip("fastapi")
    from tools.perception_lab.product_routes import ProductSessions

    class Gallery:
        def list(self):
            return [{"id": "enrolled-a", "name": "Alex"}, {"id": "enrolled-b", "name": "Alex"}]

    path = tmp_path / "notes.sqlite3"
    store = NoteMemory(path)
    manager = ProductSessions(Gallery(), lambda headers: True, note_memory=store)
    try:
        first = await manager.create()
        first_session = manager.get(first["session_id"])
        result = first_session.product.dispatch({"type": "note.save", "payload": {
            "note": {"profile_id": "enrolled-a", "text": "Builds hardware"}}})
        ident = result["id"]
        await manager.delete(first["session_id"])
        # Closing one tab leaves the shared store open for the next session.
        second = await manager.create()
        assert second["snapshot"]["notes"][0]["id"] == ident
        second_session = manager.get(second["session_id"])
        second_session.product.dispatch({"type": "note.save", "payload": {
            "note": {"id": ident, "profile_id": "enrolled-a", "text": "Builds displays"}}})
        await manager.close()
        with pytest.raises(RuntimeError, match="closed"):
            store.list_notes(["enrolled-a"])
        reopened = NoteMemory(path)
        manager = ProductSessions(Gallery(), lambda headers: True, note_memory=reopened)
        third = await manager.create()
        assert [n["text"] for n in third["snapshot"]["notes"]] == ["Builds displays"]
        assert third["snapshot"]["notes"][0]["profile_id"] == "enrolled-a"
        third_session = manager.get(third["session_id"])
        third_session.product.dispatch({"type": "note.delete", "payload": {"note_id": ident}})
        await manager.delete(third["session_id"])
        fourth = await manager.create()
        assert fourth["snapshot"]["notes"] == []
    finally:
        await manager.close()


async def test_unavailable_note_store_fails_session_creation_without_ephemeral_fallback(tmp_path):
    pytest.importorskip("fastapi")
    from fastapi import HTTPException

    from tools.perception_lab.product_routes import ProductSessions

    class Gallery:
        def list(self):
            return [{"id": "enrolled-a", "name": "Alex"}]

    store = NoteMemory(tmp_path / "notes.sqlite3")
    store.close()
    manager = ProductSessions(Gallery(), lambda headers: True, note_memory=store)
    try:
        with pytest.raises(HTTPException) as error:
            await manager.create()
        assert error.value.status_code == 503
        assert not manager.sessions
    finally:
        await manager.close()


async def test_shared_store_closes_only_after_all_sessions_finish(tmp_path):
    pytest.importorskip("fastapi")
    from tools.perception_lab.product_routes import ProductSessions

    class Gallery:
        def list(self):
            return [{"id": "enrolled-a", "name": "Alex"}]

    store = NoteMemory(tmp_path / "notes.sqlite3")
    manager = ProductSessions(Gallery(), lambda headers: True, note_memory=store)
    created = await manager.create()
    session = manager.get(created["session_id"])
    original_close = session.close
    closed = []

    async def close_session():
        store.upsert_note(note())
        closed.append(True)
        await original_close()

    session.close = close_session
    await manager.close()
    assert closed
    reopened = NoteMemory(tmp_path / "notes.sqlite3")
    try:
        assert reopened.list_notes(["enrolled-a"]) == [note()]
    finally:
        reopened.close()


def test_caller_note_objects_are_not_mutated(tmp_path):
    store = NoteMemory(tmp_path / "notes.sqlite3")
    value = conversation_note()
    original = copy.deepcopy(value)
    try:
        store.upsert_note(value)
        assert value == original
        loaded = store.list_notes(["enrolled-a"])
        loaded[0]["text"] = "Changed only locally"
        assert store.list_notes(["enrolled-a"])[0] == original
    finally:
        store.close()


def test_full_length_conversation_and_provenance_round_trip_without_truncation(tmp_path):
    value = conversation_note()
    value.update(text="a" * 1000, source_text="b" * 1000, source_segment_id="s" * 300,
                 source_session_id="i" * 128, source_encounter_id="e" * 128)
    store = NoteMemory(tmp_path / "notes.sqlite3")
    try:
        store.upsert_note(value)
        assert store.list_notes(["enrolled-a"]) == [value]
        assert store.conversation_seen("enrolled-a", value["source_text"])
    finally:
        store.close()


def test_forgetting_person_deletes_their_notes_and_hashes_only(tmp_path):
    store = NoteMemory(tmp_path / "notes.sqlite3")
    first = conversation_note()
    second = {**first, "id": "note-b", "profile_id": "enrolled-b"}
    try:
        store.upsert_note(first)
        store.upsert_note(second)
        store.delete_profile_notes("enrolled-a")
        assert store.list_notes(["enrolled-a", "enrolled-b"]) == [second]
        assert not store.conversation_seen("enrolled-a", first["source_text"])
        assert store.conversation_seen("enrolled-b", first["source_text"])
    finally:
        store.close()


async def test_person_note_write_failure_never_emits_success_or_mutates_session(tmp_path):
    pytest.importorskip("fastapi")
    from tools.perception_lab.product_routes import BrowserSession

    store = NoteMemory(tmp_path / "notes.sqlite3")
    session = BrowserSession([{"id": "enrolled-a", "name": "Alex"}], note_memory=store)
    try:
        store._db().execute("""CREATE TRIGGER deny_note BEFORE INSERT ON personal_notes
                               BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END""")
        with pytest.raises(RuntimeError, match="Cannot save personal note"):
            await session.receive_json({"type": "command", "command": {"type": "note.save", "payload": {
                "note": {"profile_id": "enrolled-a", "text": "Should not be acknowledged"}}}})
        assert not session.product.notes
        assert not any(event.get("type") in {"note.upserted", "v1.ack"} for event in session.queue._queue)
        assert store.list_notes(["enrolled-a"]) == []
    finally:
        await session.close()
        store.close()
