"""REMEMBER_NOTE / RECALL_NOTE — store and retrieve notes (AGENTS.md §9)."""

from __future__ import annotations

import re
import time
from datetime import datetime

from ..contracts.decisions import Intent
from ..contracts.display import PRIO_ANSWER, Card, CardTemplate, DisplayAction
from .base import TaskContext

_NOTE_PREFIX = re.compile(r"^.*?\b(remember that|remember to|note that|remember)\s+", re.IGNORECASE)


def _answer(title: str, body: str) -> DisplayAction:
    return DisplayAction(
        card=Card(template=CardTemplate.ANSWER, title=title, body=body, ttl_ms=8000),
        ttl_ms=8000,
        priority=PRIO_ANSWER,
        t_created=time.time(),
    )


class RememberNoteHandler:
    intent = Intent.REMEMBER_NOTE

    async def run(self, ctx: TaskContext) -> DisplayAction | None:
        utterance = ctx.world.last_utterance()
        text = _NOTE_PREFIX.sub("", utterance).strip()
        if not text:
            return None
        ctx.memory.add_note(text)
        return _answer("Noted", text)


class RecallNoteHandler:
    intent = Intent.RECALL_NOTE

    async def run(self, ctx: TaskContext) -> DisplayAction | None:
        query = ctx.world.last_utterance()
        results = ctx.memory.search_notes(query, n=1)
        if not results:
            return _answer("Notes", "No matching notes yet.")
        t, text = results[0]
        when = datetime.fromtimestamp(t).strftime("%H:%M")
        return _answer("Note", f"{text} ({when})")
