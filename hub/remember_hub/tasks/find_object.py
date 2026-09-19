"""FIND_OBJECT — the flagship "where are my keys" path (AGENTS.md §9).

Live entities first, else the last-seen index, else an honest miss. Answers are
templates over retrieval; keyframe blits attach only when a frame exists
(keyframe_ref=None in mock mode is fine)."""

from __future__ import annotations

import time
from datetime import datetime

from ..contracts.decisions import Intent
from ..contracts.display import PRIO_ANSWER, Card, CardTemplate, DisplayAction
from ..world.snapshot import zone
from .base import TaskContext, format_ago

_ZONE_WORDS = {
    "left": "to your left",
    "right": "to your right",
    "center": "ahead of you",
}


class FindObjectHandler:
    intent = Intent.FIND_OBJECT

    async def run(self, ctx: TaskContext) -> DisplayAction | None:
        target = ctx.gate_result.target_label or self._fuzzy_target(ctx)
        if target is None:
            return None
        title = target.capitalize()

        live = ctx.world.find_live(target)
        if live is not None:
            horiz = zone(live).split("-")[0]
            body = f"In view — {_ZONE_WORDS.get(horiz, 'ahead of you')}."
            return self._card(title, body)

        ls = ctx.memory.get_last_seen(target)
        if ls is not None:
            where = ", ".join(ls.context_labels) if ls.context_labels else "last position"
            when = datetime.fromtimestamp(ls.ts).strftime("%H:%M")
            body = f"Last seen near {where} — {format_ago(time.time() - ls.ts)} ({when})."
            return self._card(title, body)
            # TODO(M3): attach keyframe blit when ls.keyframe_ref is not None

        return self._card(title, f"Haven't seen {target} yet.")

    def _fuzzy_target(self, ctx: TaskContext) -> str | None:
        utterance = ctx.world.last_utterance().lower()
        for label in ctx.world.known_labels():
            if all(w in utterance for w in label.lower().split()):
                return label
        return None

    def _card(self, title: str, body: str) -> DisplayAction:
        return DisplayAction(
            card=Card(template=CardTemplate.ANSWER, title=title, body=body, ttl_ms=8000),
            ttl_ms=8000,
            priority=PRIO_ANSWER,
            t_created=time.time(),
        )
