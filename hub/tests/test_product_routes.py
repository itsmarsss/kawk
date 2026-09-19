"""V1 transport tests use synthetic perceptions and never acquire media or call a model."""
import asyncio
import struct
import time
from contextlib import asynccontextmanager

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from remember_hub.contracts.decisions import GateAnswer  # noqa: E402

from tools.perception_lab.product_routes import (
    BrowserSession,  # noqa: E402
    ProductSessions,  # noqa: E402
)


class Gallery:
    def list(self):
        return [{"id": "real-gallery-uuid", "name": "Test Person"}]


@pytest.fixture
def transport():
    manager = ProductSessions(Gallery(), lambda headers: headers.get("origin") != "https://bad.test")

    @asynccontextmanager
    async def lifespan(_app):
        yield
        await manager.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(manager.router)
    with TestClient(app) as client:
        yield client, manager


def receive_until(ws, predicate, limit=30):
    for _ in range(limit):
        message = ws.receive_json()
        if predicate(message):
            return message
    raise AssertionError("Expected event did not arrive")


def command(ws, kind, payload=None, request="test"):
    ws.send_json({"type": "command", "request_id": request,
                  "command": {"type": kind, "payload": payload or {}}})
    return receive_until(ws, lambda m: m.get("request_id") == request)


def test_session_snapshot_uses_gallery_ids_without_demo_seed(transport):
    client, manager = transport
    result = client.post("/api/v1/sessions").json()
    snapshot = result["snapshot"]
    assert [p["id"] for p in snapshot["profiles"]] == ["real-gallery-uuid"]
    assert snapshot["reminders"] == snapshot["moments"] == []
    assert snapshot["status"]["camera"] == "off"
    assert result["limits"]["jpeg_max_bytes"] == 256 * 1024
    path = manager.get(result["session_id"]).clips.storage_path
    assert client.delete("/api/v1/sessions/" + result["session_id"]).status_code == 200
    assert not path.exists()
    assert client.get("/api/v1/sessions/" + result["session_id"]).status_code == 404


def test_bad_media_is_acknowledged_and_commands_still_work(transport):
    client, _ = transport
    session = client.post("/api/v1/sessions").json()
    with client.websocket_connect(session["websocket_url"]) as ws:
        ws.send_json({"type": "hello", "device_ts_ms": 1000})
        receive_until(ws, lambda m: m.get("receipt", {}).get("hello"))
        ws.send_bytes(struct.pack("<BBHI", 1, 0, 42, 1000) + b"not-a-jpeg")
        rejected = receive_until(ws, lambda m: m.get("type") == "v1.frame_ack")
        assert rejected == {"type": "v1.frame_ack", "seq": 42, "accepted": False}
        receive_until(ws, lambda m: m.get("type") == "v1.error")
        result = command(ws, "ask", {"text": "Where are my keys?"})
        assert result["type"] == "v1.ack"
        assert result["receipt"]["answer"]["kind"] == "not_found"


def test_reminder_uuid_validation_and_session_resume(transport):
    client, _ = transport
    session = client.post("/api/v1/sessions").json()
    with client.websocket_connect(session["websocket_url"]) as ws:
        valid = command(ws, "reminder.save", {"reminder": {
            "id": "rem-test", "profile_id": "real-gallery-uuid", "text": "Ask about the pitch"}})
        assert valid["type"] == "v1.ack"
        bad = command(ws, "reminder.save", {"reminder": {
            "profile_id": "Test Person", "text": "Never join by a display name"}}, request="bad")
        assert bad["type"] == "v1.error"
    with client.websocket_connect(session["websocket_url"]) as ws:
        # A stopped capture does not make editing its temporary records impossible.
        result = command(ws, "reminder.complete", {"reminder_id": "rem-test"})
        assert result["type"] == "v1.ack"
    snapshot = client.get("/api/v1/sessions/" + session["session_id"]).json()
    assert snapshot["reminders"][0]["status"] == "completed"


def test_session_limit_is_explicit(transport):
    client, _ = transport
    for _ in range(4):
        assert client.post("/api/v1/sessions").status_code == 200
    assert client.post("/api/v1/sessions").status_code == 429


def test_reconnect_hello_restores_cleanup_state_and_preserved_records(transport):
    client, _ = transport
    session = client.post("/api/v1/sessions").json()
    with client.websocket_connect(session["websocket_url"]) as ws:
        command(ws, "capture.status", {"camera": "live", "microphone": "off"})
        command(ws, "reminder.save", {"reminder": {
            "id": "surviving-reminder", "profile_id": "real-gallery-uuid", "text": "Ask later"}})
    with client.websocket_connect(session["websocket_url"]) as ws:
        ws.send_json({"type": "hello", "device_ts_ms": 2000})
        message = receive_until(ws, lambda m: m.get("receipt", {}).get("hello"))
        snapshot = message["snapshot"]
        assert snapshot["session_id"] == session["session_id"]
        assert snapshot["status"]["camera"] == "off"
        assert snapshot["status"]["microphone"] == "off"
        assert snapshot["reminders"][0]["id"] == "surviving-reminder"
        assert snapshot["display"]["card"]["template"] == "idle"


async def test_concurrent_reaping_is_idempotent():
    manager = ProductSessions(Gallery(), lambda headers: True, idle_ttl=1)
    for _ in range(2):
        await manager.create()
    paths = [session.clips.storage_path for session in manager.sessions.values()]
    for session in manager.sessions.values():
        session.last_used -= 10
    await asyncio.gather(manager.reap(), manager.reap())
    assert not manager.sessions
    assert all(not path.exists() for path in paths)


async def test_reconnect_cannot_overtake_previous_socket_cleanup():
    manager = ProductSessions(Gallery(), lambda headers: True)
    created = await manager.create()
    session = manager.get(created["session_id"])
    cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()
    original_pause = session.pause

    async def delayed_pause():
        cleanup_started.set()
        await release_cleanup.wait()
        await original_pause()

    session.pause = delayed_pause

    class Socket:
        headers = {}
        accepted = False
        closed = None

        async def accept(self):
            self.accepted = True

        async def receive(self):
            return {"type": "websocket.disconnect"}

        async def close(self, code=1000):
            self.closed = code

        async def send_json(self, _message):
            pass

    old = Socket()
    task = asyncio.create_task(manager.socket(old, session.id))
    await asyncio.wait_for(cleanup_started.wait(), 1)
    assert session.attached
    replacement = Socket()
    await manager.socket(replacement, session.id)
    assert replacement.closed == 1008
    assert not replacement.accepted
    release_cleanup.set()
    await asyncio.wait_for(task, 1)
    assert not session.attached
    assert session.websocket is None
    await manager.close()


class DecisionBackend:
    model = last_model = "jev-1.13.0"
    last_timings_ms = {"total": 1}

    def __init__(self, *, directed=True, significant=False):
        self.directed, self.significant = directed, significant
        self.calls = []
        self.closed = False

    async def decide(self, snapshot, questions):
        self.calls.append(snapshot)
        return [GateAnswer(key=q.key, kind=q.kind, probability=(float(self.directed) if q.key == "addressed" else
                           float(self.significant) if q.key == "significant" else
                           1.0 if q.key == "intent" else 0.0),
                           choice="find" if q.key == "intent" else None) for q in questions]

    async def aclose(self):
        self.closed = True


async def capture(session, *, camera="off", microphone="live"):
    await session.receive_json({"type": "command", "command": {"type": "capture.status",
                               "payload": {"camera": camera, "microphone": microphone}}})
    await session.receive_json({"type": "stream.state", "kind": "speech", "available": True,
                               "stream_id": "speech-test"})


async def speech(session, ident="one"):
    await session.receive_json({"type": "perception.speech", "stream_id": "speech-test",
                               "data": {"segment_id": ident, "text": "Where are my keys?", "is_final": True}})


@pytest.mark.parametrize("directed", [False, True])
async def test_optional_gate_controls_actions_and_resolves_same_transcript(directed):
    backend = DecisionBackend(directed=directed)
    session = BrowserSession([], decision_backend=backend)
    try:
        await capture(session)
        await speech(session)
        before = list(session.queue._queue)
        assert not any(m.get("type") == "answer.resolved" for m in before)
        await session.decisions._runner
        messages = list(session.queue._queue)
        transcripts = [m["payload"]["segment"] for m in messages if m.get("type") == "transcript.updated"]
        assert len(transcripts) == 2
        assert transcripts[0]["id"] == transcripts[1]["id"]
        assert transcripts[0]["directed"] == "pending"
        assert transcripts[1]["directed"] == ("device" if directed else "conversation")
        assert any(m.get("type") == "answer.resolved" for m in messages) is directed
        assert not session.decision_tokens
        assert session.decision_status["backend"] == "typesafe"
        assert session.decision_status["phase"] == "ready"
        assert session.decision_status["message"] == "Jev ready"
        await speech(session)
        assert len(backend.calls) == 1  # Duplicate final cannot run twice.
    finally:
        await session.close()
    assert backend.closed


async def test_significant_gate_uses_original_event_time_and_requires_camera():
    backend = DecisionBackend(significant=True)
    session = BrowserSession([], decision_backend=backend)
    requests = []
    session.product.trigger_clip = requests.append
    try:
        await capture(session)
        await speech(session)
        await session.decisions._runner
        assert not requests
        await capture(session, camera="live")
        source_at = time.time() - 1
        await session.receive_json({"type": "perception.speech", "stream_id": "speech-test",
                                   "data": {"segment_id": "two", "text": "Where are my keys?",
                                            "is_final": True, "observed_at": source_at}})
        await session.decisions._runner
        assert len(requests) == 1
        moment = session.product.moments[requests[0]["moment_id"]]
        from tools.perception_lab.product import epoch
        assert abs(epoch(moment["event_at"]) - source_at) < .001
        assert moment["source"] == "live-agent"
        assert moment["decision_model"] == "jev-1.13.0"
        assert session.product.auto_capture_rules is False
        await session.pause()
        assert session.decision_status["phase"] == "stopped"
        assert not session.decision_tokens
    finally:
        await session.close()


async def test_missing_live_gate_configuration_does_not_create_rules_session():
    from fastapi import HTTPException

    from tools.perception_lab.product_decisions import backend_from_environment
    manager = ProductSessions(Gallery(), lambda headers: True,
                              decision_factory=lambda: backend_from_environment({"REMEMBER_V1_DECISIONS": "typesafe"}))
    with pytest.raises(HTTPException) as error:
        await manager.create()
    assert error.value.status_code == 503
    assert not manager.sessions


async def test_rejected_perception_can_retry_with_a_fresh_observation(monkeypatch):
    class RejectingBridge:
        def __init__(self):
            self.events = []

        def submit(self, event):
            self.events.append(event)
            return len(self.events) > 1

    session = BrowserSession([])
    bridge = RejectingBridge()
    session.decisions = bridge
    now = [100.0]
    monkeypatch.setattr("tools.perception_lab.product_routes.time.monotonic", lambda: now[0])
    try:
        session._decision_input("perception.objects", {}, "objects-test")
        now[0] += 2
        session._decision_input("perception.objects", {}, "objects-test")
        now[0] += 2
        session._decision_input("perception.objects", {}, "objects-test")
        assert len(bridge.events) == 2
        assert bridge.events[0].event_id != bridge.events[1].event_id
    finally:
        session.decisions = None
        await session.close()
