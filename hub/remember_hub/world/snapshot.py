"""World-model -> Jev text snapshot (AGENTS.md §7).

Deterministic, compact, fixed section order. EVERY numeric a question must judge is
pre-bucketed into categorical words — Jev cannot compare numbers. Raw timestamps may
appear (task templates echo them) but no question depends on interpreting one.
"""

from __future__ import annotations

import time
from datetime import datetime

from ..contracts.world import Entity
from .model import WorldModel

# Buckets (§7): dwell brief <3s / short 3-15s / long >15s; proximity near >10% /
# mid 2-10% / far <2% of frame area; display fresh <5s / aging 5-15s / stale >15s.


def dwell_bucket(seconds: float) -> str:
    if seconds < 3:
        return "brief"
    return "short" if seconds <= 15 else "long"


def proximity_bucket(area_fraction: float) -> str:
    if area_fraction > 0.10:
        return "near"
    return "mid" if area_fraction >= 0.02 else "far"


def display_age_bucket(seconds: float) -> str:
    if seconds < 5:
        return "fresh"
    return "aging" if seconds <= 15 else "stale"


def sim_bucket(sim: float, threshold: float) -> str:
    if sim < threshold:
        return "weak"
    return "ok" if sim <= threshold + 0.15 else "strong"


def zone(ent: Entity) -> str:
    w, h = ent.frame_wh
    w, h = (w or 1, h or 1)
    cx = (ent.box_xyxy[0] + ent.box_xyxy[2]) / 2 / w
    cy = (ent.box_xyxy[1] + ent.box_xyxy[3]) / 2 / h
    horiz = "left" if cx < 1 / 3 else ("right" if cx > 2 / 3 else "center")
    vert = "upper" if cy < 0.5 else "lower"
    return f"{horiz}-{vert}"


def area_fraction(ent: Entity) -> float:
    w, h = ent.frame_wh
    w, h = (w or 1, h or 1)
    return ((ent.box_xyxy[2] - ent.box_xyxy[0]) * (ent.box_xyxy[3] - ent.box_xyxy[1])) / (w * h)


def hhmm(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def build_snapshot(
    world: WorldModel,
    display_template: str,
    display_age_s: float,
    match_threshold: float,
    now: float | None = None,
) -> str:
    now = now if now is not None else time.time()
    in_view = world.in_view()

    obj_bits: list[str] = []
    for ent in in_view:
        parts = [f"{ent.label}#{ent.track_id}"]
        if ent.label == "person":
            name = ent.person.name if ent.person and ent.person.name else "?"
            parts.append(f"name={name}")
        parts.append(zone(ent))
        parts.append(proximity_bucket(area_fraction(ent)))
        parts.append(f"dwell={dwell_bucket(now - ent.first_seen)}")
        holder = world.held_by(ent) if ent.label != "person" else None
        if holder:
            parts.append(f"held-by={holder}")
        near = [
            e.label
            for e in in_view
            if e.track_id != ent.track_id and e.label not in ("person", ent.label)
        ][:3]
        if near and ent.label != "person":
            parts.append(f"near[{','.join(near)}]")
        obj_bits.append(" ".join(parts))

    people_bits: list[str] = []
    for ent in in_view:
        if ent.label != "person":
            continue
        if ent.person and ent.person.name:
            people_bits.append(
                f"{ent.track_id}={ent.person.name} "
                f"({sim_bucket(ent.person.sim, match_threshold)}, stable)"
            )
        else:
            people_bits.append(f"{ent.track_id}=? (unknown)")

    last_seen_bits = [
        f"{ls.label}@{hhmm(ls.ts)} near[{','.join(ls.context_labels) or '-'}]"
        for ls in world.memory.recent_last_seen(5)
    ]
    transcript_bits = [f'[{seg.speaker}] "{seg.text}"' for seg in world.recent_finals(15.0)][-4:]

    lines = [
        f"TIME {datetime.fromtimestamp(now).strftime('%H:%M:%S')}  "
        f"SPEECH {'yes' if world.speech_active() else 'no'}  "
        f"DISPLAY {display_template}({display_age_bucket(display_age_s)})",
        "OBJECTS: " + (" · ".join(obj_bits) if obj_bits else "none"),
        "PEOPLE: "
        + ("; ".join(people_bits) if people_bits else "none")
        + f". user_in_conversation={'yes' if world.user_in_conversation() else 'no'}",
        "LAST_SEEN: " + (" · ".join(last_seen_bits) if last_seen_bits else "none"),
        "EVENTS_30S: " + (" · ".join(world.recent_events(30.0)[-6:]) or "none"),
        "TRANSCRIPT_15S: " + (" ".join(transcript_bits) if transcript_bits else "(silence)"),
    ]
    return "\n".join(lines)
