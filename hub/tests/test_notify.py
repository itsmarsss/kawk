"""Notify tier: policy gating, service fan-out, subscription store, webpush
pruning (injected sender — no pywebpush needed), and the PWA server's HTTP
surface driven over a real socket. Core deps only (AGENTS.md §11)."""

import asyncio
import json
import time
from pathlib import Path

from remember_hub.bus import EventBus
from remember_hub.config import PwaCfg
from remember_hub.contracts.display import (
    PRIO_ANSWER,
    PRIO_PROFILE,
    Card,
    CardTemplate,
    DisplayAction,
    RasterBlit,
)
from remember_hub.notify.base import NotifyEvent, NotifyPolicy
from remember_hub.notify.pwa_server import PwaServer
from remember_hub.notify.service import NotifyService
from remember_hub.notify.webpush_sink import PushSubscription, SubscriptionStore, WebPushSink


def action(template=CardTemplate.ANSWER, title="Keys", body="near desk", prio=PRIO_ANSWER):
    return DisplayAction(
        card=Card(template=template, title=title, body=body),
        ttl_ms=8000,
        priority=prio,
        t_created=time.time(),
    )


def event(**kw):
    return NotifyEvent.from_action(action(**kw))


# ---- policy ---------------------------------------------------------------------------


def test_policy_gates_idle_priority_and_repeats():
    policy = NotifyPolicy(min_priority=PRIO_PROFILE, cooldown_s=5.0)
    assert policy.should_notify(event(), now=100.0)
    # exact repeat within cooldown collapses
    assert not policy.should_notify(event(), now=102.0)
    # after cooldown it fires again
    assert policy.should_notify(event(), now=106.0)
    # different content fires immediately
    assert policy.should_notify(event(title="Wallet"), now=106.1)
    # idle and sub-threshold never fire
    assert not policy.should_notify(event(template=CardTemplate.IDLE, prio=0), now=200.0)
    assert not policy.should_notify(event(prio=PRIO_PROFILE - 1, title="x"), now=201.0)


def test_event_from_action_blit_only_is_none():
    blit = DisplayAction(blit=RasterBlit(seq=1), ttl_ms=0, priority=0)
    assert NotifyEvent.from_action(blit) is None
    ev = event(title="")
    assert ev.title == "Answer"  # template fallback title


# ---- service fan-out --------------------------------------------------------------------


class FakeSink:
    name = "fake"

    def __init__(self):
        self.sent: list[NotifyEvent] = []

    async def send(self, ev):
        self.sent.append(ev)


async def test_service_routes_display_current_to_sinks():
    bus = EventBus()
    service = NotifyService(bus, NotifyPolicy(min_priority=PRIO_PROFILE, cooldown_s=0.0))
    sink = FakeSink()
    service.add_sink(sink)
    q = service.listen()

    await bus.publish("display.current", action())
    await service.drain()
    assert [e.title for e in sink.sent] == ["Keys"]
    assert q.get_nowait().title == "Keys"  # SSE listeners see it too

    # idle reaches listeners (in-app view) but never buzzes a sink
    await bus.publish("display.current", action(template=CardTemplate.IDLE, prio=0))
    await service.drain()
    assert len(sink.sent) == 1
    assert q.get_nowait().template == "idle"


async def test_listener_queue_bounded_drop_oldest():
    bus = EventBus()
    service = NotifyService(bus, NotifyPolicy(min_priority=999))  # sinks never fire
    q = service.listen()
    for i in range(20):
        await bus.publish("display.current", action(title=f"t{i}"))
    assert q.qsize() <= 8
    drained = []
    while not q.empty():
        drained.append(q.get_nowait().title)
    assert drained[-1] == "t19"  # newest survives the drop-oldest policy


# ---- webpush sink ---------------------------------------------------------------------


class Gone(Exception):
    def __init__(self):
        self.response = type("R", (), {"status_code": 410})()


async def test_webpush_prunes_dead_subscriptions(tmp_path: Path):
    store = SubscriptionStore(tmp_path / "subs.json")
    store.add(PushSubscription(endpoint="https://push/alive", keys={"p256dh": "k", "auth": "a"}))
    store.add(PushSubscription(endpoint="https://push/dead", keys={"p256dh": "k", "auth": "a"}))
    calls = []

    def sender(info, payload, ttl, urgency):
        calls.append((info["endpoint"], json.loads(payload), ttl, urgency))
        if "dead" in info["endpoint"]:
            raise Gone()

    sink = WebPushSink(store, tmp_path / "vapid.pem", sender=sender)
    await sink.send(event())
    assert len(calls) == 2
    assert all(c[3] == "high" for c in calls)  # PRIO_ANSWER -> high urgency
    assert list(store.subs) == ["https://push/alive"]
    # persisted prune survives reload
    assert list(SubscriptionStore(tmp_path / "subs.json").subs) == ["https://push/alive"]


# ---- pwa server over a real socket -------------------------------------------------------


async def _request(port, method, path, body=b"", read_all=True):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        f"{method} {path} HTTP/1.1\r\nHost: t\r\nContent-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    await writer.drain()
    data = await (reader.read() if read_all else reader.readuntil(b"\r\n\r\n"))
    if not read_all:
        return reader, writer, data
    writer.close()
    return data


async def test_pwa_server_static_subscribe_and_sse(tmp_path: Path):
    static = tmp_path / "pwa"
    static.mkdir()
    (static / "index.html").write_text("<h1>remember</h1>")
    bus = EventBus()
    service = NotifyService(bus, NotifyPolicy(min_priority=999))
    store = SubscriptionStore(tmp_path / "subs.json")
    server = PwaServer(
        bus, service, store, PwaCfg(host="127.0.0.1"), tmp_path / "vapid.pem", static_dir=static
    )
    port = await server.start(port=0)
    try:
        assert b"remember" in await _request(port, "GET", "/")
        assert b"404" in await _request(port, "GET", "/../etc/passwd")  # traversal blocked
        assert b"503" in await _request(port, "GET", "/api/vapid-key")  # no keys yet

        sub = {"endpoint": "https://push/x", "keys": {"p256dh": "k", "auth": "a"}}
        reply = await _request(port, "POST", "/api/subscribe", json.dumps(sub).encode())
        assert b"201" in reply and len(store) == 1

        # SSE: connect, then publish a card and see it arrive as a data frame
        reader, writer, _ = await _request(port, "GET", "/api/events", read_all=False)
        await bus.publish("display.current", action(title="Live"))

        async def read_live() -> bool:
            while True:  # skip the retry: field / keepalive comments until the data frame
                chunk = await reader.readuntil(b"\r\n\r\n")
                if b"data: " in chunk:
                    assert b"Live" in chunk
                    return True

        assert await asyncio.wait_for(read_live(), timeout=2)
        writer.close()

        status = await _request(port, "GET", "/api/status")
        assert b'"subscriptions": 1' in status or b'"subscriptions":1' in status
    finally:
        await server.stop()
