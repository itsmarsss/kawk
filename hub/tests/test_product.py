"""V1 tests exercise real percept-shaped inputs and output contracts, without models."""
import copy

import pytest

from tools.perception_lab.product import ProductSession, iso


class Clock:
    value = 1_790_000_000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


@pytest.fixture
def rig():
    clock = Clock()
    events, controls, clips = [], [], []
    session = ProductSession("test-session", events.append, clock,
                             [{"id": "real-gallery-a", "name": "Alex"},
                              {"id": "real-gallery-b", "name": "Alex"}],
                             clips.append, controls.append)
    for kind in ("faces", "objects", "speech"):
        session.stream_state(kind, True, stream_id=kind + "-1")
    session.set_capture(camera="live", microphone="live")
    return session, clock, events, controls, clips


def face_frame(session, clock, ident="real-gallery-a", track=1, more=(), enrollment=None):
    rows = [{"track_id": track, "box": [100, 70, 280, 270], "stable_id": ident,
             "stable_name": "Alex" if ident else None, "detection_score": .95}, *more]
    frame = {"type": "frame", "faces": rows, "input_wh": [640, 480], "detected_count": len(rows), "observed_at": clock()}
    if enrollment:
        frame["enrollment"] = enrollment
    return session.ingest_faces(frame, stream_id="faces-1")


def empty_frames(session, clock, kind, duration=2.4):
    for _ in range(round(duration / .2)):
        clock.advance(.2)
        frame = {"type": "frame", kind: [], "input_wh": [640, 480], "observed_at": clock()}
        (session.ingest_faces if kind == "faces" else session.ingest_objects)(frame, stream_id=kind + "-1")


def object_frame(session, clock, track="backend-track", label="keys"):
    return session.ingest_objects({"type": "frame", "input_wh": [640, 480], "observed_at": clock(),
        "objects": [{"label": label, "track_id": track, "box_xyxy": [100, 280, 180, 350], "score": .9}]}, stream_id="objects-1")


def command(session, kind, **payload):
    return session.dispatch({"type": kind, "payload": payload})


def test_person_profile_uses_real_uuid_and_previous_encounter_without_frame_flashes(rig):
    s, clock, events, _, _ = rig
    command(s, "note.save", note={"profile_id": "real-gallery-a", "text": "Works on hardware"})
    face_frame(s, clock)
    first_seen = iso(clock())
    first_action = s.display["id"]
    assert s.display["card"]["title"] == "Alex"
    assert "First meeting" in s.display["card"]["body"]
    assert "Works on hardware" in s.display["card"]["body"]
    for _ in range(4):
        clock.advance(.2)
        face_frame(s, clock)
    assert s.display["id"] == first_action
    latest_seen = iso(clock())
    empty_frames(s, clock, "faces")
    assert s.profiles["real-gallery-a"]["last_seen_at"] == latest_seen
    clock.advance(.2)
    face_frame(s, clock, track=55)
    assert latest_seen in s.display["card"]["body"]
    assert first_seen != s.encounters[s.active["real-gallery-a"]]["started_at"]
    assert len([e for e in s.encounters.values() if e["profile_id"] == "real-gallery-a"]) == 2
    assert all(e["schema_version"] == "1.0" for e in events)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))


def test_reminder_targets_uuid_dismisses_for_encounter_and_done_never_returns(rig):
    s, clock, _, _, _ = rig
    rid = command(s, "reminder.save", reminder={"profile_id": "real-gallery-a", "text": "Return charger"})["id"]
    face_frame(s, clock, ident="real-gallery-b")
    assert s.display["card"]["reminder"] is None  # same name, different person
    empty_frames(s, clock, "faces")
    face_frame(s, clock)
    assert s.display["card"]["reminder"]["id"] == rid
    eid = s.active["real-gallery-a"]
    command(s, "reminder.dismiss", reminder_id=rid, encounter_id=eid)
    assert s.display["card"]["reminder"] is None
    empty_frames(s, clock, "faces")
    face_frame(s, clock, track=8)
    assert s.display["card"]["reminder"]["id"] == rid
    command(s, "reminder.complete", reminder_id=rid)
    empty_frames(s, clock, "faces")
    face_frame(s, clock, track=9)
    assert s.display["card"]["reminder"] is None


def test_reminder_edit_and_snooze_refresh_card_only_on_changed_content(rig):
    s, clock, _, _, _ = rig
    rid = command(s, "reminder.save", reminder={"profile_id": "real-gallery-a", "text": "Old text"})["id"]
    face_frame(s, clock)
    command(s, "reminder.save", reminder={"id": rid, "profile_id": "real-gallery-a", "text": "New text"})
    assert s.display["card"]["reminder"]["text"] == "New text"
    command(s, "reminder.snooze", reminder_id=rid, minutes=1)
    assert s.display["card"]["reminder"] is None
    for _ in range(61):
        clock.advance(1)
        face_frame(s, clock)
    assert s.display["card"]["reminder"]["id"] == rid


@pytest.mark.parametrize("noun", ["note", "reminder"])
def test_reassigning_record_removes_it_from_previous_person_display(rig, noun):
    s, clock, _, _, _ = rig
    result = command(s, f"{noun}.save", **{noun: {"profile_id": "real-gallery-a", "text": "Only for A"}})
    face_frame(s, clock)
    assert "Only for A" in str(s.display["card"])
    command(s, f"{noun}.save", **{noun: {"id": result["id"], "profile_id": "real-gallery-b", "text": "Only for B"}})
    assert "Only for A" not in str(s.display["card"])
    assert "Only for B" not in str(s.display["card"])


def test_objects_reassociate_reset_ids_freeze_on_outage_and_recall_last_real_observation(rig):
    s, clock, _, _, _ = rig
    object_frame(s, clock, "sam-generation-1:1")
    clock.advance(.2)
    object_frame(s, clock, "sam-generation-2:1")
    assert len(s.active) == 1
    assert len(s.encounters) == 1
    assert "ownership" in s.profiles["object:keys"]["descriptor"]
    assert "in view" in command(s, "ask", text="Where are my keys?")["answer"]["text"]
    s.stream_state("objects", False, stream_id="objects-1")
    clock.advance(30)
    s.tick()
    assert "object:keys" in s.active
    s.stream_state("objects", True, stream_id="objects-2")
    assert not object_frame(s, clock)  # stale connection cannot change state
    s.ingest_objects({"objects": [{"label": "keys", "box_xyxy": [100, 280, 180, 350], "score": .9}],
                      "input_wh": [640, 480], "observed_at": clock()}, stream_id="objects-2")
    last = iso(clock())
    for _ in range(12):
        clock.advance(.2)
        s.ingest_objects({"objects": [], "observed_at": clock()}, stream_id="objects-2")
    assert "object:keys" not in s.active
    answer = command(s, "ask", text="Where are my keys?")["answer"]
    assert answer["kind"] == "found"
    assert "last seen" in answer["text"]
    assert last in answer["context"]
    assert "moment_id" not in answer
    assert command(s, "ask", text="Where is my wallet?")["answer"]["kind"] == "not_found"


def test_stale_stream_capture_timestamp_and_duplicate_frame_do_not_apply(rig):
    s, clock, events, _, _ = rig
    initial = {"faces": [], "observed_at": clock(), "frame_id": 3}
    assert s.ingest_faces(initial, stream_id="faces-1")
    count = len(events)
    assert not s.ingest_faces(initial, stream_id="faces-1")
    assert not s.ingest_faces({**initial, "frame_id": 4, "observed_at": clock() - 1}, stream_id="faces-1")
    assert not s.ingest_faces({**initial, "frame_id": 4}, stream_id="old-connection")
    assert len(events) == count


def test_introduction_binds_unknown_track_and_real_completion_uuid(rig):
    s, clock, events, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None, track=12)
        clock.advance(.2)
    segment = {"segment_id": "intro-1", "text": "Hi, I'm Maya", "is_final": True}
    s.ingest_transcript(segment, stream_id="speech-1")
    assert controls[-1]["type"] == "enroll"
    assert controls[-1]["name"] == "Maya"
    assert controls[-1]["target_track_id"] == "12"
    assert not s.ingest_transcript(segment, stream_id="speech-1")
    assert len(controls) == 1
    face_frame(s, clock, ident=None, track=12,
               enrollment={"status": "complete", "target_track_id": 12,
                           "person": {"id": "new-real-gallery-uuid", "name": "Maya"}})
    assert s.profiles["new-real-gallery-uuid"]["name"] == "Maya"
    assert any(e["type"] == "enrollment.updated" and e["payload"]["enrollment"]["status"] == "complete" for e in events)
    assert s.enrollment is None


def test_ambiguous_or_disappearing_intro_never_enrolls_someone_else(rig):
    s, clock, events, controls, _ = rig
    second = {"track_id": 13, "box": [350, 70, 540, 270], "stable_id": None}
    for _ in range(3):
        face_frame(s, clock, ident=None, track=12, more=[second])
        clock.advance(.2)
    s.ingest_transcript({"segment_id": "intro-1", "text": "Hi, I'm Maya", "is_final": True}, stream_id="speech-1")
    assert not controls
    assert events[-1]["payload"]["enrollment"]["status"] == "ambiguous"
    for _ in range(3):
        face_frame(s, clock, ident=None, track=12)
        clock.advance(.2)
    s.ingest_transcript({"segment_id": "intro-2", "text": "Hi, I'm Maya", "is_final": True}, stream_id="speech-1")
    assert controls[-1]["target_track_id"] == "12"
    face_frame(s, clock, ident=None, track=99)
    assert controls[-1]["type"] == "cancel_enrollment"
    assert s.enrollment is None
    assert len(s.profiles) == 2


def test_intro_bad_name_reprompts_once_and_timeout_cancels(rig):
    s, clock, events, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None)
        clock.advance(.2)
    s.ingest_transcript({"segment_id": "a", "text": "I'm here to talk about hardware", "is_final": True}, stream_id="speech-1")
    assert s.enrollment.waiting_name
    s.ingest_transcript({"segment_id": "b", "text": "here are way too many words", "is_final": True}, stream_id="speech-1")
    assert s.enrollment is None
    assert not controls
    s.ingest_transcript({"segment_id": "c", "text": "I'm Maya", "is_final": True}, stream_id="speech-1")
    clock.advance(31)
    s.tick()
    assert s.enrollment is None
    assert controls[-1]["type"] == "cancel_enrollment"


def test_supported_transcripts_only_and_note_recall(rig):
    s, clock, events, _, _ = rig
    face_frame(s, clock)
    s.ingest_transcript({"segment_id": "a", "text": "I asked him where are my keys", "is_final": True}, stream_id="speech-1")
    assert not any(e["type"] == "answer.resolved" for e in events)
    s.ingest_transcript({"segment_id": "b", "text": "Remember that Alex likes tea", "is_final": True}, stream_id="speech-1")
    assert len(s.notes) == 1
    assert "Alex likes tea" in command(s, "ask", text="Recall notes about Alex")["answer"]["text"]
    s.ingest_transcript({"segment_id": "c", "text": "clear display", "is_final": True}, stream_id="speech-1")
    assert s.display["card"]["template"] == "idle"


def test_typed_clear_dispatch_resolves_answer_without_overwriting_idle(rig):
    s, clock, events, _, _ = rig
    face_frame(s, clock)
    reply = command(s, "ask", text="Clear the display.")["answer"]
    assert reply["kind"] == "found" and reply["text"] == "Display cleared."
    assert s.display["card"]["template"] == "idle"
    assert [e["type"] for e in events if e["type"].startswith("answer.")] == ["answer.pending", "answer.resolved"]
    clock.advance(.2)
    face_frame(s, clock)
    assert s.display["card"]["template"] == "idle"


def test_typed_remember_dispatch_saves_once_to_live_profile_and_keeps_note_confirmation(rig):
    s, clock, events, _, _ = rig
    face_frame(s, clock)
    answer = command(s, "ask", text="Remember that Alex likes tea.")["answer"]
    assert answer["kind"] == "found" and answer["profile_id"] == "real-gallery-a"
    assert list(s.notes.values())[0]["text"] == "Alex likes tea"
    assert len([e for e in events if e["type"] == "note.upserted"]) == 1
    assert s.display["card"]["title"] == "Note saved"
    assert s.display["card"]["body"] == "Alex likes tea"
    s.stream_state("faces", False, stream_id="faces-1")
    failed = command(s, "ask", text="Remember that this must not attach to a stale face")["answer"]
    assert failed["kind"] == "not_found" and len(s.notes) == 1
    assert "profile_id" not in failed


def test_typed_intro_dispatch_starts_once_and_keeps_enrollment_prompt(rig):
    s, clock, events, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None)
        clock.advance(.2)
    answer = command(s, "ask", text="I'm Maya.")["answer"]
    assert answer["kind"] == "found" and answer["text"] == "Learning Maya from clear face frames"
    assert s.enrollment.name == "Maya" and controls[-1]["name"] == "Maya"
    assert s.display["card"]["template"] == "enroll_prompt"
    assert not any(p["name"] == "Maya" for p in s.profiles.values())  # real enrollment still needs face samples
    command(s, "ask", text="I'm Maya.")
    assert len([c for c in controls if c["type"] == "enroll"]) == 1
    assert len([e for e in events if e["type"] == "answer.resolved"]) == 2


def test_typed_intro_stopped_camera_and_ambiguous_target_do_not_enroll(rig):
    s, clock, _, controls, _ = rig
    s.stop()
    answer = command(s, "ask", text="I'm Maya")["answer"]
    assert answer["kind"] == "not_found" and "Start the camera" in answer["text"]
    assert not controls and s.enrollment is None
    s.set_capture(camera="live")
    s.stream_state("faces", True, stream_id="faces-1")
    second = {"track_id": 2, "box": [350, 70, 540, 270], "stable_id": None}
    for _ in range(3):
        face_frame(s, clock, ident=None, more=[second])
        clock.advance(.2)
    answer = command(s, "ask", text="I'm Maya")["answer"]
    assert answer["kind"] == "not_found" and "exactly one" in answer["text"]
    assert not controls and s.enrollment is None


def test_typed_long_intro_keeps_name_reprompt_without_answer_covering_it(rig):
    s, clock, _, _, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None)
        clock.advance(.2)
    answer = command(s, "ask", text="I'm here to talk about hardware")["answer"]
    assert answer["kind"] == "not_found" and "Say just their name" in answer["text"]
    assert s.enrollment.waiting_name
    assert s.display["card"]["template"] == "enroll_prompt"


def test_spoken_person_reminder_demo_binds_uuid_and_shows_on_next_encounter(rig):
    s, clock, events, _, _ = rig
    s.profiles["real-gallery-a"]["name"] = "Bob"
    face_frame(s, clock)
    segment = {"segment_id": "remind-bob", "text": "Remind me to ask Bob about dinner.", "is_final": True}
    assert s.ingest_transcript(segment, stream_id="speech-1")
    assert not s.ingest_transcript(segment, stream_id="speech-1")
    assert len(s.reminders) == 1
    reminder = next(iter(s.reminders.values()))
    assert reminder["profile_id"] == "real-gallery-a"
    assert reminder["text"] == "Ask Bob about dinner"
    assert reminder["dismissed_for_encounter_id"] == s.active["real-gallery-a"]
    first_upsert = next(e["payload"]["reminder"] for e in events if e["type"] == "reminder.upserted")
    assert first_upsert["dismissed_for_encounter_id"] == s.active["real-gallery-a"]
    assert not s._due("real-gallery-a")
    answer = [e["payload"]["answer"] for e in events if e["type"] == "answer.resolved"][-1]
    assert answer["kind"] == "found" and answer["profile_id"] == "real-gallery-a"
    assert "Next time" in answer["text"]
    empty_frames(s, clock, "faces")
    clock.advance(9)
    s.tick()
    face_frame(s, clock, track=9)
    assert s.display["card"]["reminder"] == {"id": reminder["id"], "text": "Ask Bob about dinner"}
    command(s, "reminder.save", reminder={**reminder, "text": "Ask about Saturday dinner"})
    assert s.display["card"]["reminder"]["text"] == "Ask about Saturday dinner"


@pytest.mark.parametrize("utterance", [
    "Please, remind me to ask Bob O’Neil, about dinner!",
    "remind me to tell bob o'neil about dinner.",
    "Remind me to talk to BOB O'NEIL about dinner?",
])
def test_typed_reminder_supports_full_names_punctuation_and_paused_state(rig, utterance):
    s, clock, _, _, _ = rig
    s.profiles["real-gallery-a"]["name"] = "Bob O'Neil"
    s.stop()
    answer = command(s, "ask", text=utterance)["answer"]
    assert answer["kind"] == "found"
    reminder = next(iter(s.reminders.values()))
    assert reminder["profile_id"] == "real-gallery-a"
    assert reminder["text"].endswith("Bob O'Neil about dinner")
    assert reminder["status"] == "active"
    assert "dismissed_for_encounter_id" not in reminder
    clock.advance(9)
    s.tick()
    assert len(s.reminders) == 1


@pytest.mark.parametrize("name,expected", [("Alex", "More than one"), ("Bob", "do not have")])
def test_reminder_names_must_resolve_to_exactly_one_enrolled_person(rig, name, expected):
    s, clock, events, _, _ = rig
    face_frame(s, clock)  # current face must not resolve ambiguous/unmatched speech by guesswork
    before = copy.deepcopy(s.reminders)
    answer = command(s, "ask", text=f"Remind me to ask {name} about dinner.")["answer"]
    assert answer["kind"] == "not_found"
    assert expected in answer["text"] and "No reminder was saved" in answer["text"]
    assert s.reminders == before
    assert not any(e["type"] == "reminder.upserted" for e in events)


def test_reminder_requires_final_anchored_request_and_preserves_notes(rig):
    s, clock, _, _, _ = rig
    s.profiles["real-gallery-a"]["name"] = "Bob"
    face_frame(s, clock)
    nid = command(s, "note.save", note={"profile_id": "real-gallery-a", "text": "Vegetarian"})["id"]
    s.ingest_transcript({"segment_id": "draft", "text": "Remind me to ask Bob about dinner", "is_final": False}, stream_id="speech-1")
    s.ingest_transcript({"segment_id": "quoted", "text": "I said remind me to ask Bob about dinner", "is_final": True}, stream_id="speech-1")
    assert not s.reminders
    assert s.notes[nid]["text"] == "Vegetarian"
    answer = command(s, "ask", text="Remind me to ask Bob about " + "d" * 241)["answer"]
    assert answer["kind"] == "unsupported" and not s.reminders


def gate_final(session, segment_id, utterance):
    accepted = session.ingest_transcript({"segment_id": segment_id, "text": utterance, "is_final": True},
                                         stream_id="speech-1", execute_rules=False)
    return session.pending_transcript_decision(segment_id, stream_id="speech-1") if accepted else None


def gate_decision(intent="find", directed=True, allow_introduction=False):
    return {"intent": intent, "directed": directed, "allow_introduction": allow_introduction}


def test_optional_speech_gate_records_once_and_executes_matching_decision_once(rig):
    s, clock, events, _, _ = rig
    token = gate_final(s, "gated", "Where are my keys?")
    assert token and not any(e["type"] == "answer.resolved" for e in events)
    staged = [e["payload"]["segment"] for e in events if e["type"] == "transcript.updated"]
    assert len(staged) == 1 and staged[0]["directed"] == "pending"
    assert gate_final(s, "gated", "Where are my keys?") is None
    clock.advance(.2)
    assert s.apply_transcript_decision(token, gate_decision())
    assert not s.apply_transcript_decision(token, gate_decision())
    transcripts = [e["payload"]["segment"] for e in events if e["type"] == "transcript.updated"]
    assert len(transcripts) == 2 and transcripts[-1]["directed"] == "device"
    assert transcripts[-1]["id"] == transcripts[0]["id"]
    assert transcripts[-1]["started_at"] == transcripts[0]["started_at"]
    assert transcripts[-1]["updated_at"] != transcripts[0]["updated_at"]
    assert len([e for e in events if e["type"] == "answer.resolved"]) == 1


@pytest.mark.parametrize("decision", [gate_decision(directed=False), gate_decision(intent="clear"), gate_decision(intent="none")])
def test_gate_rejection_records_speech_without_executing_or_retrying(rig, decision):
    s, _, events, _, _ = rig
    token = gate_final(s, "overheard", "Where are my keys?")
    assert not s.apply_transcript_decision(token, decision)
    assert not s.apply_transcript_decision(token, gate_decision())
    assert not any(e["type"] == "answer.resolved" for e in events)
    transcript = [e["payload"]["segment"] for e in events if e["type"] == "transcript.updated"][-1]
    assert transcript["text"] == "Where are my keys?"
    assert transcript["directed"] == ("device" if decision["directed"] else "conversation")


@pytest.mark.parametrize("change", ["stop", "stream", "unavailable", "expired", "microphone"])
def test_gate_response_cannot_execute_after_capture_context_is_stale(rig, change):
    s, clock, events, _, _ = rig
    token = gate_final(s, "old", "Where are my keys?")
    if change == "stop":
        s.stop()
        s.set_capture(microphone="live")
        s.stream_state("speech", True, stream_id="speech-1")
    elif change == "stream":
        s.stream_state("speech", True, stream_id="speech-new")
    elif change == "unavailable":
        s.stream_state("speech", False, stream_id="speech-1")
        s.stream_state("speech", True, stream_id="speech-1")
    elif change == "microphone":
        s.set_capture(microphone="off")
    else:
        clock.advance(10.1)
    before = len(events)
    assert not s.apply_transcript_decision(token, gate_decision())
    assert len(events) == before
    assert not any(e["type"] == "answer.resolved" for e in events)


def test_gate_cannot_apply_intro_to_replacement_face_or_note_to_different_foreground(rig):
    s, clock, _, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None, track=12)
        clock.advance(.2)
    token = gate_final(s, "intro", "Hi, I'm Maya")
    for _ in range(3):
        face_frame(s, clock, ident=None, track=13)
        clock.advance(.2)
    assert not s.apply_transcript_decision(token, gate_decision("introduction", False, True))
    assert not controls
    face_frame(s, clock)
    note = gate_final(s, "note", "Remember that likes tea")
    empty_frames(s, clock, "faces")
    face_frame(s, clock, ident="real-gallery-b")
    assert not s.apply_transcript_decision(note, gate_decision("note"))
    assert not s.notes


def test_gate_intro_permission_and_typed_ask_remain_independent(rig):
    s, clock, events, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None, track=12)
        clock.advance(.2)
    denied = gate_final(s, "intro-denied", "Hi, I'm Maya")
    assert not s.apply_transcript_decision(denied, gate_decision("introduction", True, False))
    permitted = gate_final(s, "intro-ok", "Hi, I'm Maya")
    assert s.apply_transcript_decision(permitted, gate_decision("introduction", False, True))
    assert controls[-1]["target_track_id"] == "12"
    command(s, "ask", text="Where are my keys?")
    assert len([e for e in events if e["type"] == "answer.resolved"]) == 1


@pytest.mark.parametrize("utterance", ["Who is this?", "Who's that person?", "Please identify this person.", "Who am I talking to?"])
def test_identify_current_person_includes_real_uuid_prior_encounter_and_notes(rig, utterance):
    s, clock, _, _, _ = rig
    face_frame(s, clock)
    previously_seen = iso(clock())
    empty_frames(s, clock, "faces")
    face_frame(s, clock)
    command(s, "note.save", note={"profile_id": "real-gallery-a", "text": "Works on hardware"})
    answer = command(s, "ask", text=utterance)["answer"]
    assert answer["kind"] == "found" and answer["profile_id"] == "real-gallery-a"
    assert "This is Alex." in answer["text"]
    assert previously_seen in answer["text"] and "Works on hardware" in answer["text"]
    assert s.display["card"]["template"] == "answer"
    assert s.display["card"]["body"] == answer["text"]


def test_gated_identify_executes_once_and_rechecks_original_person_uuid(rig):
    s, clock, events, _, _ = rig
    face_frame(s, clock)
    first = gate_final(s, "identify-a", "Who is this?")
    assert s.apply_transcript_decision(first, gate_decision("identify"))
    assert not s.apply_transcript_decision(first, gate_decision("identify"))
    delayed = gate_final(s, "identify-delayed", "Who is this?")
    empty_frames(s, clock, "faces")
    face_frame(s, clock, ident="real-gallery-b")  # same display name, different UUID
    count = len([e for e in events if e["type"] == "answer.resolved"])
    assert not s.apply_transcript_decision(delayed, gate_decision("identify"))
    assert len([e for e in events if e["type"] == "answer.resolved"]) == count


def test_identify_does_not_guess_from_unknown_faces_or_stale_known_tracks(rig):
    s, clock, _, _, _ = rig
    face_frame(s, clock, ident=None)
    assert command(s, "ask", text="Who is that?")["answer"]["kind"] == "not_found"
    face_frame(s, clock)
    gated = gate_final(s, "identify-outage", "Who is this?")
    s.stream_state("faces", False, stream_id="faces-1")
    assert not s.apply_transcript_decision(gated, gate_decision("identify"))
    answer = command(s, "ask", text="Who is this?")["answer"]
    assert answer["kind"] == "not_found" and "profile_id" not in answer


def test_gate_context_is_bounded_categorical_and_excludes_old_transcripts(rig):
    s, clock, _, _, _ = rig
    face_frame(s, clock)
    object_frame(s, clock)
    gate_final(s, "recent", "Where are my keys?")
    state = s.decision_state()
    assert '"name": "Alex"' in state and '"name": "Keys"' in state
    assert '"proximity": "mid"' in state and '"dwell": "brief"' in state
    assert "speaker identity unknown" in state
    assert "Where are my keys?" in state
    assert "embedding" not in state and "box" not in state and len(state) < 6000
    for index in range(50):
        gate_final(s, str(index), "x" * 1000)
    assert len(s._pending_speech) <= 32 and len(s._recent_transcripts) <= 12
    assert len(s.decision_state()) < 6000
    clock.advance(61)
    assert 'TRANSCRIPTS_60S []' in s.decision_state()


def test_decision_state_does_not_change_for_raw_time_or_same_perception(rig):
    s, clock, _, _, _ = rig
    face_frame(s, clock)
    object_frame(s, clock)
    first = s.decision_state()
    clock.advance(.1)
    face_frame(s, clock)
    object_frame(s, clock)
    assert s.decision_state() == first
    assert len(first) <= 4096


def test_gate_introduction_context_matches_real_stability_ambiguity_and_availability(rig):
    s, clock, _, _, _ = rig
    assert "INTRODUCTION_TARGET=none" in s.decision_state()
    for _ in range(2):
        face_frame(s, clock, ident=None, track=12)
        clock.advance(.1)
    assert "INTRODUCTION_TARGET=none" in s.decision_state()
    face_frame(s, clock, ident=None, track=12)
    stable = s.decision_state()
    assert "INTRODUCTION_TARGET=single_stable_unknown" in stable
    clock.advance(.1)
    face_frame(s, clock, ident=None, track=12)
    assert s.decision_state() == stable
    second = {"track_id": 13, "box": [350, 70, 540, 270], "stable_id": None}
    face_frame(s, clock, ident=None, track=12, more=[second])
    assert "INTRODUCTION_TARGET=ambiguous" in s.decision_state()
    face_frame(s, clock, ident="real-gallery-a", track=12)
    assert "INTRODUCTION_TARGET=none" in s.decision_state()
    for _ in range(3):
        clock.advance(.1)
        face_frame(s, clock, ident=None, track=15)
    assert "INTRODUCTION_TARGET=single_stable_unknown" in s.decision_state()
    clock.advance(1.1)
    assert "INTRODUCTION_TARGET=none" in s.decision_state()
    s.stream_state("faces", False, stream_id="faces-1")
    assert "INTRODUCTION_TARGET=none" in s.decision_state()
    assert len(s.decision_state().encode("utf-8")) <= 4096


def test_selected_gate_mode_disables_rule_clips_but_keeps_manual_capture():
    clock = Clock()
    clips = []
    s = ProductSession("gated-session", lambda _: None, clock, trigger_clip=clips.append, auto_capture_rules=False)
    s.set_capture(camera="live")
    s.stream_state("objects", True, stream_id="objects-1")
    object_frame(s, clock)
    clock.advance(.2)
    object_frame(s, clock)
    empty_frames(s, clock, "objects")
    assert not clips and not s.moments
    assert "last_seen_at" in s.profiles["object:keys"]
    command(s, "moment.mark")
    assert len(clips) == 1


def test_decision_source_event_retains_disappeared_object_and_last_observation():
    clock = Clock()
    decisions = []
    s = ProductSession("source-events", lambda _: None, clock,
                       auto_capture_rules=False, on_decision_event=decisions.append)
    s.set_capture(camera="live")
    s.stream_state("objects", True, stream_id="objects-1")
    object_frame(s, clock)
    eid, observed = s.active["object:keys"], clock()
    empty_frames(s, clock, "objects")
    assert decisions == [{"kind": "object_disappeared", "event_id": eid + ":disappeared",
                          "encounter_id": eid, "profile_id": "object:keys", "event_at": observed}]
    s.tick()
    assert len(decisions) == 1
    object_frame(s, clock)
    s.stream_state("objects", False, stream_id="objects-1")
    clock.advance(30)
    s.tick()
    s.stop()
    assert len(decisions) == 1  # an outage and Stop are not observed disappearance


def test_provider_status_distinguishes_configured_jev_from_rules_and_service_health():
    s = ProductSession("configured-session", lambda _: None, auto_capture_rules=False)
    status = s.snapshot()["status"]
    assert status["label"] == "Live · Jev configured"
    assert status["message"] == "Real perception; optional Jev decisions and temporary session history. See decision status for service health."
    s.stop()
    stopped = s.snapshot()["status"]
    assert stopped["label"] == "Live · stopped"
    assert stopped["message"] == status["message"]
    rules = ProductSession("rules-session", lambda _: None).snapshot()["status"]
    assert rules["label"] == "Live · V1 rules"
    assert "Agent decisions are not connected" in rules["message"]


@pytest.mark.parametrize("timestamp_type", ["epoch", "iso"])
def test_jev_moment_retains_original_event_time_and_compatible_provenance(rig, timestamp_type):
    s, clock, events, _, clips = rig
    observed = clock()
    clock.advance(2)
    event_at = observed if timestamp_type == "epoch" else iso(observed)
    mid = command(s, "moment.mark", source="jev-1.13.0", event_at=event_at,
                  title="Observed meaningful event")["moment_id"]
    moment = s.moments[mid]
    assert moment["source"] == "live-agent"
    assert moment["decision_model"] == "jev-1.13.0"
    assert moment["event_at"] == iso(observed) != iso(clock())
    assert clips[-1]["event_at"] == iso(observed)
    assert next(e["payload"]["moment"] for e in events if e["type"] == "moment.recording")["decision_model"] == "jev-1.13.0"
    default_id = command(s, "moment.mark")["moment_id"]
    assert s.moments[default_id]["source"] == "v1-rules"
    assert "decision_model" not in s.moments[default_id]


@pytest.mark.parametrize("case", ["expired", "future", "missing", "nan", "bool", "source"])
def test_jev_moment_rejects_misleading_source_time_without_mutation(rig, case):
    s, clock, events, _, clips = rig
    data = {"source": "jev-1.13.0", "event_at": clock()}
    if case == "expired":
        data["event_at"] = clock() - 10.01
    elif case == "future":
        data["event_at"] = clock() + .001
    elif case == "missing":
        data.pop("event_at")
    elif case == "nan":
        data["event_at"] = float("nan")
    elif case == "bool":
        data["event_at"] = True
    else:
        data["source"] = "unverified-model"
    before, emitted = s.snapshot(), len(events)
    with pytest.raises(ValueError):
        command(s, "moment.mark", **data)
    assert s.snapshot() == before and len(events) == emitted and not clips


def test_gate_malformed_decision_does_not_consume_the_pending_token(rig):
    s, _, _, _, _ = rig
    token = gate_final(s, "pending", "Where are my keys?")
    with pytest.raises(ValueError):
        s.apply_transcript_decision(token, {"intent": "find", "directed": "yes", "allow_introduction": False})
    assert s.apply_transcript_decision(token, gate_decision())


def test_lcd_priority_expiry_no_image_and_no_continuous_profile_refresh(rig):
    s, clock, events, _, _ = rig
    face_frame(s, clock)
    assert s.display["display"] == {"w": 240, "h": 240}
    assert s.display["blit"] is None
    assert s.display["card"]["image_ref"] is None
    command(s, "ask", text="Where are my keys?")
    assert s.display["priority"] == 30
    for _ in range(9):
        clock.advance(1)
        face_frame(s, clock)
    assert s.display["card"]["template"] == "profile"
    for _ in range(9):
        clock.advance(1)
        face_frame(s, clock)
    assert s.display["card"]["template"] == "idle"
    clock.advance(1)
    face_frame(s, clock)
    assert s.display["card"]["template"] == "idle"


def test_clip_deleted_or_stopped_cannot_be_resurrected(rig):
    s, clock, events, _, clips = rig
    object_frame(s, clock)
    mid = command(s, "moment.mark", title="Keys left on desk")["moment_id"]
    assert clips[-1]["event_at"] == iso(clock())
    assert clips[-1]["profile_ids"] == ["object:keys"]
    command(s, "moment.delete", moment_id=mid)
    assert not s.clip_completed(mid, {})
    second = command(s, "moment.mark")["moment_id"]
    s.stop()
    assert s.moments[second]["status"] == "failed"
    assert not s.clip_completed(second, {})
    count = len(events)
    s.stop()
    assert len(events) == count
    assert not object_frame(s, clock)


def test_stop_keeps_browsable_editable_history_and_start_rebinds_streams(rig):
    s, clock, _, _, _ = rig
    face_frame(s, clock)
    note_id = command(s, "note.save", note={"profile_id": "real-gallery-a", "text": "Likes tea"})["id"]
    s.stop()
    command(s, "note.save", note={"id": note_id, "profile_id": "real-gallery-a", "text": "Likes coffee"})
    assert command(s, "ask", text="Recall notes about Alex")["answer"]["kind"] == "found"
    assert "coffee" in s.display["card"]["body"]
    clock.advance(9)
    s.tick()
    assert s.display["card"]["template"] == "idle"
    assert s.notes[note_id]["text"] == "Likes coffee"
    s.set_capture(camera="live")
    s.stream_state("faces", True, stream_id="faces-2")
    assert not face_frame(s, clock)  # old faces-1 connection
    assert s.ingest_faces({"faces": [{"track_id": 1, "stable_id": "real-gallery-a", "box": [100, 70, 280, 270]}],
                           "input_wh": [640, 480], "observed_at": clock()}, stream_id="faces-2")
    assert "Last met:" in s.display["card"]["body"]
    assert s.session_id == "test-session"


def test_camera_off_closes_encounter_even_while_microphone_remains_live(rig):
    s, clock, _, _, _ = rig
    face_frame(s, clock)
    s.set_capture(camera="off")
    assert not s.active
    assert s.display["card"]["template"] == "idle"
    assert s.running  # microphone still on
    assert not face_frame(s, clock)  # late callback on disabled camera stream
    s.set_capture(microphone="off")
    assert not s.running


def test_enrollment_control_errors_are_bound_to_the_face_connection(rig):
    s, clock, events, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None, track=12)
        clock.advance(.2)
    command(s, "enrollment.introduction", name="Maya")
    assert s.enrollment
    result = command(s, "enrollment.status", stream_id="old", data={"type": "error", "message": "stale"})
    assert result["ignored"] and s.enrollment
    command(s, "enrollment.status", stream_id="faces-1", data={"type": "error", "message": "Target no longer visible"})
    assert s.enrollment is None
    assert controls[-1]["type"] == "cancel_enrollment"
    assert events[-1]["payload"]["enrollment"]["message"] == "Target no longer visible"


def test_encoder_failure_reason_cannot_leave_recording_stuck(rig):
    s, _, events, _, _ = rig
    mid = command(s, "moment.mark")["moment_id"]
    assert s.clip_failed(mid, "encoder stderr " * 200)
    assert s.moments[mid]["status"] == "failed"
    assert len(s.moments[mid]["failure_reason"]) == 300
    assert len(events[-1]["payload"]["reason"]) == 300


def test_saved_clip_expiry_removes_playable_url(rig):
    s, clock, _, _, _ = rig
    mid = command(s, "moment.mark")["moment_id"]
    when = clock()
    clock.advance(5)
    assert s.clip_completed(mid, {"id": mid, "url": "/api/clip/test.mp4", "mime": "video/mp4",
                                 "start_at": iso(when - 5), "end_at": iso(when + 5),
                                 "requested_start_at": iso(when - 5), "requested_end_at": iso(when + 5),
                                 "duration_s": 10, "coverage": "complete", "provenance": {"kind": "live-ring-buffer"}})
    assert s.clip_expired(mid)
    assert s.moments[mid]["status"] == "failed"
    assert s.moments[mid]["clip"] is None


@pytest.mark.parametrize("kind,payload", [
    ("reminder.save", {"reminder": {"profile_id": "missing", "text": "x"}}),
    ("note.save", {"note": {"profile_id": "real-gallery-a", "text": ""}}),
    ("reminder.save", {"reminder": {"profile_id": "real-gallery-a", "text": "x", "status": "bogus"}}),
    ("reminder.snooze", {"reminder_id": "missing", "minutes": -1}),
    ("capture.status", {"camera": "simulated"}),
    ("reminder.save", {"reminder": {"profile_id": "real-gallery-a", "text": "x"}, "defer_until_next_encounter": "yes"}),
    ("moment.mark", {"profile_ids": [{}]}),
    ("moment.mark", {"profile_ids": [[]]}),
    ("unknown", {}),
])
def test_malformed_commands_rejected_without_state_changes(rig, kind, payload):
    s, _, _, _, _ = rig
    before = copy.deepcopy(s.snapshot())
    with pytest.raises(ValueError):
        command(s, kind, **payload)
    assert s.snapshot() == before


@pytest.mark.parametrize("kind,frame", [
    ("faces", {"faces": [None]}),
    ("objects", {"objects": [None]}),
    ("faces", {"faces": [], "detected_count": "many"}),
    ("faces", {"faces": [], "detected_count": float("inf")}),
    ("faces", {"faces": [], "detected_count": -1}),
    ("faces", {"faces": [], "observed_at": float("inf")}),
    ("objects", {"objects": [{"label": "keys", "box_xyxy": [0, 1, 2, 3], "score": "high"}]}),
    ("objects", {"objects": [{"label": "keys", "box_xyxy": [None, 1, 2, 3]}]}),
    ("faces", {"faces": [], "enrollment": {"status": "complete", "person": None}}),
])
def test_malformed_perception_does_not_mutate_stream_or_product(rig, kind, frame):
    s, _, events, _, _ = rig
    before, streams, event_count = s.snapshot(), copy.deepcopy(s.streams), len(events)
    with pytest.raises(ValueError):
        (s.ingest_faces if kind == "faces" else s.ingest_objects)(frame, stream_id=kind + "-1")
    assert s.snapshot() == before
    assert s.streams == streams
    assert len(events) == event_count


def test_both_capture_flags_validated_before_either_changes(rig):
    s, _, _, _, _ = rig
    before = s.snapshot()
    with pytest.raises(ValueError):
        s.set_capture(camera="off", microphone="bad")
    assert s.snapshot() == before


def test_real_clip_can_be_recalled_and_wrong_timing_or_url_is_rejected(rig):
    s, clock, _, _, _ = rig
    object_frame(s, clock)
    mid = command(s, "moment.mark", title="Keys set down")["moment_id"]
    event_at = clock()
    clip = {"id": mid, "url": "/api/clips/example.mp4", "mime": "video/mp4",
            "start_at": iso(event_at - 2), "end_at": iso(event_at + 5),
            "requested_start_at": iso(event_at - 5), "requested_end_at": iso(event_at + 5),
            "duration_s": 7, "coverage": "partial", "provenance": {"kind": "live-ring-buffer"}}
    with pytest.raises(ValueError, match="post-event"):
        s.clip_completed(mid, clip)
    clock.advance(5)
    with pytest.raises(ValueError, match="same-origin"):
        s.clip_completed(mid, {**clip, "url": "//example.com/video.mp4"})
    with pytest.raises(ValueError, match="missing footage"):
        s.clip_completed(mid, {**clip, "coverage": "complete"})
    assert s.moments[mid]["status"] == "recording"
    assert s.clip_completed(mid, clip)
    empty_frames(s, clock, "objects")
    answer = command(s, "ask", text="Where are my keys?")["answer"]
    assert answer["moment_id"] == mid
    assert s.display["card"]["clip_id"] == mid


def test_recall_during_coasting_gap_uses_last_confirmed_observation(rig):
    s, clock, _, _, _ = rig
    object_frame(s, clock)
    observed = iso(clock())
    empty_frames(s, clock, "objects", duration=1.2)
    assert "object:keys" in s.active  # two-second absence threshold not reached
    assert "last_seen_at" not in s.profiles["object:keys"]
    answer = command(s, "ask", text="Where are my keys?")["answer"]
    assert answer["kind"] == "found"
    assert "last seen" in answer["text"]
    assert "in view" not in answer["text"]
    assert observed in answer["context"]


def test_recall_during_outage_never_claims_frozen_tracks_are_in_view(rig):
    s, clock, _, _, clips = rig
    object_frame(s, clock)
    clock.advance(.2)
    object_frame(s, clock)
    observed = iso(clock())
    s.stream_state("objects", False, stream_id="objects-1")
    clock.advance(30)
    s.tick()
    answer = command(s, "ask", text="Where are my keys?")["answer"]
    assert "last seen" in answer["text"]
    assert "in view" not in answer["text"]
    assert observed in answer["context"]
    assert any("unavailable" in line for line in answer["context"])
    assert not clips  # outage is not a disappearance event


def test_answer_is_not_preempted_by_enrollment_then_pending_prompt_surfaces(rig):
    s, clock, _, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None)
        clock.advance(.2)
    command(s, "ask", text="Where are my keys?")
    answer_id = s.display["id"]
    command(s, "enrollment.introduction", name="Maya")
    assert controls[-1]["name"] == "Maya"
    assert s.display["id"] == answer_id
    for _ in range(9):
        clock.advance(1)
        face_frame(s, clock, ident=None)
    assert s.enrollment
    assert s.display["priority"] == 20
    assert s.display["card"]["template"] == "enroll_prompt"
    assert s.display["card"]["title"] == "Maya"


@pytest.mark.parametrize("reply", ["Maya.", "Maya!", "That's Maya.", "Her name's Maya."])
def test_waiting_name_accepts_sentence_punctuation_and_fixed_prefixes(rig, reply):
    s, clock, _, controls, _ = rig
    for _ in range(3):
        face_frame(s, clock, ident=None)
        clock.advance(.2)
    s.ingest_transcript({"segment_id": "long", "text": "I'm here to discuss all the hardware", "is_final": True}, stream_id="speech-1")
    assert s.enrollment.waiting_name
    s.ingest_transcript({"segment_id": "name", "text": reply, "is_final": True}, stream_id="speech-1")
    assert s.enrollment and not s.enrollment.waiting_name
    assert controls[-1]["name"] == "Maya"


def test_disappearance_automatically_marks_exact_observation_and_updates_waiting_recall(rig):
    s, clock, events, _, clips = rig
    object_frame(s, clock)
    clock.advance(.2)
    object_frame(s, clock)
    observed = clock()
    empty_frames(s, clock, "objects")
    assert len(clips) == 1
    request = clips[0]
    assert request["event_at"] == iso(observed)
    assert request["profile_ids"] == ["object:keys"]
    mid = request["moment_id"]
    assert "disappearance rule" in s.moments[mid]["summary"]
    answer = command(s, "ask", text="Where are my keys?")["answer"]
    assert "moment_id" not in answer
    assert "The clip is still being saved." in answer["context"]
    clock.advance(3)
    clip = {"id": mid, "url": "/api/clips/keys.mp4", "mime": "video/mp4",
            "start_at": iso(observed - 5), "end_at": iso(observed + 5),
            "requested_start_at": iso(observed - 5), "requested_end_at": iso(observed + 5),
            "duration_s": 10, "coverage": "complete", "provenance": {"kind": "live-ring-buffer"}}
    s.clip_completed(mid, clip)
    updated = [event["payload"]["answer"] for event in events if event["type"] == "answer.resolved"][-1]
    assert updated["query_id"] == answer["query_id"]
    assert updated["moment_id"] == mid
    assert "still being saved" not in str(updated)
    assert s.display["card"]["clip_id"] == mid
    # Repeating this category within the cooldown produces another encounter, not another clip.
    object_frame(s, clock, track="again")
    clock.advance(.2)
    object_frame(s, clock, track="again")
    empty_frames(s, clock, "objects")
    assert len(clips) == 1
    clock.advance(31)
    object_frame(s, clock, track="later")
    clock.advance(.2)
    object_frame(s, clock, track="later")
    empty_frames(s, clock, "objects")
    assert len(clips) == 2


def test_single_observation_and_camera_stop_do_not_trigger_automatic_clips(rig):
    s, clock, _, _, clips = rig
    object_frame(s, clock)
    empty_frames(s, clock, "objects")
    assert not clips
    object_frame(s, clock)
    clock.advance(.2)
    object_frame(s, clock)
    s.set_capture(camera="off")
    assert not clips


def test_multiple_boxes_in_one_frame_do_not_count_as_repeated_object_observations(rig):
    s, clock, _, _, clips = rig
    s.ingest_objects({"observed_at": clock(), "input_wh": [640, 480], "objects": [
        {"label": "keys", "box_xyxy": [100, 280, 180, 350], "score": .9},
        {"label": "keys", "box_xyxy": [400, 280, 480, 350], "score": .9},
    ]}, stream_id="objects-1")
    empty_frames(s, clock, "objects")
    assert not clips


def test_older_clip_does_not_claim_to_show_a_newer_sighting(rig):
    s, clock, _, _, _ = rig
    object_frame(s, clock)
    event_at = clock()
    mid = command(s, "moment.mark")["moment_id"]
    clock.advance(5)
    s.clip_completed(mid, {"id": mid, "url": "/api/clips/old.mp4", "mime": "video/mp4",
                          "start_at": iso(event_at - 5), "end_at": iso(event_at + 5),
                          "requested_start_at": iso(event_at - 5), "requested_end_at": iso(event_at + 5),
                          "duration_s": 10, "coverage": "complete", "provenance": {"kind": "live-ring-buffer"}})
    clock.advance(10)
    object_frame(s, clock)
    answer = command(s, "ask", text="Where are my keys?")["answer"]
    assert "moment_id" not in answer
    assert "No saved clip covers this sighting yet." in answer["context"]


def test_clip_finishing_does_not_overwrite_a_more_recent_question(rig):
    s, clock, events, _, _ = rig
    object_frame(s, clock)
    observed = clock()
    mid = command(s, "moment.mark")["moment_id"]
    command(s, "ask", text="Where are my keys?")
    newer = command(s, "ask", text="Where is my wallet?")["answer"]
    count = len([e for e in events if e["type"] == "answer.resolved"])
    clock.advance(5)
    s.clip_completed(mid, {"id": mid, "url": "/api/clips/keys.mp4", "mime": "video/mp4",
                          "start_at": iso(observed - 5), "end_at": iso(observed + 5),
                          "requested_start_at": iso(observed - 5), "requested_end_at": iso(observed + 5),
                          "duration_s": 10, "coverage": "complete", "provenance": {"kind": "live-ring-buffer"}})
    assert len([e for e in events if e["type"] == "answer.resolved"]) == count
    assert s.display["card"]["title"] == newer["question"]
