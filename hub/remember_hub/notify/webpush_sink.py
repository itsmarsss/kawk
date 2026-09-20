"""Web Push sink: delivers NotifyEvents to PWA subscriptions (phone -> watch).

pywebpush (the `pwa` extra) does VAPID signing + RFC 8291 payload encryption;
Apple/Google push relays handle wake-up delivery, and iOS mirrors the resulting
notification to a paired Apple Watch when the phone is locked. The pywebpush
call is blocking -> run in a thread; the transport is injectable so tests (and
mock demos) run without the extra installed (AGENTS.md §3.2).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from pathlib import Path

from pydantic import BaseModel, Field

from .base import NotifyEvent

log = logging.getLogger(__name__)

# sender(subscription_info, payload_json, ttl_s, urgency) -> None; raises on failure
Sender = Callable[[dict, str, int, str], None]

# Push-relay statuses that mean "this subscription is dead, forget it"
_GONE = {404, 410}


class PushSubscription(BaseModel):
    """The browser's PushSubscription.toJSON() shape, stored verbatim."""

    endpoint: str
    keys: dict[str, str]
    expirationTime: float | None = None  # noqa: N815 - browser field name
    created: float = Field(default_factory=time.time)
    ua: str = ""

    def info(self) -> dict:
        return {"endpoint": self.endpoint, "keys": self.keys}


class SubscriptionStore:
    """JSON-file persistence keyed by endpoint (data/ is gitignored)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.subs: dict[str, PushSubscription] = {}
        if path.exists():
            try:
                raw = json.loads(path.read_text())
                self.subs = {e: PushSubscription.model_validate(s) for e, s in raw.items()}
            except Exception:
                log.exception("corrupt subscription store %s — starting empty", path)

    def add(self, sub: PushSubscription) -> None:
        self.subs[sub.endpoint] = sub
        self._flush()

    def remove(self, endpoint: str) -> bool:
        existed = self.subs.pop(endpoint, None) is not None
        if existed:
            self._flush()
        return existed

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({e: s.model_dump(mode="json") for e, s in self.subs.items()}, indent=1)
        )
        tmp.replace(self.path)

    def __len__(self) -> int:
        return len(self.subs)


class WebPushSink:
    name = "webpush"

    def __init__(
        self,
        store: SubscriptionStore,
        vapid_private_key: Path,
        vapid_sub: str = "mailto:demo@example.com",
        sender: Sender | None = None,
    ) -> None:
        self.store = store
        self.vapid_private_key = vapid_private_key
        self.vapid_sub = vapid_sub
        self._sender = sender or self._default_sender

    async def send(self, event: NotifyEvent) -> None:
        if not self.store.subs:
            return
        payload = json.dumps(
            {
                "title": event.title,
                "body": event.body,
                "tag": event.tag,
                "data": {"template": event.template, "ts": event.ts},
            }
        )
        urgency = "high" if event.priority >= 25 else "normal"
        results = await asyncio.gather(
            *(
                asyncio.to_thread(self._sender, sub.info(), payload, event.ttl_s, urgency)
                for sub in list(self.store.subs.values())
            ),
            return_exceptions=True,
        )
        for sub, result in zip(list(self.store.subs.values()), results, strict=False):
            if isinstance(result, BaseException):
                if _status_of(result) in _GONE:
                    log.info("pruning dead push subscription %s…", sub.endpoint[:40])
                    self.store.remove(sub.endpoint)
                else:
                    log.warning("web push to %s… failed: %s", sub.endpoint[:40], result)

    # ---- default transport (needs the [pwa] extra) --------------------------------

    def _default_sender(self, sub_info: dict, payload: str, ttl_s: int, urgency: str) -> None:
        from pywebpush import webpush  # lazy: heavy dep lives behind the extra

        webpush(
            subscription_info=sub_info,
            data=payload,
            vapid_private_key=str(self.vapid_private_key),
            vapid_claims={"sub": self.vapid_sub},
            ttl=ttl_s,
            headers={"Urgency": urgency},
        )


def _status_of(exc: BaseException) -> int | None:
    """Extract the push-relay HTTP status from a pywebpush/requests exception."""
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def webpush_available() -> bool:
    try:
        import pywebpush  # noqa: F401

        return True
    except ImportError:
        return False
