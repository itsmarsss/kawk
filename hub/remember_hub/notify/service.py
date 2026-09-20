"""NotifyService: bus `display.current` -> policy -> fan-out to sinks + SSE feed.

Subscribes to the compositor's arbitrated output, so notifications see exactly
what the LCD would have shown — dedupe/priority/TTL arbitration is not
re-implemented here. SSE listeners get every card (in-app live view); sinks
only get what NotifyPolicy passes (a buzz on the wrist is expensive).

Per AGENTS.md §3.1 no queue may grow: SSE listener queues are bounded and
drop-oldest, and sink sends are fire-and-forget tasks that log failures.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque

from ..bus import EventBus
from ..contracts.display import DisplayAction
from .base import NotifyEvent, NotifyPolicy, NotifySink

log = logging.getLogger(__name__)

_LISTENER_QUEUE = 8
_HISTORY = 50


class NotifyService:
    def __init__(self, bus: EventBus, policy: NotifyPolicy | None = None) -> None:
        self.bus = bus
        self.policy = policy or NotifyPolicy()
        self.sinks: list[NotifySink] = []
        self.history: deque[NotifyEvent] = deque(maxlen=_HISTORY)
        self.current: NotifyEvent | None = None
        self.notified = 0
        self._listeners: set[asyncio.Queue[NotifyEvent]] = set()
        self._pending: set[asyncio.Task] = set()
        bus.subscribe("display.current", self.on_display)

    def add_sink(self, sink: NotifySink) -> None:
        self.sinks.append(sink)
        log.info("notify sink registered: %s", sink.name)

    # ---- live listeners (SSE) ----------------------------------------------------

    def listen(self) -> asyncio.Queue[NotifyEvent]:
        q: asyncio.Queue[NotifyEvent] = asyncio.Queue(maxsize=_LISTENER_QUEUE)
        self._listeners.add(q)
        return q

    def unlisten(self, q: asyncio.Queue[NotifyEvent]) -> None:
        self._listeners.discard(q)

    # ---- pipeline ------------------------------------------------------------------

    async def on_display(self, action: DisplayAction) -> None:
        event = NotifyEvent.from_action(action)
        if event is None:
            return
        self.current = event
        for q in self._listeners:
            if q.full():  # drop-oldest, never block the bus
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)
        if not self.policy.should_notify(event):
            return
        self.history.appendleft(event)
        self.notified += 1
        for sink in self.sinks:
            task = asyncio.create_task(self._send(sink, event))
            self._pending.add(task)
            task.add_done_callback(self._pending.discard)

    async def _send(self, sink: NotifySink, event: NotifyEvent) -> None:
        try:
            await sink.send(event)
        except Exception:
            log.exception("notify sink %s failed", sink.name)

    async def drain(self) -> None:
        """Await in-flight sink sends (tests + clean shutdown)."""
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)

    def stats(self) -> dict:
        return {
            "sinks": [s.name for s in self.sinks],
            "notified": self.notified,
            "listeners": len(self._listeners),
            "history": [e.model_dump(mode="json") for e in list(self.history)[:10]],
        }
