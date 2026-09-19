"""Tick policy: when to ask Jev, and hysteresis/debounce (AGENTS.md §7).

Reactive tick on (a) STT final, (b) meaningful WorldDelta — identity-vote
stabilization ticks immediately — plus (c) a 1 s heartbeat. Full bank every tick.
Debounce lives HERE, not in handlers.
"""

from __future__ import annotations

import asyncio
import logging

from ..bus import EventBus
from ..config import FaceCfg, GateCfg
from ..contracts.decisions import GateResult, Intent
from ..contracts.percepts import TranscriptSegment
from ..contracts.world import DeltaKind, WorldDelta
from ..display.compositor import Compositor
from ..world.model import WorldModel
from ..world.snapshot import build_snapshot
from .jev_base import JevBackend
from .questions import build_bank

log = logging.getLogger(__name__)


class GatePolicy:
    def __init__(
        self,
        bus: EventBus,
        jev: JevBackend,
        world: WorldModel,
        compositor: Compositor,
        cfg: GateCfg,
        face_cfg: FaceCfg,
        heartbeat_ms: int = 1000,
    ) -> None:
        self.bus = bus
        self.jev = jev
        self.world = world
        self.compositor = compositor
        self.cfg = cfg
        self.face_cfg = face_cfg
        self.heartbeat_ms = heartbeat_ms
        self._debounce: dict[str, int] = {}
        self._lock = asyncio.Lock()
        self._hb_task: asyncio.Task | None = None

        bus.subscribe("world.delta", self._on_delta)
        bus.subscribe("percepts.stt", self._on_stt)

    def start(self) -> None:
        self._hb_task = asyncio.create_task(self._heartbeat())

    def stop(self) -> None:
        if self._hb_task:
            self._hb_task.cancel()

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_ms / 1000)
            await self.tick("heartbeat")

    async def _on_delta(self, delta: WorldDelta) -> None:
        await self.tick(delta.kind.value, entity_id=delta.entity_id)

    async def _on_stt(self, seg: TranscriptSegment) -> None:
        if seg.is_final:
            await self.tick("stt_final")

    async def tick(self, reason: str, entity_id: str | None = None) -> None:
        async with self._lock:
            template, age_s = self.compositor.state()
            state = build_snapshot(self.world, template, age_s, self.face_cfg.match_threshold)
            bank = build_bank(self.world)
            answers = await self.jev.ask(state, bank)
            by_key = {q.key: q for q in bank}
            results: list[GateResult] = []

            addressed = (answers.get("addressed") or object).noul if "addressed" in answers else 0
            addressed = addressed or 0.0

            # Spoken intents fire only on a final utterance, gated by `addressed`.
            if reason == "stt_final" and addressed >= self.cfg.addressed_threshold:
                ans = answers.get("intent")
                if ans and ans.choice:
                    prob = (ans.probabilities or {}).get(ans.choice, 0.0)
                    intent = Intent(ans.choice)
                    if intent is not Intent.NONE and prob >= self.cfg.intent_min_prob:
                        target = None
                        ft = answers.get("find_target")
                        if intent is Intent.FIND_OBJECT and ft and ft.choice != "none of these":
                            target = ft.choice
                        results.append(
                            GateResult(
                                intent=intent,
                                source_question="intent",
                                target_label=target,
                                confidence=prob,
                            )
                        )

            # show_profile fires on the identity-stabilized tick (3-vote = debounce, §7).
            if reason == DeltaKind.IDENTITY_CHANGED.value:
                ans = answers.get("show_profile")
                if ans and (ans.noul or 0) >= self.cfg.profile_threshold:
                    results.append(
                        GateResult(
                            intent=Intent.IDENTIFY_PERSON,
                            source_question="show_profile",
                            person_track=entity_id,
                            confidence=ans.noul or 0,
                        )
                    )

            # Ambient Nouls with tick-count debounce.
            for key, threshold, debounce in (
                ("enroll_worthy", self.cfg.enroll_threshold, self.cfg.enroll_debounce),
                ("clear_display", self.cfg.clear_threshold, by_key["clear_display"].debounce_ticks),
            ):
                ans = answers.get(key)
                if ans is None:
                    continue
                if (ans.noul or 0) >= threshold:
                    self._debounce[key] = self._debounce.get(key, 0) + 1
                else:
                    self._debounce[key] = 0
                if self._debounce[key] >= debounce:
                    self._debounce[key] = 0
                    question = by_key[key]
                    if question.intent is Intent.ENROLL_PERSON:
                        track = self.world.stable_unknown_person()
                        if track is None:
                            continue
                        results.append(
                            GateResult(
                                intent=Intent.ENROLL_PERSON,
                                source_question=key,
                                person_track=track,
                                confidence=ans.noul or 0,
                            )
                        )
                    elif question.intent is Intent.CLEAR_DISPLAY:
                        if self.compositor.state()[0] != "idle":
                            results.append(
                                GateResult(
                                    intent=Intent.CLEAR_DISPLAY,
                                    source_question=key,
                                    confidence=ans.noul or 0,
                                )
                            )

        for result in results:
            log.info(
                "gate: %s (%s, conf %.2f)", result.intent, result.source_question, result.confidence
            )
            await self.bus.publish("gate.result", result)
