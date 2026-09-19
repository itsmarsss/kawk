"""Optional Jev bridge tests use the real adapter with an offline HTTP transport."""

import asyncio
import copy

import pytest
from remember_hub.contracts.decisions import GateAnswer
from remember_hub.gate.jev_typesafe import TypeSafeJevBackend

from tools.perception_lab.product_decisions import (
    MODEL,
    DecisionEvent,
    V1DecisionBridge,
    backend_from_environment,
)


class Clock:
    now = 100.0

    def __call__(self):
        return self.now


class Response:
    def __init__(self, data, status=200, headers=None):
        self.data, self.status_code, self.headers = data, status, headers or {}

    def json(self):
        return self.data


class Transport:
    def __init__(self, *, directed=.9, significant=.1, intent="find", introduction=.1):
        self.probabilities = {"addressed": directed, "significant": significant,
                              "allow_introduction": introduction}
        self.intent = intent
        self.calls = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.active = self.max_active = 0
        self.status = 200
        self.headers = {}

    async def __call__(self, url, **kwargs):
        self.calls.append(copy.deepcopy(kwargs["json"]))
        self.active += 1
        self.max_active = max(self.active, self.max_active)
        self.entered.set()
        try:
            await self.release.wait()
            answers = {}
            for key, question in kwargs["json"]["questions"].items():
                if question["type"] == "noul":
                    answers[key] = {"type": "noul", "noul": self.probabilities[key]}
                else:
                    answers[key] = {"type": "choice", "choice": self.intent, "confidence": 1,
                                    "probabilities": {label: float(label == self.intent)
                                                      for label in question["criteria"]}}
            return Response({"model": MODEL, "answers": answers}, self.status, self.headers)
        finally:
            self.active -= 1


def rig(transport=None):
    clock, voices, moments, statuses = Clock(), [], [], []
    transport = transport or Transport()
    backend = TypeSafeJevBackend("offline-fixture-key", transport=transport)
    bridge = V1DecisionBridge(backend, on_voice=lambda event, decision: voices.append((event, decision)),
                              on_moment=lambda event, decision: moments.append((event, decision)),
                              on_status=statuses.append, clock=clock)
    return bridge, transport, clock, voices, moments, statuses


def event(ident="final-1", at=100, **kwargs):
    return DecisionEvent(ident, at, "transcript", "PEOPLE none; OBJECTS keys left-lower; DISPLAY idle fresh",
                         "Where are my keys?", **kwargs)


async def finish(bridge):
    if bridge._runner:
        await bridge._runner


def test_default_mode_uses_no_backend_and_missing_key_never_fakes_live():
    assert backend_from_environment({}) is None
    assert backend_from_environment({"REMEMBER_V1_DECISIONS": "rules", "TYPESAFE_API_KEY": "unused"}) is None
    with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
        backend_from_environment({"REMEMBER_V1_DECISIONS": "typesafe"})
    with pytest.raises(ValueError, match="rules or typesafe"):
        backend_from_environment({"REMEMBER_V1_DECISIONS": "something-else"})
    backend = backend_from_environment({"REMEMBER_V1_DECISIONS": "typesafe", "TYPESAFE_API_KEY": "offline"})
    assert backend.model == MODEL and backend.timeout_seconds == 2


@pytest.mark.parametrize("changes", [{"event_at": float("nan")}, {"state": "x" * 6001},
                                     {"transcript": "x" * 1001}, {"profile_ids": [1]},
                                     {"clip_eligible": "yes"}, {"kind": "image"}])
def test_only_bounded_text_and_immutable_metadata_enter_decisions(changes):
    args = dict(event_id="e", event_at=100., kind="transcript", state="OBJECTS none", transcript="hello")
    with pytest.raises(ValueError):
        DecisionEvent(**{**args, **changes})
    mutable = ["profile-1"]
    value = DecisionEvent(**args, profile_ids=mutable)
    mutable.clear()
    assert value.profile_ids == ("profile-1",)


async def test_denied_directedness_is_reported_without_pretending_command_execution():
    bridge, transport, _, voices, moments, statuses = rig(Transport(directed=.2, intent="find"))
    assert bridge.submit(event())
    await finish(bridge)
    assert voices[0][1]["directed"] is False
    assert voices[0][1]["intent"] == "find"
    assert not moments
    assert statuses[-1]["state"] == "ready"
    body = transport.calls[0]
    assert body["model"] == MODEL
    assert set(body["questions"]) == {"addressed", "intent", "allow_introduction", "significant"}
    assert 'LATEST_FINAL_SPEECH: "Where are my keys?"' in body["state"]
    assert set(body) == {"model", "state", "questions"}  # No images or embeddings.
    await bridge.aclose()


async def test_introduction_is_independent_of_device_directedness_but_explicitly_gated():
    bridge, _, _, voices, _, _ = rig(Transport(directed=.1, introduction=.9, intent="introduction"))
    bridge.submit(event())
    await finish(bridge)
    assert voices[0][1]["directed"] is False
    assert voices[0][1]["allow_introduction"] is True
    assert voices[0][1]["intent"] == "introduction"
    await bridge.aclose()


async def test_one_request_and_newest_pending_drop_older_voice_results():
    bridge, transport, _, voices, _, statuses = rig()
    transport.release.clear()
    bridge.submit(event("first"))
    await transport.entered.wait()
    bridge.submit(event("second"))
    bridge.submit(event("third"))
    assert len(transport.calls) == 1
    transport.release.set()
    await finish(bridge)
    assert transport.max_active == 1
    assert len(transport.calls) == 2
    assert [value.event_id for value, _ in voices] == ["third"]
    assert any(status.get("event_id") == "second" and status.get("reason") == "newer_pending_event"
               for status in statuses)
    assert not bridge.submit(event("third"))
    await bridge.aclose()


async def test_perception_cannot_displace_pending_voice_but_newer_voice_can():
    bridge, transport, _, voices, _, statuses = rig()
    transport.release.clear()
    bridge.submit(DecisionEvent("active-scene", 100, "perception", "KEYS appeared"))
    await transport.entered.wait()
    bridge.submit(event("older-final"))
    assert not bridge.submit(DecisionEvent("incoming-scene", 100, "perception", "PHONE appeared"))
    assert bridge._pending.event_id == "older-final"
    assert statuses[-1] == {"provider": "typesafe", "model": MODEL, "state": "dropped",
                           "event_id": "incoming-scene", "reason": "pending_transcript_has_priority"}
    assert bridge.submit(event("newer-final"))
    assert statuses[-1]["event_id"] == "older-final"
    assert statuses[-1]["reason"] == "newer_pending_event"
    transport.release.set()
    await finish(bridge)
    assert [value.event_id for value, _ in voices] == ["newer-final"]
    assert len(transport.calls) == 2
    await bridge.aclose()


@pytest.mark.parametrize("http_status", [401, 403, 529])
async def test_failure_drops_pending_token_but_keeps_actionable_error_visible(http_status):
    bridge, transport, _, voices, _, statuses = rig()
    transport.release.clear()
    transport.status = http_status
    bridge.submit(DecisionEvent("active-scene", 100, "perception", "KEYS appeared"))
    await transport.entered.wait()
    bridge.submit(event("pending-final"))
    transport.release.set()
    await finish(bridge)
    assert not voices and bridge._pending is None
    assert any(status.get("event_id") == "active-scene" and status["state"] == "error"
               for status in statuses)
    assert any(status.get("event_id") == "pending-final" and status.get("reason") == "provider_failure"
               for status in statuses)
    assert statuses[-1]["state"] == "error"
    assert statuses[-1]["event_id"] == "active-scene"
    assert statuses[-1]["requires_reconfiguration"] is (http_status in (401, 403))
    await bridge.aclose()


async def test_significant_clip_keeps_source_time_and_global_and_subject_cooldowns():
    bridge, _, clock, _, moments, _ = rig(Transport(significant=.95))
    for ident, at, subject in [("a", 100, "keys"), ("b", 101, "phone"), ("c", 111, "phone"),
                               ("d", 121, "keys"), ("e", 131, "keys")]:
        clock.now = at + 2  # Inference/transport delay does not shift the clip window.
        bridge.submit(event(ident, at, clip_eligible=True, subject_key=subject,
                            profile_ids=("object:" + subject,)))
        await finish(bridge)
    assert [(value.event_id, value.event_at) for value, _ in moments] == [("a", 100), ("c", 111), ("e", 131)]
    assert moments[0][0].profile_ids == ("object:keys",)
    await bridge.aclose()


async def test_significance_alone_cannot_save_without_capture_or_full_preroll_age():
    bridge, _, clock, _, moments, statuses = rig(Transport(significant=.95))
    bridge.submit(event("no-camera"))
    await finish(bridge)
    clock.now = 112
    bridge.submit(event("too-late-for-preroll", 100, clip_eligible=True))
    await finish(bridge)
    assert not moments
    assert not bridge.submit(event("stale", 90, clip_eligible=True))
    assert statuses[-1]["reason"] == "stale_source_event"
    await bridge.aclose()


async def test_backoff_retries_only_a_new_submission_not_a_queued_snapshot():
    bridge, transport, clock, voices, moments, statuses = rig()
    transport.status, transport.headers = 429, {"retry-after": "3"}
    bridge.submit(event("rate-limited"))
    await finish(bridge)
    assert not voices and not moments
    assert statuses[-1]["state"] == "error"
    clock.now = 101
    assert not bridge.submit(event("during-backoff", 101))
    transport.status = 200
    clock.now = 104
    await asyncio.sleep(0)
    assert len(transport.calls) == 1  # No timer automatically replays old state.
    bridge.submit(event("fresh", 104))
    await finish(bridge)
    assert len(transport.calls) == 2
    assert voices[0][0].event_id == "fresh"
    await bridge.aclose()


async def test_bad_credentials_block_further_calls_until_reconfiguration():
    bridge, transport, clock, voices, _, statuses = rig()
    transport.status = 401
    bridge.submit(event())
    await finish(bridge)
    clock.now = 120
    assert not bridge.submit(event("later", 120))
    assert len(transport.calls) == 1 and not voices
    assert statuses[-1]["requires_reconfiguration"] is True
    await bridge.aclose()


async def test_timeout_produces_no_fallback_and_releases_admission():
    bridge, transport, clock, voices, moments, statuses = rig()
    bridge.backend.timeout_seconds = .01
    transport.release.clear()
    bridge.submit(event())
    await finish(bridge)
    assert not voices and not moments
    assert statuses[-1]["state"] == "error"
    assert not bridge.backend._busy
    clock.now += 3
    transport.release.set()
    bridge.submit(event("fresh", clock.now))
    await finish(bridge)
    assert len(voices) == 1
    await bridge.aclose()


async def test_stop_cancels_before_close_and_resume_uses_fresh_events():
    bridge, transport, clock, voices, _, _ = rig()
    transport.release.clear()
    bridge.submit(event())
    await transport.entered.wait()
    await bridge.stop()
    assert not voices and transport.active == 0
    assert not bridge.submit(event("while-stopped"))
    bridge.start()
    transport.release.set()
    clock.now += 1
    bridge.submit(event("resumed", clock.now))
    await finish(bridge)
    assert voices[0][0].event_id == "resumed"
    await bridge.aclose()
    assert bridge.backend._closed
    with pytest.raises(RuntimeError, match="closed"):
        bridge.start()


async def test_generation_guard_drops_a_backend_that_swallows_cancellation():
    entered = asyncio.Event()

    class Backend:
        async def decide(self, snapshot, questions):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                return [GateAnswer(key=q.key, kind=q.kind, probability=1,
                                   choice="find" if q.kind == "choice" else None) for q in questions]

        async def aclose(self):
            pass

    voices, moments = [], []
    bridge = V1DecisionBridge(Backend(), on_voice=lambda *args: voices.append(args),
                              on_moment=lambda *args: moments.append(args), on_status=lambda _: None,
                              clock=lambda: 100.)
    bridge.submit(event(clip_eligible=True))
    await entered.wait()
    await bridge.stop()
    assert not voices and not moments
    await bridge.aclose()


async def test_perception_events_never_dispatch_voice_commands():
    bridge, _, _, voices, moments, _ = rig(Transport(significant=.9))
    bridge.submit(DecisionEvent("object-change", 100, "perception", "KEYS disappeared; dwell short",
                                profile_ids=("object:keys",), clip_eligible=True))
    await finish(bridge)
    assert not voices
    assert len(moments) == 1
    await bridge.aclose()
