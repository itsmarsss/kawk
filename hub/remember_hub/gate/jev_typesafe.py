"""TypeSafe's documented HTTP API; no SDK or cloud dependency at import time.

Verified 2026-09-19: https://docs.typesafe.ai/api and /sdk/python.
One bank, one request. Failures propagate: this adapter never fabricates gate
answers or retries an old snapshot. A scheduler may retry a fresh snapshot later.
"""

import asyncio
import math
from collections.abc import Mapping
from time import perf_counter
from typing import Any, Protocol

from remember_hub.contracts.decisions import GateAnswer, GateQuestion

ENDPOINT = "https://api.typesafe.ai/v1/systemone"


class JevError(RuntimeError):
    """An actionable error with no provider response body or secret attached."""


class JevHTTPError(JevError):
    def __init__(self, status_code: int, retry_after_seconds: float | None = None):
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds
        action = {
            401: "Check TYPESAFE_API_KEY and account access.",
            403: "Check TypeSafe account access.",
            422: "Check question criteria and the pinned model against TypeSafe docs.",
            429: "Rate limited; schedule a fresh snapshot after backoff.",
            529: "Provider overloaded; schedule a fresh snapshot after backoff.",
        }.get(status_code, "Check TypeSafe availability before a later fresh request.")
        super().__init__(f"TypeSafe HTTP {status_code}. {action}")


class JevResponse(Protocol):
    status_code: int
    headers: Mapping[str, str]

    def json(self) -> Any: ...


class JevTransport(Protocol):
    """Inject a post-like callable for offline tests; caller owns its lifetime."""

    async def __call__(
        self, url: str, *, headers: dict[str, str], json: dict[str, Any], timeout: float
    ) -> JevResponse: ...


def _probability(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JevError("TypeSafe returned a nonnumeric probability.")
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise JevError("TypeSafe returned a probability outside [0, 1].")
    return float(value)


def _distribution(raw: Any, expected: set[str]) -> dict[str, float]:
    if not isinstance(raw, dict) or set(raw) != expected:
        raise JevError("TypeSafe returned an incomplete or unexpected probability distribution.")
    result = {key: _probability(value) for key, value in raw.items()}
    # Allow only small floating-point/serialization rounding, never renormalize.
    if not math.isclose(sum(result.values()), 1, abs_tol=1e-3):
        raise JevError("TypeSafe probabilities do not sum to one.")
    return result


def _questions(questions: list[GateQuestion]) -> dict[str, dict[str, Any]]:
    bank: dict[str, dict[str, Any]] = {}
    for question in questions:
        if not question.key.strip() or question.key in bank:
            raise ValueError("Gate question keys must be nonempty and unique.")
        if not question.instructions.strip():
            raise ValueError("Gate question instructions must not be empty.")
        item: dict[str, Any] = {"type": question.kind, "instructions": question.instructions}
        if question.kind == "noul":
            if question.choices:
                raise ValueError("Noul questions do not use GateQuestion.choices.")
        else:
            limit = 255 if question.kind == "choice" else 10
            if not 2 <= len(question.choices) <= limit:
                raise ValueError(f"{question.kind} questions require 2–{limit} choices.")
            if any(not label.strip() for label in question.choices):
                raise ValueError("Question choices must not be empty.")
            if len(set(question.choices)) != len(question.choices):
                raise ValueError("Question choices must be unique.")
            item["criteria"] = (
                dict.fromkeys(question.choices) if question.kind == "choice"
                else list(question.choices)
            )
        bank[question.key] = item
    return bank


def _answers(body: Any, questions: list[GateQuestion]) -> list[GateAnswer]:
    if not isinstance(body, dict) or not isinstance(body.get("model"), str):
        raise JevError("TypeSafe returned a malformed response envelope.")
    raw = body.get("answers")
    if not isinstance(raw, dict) or set(raw) != {question.key for question in questions}:
        raise JevError("TypeSafe did not return exactly the requested question bank.")
    answers: list[GateAnswer] = []
    for question in questions:
        value = raw[question.key]
        if not isinstance(value, dict) or value.get("type") != question.kind:
            raise JevError("TypeSafe answer type does not match its question.")
        if question.kind == "noul":
            answers.append(GateAnswer(
                key=question.key, kind="noul", probability=_probability(value.get("noul"))
            ))
            continue
        _probability(value.get("confidence"))  # Validate, but do not confuse it with P(choice).
        labels = (set(question.choices) if question.kind == "choice"
                  else {str(index) for index in range(len(question.choices))})
        probabilities = _distribution(value.get("probabilities"), labels)
        if question.kind == "choice":
            choice = value.get("choice")
            if not isinstance(choice, str) or choice not in labels:
                raise JevError("TypeSafe returned a choice outside the requested criteria.")
            if probabilities[choice] + 1e-6 < max(probabilities.values()):
                raise JevError("TypeSafe choice disagrees with its probability distribution.")
            answers.append(GateAnswer(
                key=question.key, kind="choice", choice=choice,
                probability=probabilities[choice], probabilities=probabilities,
            ))
        else:
            score = value.get("score")
            if (isinstance(score, bool) or not isinstance(score, (int, float))
                    or not math.isfinite(score) or not 0 <= score <= len(labels) - 1):
                raise JevError("TypeSafe returned a score outside the requested rubric.")
            legend = {str(index): label for index, label in enumerate(question.choices)}
            if value.get("legend") != legend:
                raise JevError("TypeSafe score legend does not match the requested rubric.")
            answers.append(GateAnswer(
                key=question.key, kind="score", score=float(score), probabilities=probabilities
            ))
    return answers


class TypeSafeJevBackend:
    """Async, reusable HTTP connection; one active decision and no hidden queue.

    ``transport`` is an optional async post-like callable. It receives the same
    URL/headers/body as httpx and returns a JevResponse. No httpx is needed when
    injected. ``last_timings_ms`` measures this adapter, not provider-only GPU
    time. It is cleared at each accepted call, including calls that fail.
    """

    def __init__(
        self, api_key: str, model: str = "jev-1.13.0", *,
        timeout_seconds: float = 2.0, transport: JevTransport | None = None,
    ):
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("Set TYPESAFE_API_KEY before selecting the typesafe backend.")
        if not isinstance(model, str) or not model.strip():
            raise ValueError("TypeSafe model must be nonempty.")
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be finite and positive.")
        self._api_key = api_key.strip()
        self.model = model
        self.timeout_seconds = timeout_seconds
        self._transport = transport
        self._client: Any = None
        self._busy = False
        self._closed = False
        self.last_timings_ms: dict[str, float] = {}
        self.last_model: str | None = None

    async def decide(self, snapshot: str, questions: list[GateQuestion]) -> list[GateAnswer]:
        if self._closed:
            raise JevError("TypeSafe backend is closed; create a new instance.")
        if self._busy:
            raise JevError("TypeSafe decision already in flight; drop the obsolete tick.")
        self._busy = True
        start = perf_counter()
        self.last_timings_ms = {}
        self.last_model = None
        try:
            if not isinstance(snapshot, str):
                raise TypeError("The Jev snapshot must be text.")
            # Freeze mutable caller-owned questions before the first await.
            questions = [question.model_copy(deep=True) for question in questions]
            payload = {"model": self.model, "state": snapshot, "questions": _questions(questions)}
            self.last_timings_ms["prepare"] = (perf_counter() - start) * 1000
            if not questions:
                return []
            post = self._transport
            if post is None:
                if self._client is None:
                    try:
                        import httpx
                    except ImportError:
                        raise JevError("TypeSafe HTTP backend requires: uv sync --extra cloud") from None
                    self._client = httpx.AsyncClient(follow_redirects=False)
                post = self._client.post
            request_start = perf_counter()
            try:
                async with asyncio.timeout(self.timeout_seconds):
                    response = await post(  # type: ignore[misc]
                        ENDPOINT, headers={"Authorization": f"Bearer {self._api_key}",
                                           "Content-Type": "application/json"},
                        json=payload, timeout=self.timeout_seconds,
                    )
            except TimeoutError:
                raise JevError("TypeSafe request timed out; this snapshot was not retried.") from None
            except Exception:
                # Do not include exception strings that could echo headers/state.
                raise JevError("TypeSafe transport failed; check connectivity and retry a fresh tick.") from None
            finally:
                self.last_timings_ms["request"] = (perf_counter() - request_start) * 1000
            if response.status_code != 200:
                try:
                    delay = float(response.headers.get("retry-after", ""))
                    retry_after = delay if math.isfinite(delay) and delay >= 0 else None
                except (TypeError, ValueError):
                    retry_after = None
                raise JevHTTPError(response.status_code, retry_after)
            parse_start = perf_counter()
            try:
                try:
                    body = response.json()
                except (ValueError, TypeError):
                    raise JevError("TypeSafe returned invalid JSON.") from None
                result = _answers(body, questions)
                self.last_model = body["model"]
                return result
            finally:
                self.last_timings_ms["parse"] = (perf_counter() - parse_start) * 1000
        finally:
            self.last_timings_ms["total"] = (perf_counter() - start) * 1000
            self._busy = False

    async def aclose(self) -> None:
        if self._busy:
            raise JevError("Finish or cancel the in-flight decision before closing TypeSafe.")
        self._closed = True
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> "TypeSafeJevBackend":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()
