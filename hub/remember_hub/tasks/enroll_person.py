"""ENROLL_PERSON — two-phase state machine keyed by track_id (AGENTS.md §9).

Phase 1 (gate fires): prompt card "Who is this? Say just their name".
Phase 2 (next STT final): extract name by stripping a FIXED prefix list (no
generative model exists to do it); >3 words -> re-prompt once, then abort.
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass

from ..contracts.decisions import Intent
from ..contracts.display import PRIO_ANSWER, PRIO_ENROLL, Card, CardTemplate, DisplayAction
from ..contracts.percepts import TranscriptSegment
from .base import TaskContext

_PREFIXES = re.compile(
    r"^(this is|their name is|her name is|his name is|that's|that is|it's|its|name is)\s+",
    re.IGNORECASE,
)
_TIMEOUT_S = 12.0


def extract_name(text: str) -> str | None:
    cleaned = re.sub(r"[^\w\s'-]", "", text).strip()
    cleaned = _PREFIXES.sub("", cleaned).strip()
    if not cleaned or len(cleaned.split()) > 3:
        return None
    return cleaned.title()


@dataclass
class _Pending:
    track_id: str
    deadline: float
    reprompted: bool = False


class EnrollPersonHandler:
    intent = Intent.ENROLL_PERSON

    def __init__(self) -> None:
        self._pending: _Pending | None = None
        self._ctx: TaskContext | None = None  # captured at run(); bus/world/gallery live refs

    async def run(self, ctx: TaskContext) -> DisplayAction | None:
        if self._pending is not None:
            return None  # gate may re-fire while we wait; ignore
        track = ctx.gate_result.person_track or ctx.world.stable_unknown_person()
        if track is None:
            return None
        self._ctx = ctx
        self._pending = _Pending(track_id=track, deadline=time.time() + _TIMEOUT_S)
        return self._prompt_card()

    async def on_stt(self, seg: TranscriptSegment) -> None:
        """Wired to percepts.stt by the router."""
        if self._pending is None or not seg.is_final or self._ctx is None:
            return
        if time.time() > self._pending.deadline:
            self._pending = None
            return
        name = extract_name(seg.text)
        if name is None:
            if not self._pending.reprompted:
                self._pending.reprompted = True
                self._pending.deadline = time.time() + _TIMEOUT_S
                await self._ctx.bus.publish("display.action", self._prompt_card(again=True))
            else:
                self._pending = None
            return

        ctx, pending = self._ctx, self._pending
        embeddings, model_tag = ctx.world.face_embeddings(pending.track_id, n=10)
        if not embeddings or model_tag is None:
            return  # no usable face crops yet; keep waiting until the deadline
        person_id = uuid.uuid4().hex
        ctx.gallery.enroll(person_id, name, embeddings, model_tag)
        ctx.world.reset_identity_votes(pending.track_id)
        ctx.memory.record_event("enrolled", name)
        self._pending = None
        await ctx.bus.publish(
            "display.action",
            DisplayAction(
                card=Card(
                    template=CardTemplate.ANSWER,
                    title=name,
                    body=f"Nice to meet you, {name}.",
                    ttl_ms=5000,
                ),
                ttl_ms=5000,
                priority=PRIO_ANSWER,
                t_created=time.time(),
            ),
        )

    def _prompt_card(self, again: bool = False) -> DisplayAction:
        body = "Say just their name." if not again else "One more time — just their name."
        return DisplayAction(
            card=Card(
                template=CardTemplate.ENROLL_PROMPT,
                title="Who is this?",
                body=body,
                ttl_ms=int(_TIMEOUT_S * 1000),
            ),
            ttl_ms=int(_TIMEOUT_S * 1000),
            priority=PRIO_ENROLL,
            t_created=time.time(),
        )
