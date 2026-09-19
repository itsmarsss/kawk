"""Temporary live V1 state and deterministic handlers, independent of capture/UI/vendor APIs.

All methods are synchronous. Callbacks enqueue work; they must not block. ``clock`` and
incoming ``observed_at`` values are UTC epoch seconds. The host maps capture-monotonic
timestamps before ingestion. ``trigger_clip`` receives an ISO UTC ``event_at``; its
owner later calls ``clip_completed`` or ``clip_failed``. No images or embeddings are
stored here. Capture state is temporary; an optional note repository persists
personal notes by enrolled gallery UUID across sessions and process restarts.

Rules recognize a small anchored command grammar. They do not establish speaker
identity, general assistant-directedness, or significance. The Jev decision bridge
selects ordinary conversation excerpts independently of command addressedness.
The explicit V1 object rule also marks a repeatedly observed category after two
seconds of confirmed absence, at its last observation, with a 30-second/category
cooldown and the same bounded clip limits. This is a placement proxy, not Jev or
identification of an owner's particular keys. Outages and Stop never trigger it.
"""
from __future__ import annotations

import copy
import json
import logging
import math
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

JSON = dict[str, Any]
SCHEMA = "1.0"
MAX_RECORDS = 256
MAX_MOMENTS = 40
MAX_TRACKS = 128
COAST_S = 1.0
END_S = 2.0
OBSERVATION_GAP_S = 1.5
AUTO_CLIP_COOLDOWN_S = 30
PRIORITY = {"idle": 0, "profile": 10, "enroll_prompt": 20, "alert": 20, "answer": 30}
_LOG = logging.getLogger(__name__)


def iso(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch(value: str) -> float:
    if not isinstance(value, str):
        raise ValueError("Expected ISO UTC timestamp")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("Timestamp needs a timezone")
        return stamp.timestamp()
    except (TypeError, OverflowError) as exc:
        raise ValueError("Expected ISO UTC timestamp") from exc


def text(value: Any, field_name: str, limit: int = 400) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f"{field_name} must contain 1–{limit} characters")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in value):
        raise ValueError(f"{field_name} contains control characters")
    return value.strip()


def box(value: Any, wh: Any) -> tuple[float, float, float, float]:
    if not isinstance(value, (tuple, list)) or len(value) != 4:
        raise ValueError("Expected xyxy box")
    if not isinstance(wh, (tuple, list)) or len(wh) != 2:
        raise ValueError("Expected frame dimensions")
    try:
        w, h = (float(v) for v in wh)
        coords = tuple(float(v) for v in value)
    except (TypeError, OverflowError) as exc:
        raise ValueError("Invalid frame geometry") from exc
    if not all(math.isfinite(v) for v in (*coords, w, h)) or min(w, h) <= 0:
        raise ValueError("Invalid frame geometry")
    x1, y1, x2, y2 = coords
    if x2 <= x1 or y2 <= y1:
        raise ValueError("Empty face/object box")
    return x1 / w, y1 / h, x2 / w, y2 / h


def iou(a: tuple, b: tuple) -> float:
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / max(union, 1e-9)


def frame_rows(frame: Any, kind: str, limit: int) -> list[JSON]:
    if not isinstance(frame, dict):
        raise ValueError("Expected a perception frame object")
    rows = frame.get(kind, [])
    if not isinstance(rows, list) or len(rows) > limit or any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"Invalid {kind}")
    return rows


def validate_enrollment(result: Any) -> None:
    if not isinstance(result, dict) or result.get("status") not in ("collecting", "complete", "error"):
        raise ValueError("Invalid enrollment update")
    for key in ("collected", "required"):
        if key in result and (isinstance(result[key], bool) or not isinstance(result[key], int) or not 0 <= result[key] <= 10):
            raise ValueError("Invalid enrollment sample count")
    if result["status"] == "complete":
        person = result.get("person")
        if not isinstance(person, dict):
            raise ValueError("Missing enrolled person")
        text(person.get("id"), "person.id", 128)
        text(person.get("name"), "person.name", 80)


@dataclass
class Stream:
    stream_id: str | None = None
    available: bool = False
    clock: float = 0
    advanced_at: float = 0
    received_at: float | None = None
    observed_at: float | None = None
    frame_id: int | None = None


@dataclass
class Track:
    key: str
    stream: str
    box: tuple
    profile_id: str | None
    label: str
    last_clock: float
    observed_at: float
    sightings: int = 1
    source_track: str | None = None
    location: str = "In view"


@dataclass
class Enrollment:
    target: str
    stream_id: str | None
    name: str
    started: float
    attempts: int = 0
    waiting_name: bool = False


class ProductSession:
    """One live capture session with bounded, replaceable temporary storage."""

    def __init__(self, session_id: str, emit: Callable[[JSON], None],
                 clock: Callable[[], float] = time.time, gallery_people: Iterable[JSON] = (),
                 trigger_clip: Callable[[JSON], None] | None = None,
                 control: Callable[[JSON], None] | None = None,
                 auto_capture_rules: bool = True,
                 on_decision_event: Callable[[JSON], None] | None = None,
                 note_memory=None,
                 rename_person: Callable[[str, str], JSON] | None = None):
        if not isinstance(auto_capture_rules, bool):
            raise ValueError("auto_capture_rules must be boolean")
        self.session_id = text(session_id, "session_id", 128)
        self._emit_callback, self.clock = emit, clock
        self.trigger_clip, self.control = trigger_clip, control
        self.auto_capture_rules = auto_capture_rules
        self.on_decision_event = on_decision_event
        self.note_memory = note_memory
        self.rename_person = rename_person
        self._conversation_seen: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._deleted_notes: OrderedDict[str, None] = OrderedDict()
        self.created_at = self.clock()
        self.seq = 0
        self.running = True
        self.profiles: dict[str, JSON] = {}
        self._deleted_profiles: OrderedDict[str, None] = OrderedDict()
        self.notes: dict[str, JSON] = {}
        self.encounters: dict[str, JSON] = {}
        self.reminders: dict[str, JSON] = {}
        self.moments: dict[str, JSON] = {}
        self.tracks: dict[str, Track] = {}
        self.streams = {kind: Stream(advanced_at=self.created_at) for kind in ("faces", "objects", "speech")}
        self.capture = {"camera": "off", "microphone": "off"}
        self.active: dict[str, str] = {}  # stable profile UUID -> encounter UUID
        self.presence: dict[str, JSON] = {}
        self.foreground: str | None = None
        self.final_segments: OrderedDict[str, None] = OrderedDict()
        self._recent_transcripts: OrderedDict[str, JSON] = OrderedDict()
        self._pending_speech: OrderedDict[str, JSON] = OrderedDict()
        self._speech_generation = 0
        self.enrollment: Enrollment | None = None
        self._enroll_candidate: JSON | None = None
        self._auto_clip_at: dict[str, float] = {}
        self._last_answer: JSON | None = None
        self._answer_observation: float | None = None
        self._face_count = 0
        self._unknown_tracks: set[str] = set()
        self._observed_face_tracks: set[str] = set()
        self._candidate: JSON | None = None
        self._display_key: str | None = None
        self._profile_key: str | None = None
        self.display = self._action("idle", "Ready", "Camera and microphone are off", ttl_ms=0)
        for person in gallery_people:
            self._gallery_profile(person, emit=False)
        if self.note_memory is not None:
            people = [pid for pid, profile in self.profiles.items() if profile["kind"] == "person"]
            # Session handlers append and read the last records as the newest.
            self.notes = {note["id"]: note for note in reversed(self.note_memory.list_notes(people))}

    def _id(self, prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex}"

    def _emit(self, kind: str, payload: JSON) -> None:
        self.seq += 1
        self._emit_callback(copy.deepcopy({"schema_version": SCHEMA, "event_id": f"{self.session_id}:{self.seq}",
                                          "session_id": self.session_id, "seq": self.seq,
                                          "occurred_at": iso(self.clock()), "type": kind, "payload": payload}))

    def _status(self) -> JSON:
        return {"schema_version": SCHEMA, "provider": "live", "state": "running" if self.running else "stopped",
                "label": ("Live · V1 rules" if self.auto_capture_rules else "Live · Jev configured") if self.running else "Live · stopped",
                "message": "Real perception; limited command rules and temporary session history. Agent decisions are not connected."
                if self.auto_capture_rules else "Real perception; optional Jev decisions and temporary session history. See decision status for service health.",
                "session_id": self.session_id, "memory_persistent": self.note_memory is not None,
                **self.capture, "since": iso(self.created_at)}

    def snapshot(self) -> JSON:
        return copy.deepcopy({"schema_version": SCHEMA, "session_id": self.session_id, "status": self._status(),
                              **{key: list(getattr(self, key).values()) for key in
                                 ("profiles", "notes", "encounters", "reminders", "moments")},
                              "display": self.display})

    def set_capture(self, *, camera: str | None = None, microphone: str | None = None) -> None:
        updates = {kind: value for kind, value in (("camera", camera), ("microphone", microphone)) if value is not None}
        if any(value not in ("off", "live") for value in updates.values()):
            raise ValueError("Capture status must be off or live")
        if "live" in updates.values() and not self.running:
            self.start()
        for kind, value in (("camera", camera), ("microphone", microphone)):
            if value is not None:
                self.capture[kind] = value if self.running else "off"
        if camera == "off":
            self._cancel_enrollment("Camera stopped", "cancelled")
            for ident in list(self.active):
                self._end(ident)
            for kind in ("faces", "objects"):
                self.streams[kind].available = False
                self.streams[kind].received_at = None
            self.tracks.clear()
            self._unknown_tracks.clear()
            self._face_count = 0
            self.foreground = self._candidate = self._profile_key = None
            self._emit("recognition.cleared", {"track_id": "*"})
            self._idle()
        if self.capture == {"camera": "off", "microphone": "off"}:
            self.stop()
        self._emit("provider.status", {"status": self._status()})

    def start(self) -> None:
        """Resume capture eligibility while retaining session notes, clips and identities."""
        if self.running:
            return
        self.running = True
        self._invalidate_speech_decisions()
        self.streams = {kind: Stream(advanced_at=self.clock()) for kind in ("faces", "objects", "speech")}
        self.tracks.clear()
        self.presence.clear()
        self._unknown_tracks.clear()
        self._observed_face_tracks.clear()
        self.foreground = self._candidate = self._profile_key = None
        self._emit("session.started", {"status": self._status()})
        self._idle()

    def stream_state(self, kind: str, available: bool, *, stream_id: str | None = None) -> None:
        if kind not in self.streams or not isinstance(available, bool):
            raise ValueError("Invalid stream status")
        self._advance()
        state = self.streams[kind]
        if kind == "speech" and (not available or (stream_id is not None and stream_id != state.stream_id)):
            self._invalidate_speech_decisions()
        if stream_id is not None and stream_id != state.stream_id:
            state.stream_id = text(stream_id, "stream_id", 128)
            state.frame_id = state.observed_at = state.received_at = None
            if kind == "faces":
                self._cancel_enrollment("Face connection changed; introduce again", "error")
                self._unknown_tracks.clear()
        state.available = available and self.running
        if not available:
            state.received_at = None
            if kind == "faces":
                self._cancel_enrollment("Face stream is unavailable", "error")
                self._face_count = 0
                self._unknown_tracks.clear()

    def _advance(self) -> None:
        now = self.clock()
        for stream in self.streams.values():
            if stream.available and stream.received_at is not None:
                end = min(now, stream.received_at + OBSERVATION_GAP_S)
                stream.clock += max(0, end - stream.advanced_at)
            stream.advanced_at = now

    def _accept(self, kind: str, frame: JSON, stream_id: str | None) -> tuple[bool, float]:
        if not self.running or not isinstance(frame, dict) or frame.get("type") in ("busy", "error"):
            return False, self.clock()
        stream = self.streams[kind]
        if not stream.available:
            return False, self.clock()
        incoming = stream_id if stream_id is not None else frame.get("stream_id")
        if incoming is not None:
            text(incoming, "stream_id", 128)
        if incoming is not None and stream.stream_id is not None and incoming != stream.stream_id:
            return False, self.clock()
        observed = frame.get("observed_at", self.clock())
        if isinstance(observed, bool) or not isinstance(observed, (int, float)) or not math.isfinite(observed):
            raise ValueError("observed_at must be epoch seconds")
        if observed > self.clock() + 1 or observed < self.created_at - 5:
            return False, observed
        if stream.observed_at is not None and observed < stream.observed_at:
            return False, observed
        frame_id = frame.get("frame_id")
        if frame_id is not None and (isinstance(frame_id, bool) or not isinstance(frame_id, int) or frame_id < 0):
            raise ValueError("Invalid frame_id")
        if isinstance(frame_id, int) and stream.frame_id is not None and frame_id <= stream.frame_id:
            return False, observed
        self._advance()
        stream.available, stream.received_at, stream.observed_at = True, self.clock(), observed
        if incoming is not None:
            stream.stream_id = incoming
        if isinstance(frame_id, int):
            stream.frame_id = frame_id
        return True, observed

    def _gallery_profile(self, person: JSON, *, emit: bool = True) -> str:
        ident, name = text(person.get("id"), "person.id", 128), text(person.get("name"), "person.name", 80)
        if ident in self._deleted_profiles:
            raise ValueError("This person was deleted; start a new enrollment")
        if ident not in self.profiles and len(self.profiles) >= MAX_RECORDS:
            raise ValueError("Session profile limit reached")
        previous = self.profiles.get(ident, {})
        record = {"schema_version": SCHEMA, "id": ident, "kind": "person", "name": name,
                  "created_at": previous.get("created_at", iso(self.clock())), "source": "live-perception", **previous}
        record["name"] = name
        self.profiles[ident] = record
        if emit:
            self._emit("profile.upserted", {"profile": record})
        return ident

    def ingest_faces(self, frame: JSON, *, stream_id: str | None = None) -> bool:
        rows = frame_rows(frame, "faces", 64)
        parsed = [(row, box(row.get("box"), frame.get("input_wh", (640, 480)))) for row in rows]
        count = frame.get("detected_count", len(rows))
        if isinstance(count, bool) or not isinstance(count, int) or not len(rows) <= count <= 4096:
            raise ValueError("Invalid detected_count")
        for row, _ in parsed:
            track_id = row.get("track_id")
            if isinstance(track_id, bool) or not isinstance(track_id, (str, int)) or not str(track_id) or len(str(track_id)) > 128:
                raise ValueError("Invalid face track_id")
            if row.get("stable_id") is not None and not isinstance(row["stable_id"], str):
                raise ValueError("Invalid stable face identity")
        if frame.get("enrollment") is not None:
            validate_enrollment(frame["enrollment"])
        accepted, observed = self._accept("faces", frame, stream_id)
        if not accepted:
            return False
        self._face_count = count
        self._unknown_tracks.clear()
        self._observed_face_tracks.clear()
        stream = self.streams["faces"]
        for row, coords in parsed:
            track_id = str(row.get("track_id", ""))
            if not track_id:
                continue
            known = row.get("stable_id")
            ident = known if isinstance(known, str) and known in self.profiles and self.profiles[known]["kind"] == "person" else None
            key = f"faces:{stream.stream_id}:{track_id}"
            self._observed_face_tracks.add(key)
            old = self.tracks.get(key)
            track = Track(key, "faces", coords, ident, "person", stream.clock, observed,
                          (old.sightings + 1) if old and old.profile_id == ident else 1, track_id)
            self.tracks[key] = track
            if ident:
                self._encounter(ident, observed, "In view", "faces")
            else:
                self._unknown_tracks.add(key)
        enrollment = frame.get("enrollment")
        if enrollment:
            self._enrollment_frame(enrollment)
        if self.enrollment and (self._face_count != 1 or not any(
                self.tracks[key].source_track == self.enrollment.target for key in self._unknown_tracks)):
            self._cancel_enrollment("The target changed or more than one face is visible", "error")
        self._trim_tracks()
        self.tick()
        self._foreground()
        return True

    def ingest_objects(self, frame: JSON, *, stream_id: str | None = None) -> bool:
        rows = frame_rows(frame, "objects", 128)
        parsed = [(row, box(row.get("box_xyxy"), frame.get("input_wh", (1280, 720)))) for row in rows]
        for row, _ in parsed:
            text(row.get("label"), "label", 60)
            score = row.get("score", 1)
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid object score")
        accepted, observed = self._accept("objects", frame, stream_id)
        if not accepted:
            return False
        stream = self.streams["objects"]
        available = {key for key, tr in self.tracks.items() if tr.stream == "objects"}
        labels = {str(row.get("label", "")).strip().lower() for row, _ in parsed}
        for row, coords in parsed:
            label = text(row.get("label"), "label", 60).lower()
            score = row.get("score", 1)
            if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid object score")
            if label == "person" or score < 0.25:
                continue
            candidates = [(key, iou(self.tracks[key].box, coords)) for key in available if self.tracks[key].label == label]
            best = max(candidates, key=lambda pair: pair[1], default=(None, 0))
            key = best[0] if best[1] >= 0.25 else self._id("object_track")
            available.discard(key)
            ident = "object:" + label
            if ident not in self.profiles:
                if len(self.profiles) >= MAX_RECORDS:
                    continue
                self.profiles[ident] = {"schema_version": SCHEMA, "id": ident, "kind": "object", "name": label.capitalize(),
                                        "descriptor": "Object category; individual ownership is not identified",
                                        "created_at": iso(observed), "source": "live-perception"}
                self._emit("profile.upserted", {"profile": self.profiles[ident]})
            x, y = (coords[0] + coords[2]) / 2, (coords[1] + coords[3]) / 2
            zone = ("left" if x < 1 / 3 else "right" if x > 2 / 3 else "center") + (", upper frame" if y < .5 else ", lower frame")
            others = sorted(labels - {label, "person", ""})[:3]
            location = zone + ("; visible with " + ", ".join(others) if others else "")
            old = self.tracks.get(key)
            self.tracks[key] = Track(key, "objects", coords, ident, label, stream.clock, observed,
                                     old.sightings + 1 if old else 1, str(row.get("track_id", "")), location)
            self._encounter(ident, observed, location, "objects")
        self._trim_tracks()
        self.tick()
        self._foreground()
        return True

    def _trim_tracks(self) -> None:
        if len(self.tracks) > MAX_TRACKS:
            for track in sorted(self.tracks.values(), key=lambda tr: tr.observed_at)[:len(self.tracks) - MAX_TRACKS]:
                del self.tracks[track.key]

    def _encounter(self, ident: str, observed: float, location: str, stream: str) -> None:
        previous = self.presence.get(ident, {})
        sightings = previous.get("sightings", 0) + int(previous.get("observed_at") != observed) if ident in self.active else 1
        self.presence[ident] = {"stream": stream, "clock": self.streams[stream].clock,
                                "observed_at": observed, "location": location, "sightings": sightings}
        if ident in self.active:
            return
        self._bounded(self.encounters, 512)
        eid = self._id("enc")
        encounter = {"schema_version": SCHEMA, "id": eid, "profile_id": ident,
                     "started_at": iso(observed), "location": location, "confidence": "strong", "source": "live-perception"}
        self.encounters[eid] = encounter
        self.active[ident] = eid
        self._emit("encounter.started", {"encounter": encounter})

    def _end(self, ident: str, *, confirmed_absence: bool = False) -> None:
        eid = self.active.pop(ident, None)
        if not eid:
            return
        record = self.encounters[eid]
        latest = self.presence.get(ident)
        observed = latest["observed_at"] if latest else epoch(record["started_at"])
        record["ended_at"] = iso(observed)
        self.profiles[ident].update(last_seen_at=iso(observed), last_seen_location=latest["location"] if latest else record.get("location", "In view"))
        self._emit("encounter.ended", {"encounter_id": eid, "ended_at": record["ended_at"]})
        self._emit("profile.upserted", {"profile": self.profiles[ident]})
        if confirmed_absence and self.profiles[ident]["kind"] == "object":
            if self.on_decision_event:
                try:
                    self.on_decision_event({"kind": "object_disappeared", "event_id": eid + ":disappeared",
                                            "encounter_id": eid, "profile_id": ident, "event_at": observed})
                except Exception:
                    _LOG.exception("Decision source-event consumer failed")
            if self.auto_capture_rules:
                self._auto_capture(ident)

    def _auto_capture(self, ident: str) -> None:
        """V1 placement proxy: a repeatedly observed object disappears from view.

        This rule is intentionally not a significance model or ownership assertion.
        Only successful observation frames advance the disappearance clock; an outage,
        Stop or one-frame false positive cannot save a placement clip.
        """
        seen = self.presence.get(ident)
        if not seen or seen["sightings"] < 2 or self.trigger_clip is None or self.capture["camera"] != "live":
            return
        event_at = seen["observed_at"]
        if event_at - self._auto_clip_at.get(ident, float("-inf")) < AUTO_CLIP_COOLDOWN_S:
            return
        if self.clock() - event_at > 15 or len(self.moments) >= MAX_MOMENTS or sum(m["status"] == "recording" for m in self.moments.values()) >= 3:
            return
        self._auto_clip_at[ident] = event_at
        try:
            self._mark({"title": f"{self.profiles[ident]['name']} last seen", "event_at": iso(event_at),
                        "profile_ids": [ident], "location": seen["location"],
                        "summary": "Saved by the V1 object-disappearance rule. Object category, not verified ownership."})
        except Exception:
            # _mark already emits a failed moment when a capture callback fails. A
            # clip failure must not take down ongoing perception or erase last-seen.
            return

    def _track_live(self, track: Track) -> bool:
        stream = self.streams[track.stream]
        return (stream.available and stream.received_at is not None
                and self.clock() - stream.received_at <= OBSERVATION_GAP_S
                and self.clock() - track.observed_at <= OBSERVATION_GAP_S
                and stream.clock - track.last_clock <= COAST_S)

    def _foreground(self) -> None:
        candidates = [tr for tr in self.tracks.values() if tr.profile_id and tr.profile_id in self.active
                      and self._track_live(tr)]
        preferred = max(candidates, key=lambda tr: (tr.stream == "faces", (tr.box[2] - tr.box[0]) * (tr.box[3] - tr.box[1])), default=None)
        ident = preferred.profile_id if preferred else None
        if ident != self.foreground:
            self.foreground = ident
            self._candidate = None
            self._profile_key = None
            if ident:
                self._profile_card(ident)
            elif self.display["priority"] <= PRIORITY["profile"]:
                self._idle()

    def _previous(self, ident: str) -> JSON | None:
        records = [e for e in self.encounters.values() if e["profile_id"] == ident and e.get("ended_at")]
        return max(records, key=lambda e: e["ended_at"], default=None)

    def _profile_body(self, ident: str) -> str:
        profile = self.profiles[ident]
        previous = self._previous(ident)
        label = "Last met" if profile["kind"] == "person" else "Last seen"
        body = f"{label}: {previous['ended_at']}" if previous else ("First meeting this session" if profile["kind"] == "person" else "First seen this session")
        notes = [self._note_display_text(n) for n in self.notes.values() if n["profile_id"] == ident]
        if notes:
            body += "\n" + "\n".join(notes[-2:])
        return body

    def _profile_card(self, ident: str, *, force: bool = False) -> None:
        profile = self.profiles[ident]
        body = self._profile_body(ident)
        reminder = next(iter(self._due(ident)), None)
        self._candidate = self._action("profile", profile["name"], body, reminder=reminder)
        key = f"profile:{self.active.get(ident)}:{profile['name']}:{body}:{reminder and (reminder['id'], reminder['text'])}"
        if key == self._profile_key and not force:
            return
        self._profile_key = key
        self._show(self._candidate, key, force=force)

    @staticmethod
    def _note_display_text(note: JSON) -> str:
        return (f'Heard in conversation: “{note["text"]}”'
                if note.get("attribution") == "conversation_context" and not note.get("edited_by_user")
                else note["text"])

    def _due(self, ident: str) -> list[JSON]:
        eid = self.active.get(ident)
        return [r for r in self.reminders.values() if r["profile_id"] == ident and r["status"] != "completed"
                and (r["status"] != "snoozed" or epoch(r["snoozed_until"]) <= self.clock())
                and (not eid or r.get("dismissed_for_encounter_id") != eid)]

    def _action(self, template: str, title: str, body: str, *, ttl_ms: int = 8000,
                reminder: JSON | None = None, clip_id: str | None = None) -> JSON:
        card = {"template": template, "title": title, "body": body, "image_ref": None,
                "reminder": {"id": reminder["id"], "text": reminder["text"]} if reminder else None}
        if clip_id:
            card["clip_id"] = clip_id
        return {"schema_version": SCHEMA, "id": self._id("display"), "display": {"w": 240, "h": 240},
                "card": card, "blit": None, "ttl_ms": ttl_ms, "priority": PRIORITY[template],
                "issued_at": iso(self.clock()), "expires_at": iso(self.clock() + ttl_ms / 1000) if ttl_ms else None}

    def _show(self, action: JSON, key: str, *, force: bool = False) -> None:
        if not force and (key == self._display_key or action["priority"] < self.display["priority"]):
            return
        self.display, self._display_key = action, key
        self._emit("display.updated", {"action": action})

    def _idle(self) -> None:
        title = datetime.fromtimestamp(self.clock()).strftime("%H:%M")
        self._show(self._action("idle", title, "Ready" if self.running else "Stopped", ttl_ms=0), f"idle:{title}:{self.running}", force=True)

    def tick(self) -> None:
        self._advance()
        for ident in list(self.active):
            seen = self.presence.get(ident)
            if seen and self.streams[seen["stream"]].clock - seen["clock"] >= END_S:
                self._end(ident, confirmed_absence=True)
        self.tracks = {key: tr for key, tr in self.tracks.items() if self.streams[tr.stream].clock - tr.last_clock < END_S}
        self._foreground()
        if self.foreground:
            self._profile_card(self.foreground)
        if self.enrollment and self.clock() - self.enrollment.started >= 30:
            self._cancel_enrollment("Introduction timed out; try again", "error")
        expires = self.display.get("expires_at")
        if expires and self.clock() >= epoch(expires):
            was_priority = self.display["priority"]
            self._display_key = None
            if was_priority > PRIORITY["enroll_prompt"] and self.enrollment and self._enroll_candidate:
                candidate = self._enroll_candidate
                refreshed = self._action("enroll_prompt", candidate["card"]["title"], candidate["card"]["body"])
                self._show(refreshed, f"enroll:{self.enrollment.target}", force=True)
            elif was_priority > PRIORITY["profile"] and self.foreground:
                self.display = self._action("idle", "", "", ttl_ms=0)
                self._profile_card(self.foreground, force=True)
            else:
                self._idle()
        elif self.display["card"]["template"] == "idle":
            title = datetime.fromtimestamp(self.clock()).strftime("%H:%M")
            if title != self.display["card"]["title"]:
                self._idle()

    def ingest_transcript(self, segment: JSON, *, stream_id: str | None = None, execute_rules: bool = True) -> bool:
        if not isinstance(segment, dict):
            raise ValueError("Expected transcript object")
        if not isinstance(execute_rules, bool):
            raise ValueError("execute_rules must be boolean")
        stream = self.streams["speech"]
        if not self.running or not stream.available or (stream_id is not None and stream.stream_id is not None and stream_id != stream.stream_id):
            return False
        raw_id = text(str(segment.get("segment_id", segment.get("id", ""))), "segment_id", 128)
        sid = f"{stream.stream_id}:{raw_id}"
        if sid in self.final_segments:
            return False
        value = text(segment.get("text"), "transcript", 1000)
        final = segment.get("is_final")
        if not isinstance(final, bool):
            raise ValueError("is_final must be boolean")
        rule = self._parse(value) if final else None
        now = iso(self.clock())
        transcript = {"schema_version": SCHEMA, "id": sid, "text": value,
                    "is_final": final, "started_at": now, "updated_at": now, "speaker": "unknown",
                    "directed": "pending" if not execute_rules or not final else "device" if rule and rule[0] != "introduction" else "conversation"}
        self._recent_transcripts[sid] = {**transcript, "recorded_at": self.clock()}
        self._recent_transcripts.move_to_end(sid)
        while len(self._recent_transcripts) > 12:
            self._recent_transcripts.popitem(last=False)
        self._emit("transcript.updated", {"segment": transcript})
        if not final:
            return True
        self.final_segments[sid] = None
        while len(self.final_segments) > 512:
            self.final_segments.popitem(last=False)
        if not execute_rules:
            if self.enrollment and self.enrollment.waiting_name and not rule:
                rule = ("introduction", value)
            token = self._id("speech_decision")
            self._pending_speech[token] = {"id": sid, "text": value, "rule": rule,
                "segment": transcript,
                "generation": self._speech_generation, "stream_id": stream.stream_id,
                "recorded_at": self.clock(), "foreground": self.foreground,
                "identity_target": self._live_person_target(),
                "conversation_target": self._conversation_target(),
                "intro_target": self._introduction_binding(),
                "face_stream_id": self.streams["faces"].stream_id}
            while len(self._pending_speech) > 32:
                self._pending_speech.popitem(last=False)
            return True
        self._execute_transcript_rule(value, rule)
        return True

    def _execute_transcript_rule(self, value: str, rule: tuple[str, str] | None) -> None:
        if self.enrollment and self.enrollment.waiting_name and not rule:
            self._introduction(value)
        elif rule:
            kind, argument = rule
            if kind == "introduction":
                self._introduction(argument)
            elif kind == "clear":
                self._idle()
            elif kind == "note":
                self._save_spoken_note(argument)
            else:
                self.ask(value, parsed=rule)

    def _invalidate_speech_decisions(self) -> None:
        self._speech_generation += 1
        self._pending_speech.clear()

    def pending_transcript_decision(self, segment_id: str, *, stream_id: str | None = None) -> str | None:
        """Opaque token for a final already recorded with execute_rules=False."""
        current = self.streams["speech"].stream_id
        if stream_id is not None and stream_id != current:
            return None
        sid = f"{current}:{segment_id}"
        return next((token for token, pending in reversed(self._pending_speech.items()) if pending["id"] == sid), None)

    def apply_transcript_decision(self, token: str, decision: JSON) -> bool:
        """Consume one gate result; never replay ingestion or trust generated entities.

        The optional bridge owns model thresholds. This boundary requires its typed
        permission to agree with the stored, supported rule and the original capture
        context. False means rejected, expired, already consumed or unsupported.
        """
        if not isinstance(token, str) or not isinstance(decision, dict):
            raise ValueError("Expected a speech decision token and typed decision")
        if not isinstance(decision.get("directed"), bool) or not isinstance(decision.get("allow_introduction"), bool):
            raise ValueError("Speech decision permissions must be boolean")
        if any(not isinstance(decision.get(key, default), bool) for key, default in
               (("remember_conversation", False), ("command_current", True))):
            raise ValueError("Memory and command permissions must be boolean")
        if decision.get("remember_conversation") and decision.get("source") != "jev-1.13.0":
            raise ValueError("Automatic conversation memory requires the pinned Jev model")
        intent = decision.get("intent")
        if not isinstance(intent, str) or intent not in {"none", "find", "identify", "introduction", "note", "recall", "clear", "reminder"}:
            raise ValueError("Unsupported speech decision intent")
        pending = self._pending_speech.pop(token, None)
        if not pending:
            return False
        stream = self.streams["speech"]
        if (not self.running or not stream.available or self.capture["microphone"] != "live"
                or pending["generation"] != self._speech_generation or pending["stream_id"] != stream.stream_id
                or self.clock() - pending["recorded_at"] > 10):
            return False
        resolved = {**pending["segment"], "directed": "device" if decision["directed"] else "conversation",
                    "updated_at": iso(self.clock())}
        rule = pending["rule"]
        # Ambient memory is independent of addressedness and the command grammar.
        # Explicit commands retain their own single write and confirmation path.
        memory_saved = False
        if decision.get("remember_conversation") and not (rule and decision["directed"]):
            resolved["memory"] = self._remember_conversation(pending, decision)
            memory_saved = resolved["memory"]["state"] == "saved"
        recent = self._recent_transcripts.get(pending["id"])
        if recent:
            recent.update(resolved)
        self._emit("transcript.updated", {"segment": resolved})
        if not decision.get("command_current", True):
            return memory_saved
        if not rule or intent != rule[0]:
            return memory_saved
        if intent == "introduction":
            if (not decision["allow_introduction"] or not pending["intro_target"]
                    or pending["intro_target"] != self._introduction_binding()
                    or pending["face_stream_id"] != self.streams["faces"].stream_id):
                return False
        elif not decision["directed"]:
            return memory_saved
        if intent == "note" and pending["foreground"] != self.foreground:
            return False
        if intent == "identify" and pending["identity_target"] != self._live_person_target():
            return False
        self._execute_transcript_rule(pending["text"], rule)
        return True

    def _conversation_target(self) -> tuple[str, str, str, str | None] | None:
        """Bind co-present conversation context, never claim a visible face is the speaker."""
        if self.capture["camera"] != "live" or self._face_count != 1:
            return None
        tracks = [track for track in self.tracks.values() if track.stream == "faces" and self._track_live(track)]
        if len(tracks) != 1:
            return None
        track = tracks[0]
        pid = track.profile_id
        if not pid or pid not in self.active or self.profiles.get(pid, {}).get("kind") != "person":
            return None
        return pid, self.active[pid], track.key, self.streams["faces"].stream_id

    @staticmethod
    def _conversation_key(value: str) -> str:
        return " ".join(value.replace("’", "'").split()).casefold().rstrip(".?! ")

    def _remember_conversation(self, pending: JSON, decision: JSON) -> JSON:
        target = pending.get("conversation_target")
        if not target or target != self._conversation_target():
            return {"state": "not_saved", "reason": "No unambiguous, unchanged person in view"}
        pid, encounter, _, _ = target
        value = pending["text"]
        result = {"profile_id": pid, "profile_name": self.profiles[pid]["name"]}
        key = (pid, self._conversation_key(value))
        duplicate = next((note for note in self.notes.values() if note["profile_id"] == pid
                          and self._conversation_key(note.get("source_text", note["text"])) == key[1]), None)
        try:
            if duplicate or key in self._conversation_seen or (
                    self.note_memory is not None and self.note_memory.conversation_seen(pid, value)):
                return {**result, "state": "duplicate", "note_id": duplicate["id"] if duplicate else None,
                        "reason": "Already remembered or previously removed"}
            if len(self.notes) >= MAX_RECORDS:
                raise ValueError("Note limit reached; delete an old note before saving another")
            note = {"schema_version": SCHEMA, "id": self._id("note"), "profile_id": pid,
                    "text": value, "created_at": iso(pending["recorded_at"]), "updated_at": iso(self.clock()),
                    "source": "live-agent", "attribution": "conversation_context", "speaker": "unknown",
                    "source_text": value, "source_segment_id": pending["id"],
                    "source_session_id": self.session_id, "source_encounter_id": encounter,
                    "decision_model": decision["source"]}
            if self.note_memory is not None:
                self.note_memory.upsert_note(note)
        except (ValueError, RuntimeError) as exc:
            return {**result, "state": "not_saved", "reason": str(exc)[:300]}
        self.notes[note["id"]] = note
        self._conversation_seen[key] = None
        while len(self._conversation_seen) > 512:
            self._conversation_seen.popitem(last=False)
        self._emit("note.upserted", {"note": note})
        if self.foreground == pid:
            self._profile_card(pid)
        return {**result, "state": "saved", "note_id": note["id"]}

    def decision_state(self) -> str:
        """Bounded text-only context for a decision provider, without private vectors."""
        now = self.clock()
        tracks = [track for track in self.tracks.values() if self._track_live(track)]

        def describe(track: Track) -> str:
            area = (track.box[2] - track.box[0]) * (track.box[3] - track.box[1])
            distance = "near" if area >= .25 else "mid" if area >= .05 else "far"
            record = self.encounters.get(self.active.get(track.profile_id or "", ""))
            age = now - epoch(record["started_at"]) if record else 0
            dwell = "long" if age >= 15 else "short" if age >= 3 else "brief"
            name = self.profiles[track.profile_id]["name"] if track.profile_id in self.profiles else "unknown person"
            return json.dumps({"name": name, "identity": "stable" if track.profile_id else "unknown",
                               "proximity": distance, "dwell": dwell, "location": track.location[:100]}, ensure_ascii=False)

        people = [describe(track) for track in tracks if track.stream == "faces"][:4]
        objects = [describe(track) for track in tracks if track.stream == "objects"][:6]
        age = now - epoch(self.display["issued_at"])
        display_age = "fresh" if age < 3 else "aging" if age < 8 else "stale"
        transcript = [{"speaker": "unknown", "text": row["text"][:160], "final": row["is_final"],
                       "directed": row["directed"]} for row in self._recent_transcripts.values()
                      if now - row["recorded_at"] <= 60][-5:]
        last_seen = [{"name": p["name"], "recency": "recent" if now - epoch(p["last_seen_at"]) <= 30 else "earlier",
                      "location": p.get("last_seen_location", "")[:100]}
                     for p in self.profiles.values() if p.get("last_seen_at")][-4:]
        has_person = bool(people)
        introduction_target, _ = self._introduction_target()
        latest_final = next((row["text"] for row in reversed(self._recent_transcripts.values())
                             if row["is_final"] and now - row["recorded_at"] <= 10), "")
        intro_rule = self._parse(latest_final)
        intro_name = intro_rule[1] if intro_rule and intro_rule[0] == "introduction" else None
        conversation_target = self._conversation_target()
        memory_context = ({"name": self.profiles[conversation_target[0]]["name"],
                           "attribution": "conversation context only; speaker unknown"}
                          if conversation_target else None)
        remembered = [note["text"][:200] for note in self.notes.values()
                      if conversation_target and note["profile_id"] == conversation_target[0]][-4:]

        def serialize() -> str:
            return "\n".join([
                "CAPTURE " + json.dumps(self.capture),
                f"DISPLAY {self.display['card']['template']}({display_age})",
                "PEOPLE " + (" · ".join(people) or "none currently observed"),
                "INTRODUCTION_TARGET=" + introduction_target,
                "INTRODUCTION_NAME_CANDIDATE " + json.dumps(intro_name, ensure_ascii=False),
                "MEMORY_TARGET " + json.dumps(memory_context, ensure_ascii=False),
                "ALREADY_REMEMBERED " + json.dumps(remembered, ensure_ascii=False),
                "OBJECTS " + (" · ".join(objects) or "none currently observed"),
                "CONVERSATION_CONTEXT " + ("person_in_view; speaker identity unknown" if has_person else "no person currently observed; speaker identity unknown"),
                "LAST_SEEN " + json.dumps(last_seen, ensure_ascii=False),
                "TRANSCRIPTS_60S " + json.dumps(transcript, ensure_ascii=False),
            ])

        state = serialize()
        for group in (last_seen, objects, people, transcript, remembered):
            while group and len(state.encode("utf-8")) > 4096:
                group.pop(0)
                state = serialize()
        return state

    @staticmethod
    def _parse(value: str) -> tuple[str, str] | None:
        normalized = value.strip().rstrip(".?! ").replace("’", "'")
        found = re.fullmatch(r"(?:please )?where (?:are|is|did I (?:leave|put)) (?:my|the) ([\w -]{1,60})(?: please)?", normalized, re.I)
        if found:
            return "find", found[1].strip().lower()
        if re.fullmatch(r"(?:please )?(?:who(?: is|'s) (?:this|that)(?: person)?|who am I (?:speaking|talking) (?:to|with)|identify (?:this|that)(?: person)?)", normalized, re.I):
            return "identify", ""
        if re.fullmatch(r"(?:please )?(?:clear (?:the )?display|clear (?:the )?screen)", normalized, re.I):
            return "clear", ""
        reminder = re.fullmatch(r"(?:please[, ]+)?remind\s+me\s+to\s+(.+)", normalized, re.I)
        if reminder:
            return "reminder", reminder[1].strip()
        note = re.fullmatch(r"(?:please )?remember (?:that )?(.+)", normalized, re.I)
        if note:
            return "note", note[1]
        recall = re.fullmatch(r"(?:recall|show|what are) (?:my |the )?notes(?: about (.+))?", normalized, re.I)
        if recall:
            return "recall", (recall[1] or "").strip()
        intro = re.search(r"\b(?:I'm|I am|my name(?: is|'s)|I go by|you can call me|this is|that's|(?:their|her|his) name(?: is|'s))\s+(.+)", normalized, re.I)
        if intro:
            # Only propose text actually spoken. Jev validates this exact candidate
            # and its attribution; a name mention alone is never a naming decision.
            candidate = re.split(r"[,;.!?]|\s+(?:and|but|from|nice|here|by the way|I|who|we|it's|working|studying)\b",
                                 intro[1], maxsplit=1, flags=re.I)[0].strip()
            return "introduction", candidate or intro[1].strip()
        return None

    def _live_profile_target(self) -> str | None:
        ident = self.foreground
        if (ident in self.profiles
                and any(track.profile_id == ident and self._track_live(track) for track in self.tracks.values())):
            return ident
        return None

    def _live_person_target(self) -> str | None:
        ident = self._live_profile_target()
        return ident if ident is not None and self.profiles[ident]["kind"] == "person" else None

    def ask(self, question: str, *, parsed: tuple[str, str] | None = None) -> JSON:
        question = text(question, "question", 400)
        kind, target = parsed or self._parse(question) or ("unsupported", "")
        qid = self._id("query")
        self._emit("answer.pending", {"query_id": qid, "question": question})
        answer: JSON = {"query_id": qid, "question": question, "kind": "not_found", "text": "I have no matching record in this session.", "answered_at": iso(self.clock())}
        answer_observation = None
        handled_display = False
        if kind == "clear":
            self._idle()
            answer.update(kind="found", text="Display cleared.")
            handled_display = True
        elif kind == "note":
            answer.update(self._save_spoken_note(target))
            handled_display = True
        elif kind == "introduction":
            if not self.running or self.capture["camera"] != "live":
                answer["text"] = "Start the camera before introducing someone. No profile was created."
            else:
                result = self._introduction(target)
                answer.update(kind="found" if result["status"] in ("collecting", "complete") else "not_found", text=result["message"])
                handled_display = result["status"] in ("collecting", "listening", "complete")
        elif kind == "identify":
            ident = self._live_person_target()
            if ident:
                answer.update(kind="found", profile_id=ident,
                              text=f"This is {self.profiles[ident]['name']}.\n{self._profile_body(ident)}")
            else:
                answer["text"] = "No recognized person is currently in view."
        elif kind == "find":
            canonical = target[:-1] if target.endswith("s") else target
            options = [p for p in self.profiles.values() if p["kind"] == "object" and p["name"].lower().removesuffix("s") == canonical]
            if options:
                profile = options[0]
                ident = profile["id"]
                tracks = [tr for tr in self.tracks.values() if tr.profile_id == ident and self._track_live(tr)]
                seen = self.presence.get(ident)
                last_observed = seen["observed_at"] if seen else epoch(profile["last_seen_at"]) if profile.get("last_seen_at") else None
                answer_observation = last_observed
                if tracks:
                    latest = max(tracks, key=lambda tr: tr.observed_at)
                    answer.update(kind="found", profile_id=ident, text=f"{profile['name']}: in view, {latest.location}.")
                elif last_observed is not None:
                    location = seen["location"] if seen else profile.get("last_seen_location", "in view")
                    context = [iso(last_observed), "This session only; object category, not verified ownership."]
                    stream = self.streams["objects"]
                    if not stream.available or stream.received_at is None or self.clock() - stream.received_at > OBSERVATION_GAP_S:
                        context.append("Object observations are unavailable; this is the last confirmed sighting.")
                    answer.update(kind="found", profile_id=ident, text=f"{profile['name']}: last seen {location}.", context=context)
                moments = [m for m in self.moments.values() if ident in m["profile_ids"] and m["status"] == "saved"
                           and last_observed is not None and m.get("clip")
                           and epoch(m["clip"]["start_at"]) - .05 <= last_observed <= epoch(m["clip"]["end_at"]) + .05]
                if moments and answer["kind"] == "found":
                    answer["moment_id"] = max(moments, key=lambda m: m["event_at"])["id"]
                elif answer["kind"] == "found":
                    pending = any(m["status"] == "recording" and ident in m["profile_ids"]
                                  and last_observed is not None and abs(epoch(m["event_at"]) - last_observed) <= 5
                                  for m in self.moments.values())
                    answer.setdefault("context", []).append("The clip is still being saved." if pending else "No saved clip covers this sighting yet.")
        elif kind == "recall":
            ids = {p["id"] for p in self.profiles.values() if target and p["name"].lower() == target.lower()}
            if not target:
                ids = {self.foreground} if self.foreground else set(self.profiles)
            notes = [n for n in self.notes.values() if n["profile_id"] in ids]
            if notes:
                answer.update(kind="found", text="\n".join(self._note_display_text(n) for n in notes[-3:]))
        elif kind == "reminder":
            answer.update(self._save_person_reminder(target))
        else:
            answer.update(kind="unsupported", text="V1 supports finding an observed object, identifying the person in view, recalling notes, person reminders, introductions, and clearing the display.")
        self._emit("answer.resolved", {"answer": answer})
        self._last_answer, self._answer_observation = copy.deepcopy(answer), answer_observation
        if not handled_display:
            self._show(self._action("answer", question, answer["text"], clip_id=answer.get("moment_id")), qid, force=True)
        return answer

    def _save_person_reminder(self, request: str) -> JSON:
        """Resolve a named-person reminder without guessing speaker or face identity."""
        match = re.fullmatch(r"(ask|tell|talk\s+to|speak\s+to)\s+(.+?)\s+about\s+(.+)", request, re.I)
        if not match:
            return {"kind": "unsupported", "text": 'Say "Remind me to ask Bob about dinner," using their enrolled name.'}
        verb, name, topic = match.groups()
        name = name.strip(' ,"“”')

        def normalized(value: str) -> str:
            return " ".join(value.replace("’", "'").split()).casefold()

        people = [p for p in self.profiles.values() if p["kind"] == "person" and normalized(p["name"]) == normalized(name)]
        if not people:
            return {"kind": "not_found", "text": f'I do not have an enrolled person named {name}. Use their enrolled full name, or introduce them first. No reminder was saved.'}
        if len(people) != 1:
            return {"kind": "not_found", "text": f'More than one enrolled person is named {name}. Choose the intended profile and add the reminder there. No reminder was saved.'}
        person = people[0]
        reminder_text = f"{' '.join(verb.split()).capitalize()} {person['name']} about {topic.strip()}"
        if len(reminder_text) > 240:
            return {"kind": "unsupported", "text": "Please shorten that reminder to 240 characters. No reminder was saved."}
        if len(self.reminders) >= MAX_RECORDS:
            return {"kind": "unsupported", "text": "This session has reached its reminder limit. Delete an old reminder before adding another."}
        self.dispatch({"type": "reminder.save", "payload": {"reminder": {
            "profile_id": person["id"], "text": reminder_text}, "defer_until_next_encounter": True}})
        return {"kind": "found", "profile_id": person["id"],
                "text": f"Next time I see {person['name']}, I'll remind you: {reminder_text}."}

    def _introduction_target(self) -> tuple[str, list[Track]]:
        """Same categorical eligibility for gate context and enrollment execution."""
        stream = self.streams["faces"]
        if (self.capture["camera"] != "live" or not stream.available or stream.received_at is None
                or self.clock() - stream.received_at > 1):
            return "none", []
        candidates = [track for track in self.tracks.values() if track.key in self._observed_face_tracks
                      and track.sightings >= 3 and stream.clock - track.last_clock <= .5]
        if self._face_count > 1 or len(candidates) > 1:
            return "ambiguous", []
        if self._face_count == 1 and len(candidates) == 1:
            return ("single_stable_known" if candidates[0].profile_id else "single_stable_unknown"), candidates
        return "none", []

    def _introduction_binding(self) -> tuple[str, str | None] | None:
        _, candidates = self._introduction_target()
        return (candidates[0].key, candidates[0].profile_id) if len(candidates) == 1 else None

    def refresh_person(self, person: JSON) -> None:
        ident = self._gallery_profile(person)
        self._last_answer = None
        if self.foreground == ident:
            self._profile_card(ident, force=True)

    def _introduction(self, name: str) -> JSON:
        target_state, candidates = self._introduction_target()
        stream = self.streams["faces"]
        if target_state not in ("single_stable_unknown", "single_stable_known"):
            return self._enrollment_event("ambiguous", "An introduction needs exactly one stable face in view. No name was changed.")
        target = candidates[0].source_track
        name = text(name, "name", 160).strip('"“”').rstrip(".!? ").replace("’", "'")
        named = self._parse(name)
        if named and named[0] == "introduction":
            name = named[1]
        words = name.split()
        if not 1 <= len(words) <= 3 or any(not re.fullmatch(r"[\w'’-]+", part, re.UNICODE) for part in words):
            if self.enrollment and self.enrollment.attempts >= 1:
                message = "Could not extract a short name; introduce again"
                self._cancel_enrollment(message, "error")
                return {"status": "error", "message": message}
            else:
                self.enrollment = Enrollment(target or "", stream.stream_id, "", self.clock(), attempts=1, waiting_name=True)
                result = self._enrollment_event("listening", "Say just their name.")
                self._enroll_candidate = self._action("enroll_prompt", "Who is this?", "Say just their name.")
                self._show(self._enroll_candidate, "enroll:prompt")
                return result
        clean = text(name, "name", 80).title()
        ident = candidates[0].profile_id
        if ident:
            if self.rename_person is None:
                return self._enrollment_event("error", "Profile name updates are not connected")
            try:
                person = self.rename_person(ident, clean)
            except (ValueError, RuntimeError) as exc:
                return self._enrollment_event("error", str(exc))
            if self.profiles[ident]["name"] != clean:
                self.refresh_person(person)
            return self._enrollment_event("complete", f"Name updated to {clean}", profile_id=ident, name=clean)
        if self.control is None:
            return self._enrollment_event("error", "Enrollment control is not connected")
        if self.enrollment and not self.enrollment.waiting_name:
            return {"status": "collecting", "message": f"Already learning {self.enrollment.name}. Finish or cancel that introduction first."}
        self.enrollment = Enrollment(target or "", stream.stream_id, clean, self.clock())
        self.control({"type": "enroll", "name": clean, "target_track_id": target, "session_id": self.session_id})
        result = self._enrollment_event("collecting", f"Learning {clean} from clear face frames", collected=0, required=5)
        self._enroll_candidate = self._action("enroll_prompt", clean, "Learning this face…")
        self._show(self._enroll_candidate, f"enroll:{target}")
        return result

    def _enrollment_event(self, status: str, message: str, **extra: Any) -> JSON:
        value: JSON = {"status": status, "message": message, **extra}
        if self.enrollment:
            value.update(target_track_id=self.enrollment.target, name=self.enrollment.name)
        self._emit("enrollment.updated", {"enrollment": value})
        return value

    def _enrollment_frame(self, result: JSON) -> None:
        if not self.enrollment or self.enrollment.waiting_name:
            return
        if result.get("target_track_id") is not None and str(result["target_track_id"]) != self.enrollment.target:
            return
        status = result.get("status")
        if status == "complete":
            ident = self._gallery_profile(result.get("person", {}))
            self._enrollment_event("complete", f"Added {self.profiles[ident]['name']}", profile_id=ident)
            self.enrollment = None
            self._enroll_candidate = None
            self._show(self._action("enroll_prompt", "Profile created", self.profiles[ident]["name"], ttl_ms=3000), f"enrolled:{ident}")
        elif status == "error":
            self._cancel_enrollment(str(result.get("message", "Enrollment failed")), "error")
        elif status == "collecting":
            self._enrollment_event("collecting", "Learning clear face frames", collected=result.get("collected", 0), required=result.get("required", 5))

    def _cancel_enrollment(self, message: str, status: str = "cancelled") -> None:
        if self.enrollment:
            self._enrollment_event(status, message)
            if self.control and not self.enrollment.waiting_name:
                self.control({"type": "cancel_enrollment", "session_id": self.session_id})
            self.enrollment = None
            self._enroll_candidate = None

    def _save_spoken_note(self, value: str) -> JSON:
        ident = self._live_profile_target()
        if not ident:
            message = "A note needs a person or object in view."
            self._show(self._action("answer", "Choose a profile", message), self._id("answer"), force=True)
            return {"kind": "not_found", "text": message}
        self.dispatch({"type": "note.save", "payload": {"note": {"profile_id": ident, "text": value}}})
        self._show(self._action("answer", "Note saved", value), self._id("answer"), force=True)
        return {"kind": "found", "profile_id": ident, "text": "Note saved: " + value}

    def _bounded(self, records: dict, limit: int = MAX_RECORDS) -> None:
        if len(records) >= limit:
            raise ValueError("Temporary session storage limit reached; reset the session")

    def delete_profile(self, profile_id: str, *, delete_notes: bool = True) -> None:
        """Forget one person while retaining recordings with their tag removed."""
        ident = text(profile_id, "profile_id", 128)
        profile = self.profiles.get(ident)
        if profile is not None and profile["kind"] != "person":
            raise ValueError("Only people can be deleted")
        memory = getattr(self, "note_memory", None)
        if delete_notes and memory is not None:
            memory.delete_profile_notes(ident)
        self._deleted_profiles[ident] = None
        self._deleted_profiles.move_to_end(ident)
        while len(self._deleted_profiles) > 1024:
            self._deleted_profiles.popitem(last=False)
        removed_reminders = {key for key, row in self.reminders.items() if row["profile_id"] == ident}
        clear_display = (self.foreground == ident or self._last_answer is not None
                         or (self.display["card"].get("reminder") or {}).get("id") in removed_reminders
                         or self._display_key == f"enrolled:{ident}")
        self.profiles.pop(ident, None)
        for records in (self.notes, self.reminders, self.encounters):
            for key in [key for key, row in records.items() if row["profile_id"] == ident]:
                records.pop(key)
        self.active.pop(ident, None)
        self.presence.pop(ident, None)
        self._auto_clip_at.pop(ident, None)
        for track in self.tracks.values():
            if track.profile_id == ident:
                track.profile_id = None
        for moment in self.moments.values():
            moment["profile_ids"] = [pid for pid in moment["profile_ids"] if pid != ident]
        self._last_answer = None
        self._answer_observation = None
        self._invalidate_speech_decisions()
        for transcript in self._recent_transcripts.values():
            if transcript.get("memory", {}).get("profile_id") == ident:
                transcript.pop("memory", None)
        for key in [key for key in self._conversation_seen if key[0] == ident]:
            self._conversation_seen.pop(key)
        self._candidate = None
        self._profile_key = None
        self._emit("profile.deleted", {"profile_id": ident})
        if clear_display:
            self._idle()
        self._foreground()

    def dispatch(self, command: JSON) -> JSON:
        if not isinstance(command, dict) or not isinstance(command.get("payload", {}), dict):
            raise ValueError("Expected command object and payload")
        kind, data = command.get("type"), command.get("payload", {})
        if not self.running and kind in ("enrollment.introduction", "moment.mark"):
            raise ValueError("Start capture before enrolling or marking a moment")
        if kind == "ask":
            return {"ok": True, "answer": self.ask(data.get("text"))}
        if kind == "capture.status":
            self.set_capture(camera=data.get("camera"), microphone=data.get("microphone"))
        elif kind == "display.clear":
            self._idle()
        elif kind == "enrollment.cancel":
            self._cancel_enrollment("Cancelled")
        elif kind == "enrollment.introduction":
            self._introduction(text(data.get("name"), "name", 160))
        elif kind == "enrollment.status":
            incoming = data.get("stream_id")
            if incoming is not None and incoming != self.streams["faces"].stream_id:
                return {"ok": False, "ignored": "stale face stream"}
            update = data.get("data")
            if not isinstance(update, dict):
                raise ValueError("Expected face enrollment status data")
            if self.enrollment:
                if update.get("type") == "error":
                    self._cancel_enrollment(str(update.get("message") or "Enrollment could not start")[:300], "error")
                elif update.get("type") == "enrollment_cancelled":
                    self._cancel_enrollment("Enrollment cancelled")
                elif update.get("type") == "enrollment_started":
                    self._enrollment_event("collecting", "Learning clear face frames", collected=0, required=5)
                else:
                    validate_enrollment(update)
                    self._enrollment_frame(update)
        elif kind == "moment.mark":
            return {"ok": True, "moment_id": self._mark(data)}
        elif kind == "moment.delete":
            ident = text(data.get("moment_id"), "moment_id", 128)
            self.moments.pop(ident, None)
            for profile in self.profiles.values():
                if profile.get("last_moment_id") == ident:
                    profile.pop("last_moment_id", None)
            if self._last_answer and self._last_answer.get("moment_id") == ident:
                self._last_answer.pop("moment_id", None)
            self._emit("moment.deleted", {"moment_id": ident})
            if self.display["card"].get("clip_id") == ident:
                updated = copy.deepcopy(self.display)
                updated["card"].pop("clip_id", None)
                self._show(updated, self._id("clip_deleted"), force=True)
        elif kind == "profile.delete":
            self.delete_profile(data.get("profile_id"))
        elif kind in ("note.save", "reminder.save"):
            noun = kind.split(".")[0]
            record = data.get(noun)
            if not isinstance(record, dict):
                raise ValueError(f"Expected {noun}")
            ident = text(record["id"], "id", 128) if record.get("id") else self._id(noun)
            records = self.notes if noun == "note" else self.reminders
            previous = records.get(ident)
            if noun == "note" and ident in self._deleted_notes:
                raise ValueError("This note no longer exists; refresh the profile")
            pid = text(record.get("profile_id"), "profile_id", 128)
            if pid not in self.profiles or (noun == "reminder" and self.profiles[pid]["kind"] != "person"):
                raise ValueError("Unknown profile or reminder is not linked to a person")
            value = text(record.get("text"), "text", 240 if noun == "reminder" else 1000)
            if not previous:
                if noun == "note" and len(records) >= MAX_RECORDS:
                    raise ValueError("Note limit reached; delete an old note before saving another")
                self._bounded(records)
            saved = {"schema_version": SCHEMA, "id": ident, "profile_id": pid, "text": value,
                     "created_at": previous["created_at"] if previous else iso(self.clock()), "updated_at": iso(self.clock()), "source": "user"}
            if noun == "note" and previous and previous.get("attribution") == "conversation_context":
                if pid != previous["profile_id"]:
                    raise ValueError("A conversation note cannot be reassigned to a different person")
                saved = {**previous, **saved, "source": previous["source"], "edited_by_user": True}
            if noun == "reminder":
                defer = data.get("defer_until_next_encounter", False)
                if not isinstance(defer, bool):
                    raise ValueError("Reminder encounter deferral must be boolean")
                status = record.get("status", previous["status"] if previous else "active")
                if status not in ("active", "snoozed", "completed"):
                    raise ValueError("Invalid reminder status")
                saved["status"] = status
                if status == "snoozed":
                    until = record.get("snoozed_until", (previous or {}).get("snoozed_until"))
                    if not isinstance(until, str) or epoch(until) <= self.clock():
                        raise ValueError("Snoozed reminder needs a future timestamp")
                    saved["snoozed_until"] = until
                if status == "completed":
                    saved["completed_at"] = (previous or {}).get("completed_at", iso(self.clock()))
                # Spoken requests are for the next meeting; include the deferral
                # in the first event so the current profile never flashes it.
                if defer and pid in self.active:
                    saved["dismissed_for_encounter_id"] = self.active[pid]
            if noun == "note" and self.note_memory is not None and self.profiles[pid]["kind"] == "person":
                self.note_memory.upsert_note(saved)
            if noun == "note":
                records.pop(ident, None)  # Match persisted updated-time ordering after edits.
            records[ident] = saved
            self._emit(f"{noun}.upserted", {noun: saved})
            if self.foreground and (pid == self.foreground or (previous and previous["profile_id"] == self.foreground)):
                self._profile_card(self.foreground)
            return {"ok": True, "id": ident}
        elif kind in ("note.delete", "reminder.delete"):
            noun = kind.split(".")[0]
            ident = text(data.get(noun + "_id"), noun + "_id", 128)
            records = self.notes if noun == "note" else self.reminders
            old = records.get(ident)
            if noun == "note" and old and self.note_memory is not None and self.profiles[old["profile_id"]]["kind"] == "person":
                self.note_memory.delete_note(ident)
            old = records.pop(ident, None)
            if noun == "note":
                self._deleted_notes[ident] = None
                while len(self._deleted_notes) > 512:
                    self._deleted_notes.popitem(last=False)
            self._emit(f"{noun}.deleted", {noun + "_id": ident})
            if old and old["profile_id"] == self.foreground:
                self._profile_card(self.foreground)
        elif kind in ("reminder.complete", "reminder.snooze", "reminder.dismiss"):
            ident = text(data.get("reminder_id"), "reminder_id", 128)
            if ident not in self.reminders:
                raise ValueError("Unknown reminder")
            reminder = copy.deepcopy(self.reminders[ident])
            if kind == "reminder.complete":
                reminder.update(status="completed", completed_at=iso(self.clock()))
                reminder.pop("snoozed_until", None)
            elif kind == "reminder.snooze":
                minutes = data.get("minutes", 15)
                if isinstance(minutes, bool) or not isinstance(minutes, (int, float)) or not 1 <= minutes <= 10080:
                    raise ValueError("Snooze must be 1–10080 minutes")
                reminder.update(status="snoozed", snoozed_until=iso(self.clock() + minutes * 60))
                reminder.pop("dismissed_for_encounter_id", None)
            else:
                eid = text(data.get("encounter_id"), "encounter_id", 128)
                if self.active.get(reminder["profile_id"]) != eid:
                    raise ValueError("Reminder dismissal must refer to its active encounter")
                reminder["dismissed_for_encounter_id"] = eid
            reminder["updated_at"] = iso(self.clock())
            self.reminders[ident] = reminder
            self._emit("reminder.upserted", {"reminder": reminder})
            if reminder["profile_id"] == self.foreground:
                self._profile_card(self.foreground)
        else:
            raise ValueError(f"Unsupported command: {kind}")
        return {"ok": True}

    def _mark(self, data: JSON) -> str:
        if self.capture["camera"] != "live":
            raise ValueError("Start the camera before marking a moment")
        if self.trigger_clip is None:
            raise ValueError("Clip capture is not connected")
        if len(self.moments) >= MAX_MOMENTS or sum(m["status"] == "recording" for m in self.moments.values()) >= 3:
            raise ValueError("Clip limit reached; finish or delete a moment first")
        title = text(data.get("title", "Marked moment"), "title", 120)
        source = data.get("source", "v1-rules")
        if not isinstance(source, str) or source not in ("v1-rules", "jev-1.13.0"):
            raise ValueError("Moment source must be v1-rules or jev-1.13.0")
        if source == "jev-1.13.0" and "event_at" not in data:
            raise ValueError("Jev moments require their original source event_at")
        now = self.clock()
        raw_event_at = data.get("event_at", now)
        if isinstance(raw_event_at, str):
            event_epoch = epoch(raw_event_at)
        elif isinstance(raw_event_at, (int, float)) and not isinstance(raw_event_at, bool) and math.isfinite(raw_event_at):
            event_epoch = float(raw_event_at)
        else:
            raise ValueError("Moment event_at must be ISO UTC or finite epoch seconds")
        if source == "jev-1.13.0" and not now - 10 <= event_epoch <= now:
            raise ValueError("Jev source event must be within the past 10 seconds and cannot be in the future")
        if not now - 15 <= event_epoch <= now + 1:
            raise ValueError("Moment must be within the current capture window")
        event_at = iso(event_epoch)
        pids = data.get("profile_ids", [self.foreground] if self.foreground else [])
        if not isinstance(pids, list) or len(pids) > 16 or any(not isinstance(p, str) or p not in self.profiles for p in pids):
            raise ValueError("Unknown moment profiles")
        ident = self._id("moment")
        moment = {"schema_version": SCHEMA, "id": ident, "title": title, "event_at": event_at,
                  "status": "recording", "clip": None, "profile_ids": list(dict.fromkeys(pids)),
                  "source": "live-agent" if source == "jev-1.13.0" else "v1-rules"}
        if source == "jev-1.13.0":
            moment["decision_model"] = source
        for field_name in ("summary", "location"):
            if data.get(field_name) is not None:
                moment[field_name] = text(data[field_name], field_name, 400)
        self.moments[ident] = moment
        self._emit("moment.recording", {"moment": moment})
        try:
            self.trigger_clip({"moment_id": ident, "event_at": event_at, "title": title, "profile_ids": moment["profile_ids"]})
        except Exception:
            self.clip_failed(ident, "Clip capture could not start")
            raise
        return ident

    def clip_completed(self, moment_id: str, clip: JSON) -> bool:
        moment = self.moments.get(moment_id)
        if not self.running or not moment or moment["status"] != "recording":
            return False
        if not isinstance(clip, dict) or not isinstance(clip.get("url"), str) or not clip["url"].startswith("/") or clip["url"].startswith("//") or "\\" in clip["url"] or any(ord(ch) < 32 for ch in clip["url"]):
            raise ValueError("Clip must have a same-origin media URL")
        text(clip.get("id"), "clip.id", 128)
        if clip.get("mime") != "video/mp4" or not isinstance(clip.get("provenance"), dict) or clip["provenance"].get("kind") != "live-ring-buffer":
            raise ValueError("Expected an actual live-ring-buffer MP4")
        start, end = epoch(clip.get("start_at")), epoch(clip.get("end_at"))
        requested_start, requested_end = epoch(clip.get("requested_start_at")), epoch(clip.get("requested_end_at"))
        event_at = epoch(moment["event_at"])
        duration = clip.get("duration_s")
        if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0 or abs(duration - (end - start)) > .3:
            raise ValueError("Clip duration does not match its actual footage")
        if abs(requested_start - (event_at - 5)) > .001 or abs(requested_end - (event_at + 5)) > .001:
            raise ValueError("Clip requested window must be five seconds before and after the event")
        if end <= start or start < requested_start - .001 or end > requested_end + .001 or clip.get("coverage") not in ("complete", "partial"):
            raise ValueError("Invalid clip coverage")
        if clip["coverage"] == "complete" and (start > requested_start + .25 or end < requested_end - .25):
            raise ValueError("Complete clip has missing footage")
        if self.clock() + .05 < requested_end:
            raise ValueError("Clip cannot be saved before its post-event capture window")
        moment.update(status="saved", clip=copy.deepcopy(clip), saved_at=iso(self.clock()))
        self._emit("moment.saved", {"moment": moment})
        answer = self._last_answer
        if answer and answer.get("profile_id") in moment["profile_ids"] and self._answer_observation is not None and start - .05 <= self._answer_observation <= end + .05:
            answer = copy.deepcopy(answer)
            answer["moment_id"] = moment_id
            answer["context"] = [line for line in answer.get("context", [])
                                 if line not in ("The clip is still being saved.", "No saved clip covers this sighting yet.")]
            answer["context"].append("Clip saved from that sighting.")
            self._last_answer = answer
            self._emit("answer.resolved", {"answer": answer})
            if self._display_key == answer["query_id"]:
                action = copy.deepcopy(self.display)
                action["card"]["clip_id"] = moment_id
                self._show(action, answer["query_id"], force=True)
        return True

    def clip_failed(self, moment_id: str, reason: str) -> bool:
        moment = self.moments.get(moment_id)
        if not moment or moment["status"] not in ("recording", "saved"):
            return False
        safe = " ".join(str(reason or "Clip is unavailable").replace("\x00", "").split())[:300] or "Clip is unavailable"
        moment.update(status="failed", clip=None, failure_reason=safe)
        self._emit("moment.failed", {"moment_id": moment_id, "reason": safe})
        if self.display["card"].get("clip_id") == moment_id:
            updated = copy.deepcopy(self.display)
            updated["card"].pop("clip_id", None)
            self._show(updated, self._id("clip_expired"), force=True)
        return True

    def clip_expired(self, moment_id: str, reason: str = "Temporary clip expired") -> bool:
        return self.clip_failed(moment_id, reason)

    def stop(self) -> None:
        if not self.running:
            return
        self._invalidate_speech_decisions()
        self._cancel_enrollment("Capture stopped", "cancelled")
        for ident in list(self.active):
            self._end(ident)
        for ident, moment in self.moments.items():
            if moment["status"] == "recording":
                self.clip_failed(ident, "Capture stopped before the clip finished")
        self.running = False
        self.capture = {"camera": "off", "microphone": "off"}
        for stream in self.streams.values():
            stream.available = False
            stream.received_at = None
        self.tracks.clear()
        self.foreground = None
        self._candidate = None
        self._emit("recognition.cleared", {"track_id": "*"})
        self._emit("session.stopped", {"status": self._status()})
        self._idle()
