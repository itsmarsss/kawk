"""Replay transcript mutations and overload through the actual product classes."""
from __future__ import annotations

import asyncio

from remember_hub.contracts.decisions import GateAnswer

from tools.perception_lab.product_decisions import MODEL, DecisionEvent, V1DecisionBridge

from .support import accept_transcript, memory_decision, observe_people, observe_person, product_rig


async def run_speech_case(case: dict) -> dict:
    session, clock, evidence = product_rig(case["id"])
    partial_writes = 0
    decisions_applied = []
    for event in case["events"]:
        clock.advance_to(event["at_ms"])
        if event["type"] == "face":
            people = event["people"] if "people" in event else [event["person"]]
            observe_people(session, clock, people, event.get("track", 1))
            evidence.add("face_input", people=people)
            continue
        before = len(session.notes)
        token = accept_transcript(session, clock, event, evidence)
        if token:
            decision = memory_decision(**event.get("decision", {}))
            applied = session.apply_transcript_decision(token, decision)
            decisions_applied.append(applied)
            evidence.add("injected_decision", segment_id=event["segment_id"],
                         decision=decision, applied=applied)
        if not event["is_final"]:
            partial_writes += len(session.notes) - before
    notes = list(session.notes.values())
    action_types = {"agent.requested", "agent.handoff", "reminder.upserted", "answer.resolved"}
    actions = [row["type"] for row in evidence.rows
               if row["event"] == "product_event" and row["type"] in action_types]
    return {"observed": {
        "partial_writes": partial_writes, "note_count": len(notes),
        "note_texts": [note["text"] for note in notes],
        "note_profiles": [note["profile_id"] for note in notes],
        "speaker_claims": [note.get("speaker") for note in notes],
        "decisions_applied": decisions_applied, "actions": actions,
        "action_count": len(actions),
    }, "evidence": evidence.rows, "simulated_duration_ms": clock.simulated_ms}


class PausedMemoryGate:
    """Every provided final is useful by fixture definition; no semantic-model claim."""

    last_model = MODEL

    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0

    async def decide(self, snapshot, questions):
        self.calls += 1
        self.entered.set()
        await self.release.wait()
        probabilities = {"addressed": .1, "allow_introduction": .1,
                         "remember_conversation": .95, "significant": .1}
        return [GateAnswer(key=q.key, kind=q.kind, probability=1, choice="none")
                if q.key == "intent" else
                GateAnswer(key=q.key, kind=q.kind, probability=probabilities[q.key])
                for q in questions]

    async def aclose(self):
        pass


async def run_overload_case(case: dict) -> dict:
    session, clock, evidence = product_rig(case["id"])
    observe_person(session, clock, "bob")
    gate = PausedMemoryGate()
    resolved, statuses, tokens = [], [], {}

    def on_voice(event, decision):
        resolved.append(event.event_id)
        applied = session.apply_transcript_decision(tokens[event.event_id], decision)
        evidence.add("decision_resolved", segment_id=event.event_id, applied=applied)

    def on_status(status):
        statuses.append(status)
        evidence.add("bridge_status", **status)

    bridge = V1DecisionBridge(gate, on_voice=on_voice,
                              on_moment=lambda *_: None, on_status=on_status, clock=clock)
    try:
        for index, event in enumerate(case["events"]):
            clock.advance_to(event["at_ms"])
            token = accept_transcript(session, clock, event, evidence)
            if token is None:
                raise ValueError("Overload fixture requires new finalized segments")
            tokens[event["segment_id"]] = token
            accepted = bridge.submit(DecisionEvent(
                event["segment_id"], clock(), "transcript", session.decision_state(),
                event["text"], profile_ids=("bob",), subject_key="bob",
            ))
            evidence.add("bridge_submitted", segment_id=event["segment_id"], accepted=accepted)
            if index == 0:
                # Deterministic barrier: first request is active before B and C arrive.
                await asyncio.wait_for(gate.entered.wait(), timeout=1)
        clock.advance_to(case["release_at_ms"])
        gate.release.set()
        if bridge._runner is None:
            raise RuntimeError("Live bridge did not start its worker")
        await asyncio.wait_for(asyncio.shield(bridge._runner), timeout=1)
        drops = [{"segment_id": item.get("event_id"), "reason": item.get("reason")}
                 for item in statuses if item["state"] == "dropped"]
        return {"observed": {"resolved_segments": resolved, "note_count": len(session.notes),
                             "provider_calls": gate.calls, "dropped": drops},
                "evidence": evidence.rows, "simulated_duration_ms": clock.simulated_ms}
    finally:
        gate.release.set()
        await bridge.aclose()
