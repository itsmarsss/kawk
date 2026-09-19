import asyncio
import builtins
import copy
import importlib
import math
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from remember_hub.contracts.decisions import GateQuestion
from remember_hub.gate.jev_typesafe import ENDPOINT, JevError, JevHTTPError, TypeSafeJevBackend


def questions():
    return [
        GateQuestion(key="addressed", kind="noul", instructions="Speech is addressed to the device"),
        GateQuestion(key="intent", kind="choice", instructions="Pick an intent",
                     choices=["NONE", "FIND_OBJECT"]),
        GateQuestion(key="urgency", kind="score", instructions="Rate urgency",
                     choices=["routine", "soon", "now"]),
    ]


def body():
    return {
        "model": "jev-1.13.0",
        # Deliberately not request order; adapter must preserve caller's order.
        "answers": {
            "urgency": {"type": "score", "score": 1.6, "confidence": 0.4,
                        "probabilities": {"0": 0.1, "1": 0.2, "2": 0.7},
                        "legend": {"0": "routine", "1": "soon", "2": "now"}},
            "intent": {"type": "choice", "choice": "FIND_OBJECT", "confidence": 0.5,
                       "probabilities": {"NONE": 0.1, "FIND_OBJECT": 0.9}},
            "addressed": {"type": "noul", "noul": 0.87},
        },
        "usage": {"input_tokens": 100, "output_tokens": 20},
    }


class Response:
    def __init__(self, data=None, status=200, headers=None):
        self.data = body() if data is None else data
        self.status_code = status
        self.headers = headers or {}

    def json(self):
        if isinstance(self.data, Exception):
            raise self.data
        return self.data


class Transport:
    def __init__(self, response=None):
        self.response = response or Response()
        self.calls = []

    async def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


@pytest.mark.asyncio
async def test_single_official_bank_maps_all_three_types_without_confidence_confusion():
    transport = Transport()
    async with TypeSafeJevBackend("offline-test-key", transport=transport) as backend:
        result = await backend.decide('TRANSCRIPT: "where are my keys"', questions())
        assert [answer.key for answer in result] == ["addressed", "intent", "urgency"]
        assert result[0].probability == 0.87
        assert result[1].choice == "FIND_OBJECT"
        assert result[1].probability == 0.9  # NOT entropy confidence 0.5.
        assert result[1].probabilities == {"NONE": 0.1, "FIND_OBJECT": 0.9}
        assert result[2].score == 1.6 and result[2].probability is None
        assert backend.last_model == "jev-1.13.0"
        assert set(backend.last_timings_ms) == {"prepare", "request", "parse", "total"}
        assert all(value >= 0 for value in backend.last_timings_ms.values())
    assert len(transport.calls) == 1
    url, call = transport.calls[0]
    assert url == ENDPOINT
    assert call["headers"]["Authorization"] == "Bearer offline-test-key"
    assert call["json"] == {
        "state": 'TRANSCRIPT: "where are my keys"', "model": "jev-1.13.0",
        "questions": {
            "addressed": {"type": "noul", "instructions": "Speech is addressed to the device"},
            "intent": {"type": "choice", "instructions": "Pick an intent",
                       "criteria": {"NONE": None, "FIND_OBJECT": None}},
            "urgency": {"type": "score", "instructions": "Rate urgency",
                        "criteria": ["routine", "soon", "now"]},
        },
    }


@pytest.mark.asyncio
async def test_core_import_and_injected_transport_do_not_require_httpx(monkeypatch):
    real_import = builtins.__import__

    def without_httpx(name, *args, **kwargs):
        if name == "httpx":
            raise ImportError("deliberately absent cloud extra")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_httpx)
    module = importlib.import_module("remember_hub.gate.jev_typesafe")
    assert await module.TypeSafeJevBackend("offline", transport=Transport()).decide("", questions())
    backend = module.TypeSafeJevBackend("offline")
    assert await backend.decide("", []) == []
    with pytest.raises(JevError, match="uv sync --extra cloud"):
        await backend.decide("", questions())


@pytest.mark.parametrize("key", ["", " ", None])
def test_missing_key_rejected_at_construction(key):
    with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
        TypeSafeJevBackend(key)


@pytest.mark.parametrize("bad_questions", [
    [questions()[0], questions()[0]],
    [GateQuestion(key="", kind="noul", instructions="Is it true?")],
    [GateQuestion(key="a", kind="noul", instructions=" ")],
    [GateQuestion(key="a", kind="noul", instructions="Is it true?", choices=["ignored"])],
    [GateQuestion(key="a", kind="choice", instructions="Choose", choices=["only"])],
    [GateQuestion(key="a", kind="choice", instructions="Choose", choices=["same", "same"])],
    [GateQuestion(key="a", kind="choice", instructions="Choose", choices=["ok", " "])],
    [GateQuestion(key="a", kind="choice", instructions="Choose",
                  choices=[str(n) for n in range(256)])],
    [GateQuestion(key="a", kind="score", instructions="Rate", choices=[])],
    [GateQuestion(key="a", kind="score", instructions="Rate",
                  choices=[str(n) for n in range(11)])],
])
@pytest.mark.asyncio
async def test_bad_bank_never_reaches_network(bad_questions):
    transport = Transport()
    with pytest.raises(ValueError):
        await TypeSafeJevBackend("offline", transport=transport).decide("", bad_questions)
    assert transport.calls == []


@pytest.mark.parametrize("question_key,field,value", [
    ("addressed", "noul", math.nan), ("addressed", "noul", 1.1),
    ("addressed", "noul", True), ("addressed", "noul", "0.9"),
    ("addressed", "type", "choice"),
    ("intent", "choice", "UNKNOWN"), ("intent", "choice", "NONE"),
    ("intent", "confidence", math.inf),
    ("intent", "probabilities", {"NONE": 0.1}),
    ("intent", "probabilities", {"NONE": -0.1, "FIND_OBJECT": 1.1}),
    ("intent", "probabilities", {"NONE": 0.1, "FIND_OBJECT": 0.1}),
    ("urgency", "score", math.inf), ("urgency", "score", True),
    ("urgency", "score", 3), ("urgency", "legend", {"0": "other"}),
])
@pytest.mark.asyncio
async def test_malformed_answers_fail_entire_bank(question_key, field, value):
    data = body()
    data["answers"][question_key][field] = value
    with pytest.raises(JevError):
        await TypeSafeJevBackend("offline", transport=Transport(Response(data))).decide("", questions())


@pytest.mark.parametrize("data", [
    {}, [], {"model": "jev-1.13.0", "answers": {}},
    {**body(), "answers": {**body()["answers"], "unexpected": {"type": "noul", "noul": 1}}},
    ValueError("non-JSON response with a fake secret"),
])
@pytest.mark.asyncio
async def test_invalid_envelope_never_defaults_to_a_decision(data):
    backend = TypeSafeJevBackend("offline", transport=Transport(Response(data)))
    with pytest.raises(JevError) as error:
        await backend.decide("", questions())
    assert "fake secret" not in str(error.value)
    assert backend.last_model is None
    assert "total" in backend.last_timings_ms


@pytest.mark.parametrize("status", [401, 403, 422, 429, 529, 503, 302])
@pytest.mark.asyncio
async def test_http_failures_are_sanitized_and_not_retried(status):
    transport = Transport(Response({"secret": "never echo response"}, status, {"retry-after": "2"}))
    backend = TypeSafeJevBackend("offline", transport=transport)
    with pytest.raises(JevHTTPError) as error:
        await backend.decide("private snapshot", questions())
    assert error.value.status_code == status
    assert error.value.retry_after_seconds == 2
    assert "never echo" not in str(error.value)
    assert len(transport.calls) == 1


@pytest.mark.asyncio
async def test_timeout_cancellation_and_busy_guard_do_not_leave_a_queue():
    entered = asyncio.Event()
    release = asyncio.Event()

    async def slow(url, **kwargs):
        entered.set()
        await release.wait()
        return Response()

    backend = TypeSafeJevBackend("offline", transport=slow, timeout_seconds=1)
    original = questions()
    task = asyncio.create_task(backend.decide("", original))
    await entered.wait()
    with pytest.raises(JevError, match="already in flight"):
        await backend.decide("", questions())
    original[1].choices.clear()  # In-flight request/validation use their frozen copy.
    release.set()
    assert len(await task) == 3
    release.clear()
    task = asyncio.create_task(backend.decide("", questions()))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    backend.timeout_seconds = 0.01
    with pytest.raises(JevError, match="timed out"):
        await backend.decide("", questions())
    release.set()
    assert len(await backend.decide("", questions())) == 3
    await backend.aclose()
    with pytest.raises(JevError, match="closed"):
        await backend.decide("", questions())


@pytest.mark.asyncio
async def test_failed_new_call_clears_previous_success_metrics():
    transport = Transport()
    backend = TypeSafeJevBackend("offline", transport=transport)
    await backend.decide("", questions())
    assert "parse" in backend.last_timings_ms
    transport.response = Response(status=401)
    with pytest.raises(JevHTTPError):
        await backend.decide("", questions())
    assert "parse" not in backend.last_timings_ms
    assert backend.last_model is None
    # Never mutate a caller's question list while encoding it.
    q = questions()
    before = copy.deepcopy(q)
    transport.response = Response()
    await backend.decide("", q)
    assert q == before


@pytest.mark.asyncio
async def test_real_client_path_reuses_connection_and_closes_once(monkeypatch):
    clients = []

    class Client:
        def __init__(self, **kwargs):
            assert kwargs == {"follow_redirects": False}
            self.calls = 0
            self.closed = 0
            clients.append(self)

        async def post(self, url, **kwargs):
            assert url == ENDPOINT
            assert kwargs["headers"]["Content-Type"] == "application/json"
            self.calls += 1
            return Response()

        async def aclose(self):
            self.closed += 1

    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(AsyncClient=Client))
    async with TypeSafeJevBackend("offline") as backend:
        await backend.decide("first", questions())
        await backend.decide("next", questions())
    await backend.aclose()
    assert len(clients) == 1
    assert clients[0].calls == 2 and clients[0].closed == 1


@pytest.mark.parametrize("args,reason", [([], "Pass --live"), (["--live"], "Set TYPESAFE_API_KEY")])
def test_smoke_requires_explicit_live_and_environment_key(args, reason):
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(root / "scripts/smoke_jev.py"), *args],
        # Deliberately empty inherited credential environment; no secrets read.
        env={"PYTHONPATH": str(root / "hub")}, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 2
    assert "No request sent" in result.stderr and reason in result.stderr
