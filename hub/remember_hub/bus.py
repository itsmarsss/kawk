"""Tiny asyncio pub/sub: topic string -> async subscribers.

Subscribers are awaited sequentially so scenario tests are deterministic; a
subscriber exception is logged and never breaks the publisher (AGENTS.md §3.1:
no queues that can grow — publish is direct fan-out).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger(__name__)

Handler = Callable[[Any], Awaitable[None]]

# Topics used across the hub (single place to see the wiring):
#   percepts.detections   list[Detection]        (one batch per pushed frame)
#   percepts.face         list[FaceObservation]
#   percepts.stt          TranscriptSegment      (partials revise by seg_id)
#   percepts.audio        AudioState
#   world.delta           WorldDelta
#   gate.result           GateResult
#   display.action        DisplayAction          (task output; scenario asserts here)
#   display.current       DisplayAction          (compositor-selected, per §10)


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Handler]] = {}

    def subscribe(self, topic: str, handler: Handler) -> None:
        self._subs.setdefault(topic, []).append(handler)

    async def publish(self, topic: str, payload: Any) -> None:
        for handler in self._subs.get(topic, []):
            try:
                await handler(payload)
            except Exception:
                log.exception("bus subscriber failed on topic %s", topic)
