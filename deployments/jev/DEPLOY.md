# Jev HTTP gate

**Status: official API verified; adapter tested offline. No live request has been
made, and no TypeSafe key was available for this change.** Jev is hosted by
TypeSafe; this adapter requires no Baseten deployment or GPU allocation.

## Verified provider contract

Checked 2026-09-19 against TypeSafe's [HTTP reference](https://docs.typesafe.ai/api),
[models](https://docs.typesafe.ai/models),
[Python SDK](https://docs.typesafe.ai/sdk/python), and
[Choice](https://docs.typesafe.ai/primitives/choice) /
[Score](https://docs.typesafe.ai/primitives/score) documentation.

The endpoint is `POST https://api.typesafe.ai/v1/systemone`, with Bearer
authentication and JSON `{model, state, questions}`. Questions form a map keyed by
application IDs. A Noul uses `type` and `instructions`; a Choice adds a criteria
map from labels to descriptions or null; a Score adds an ordered rubric array.
Answers use the same IDs and report `noul`, or `choice`/`score` with probability
distributions and confidence. Score also returns a numbered legend. The official
SDK exports `AsyncTypeSafeClient` and `system_one`; the adapter uses the documented
HTTP API directly through lazily imported `httpx` instead.

The default pinned model is `jev-1.13.0`. The returned model is exposed as
`last_model`; smoke output records it. The generic frozen `GateQuestion.choices`
maps to Choice labels with null descriptions or Score's ordered levels. Noul
questions cannot carry this field. The adapter requires 2–255 Choice options or
2–10 Score levels, distinct and nonempty.

`GateAnswer.probability` is the Noul probability or the selected Choice's
probability. **It is not TypeSafe's distribution-derived confidence.** Score
answers retain their score and indexed distribution; probability stays unset.
The frozen contract has no separate vendor confidence/legend fields, so those
are validated rather than relabeled. Missing answers, wrong types, invalid
probabilities or mismatched criteria fail the entire bank; no decisions are
fabricated.

## Integration and live smoke

Install the existing cloud extra with `uv sync --extra cloud`. Set
`TYPESAFE_API_KEY` in the process environment (never a command-line argument or
checked-in file). Construct `TypeSafeJevBackend(api_key, model="jev-1.13.0")`, await
`decide(snapshot_text, questions)`, and await `aclose()` during shutdown. An async
context manager is also supported. The adapter reuses one HTTP client and rejects
overlapping calls instead of buffering obsolete snapshots. An injected async
post-like `transport` permits core-only tests without `httpx` or network access;
the caller owns the injected transport's lifecycle.

Run one synthetic, credentialed request deliberately:

```sh
uv run --extra cloud python scripts/smoke_jev.py --live
```

The command prints typed answers, resolved model, and client timings. Without
`--live` or an environment key it exits before any request. A successful smoke
establishes connectivity and response compatibility only. Validate the full real
question bank, accuracy and venue latency separately; no live latency result is
claimed here.

`last_timings_ms` records `prepare`, `request`, `parse`, and `total` using a
monotonic clock. Missing phases indicate early failure, not zero cost. `request`
includes transport/network overhead; none of these fields is provider-only GPU
time. Each accepted call clears prior timings and `last_model`.

The default end-to-end request deadline is two seconds, configurable through
`timeout_seconds`. There are no automatic retries or redirect following. HTTP
401/403/422 and rate/overload statuses produce actionable sanitized errors;
`JevHTTPError` exposes the status and numeric `retry_after_seconds` when supplied.
The scheduler should honor backoff for 429/529 and evaluate a fresh snapshot,
rather than retrying stale context inside the decision path. Provider response
bodies, input snapshots, and API keys are never included in adapter error text.

## Offline validation

`uv run pytest hub/tests/test_jev_typesafe.py` exercises the wire schema, all three
primitive mappings, input/response validation, timeout and cancellation recovery,
the one-in-flight guard, snapshot/question isolation, and lazy dependencies.
All tests use synthetic local transports and make no HTTP requests.
