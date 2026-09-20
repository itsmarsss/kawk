"""Synthetic clocks and decisions, kept separate from the real policy under test."""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

from tools.perception_lab.product import ProductSession

PEOPLE = [{"id": "bob", "name": "Bob"}, {"id": "alice", "name": "Alice"}]


@dataclass
class ReplayClock:
    """Epoch clock controlled by fixture time; never a performance measurement."""

    simulated_ms: float = 0
    origin: float = 1_790_000_000

    def __call__(self) -> float:
        return self.origin + self.simulated_ms / 1000

    def advance_to(self, value: float) -> None:
        if value < self.simulated_ms:
            raise ValueError("Replay receipt times must be nondecreasing")
        self.simulated_ms = value


@dataclass
class Evidence:
    clock: ReplayClock
    rows: list[dict[str, Any]] = field(default_factory=list)

    def add(self, event: str, **values: Any) -> None:
        self.rows.append({"simulated_ms": self.clock.simulated_ms,
                          "event": event, **copy.deepcopy(values)})


def product_rig(case_id: str) -> tuple[ProductSession, ReplayClock, Evidence]:
    clock = ReplayClock()
    evidence = Evidence(clock)

    def emit(envelope: dict[str, Any]) -> None:
        # UUIDs and wall-clock-independent fixtures need not be reproducible IDs.
        evidence.add("product_event", type=envelope["type"], payload=envelope["payload"])

    session = ProductSession(case_id, emit, clock, PEOPLE, auto_capture_rules=False)
    session.set_capture(camera="live", microphone="live")
    for kind in ("faces", "speech"):
        session.stream_state(kind, True, stream_id=f"{kind}-replay")
    return session, clock, evidence


def observe_person(session: ProductSession, clock: ReplayClock, person: str,
                   track: int = 1) -> None:
    observe_people(session, clock, [person], first_track=track)


def observe_people(session: ProductSession, clock: ReplayClock, people: list[str],
                   first_track: int = 1) -> None:
    session.ingest_faces({
        "faces": [{"track_id": first_track + index, "box": [40 + index * 300, 70, 240 + index * 300, 270],
                   "stable_id": person, "stable_name": person.title(),
                   "detection_score": .95} for index, person in enumerate(people)],
        "input_wh": [640, 480], "observed_at": clock(), "detected_count": len(people),
    }, stream_id="faces-replay")


def memory_decision(**changes: Any) -> dict[str, Any]:
    return {"directed": False, "allow_introduction": False, "intent": "none",
            "remember_conversation": True, "command_current": True,
            "source": "jev-1.13.0", **changes}


def accept_transcript(session: ProductSession, clock: ReplayClock, event: dict[str, Any],
                      evidence: Evidence) -> str | None:
    segment = {"segment_id": event["segment_id"], "text": event["text"],
               "is_final": event["is_final"], "speaker": "unknown"}
    # Preserve source timestamps in the input to demonstrate whether the current
    # app uses them. Receipt time is deliberately a separate clock.
    for key in ("source_start_ms", "source_end_ms"):
        if key in event:
            segment[key] = event[key]
    if "source_start_ms" in event:
        segment["started_at"] = clock.origin + event["source_start_ms"] / 1000
        segment["t_start_hub"] = segment["started_at"]
    accepted = session.ingest_transcript(segment, stream_id="speech-replay", execute_rules=False)
    token = session.pending_transcript_decision(event["segment_id"], stream_id="speech-replay")
    evidence.add("transcript_input", **segment, accepted=accepted,
                 decision_pending=token is not None, note_count=len(session.notes))
    return token if accepted else None
