"""Bounded websocket lifecycle with no network or microphone access."""
import asyncio
import json

import pytest

from tools.perception_lab.speech import cloud_speech_socket


class Browser:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.changed = asyncio.Event()
        self.closed = False

    async def receive(self):
        return await self.incoming.get()

    async def send_json(self, message):
        self.sent.append(message)
        self.changed.set()

    async def wait_for(self, kind):
        async with asyncio.timeout(1):
            while not any(m["type"] == kind for m in self.sent):
                self.changed.clear()
                await self.changed.wait()

    async def close(self):
        self.closed = True


class Upstream:
    def __init__(self):
        self.sent = []
        self.incoming = asyncio.Queue()
        self.closed = False
        self.fail_send = False

    async def send(self, message):
        if self.fail_send:
            raise TimeoutError("private header must not leak")
        self.sent.append(message)

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.incoming.get()
        if value is None:
            raise StopAsyncIteration
        return value

    async def close(self):
        self.closed = True


@pytest.fixture
def relay(monkeypatch):
    browser, upstream = Browser(), Upstream()
    monkeypatch.setattr("tools.perception_lab.speech.read_key", lambda: "test-private")
    async def connect(*args, **kwargs):
        assert kwargs["open_timeout"] == 120
        return upstream
    monkeypatch.setattr("websockets.connect", connect)
    return browser, upstream


@pytest.mark.asyncio
@pytest.mark.parametrize("message", [{"type": "websocket.disconnect"},
                                     {"type": "websocket.receive", "text": '{"type": "stop"}'}])
async def test_stop_or_disconnect_cancels_cloud_cold_start(relay, monkeypatch, message):
    browser, upstream = relay
    connecting, cancelled = asyncio.Event(), asyncio.Event()
    async def connect(*args, **kwargs):
        connecting.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    monkeypatch.setattr("websockets.connect", connect)
    task = asyncio.create_task(cloud_speech_socket(browser))
    await connecting.wait()
    await browser.incoming.put(message)
    await asyncio.wait_for(task, 1)
    assert cancelled.is_set() and browser.closed
    assert not any(m["type"] == "ready" for m in browser.sent)


@pytest.mark.asyncio
async def test_ready_audio_final_transcript_disconnect_cleanup(relay):
    browser, upstream = relay
    task = asyncio.create_task(cloud_speech_socket(browser))
    await browser.wait_for("ready")
    await browser.incoming.put({"type": "websocket.receive", "bytes": bytes(1024)})
    await upstream.incoming.put(json.dumps({"type": "transcription", "transcription_num": 7, "is_final": True,
                                            "segments": [{"text": "My name is William"}]}))
    await browser.wait_for("transcript")
    await browser.incoming.put({"type": "websocket.disconnect"})
    await asyncio.wait_for(task, 1)
    assert bytes(1024) in upstream.sent
    final = next(m for m in browser.sent if m["type"] == "transcript")
    assert final["text"] == "My name is William" and final["segment_id"] == "7"
    assert upstream.closed and browser.closed


@pytest.mark.asyncio
async def test_audio_send_timeout_reports_retryable_error_without_private_exception(relay):
    browser, upstream = relay
    task = asyncio.create_task(cloud_speech_socket(browser))
    await browser.wait_for("ready")
    upstream.fail_send = True
    await browser.incoming.put({"type": "websocket.receive", "bytes": bytes(1024)})
    await asyncio.wait_for(task, 1)
    error = next(m for m in browser.sent if m["type"] == "error")
    assert error["retryable"] is True
    assert "private" not in json.dumps(browser.sent)
    assert upstream.closed


@pytest.mark.asyncio
async def test_cloud_close_reports_reconnect(relay):
    browser, upstream = relay
    task = asyncio.create_task(cloud_speech_socket(browser))
    await browser.wait_for("ready")
    await upstream.incoming.put(None)
    await asyncio.wait_for(task, 1)
    assert browser.sent[-1]["type"] == "error" and browser.sent[-1]["retryable"]
    assert upstream.closed


@pytest.mark.asyncio
async def test_configuration_failure_does_not_trigger_retry_storm(relay, monkeypatch):
    browser, _ = relay
    def missing():
        raise RuntimeError("Configure the speech service")
    monkeypatch.setattr("tools.perception_lab.speech.read_key", missing)
    await cloud_speech_socket(browser)
    assert browser.sent == [{"type": "error", "message": "Configure the speech service", "retryable": False}]
    assert browser.closed
