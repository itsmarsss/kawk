"""Ambient-memory handler tests; decisions are injected, not real Jev classifications."""

import asyncio
import copy

import pytest
from remember_hub.contracts.decisions import GateAnswer

from tools.perception_lab import product
from tools.perception_lab.product import ProductSession
from tools.perception_lab.product_decisions import MODEL, DecisionEvent, V1DecisionBridge

BOB = "bbe11ee7-5dd5-4b12-a638-e0b7a6117bbd"
ALICE = "06f89044-458b-45cb-b8b8-5fd1738c1959"


class Clock:
    def __init__(self):
        self.value = 1_790_000_000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


@pytest.fixture
def rig():
    clock, events = Clock(), []
    session = ProductSession(
        "ambient-test", events.append, clock,
        [{"id": BOB, "name": "Bob"}, {"id": ALICE, "name": "Alice"}],
        auto_capture_rules=False,
    )
    session.set_capture(camera="live", microphone="live")
    for kind in ("faces", "speech"):
        session.stream_state(kind, True, stream_id=f"{kind}-1")
    return session, clock, events


def face(ident=BOB, track=1, x=100):
    return {"track_id": track, "box": [x, 70, x + 160, 270],
            "stable_id": ident, "stable_name": {BOB: "Bob", ALICE: "Alice"}.get(ident),
            "detection_score": .95}


def observe(rig, rows=None, *, stream="faces-1", detected_count=None):
    session, clock, _ = rig
    rows = [face()] if rows is None else rows
    return session.ingest_faces({
        "faces": rows, "input_wh": [640, 480], "observed_at": clock(),
        "detected_count": len(rows) if detected_count is None else detected_count,
    }, stream_id=stream)


def final(rig, text="I prefer coffee.", *, segment="fact", stream="speech-1"):
    session, _, _ = rig
    assert session.ingest_transcript(
        {"segment_id": segment, "text": text, "is_final": True},
        stream_id=stream, execute_rules=False,
    )
    token = session.pending_transcript_decision(segment, stream_id=stream)
    assert token is not None
    return token


def decision(**changes):
    return {"directed": False, "allow_introduction": False, "intent": "none",
            "remember_conversation": True, "command_current": True,
            "source": "jev-1.13.0", **changes}


def transcript(events, segment="fact"):
    return next(e["payload"]["segment"] for e in reversed(events)
                if e["type"] == "transcript.updated"
                and e["payload"]["segment"]["id"] == f"speech-1:{segment}")


def test_ordinary_final_saves_exact_conversation_context_with_uuid_and_provenance(rig):
    session, _, events = rig
    observe(rig)
    encounter = session.active[BOB]
    said = "I prefer coffee, and I'm starting a new job on Monday."
    token = final(rig, said)
    assert not session.notes  # merely receiving a final is not an accepted memory decision
    session.apply_transcript_decision(token, decision())

    assert len(session.notes) == 1
    note = next(iter(session.notes.values()))
    assert note["profile_id"] == BOB
    assert note["text"] == note["source_text"] == said
    assert note["source"] == "live-agent"
    assert note["attribution"] == "conversation_context"
    assert note["speaker"] == "unknown"  # visible face is not evidence of who spoke
    assert note["decision_model"] == "jev-1.13.0"
    assert note["source_segment_id"] == "speech-1:fact"
    assert note["source_session_id"] == "ambient-test"
    assert note["source_encounter_id"] == encounter
    resolved = transcript(events)
    assert resolved["directed"] == "conversation"
    assert resolved["memory"]["state"] == "saved"
    assert resolved["memory"]["note_id"] == note["id"]
    assert resolved["memory"]["profile_id"] == BOB
    assert len([e for e in events if e["type"] == "note.upserted"]) == 1
    assert not any(e["type"] == "answer.resolved" for e in events)


@pytest.mark.parametrize("gate", [
    decision(remember_conversation=False),
    {"directed": False, "allow_introduction": False, "intent": "none"},
])
def test_rejected_or_legacy_decision_does_not_save_ordinary_speech(rig, gate):
    session, _, _ = rig
    observe(rig)
    token = final(rig, "Nice weather today.")
    session.apply_transcript_decision(token, gate)
    assert not session.notes


def test_partial_revisions_and_repeated_final_or_callback_save_only_once(rig):
    session, _, events = rig
    observe(rig)
    for said in ("I prefer", "I prefer coffee"):
        assert session.ingest_transcript(
            {"segment_id": "fact", "text": said, "is_final": False},
            stream_id="speech-1", execute_rules=False,
        )
        assert session.pending_transcript_decision("fact", stream_id="speech-1") is None
    assert not session.notes
    token = final(rig)
    session.apply_transcript_decision(token, decision())
    assert not session.apply_transcript_decision(token, decision())
    assert not session.ingest_transcript(
        {"segment_id": "fact", "text": "I prefer coffee.", "is_final": True},
        stream_id="speech-1", execute_rules=False,
    )
    assert len(session.notes) == 1
    assert len([e for e in events if e["type"] == "note.upserted"]) == 1


@pytest.mark.parametrize("rows,detected", [
    ([], 0), ([face(None)], 1),
    ([face(), face(ALICE, 2, 350)], 2),
    ([face(), face(None, 2, 350)], 2),
    ([face()], 2),  # a second detected face cannot be ignored just because it was too small
])
def test_no_unique_known_person_never_assigns_ambient_memory(rig, rows, detected):
    session, _, events = rig
    observe(rig, rows, detected_count=detected)
    token = final(rig)
    session.apply_transcript_decision(token, decision())
    assert not session.notes
    memory = transcript(events)["memory"]
    assert memory["state"] == "not_saved" and memory.get("reason")


def test_person_arriving_after_speech_cannot_receive_earlier_memory(rig):
    session, _, events = rig
    observe(rig, [])
    token = final(rig)
    observe(rig)
    session.apply_transcript_decision(token, decision())
    assert not session.notes
    assert transcript(events)["memory"]["state"] == "not_saved"


@pytest.mark.parametrize("change", [
    "person", "track", "face_stream", "face_outage", "ambiguous", "encounter",
    "speech_stream", "microphone", "stopped", "expired",
])
def test_pending_memory_is_never_rebound_after_context_changes(rig, change):
    session, clock, _ = rig
    observe(rig)
    token = final(rig)
    if change == "person":
        observe(rig, [face(ALICE)])
    elif change == "track":
        observe(rig, [face(BOB, 9)])
    elif change == "face_stream":
        session.stream_state("faces", True, stream_id="faces-2")
        observe(rig, stream="faces-2")
    elif change == "face_outage":
        session.stream_state("faces", False, stream_id="faces-1")
    elif change == "ambiguous":
        observe(rig, [face(), face(ALICE, 2, 350)])
    elif change == "encounter":
        for _ in range(12):
            clock.advance(.2)
            observe(rig, [])
        observe(rig)
    elif change == "speech_stream":
        session.stream_state("speech", True, stream_id="speech-2")
    elif change == "microphone":
        session.set_capture(microphone="off")
    elif change == "stopped":
        session.stop()
        session.start()
        session.set_capture(camera="live", microphone="live")
        session.stream_state("speech", True, stream_id="speech-1")
        session.stream_state("faces", True, stream_id="faces-1")
        observe(rig)
    else:
        clock.advance(10.1)
        observe(rig)
    session.apply_transcript_decision(token, decision())
    assert not session.notes


def test_superseded_command_flag_does_not_discard_useful_older_conversation(rig):
    session, _, events = rig
    observe(rig)
    older = final(rig, "I'm starting my new job Monday.", segment="older")
    newer = final(rig, "Nice weather today.", segment="newer")
    session.apply_transcript_decision(older, decision(command_current=False))
    session.apply_transcript_decision(newer, decision(remember_conversation=False))
    assert len(session.notes) == 1
    assert next(iter(session.notes.values()))["text"] == "I'm starting my new job Monday."
    assert transcript(events, "older")["memory"]["state"] == "saved"


def test_superseded_command_cannot_change_display(rig):
    session, _, events = rig
    observe(rig)
    token = final(rig, "Clear the display.")
    display = copy.deepcopy(session.display)
    count = len(events)
    session.apply_transcript_decision(token, decision(
        directed=True, intent="clear", remember_conversation=False, command_current=False,
    ))
    assert session.display == display
    assert not any(e["type"] == "answer.resolved" for e in events[count:])


def test_explicit_note_command_and_ambient_gate_do_not_save_two_notes(rig):
    session, _, events = rig
    observe(rig)
    token = final(rig, "Remember that Bob prefers coffee.")
    session.apply_transcript_decision(token, decision(directed=True, intent="note"))
    assert len(session.notes) == 1
    note = next(iter(session.notes.values()))
    assert note["text"] == "Bob prefers coffee"
    assert note["source"] == "user"
    assert len([e for e in events if e["type"] == "note.upserted"]) == 1


def test_repeated_text_dedupes_per_person_but_negation_remains_distinct(rig):
    session, clock, events = rig
    observe(rig)
    first = final(rig, "I prefer coffee.", segment="first")
    session.apply_transcript_decision(first, decision())
    first_id = next(iter(session.notes))
    repeated = final(rig, "I  PREFER coffee!", segment="repeat")
    session.apply_transcript_decision(repeated, decision())
    assert len(session.notes) == 1
    memory = transcript(events, "repeat")["memory"]
    assert memory["state"] == "duplicate" and memory["note_id"] == first_id

    changed = final(rig, "I do not prefer coffee.", segment="changed")
    session.apply_transcript_decision(changed, decision())
    assert len(session.notes) == 2
    for _ in range(12):
        clock.advance(.2)
        observe(rig, [])
    observe(rig, [face(ALICE, 2)])
    other = final(rig, "I prefer coffee.", segment="other")
    session.apply_transcript_decision(other, decision())
    assert len(session.notes) == 3
    assert {n["profile_id"] for n in session.notes.values()} == {BOB, ALICE}


def test_ambient_save_preserves_existing_answer_and_appears_next_encounter(rig):
    session, clock, events = rig
    observe(rig)
    session.dispatch({"type": "ask", "payload": {"text": "Where are my keys?"}})
    display = copy.deepcopy(session.display)
    count = len(events)
    token = final(rig, "I prefer coffee.")
    session.apply_transcript_decision(token, decision())
    assert session.display == display
    assert not any(e["type"] == "answer.resolved" for e in events[count:])
    session.dispatch({"type": "display.clear"})
    for _ in range(12):
        clock.advance(.2)
        observe(rig, [])
    observe(rig, [face(BOB, 7)])
    assert "I prefer coffee." in session.display["card"]["body"]
    recalled = session.dispatch({"type": "ask", "payload": {"text": "Recall notes about Bob"}})
    assert "I prefer coffee." in recalled["answer"]["text"]


def test_deleted_note_is_not_resurrected_by_replayed_source(rig):
    session, _, _ = rig
    observe(rig)
    token = final(rig)
    session.apply_transcript_decision(token, decision())
    note_id = next(iter(session.notes))
    session.dispatch({"type": "note.delete", "payload": {"note_id": note_id}})
    assert not session.apply_transcript_decision(token, decision())
    assert not session.ingest_transcript(
        {"segment_id": "fact", "text": "I prefer coffee.", "is_final": True},
        stream_id="speech-1", execute_rules=False,
    )
    assert not session.notes


@pytest.mark.parametrize("change", [
    {"remember_conversation": "true"}, {"command_current": 1},
    {"source": "v1-rules"}, {"source": None},
])
def test_malformed_ambient_decision_rejects_before_consuming_token(rig, change):
    session, _, _ = rig
    observe(rig)
    token = final(rig)
    with pytest.raises(ValueError):
        session.apply_transcript_decision(token, decision(**change))
    assert not session.notes
    session.apply_transcript_decision(token, decision())
    assert len(session.notes) == 1


def test_full_accepted_thousand_character_final_is_saved_without_truncation(rig):
    session, _, _ = rig
    observe(rig)
    said = "I like " + "a" * 992 + "."
    assert len(said) == 1000
    token = final(rig, said)
    session.apply_transcript_decision(token, decision())
    note = next(iter(session.notes.values()))
    assert note["text"] == note["source_text"] == said


def test_note_limit_reports_not_saved_without_emitting_a_partial_note(rig):
    session, _, events = rig
    observe(rig)
    for index in range(product.MAX_RECORDS):
        session.dispatch({"type": "note.save", "payload": {
            "note": {"profile_id": BOB, "text": f"Existing note {index}"},
        }})
    second = final(rig, "I'm starting a new job Monday.", segment="second")
    count = len([e for e in events if e["type"] == "note.upserted"])
    session.apply_transcript_decision(second, decision())
    assert len(session.notes) == product.MAX_RECORDS
    assert len([e for e in events if e["type"] == "note.upserted"]) == count
    memory = transcript(events, "second")["memory"]
    assert memory["state"] == "not_saved" and memory.get("reason")


def test_storage_failure_never_claims_memory_was_saved(rig):
    class UnwritableNotes:
        def conversation_seen(self, profile_id, text):
            return False

        def upsert_note(self, note):
            raise RuntimeError("Person memory is unavailable")

    session, _, events = rig
    session.note_memory = UnwritableNotes()
    observe(rig)
    token = final(rig)
    session.apply_transcript_decision(token, decision())
    assert not session.notes
    assert not any(e["type"] == "note.upserted" for e in events)
    memory = transcript(events)["memory"]
    assert memory["state"] == "not_saved" and memory.get("reason")


async def test_bridge_preserves_inflight_useful_final_after_new_conversation_arrives(rig):
    class PausedGate:
        last_model = MODEL

        def __init__(self):
            self.entered, self.release = asyncio.Event(), asyncio.Event()
            self.calls = 0

        async def decide(self, snapshot, questions):
            self.calls += 1
            first = self.calls == 1
            self.entered.set()
            await self.release.wait()
            assert {q.key for q in questions} == {
                "addressed", "intent", "allow_introduction", "remember_conversation", "significant",
            }
            probabilities = {
                "addressed": .1, "allow_introduction": .1,
                "remember_conversation": .95 if first else .1,
                "significant": .95 if first else .1,
            }
            return [GateAnswer(key=q.key, kind=q.kind, probability=1, choice="none")
                    if q.key == "intent" else
                    GateAnswer(key=q.key, kind=q.kind, probability=probabilities[q.key])
                    for q in questions]

        async def aclose(self):
            pass

    session, clock, events = rig
    observe(rig)
    backend, resolved, moments, statuses, tokens = PausedGate(), [], [], [], {}

    def on_voice(event, gate):
        resolved.append((event.event_id, gate["command_current"]))
        session.apply_transcript_decision(tokens[event.event_id], gate)

    bridge = V1DecisionBridge(backend, on_voice=on_voice,
                              on_moment=lambda event, gate: moments.append(event),
                              on_status=statuses.append, clock=clock)

    def submit(segment, said):
        tokens[segment] = final(rig, said, segment=segment)
        return bridge.submit(DecisionEvent(
            segment, clock(), "transcript", session.decision_state(), said,
            profile_ids=(BOB,), subject_key=BOB, clip_eligible=True,
        ))

    try:
        assert submit("older", "I prefer coffee.")
        await asyncio.wait_for(backend.entered.wait(), timeout=1)
        assert submit("newer", "Nice weather today.")
        backend.release.set()
        assert bridge._runner is not None
        await asyncio.wait_for(asyncio.shield(bridge._runner), timeout=1)
        assert backend.calls == 2
        assert resolved == [("older", False), ("newer", True)]
        assert len(session.notes) == 1
        assert next(iter(session.notes.values()))["text"] == "I prefer coffee."
        assert transcript(events, "older")["memory"]["state"] == "saved"
        assert not moments  # older facts may be remembered without replaying old clip actions
        assert not any(e["type"] == "answer.resolved" for e in events)
    finally:
        backend.release.set()
        await bridge.aclose()


async def test_person_note_changes_sync_between_open_sessions_and_stale_edit_cannot_resurrect(tmp_path):
    pytest.importorskip("fastapi")
    from tools.perception_lab.product_memory import NoteMemory
    from tools.perception_lab.product_routes import ProductSessions

    class Gallery:
        def list(self):
            return [{"id": BOB, "name": "Bob"}]

    memory = NoteMemory(tmp_path / "notes.sqlite3")
    manager = ProductSessions(Gallery(), lambda headers: True, note_memory=memory)

    async def send(session, kind, **payload):
        await session.receive_json({"type": "command", "request_id": "test", "command": {
            "type": kind, "payload": payload,
        }})

    try:
        first = manager.get((await manager.create())["session_id"])
        second = manager.get((await manager.create())["session_id"])
        await send(first, "note.save", note={"profile_id": BOB, "text": "Likes coffee"})
        note_id = next(iter(first.product.notes))
        assert second.product.notes[note_id] == first.product.notes[note_id]
        await send(second, "note.save", note={"id": note_id, "profile_id": BOB, "text": "Prefers tea"})
        assert first.product.notes[note_id]["text"] == "Prefers tea"
        await send(first, "note.delete", note_id=note_id)
        assert not first.product.notes and not second.product.notes
        assert note_id in second.product._deleted_notes
        with pytest.raises(ValueError, match="no longer exists"):
            await send(second, "note.save", note={"id": note_id, "profile_id": BOB, "text": "Stale edit"})
        assert not memory.list_notes([BOB])
        third = manager.get((await manager.create())["session_id"])
        assert not third.product.notes
        # Every peer receives its own valid session envelope once, without a broadcast loop.
        messages = []
        while not second.queue.empty():
            messages.append(second.queue.get_nowait())
        note_events = [m for m in messages if m.get("type", "").startswith("note.")]
        assert [m["type"] for m in note_events] == ["note.upserted", "note.upserted", "note.deleted"]
        assert all(m["session_id"] == second.id for m in note_events)
        assert [m["seq"] for m in note_events] == sorted({m["seq"] for m in note_events})
    finally:
        await manager.close()


async def test_ambient_note_syncs_to_peer_profile_without_echo_or_queue_growth(tmp_path):
    pytest.importorskip("fastapi")
    from tools.perception_lab.product_memory import NoteMemory
    from tools.perception_lab.product_routes import ProductSessions

    class Gallery:
        def list(self):
            return [{"id": BOB, "name": "Bob"}]

    memory = NoteMemory(tmp_path / "notes.sqlite3")
    manager = ProductSessions(Gallery(), lambda headers: True, note_memory=memory)
    try:
        source = manager.get((await manager.create())["session_id"])
        peer = manager.get((await manager.create())["session_id"])
        clock = Clock()
        for browser in (source, peer):
            browser.product.clock = clock
            browser.product.set_capture(camera="live", microphone="live")
            browser.product.stream_state("faces", True, stream_id="faces-1")
            browser.product.stream_state("speech", True, stream_id="speech-1")
            observe((browser.product, clock, []))
        token = final((source.product, clock, []))
        source.product.apply_transcript_decision(token, decision())
        note_id = next(iter(source.product.notes))
        assert peer.product.notes[note_id] == source.product.notes[note_id]
        assert "I prefer coffee." in peer.product.display["card"]["body"]
        assert len(memory.list_notes([BOB])) == 1

        # A lagging peer still gets authoritative cache state, with the existing
        # bounded-queue overflow signal forcing reconnect instead of growing a queue.
        while not peer.queue.full():
            peer.queue.put_nowait({"type": "fixture"})
        source.product.dispatch({"type": "note.save", "payload": {"note": {
            "id": note_id, "profile_id": BOB, "text": "Actually prefers tea",
        }}})
        assert peer.overflow and peer.queue.qsize() == peer.queue.maxsize
        assert peer.product.notes[note_id]["text"] == "Actually prefers tea"
        assert "Actually prefers tea" in peer.product.display["card"]["body"]
        await peer.close()
        source.product.dispatch({"type": "note.delete", "payload": {"note_id": note_id}})
        assert peer.product.notes[note_id]["text"] == "Actually prefers tea"  # closed peer ignored
        assert not memory.list_notes([BOB])
    finally:
        await manager.close()


@pytest.mark.parametrize("persistent", [True, False])
async def test_temporary_object_or_unpersisted_notes_are_not_shared(tmp_path, persistent):
    pytest.importorskip("fastapi")
    from tools.perception_lab.product_memory import NoteMemory
    from tools.perception_lab.product_routes import ProductSessions

    class Gallery:
        def list(self):
            return [{"id": BOB, "name": "Bob"}]

    memory = NoteMemory(tmp_path / "notes.sqlite3") if persistent else None
    manager = ProductSessions(Gallery(), lambda headers: True, note_memory=memory)
    try:
        source = manager.get((await manager.create())["session_id"])
        peer = manager.get((await manager.create())["session_id"])
        for browser in (source, peer):
            session = browser.product
            session.set_capture(camera="live")
            session.stream_state("objects", True, stream_id="objects-1")
            session.ingest_objects({
                "objects": [{"label": "keys", "box_xyxy": [100, 280, 180, 350], "score": .9}],
                "input_wh": [640, 480], "observed_at": session.clock(),
            }, stream_id="objects-1")
        profile = "object:keys" if persistent else BOB
        source.product.dispatch({"type": "note.save", "payload": {
            "note": {"profile_id": profile, "text": "Only this temporary session"},
        }})
        assert len(source.product.notes) == 1 and not peer.product.notes
        if memory is not None:
            assert not memory.list_notes([BOB])
    finally:
        await manager.close()


def test_latest_note_selection_is_consistent_before_and_after_session_reload(rig, tmp_path):
    from tools.perception_lab.product_memory import NoteMemory

    session, clock, _ = rig
    memory = NoteMemory(tmp_path / "notes.sqlite3")
    session.note_memory = memory
    try:
        observe(rig)
        for index, said in enumerate(("I prefer coffee.", "I play tennis.", "I work in robotics.")):
            clock.advance(.1)
            token = final(rig, said, segment=f"fact-{index}")
            session.apply_transcript_decision(token, decision())
        first_id = next(iter(session.notes))
        clock.advance(.1)
        session.dispatch({"type": "note.save", "payload": {"note": {
            "id": first_id, "profile_id": BOB, "text": "Actually prefers tea",
        }}})
        before = session.display["card"]["body"]
        reloaded = ProductSession("reloaded", lambda event: None, clock,
                                  [{"id": BOB, "name": "Bob"}], note_memory=memory)
        reloaded.set_capture(camera="live")
        reloaded.stream_state("faces", True, stream_id="faces-1")
        observe((reloaded, clock, []))
        assert before == reloaded.display["card"]["body"]
        assert "Actually prefers tea" in before
    finally:
        memory.close()
