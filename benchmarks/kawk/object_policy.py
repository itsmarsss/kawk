"""Object observation gaps are different from a verified disappearance."""
from __future__ import annotations

from .support import product_rig


async def run_object_case(case: dict) -> dict:
    session, clock, evidence = product_rig(case["id"])
    session.stream_state("objects", True, stream_id="objects-replay")
    source_events = []

    def on_source(event):
        source_events.append(event)
        evidence.add("decision_source", **event)

    session.on_decision_event = on_source
    for event in case["events"]:
        clock.advance_to(event["at_ms"])
        if event["type"] == "objects":
            rows = [{"label": label, "score": .9, "box_xyxy": [100, 100, 180, 180],
                     "track_id": "synthetic-source-track"} for label in event["labels"]]
            accepted = session.ingest_objects({"objects": rows, "input_wh": [640, 480],
                                               "observed_at": clock()}, stream_id="objects-replay")
            evidence.add("object_input", labels=event["labels"], accepted=accepted)
        elif event["type"] == "stream":
            session.stream_state("objects", event["available"], stream_id="objects-replay")
            evidence.add("object_stream_state", available=event["available"])
        elif event["type"] == "tick":
            session.tick()
            evidence.add("timer_tick")
        else:
            raise ValueError("Unsupported object replay event")
    ended = [row for row in evidence.rows
             if row["event"] == "product_event" and row["type"] == "encounter.ended"]
    return {"observed": {
        "disappearance_candidates": len(source_events), "ended_encounters": len(ended),
        "encounter_count": len(session.encounters),
        "active_objects": sorted(pid for pid in session.active if pid.startswith("object:")),
    }, "evidence": evidence.rows, "simulated_duration_ms": clock.simulated_ms}
