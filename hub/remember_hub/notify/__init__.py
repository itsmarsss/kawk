"""Notify tier: display.current -> phone/watch push notifications (AGENTS.md §9).

build_notify() wires the whole tier from config; webpush degrades gracefully
(SSE in-app view keeps working) when keys or the [pwa] extra are missing.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..bus import EventBus
from ..config import PwaCfg
from .base import NotifyEvent, NotifyPolicy, NotifySink
from .pwa_server import PwaServer
from .service import NotifyService
from .webpush_sink import SubscriptionStore, WebPushSink, webpush_available

log = logging.getLogger(__name__)

__all__ = [
    "NotifyEvent",
    "NotifyPolicy",
    "NotifyService",
    "NotifySink",
    "PwaServer",
    "SubscriptionStore",
    "WebPushSink",
    "build_notify",
]


def build_notify(bus: EventBus, cfg: PwaCfg, data_dir: Path) -> tuple[NotifyService, PwaServer]:
    service = NotifyService(
        bus, NotifyPolicy(min_priority=cfg.min_priority, cooldown_s=cfg.cooldown_s)
    )
    store = SubscriptionStore(data_dir / "push_subs.json")
    vapid_key = data_dir / "vapid_private.pem"
    if webpush_available():
        service.add_sink(WebPushSink(store, vapid_key, vapid_sub=cfg.vapid_sub))
    else:
        log.warning(
            "pywebpush not installed — notifications limited to the in-app SSE view "
            "(run: uv sync --extra pwa)"
        )
    server = PwaServer(bus, service, store, cfg, vapid_key)
    return service, server
