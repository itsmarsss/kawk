"""Notify tier contracts: DisplayAction -> NotifyEvent -> pluggable sinks.

The device LCD is demoted to an optional fallback — the primary output surface
is now a push notification on the wearer's phone/watch (PWA, devices/pwa/).
Modularity mirrors perception backends (AGENTS.md §3.7): a sink is anything
implementing NotifySink; new surfaces (Slack, SMS, LCD) register alongside
web push without touching the service.
"""

from __future__ import annotations

import time
from typing import Protocol

from pydantic import BaseModel, Field

from ..contracts.display import CardTemplate, DisplayAction


class NotifyEvent(BaseModel):
    """What a sink delivers: a card flattened to notification semantics."""

    title: str
    body: str = ""
    template: str = CardTemplate.IDLE.value
    priority: int = 0
    ttl_s: int = 60  # push TTL: how long the event is worth delivering late
    tag: str = "remember-card"  # same tag = newer replaces older on the phone
    ts: float = Field(default_factory=time.time)

    @classmethod
    def from_action(cls, action: DisplayAction) -> NotifyEvent | None:
        """Blit-only actions have no notification semantics -> None."""
        card = action.card
        if card is None:
            return None
        title = card.title or card.template.value.replace("_", " ").title()
        return cls(
            title=title,
            body=card.body,
            template=card.template.value,
            priority=action.priority,
            ttl_s=max(30, (action.ttl_ms or 0) // 1000),
            ts=action.t_created or time.time(),
        )


class NotifySink(Protocol):
    """One delivery surface. send() must swallow per-recipient failures —
    a dead phone subscription can never break the display path."""

    name: str

    async def send(self, event: NotifyEvent) -> None: ...


class NotifyPolicy:
    """Hub-side gate deciding which display states become notifications.

    Suppresses idle, sub-threshold priorities, and repeats within a cooldown
    (the compositor re-publishes on expiry; the wearer only needs one buzz).
    """

    def __init__(
        self,
        min_priority: int = 10,
        cooldown_s: float = 3.0,
        suppress_templates: set[str] | None = None,
    ) -> None:
        self.min_priority = min_priority
        self.cooldown_s = cooldown_s
        self.suppress_templates = suppress_templates or {CardTemplate.IDLE.value}
        self._last_key: tuple[str, str, str] | None = None
        self._last_ts = 0.0

    def should_notify(self, event: NotifyEvent, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        if event.template in self.suppress_templates:
            return False
        if event.priority < self.min_priority:
            return False
        key = (event.template, event.title, event.body)
        if key == self._last_key and (now - self._last_ts) < self.cooldown_s:
            return False
        self._last_key = key
        self._last_ts = now
        return True
