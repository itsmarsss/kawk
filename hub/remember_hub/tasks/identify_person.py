"""IDENTIFY_PERSON — profile card; also serves the ambient show_profile Noul (§9)."""

from __future__ import annotations

import time

from ..contracts.decisions import Intent
from ..contracts.display import PRIO_PROFILE, Card, CardTemplate, DisplayAction
from .base import TaskContext, format_ago


class IdentifyPersonHandler:
    intent = Intent.IDENTIFY_PERSON

    async def run(self, ctx: TaskContext) -> DisplayAction | None:
        ent = None
        if ctx.gate_result.person_track:
            ent = ctx.world.tracks.entities.get(ctx.gate_result.person_track)
        if ent is None or ent.person is None or not ent.person.name:
            for candidate in ctx.world.in_view():
                if candidate.label == "person" and candidate.person and candidate.person.name:
                    ent = candidate
                    break
        if ent is None or ent.person is None or not ent.person.name:
            return None

        name = ent.person.name
        bits: list[str] = []
        enrolled_at = ctx.gallery.enrolled_at(ent.person.person_id or "")
        if enrolled_at:
            bits.append(f"Met {format_ago(time.time() - enrolled_at)}.")
        notes = ctx.memory.search_notes(name, n=1)
        if notes:
            bits.append(f'Note: "{notes[0][1]}"')
        body = " ".join(bits) or "You know them."

        return DisplayAction(
            card=Card(template=CardTemplate.PROFILE, title=name, body=body, ttl_ms=8000),
            ttl_ms=8000,
            priority=PRIO_PROFILE,
            t_created=time.time(),
        )
