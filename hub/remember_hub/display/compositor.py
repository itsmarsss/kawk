"""Compositor: arbitrates DisplayActions into ONE current display (AGENTS.md §9).

Priority: answer/alert > enroll > profile > idle. TTL expiry reverts to the idle
card. play_clip() renders video as a hub-paced blit sequence (§5) — at-most-one-
in-flight is the caller's (devicelink's) job.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable

from ..bus import EventBus
from ..contracts.display import Card, CardTemplate, DisplayAction, RasterBlit


def idle_action() -> DisplayAction:
    return DisplayAction(
        card=Card(template=CardTemplate.IDLE, title="", body="", ttl_ms=0),
        ttl_ms=0,
        priority=0,
        t_created=time.time(),
    )


class Compositor:
    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self.current = idle_action()
        self._since = time.time()
        self._prio = 0
        self._expiry: asyncio.Task | None = None
        bus.subscribe("display.action", self.on_action)

    def state(self) -> tuple[str, float]:
        template = self.current.card.template.value if self.current.card else "idle"
        return template, time.time() - self._since

    async def on_action(self, action: DisplayAction) -> None:
        is_idle = action.card is not None and action.card.template is CardTemplate.IDLE
        expired = self.current.ttl_ms > 0 and (
            time.time() - self._since > self.current.ttl_ms / 1000
        )
        if not (action.priority >= self._prio or expired or self._prio == 0):
            return
        self.current = action
        self._since = time.time()
        self._prio = 0 if is_idle else action.priority
        if self._expiry:
            self._expiry.cancel()
            self._expiry = None
        if not is_idle and action.ttl_ms > 0:
            self._expiry = asyncio.create_task(self._expire_after(action.ttl_ms / 1000))
        await self.bus.publish("display.current", action)

    async def _expire_after(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
        self._prio = 0
        self.current = idle_action()
        self._since = time.time()
        await self.bus.publish("display.current", self.current)

    async def play_clip(
        self, frames: Iterable[RasterBlit], fps: float = 10.0, max_fps: float = 10.0
    ) -> None:
        """Video on the display = hub-paced 0x10 blit sequence (§5)."""
        interval = 1.0 / min(fps, max_fps)
        for blit in frames:
            await self.bus.publish(
                "display.current",
                DisplayAction(blit=blit, ttl_ms=0, priority=self._prio, t_created=time.time()),
            )
            await asyncio.sleep(interval)
