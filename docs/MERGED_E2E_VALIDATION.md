# Merged bridge verification — 2026-09-20

Two isolated runs used the real Node memory service, Bun harness, Jev API, OpenAI
Responses API, local code runner, Playwright and proxied SSE notifications.
Historical speech, face identities and a sign image were controlled fixtures.
These results measure request/observation submission to SSE receipt, not physical
speech onset, iPhone camera latency or OS push delivery. Each case ran once.

| Case | Result | Observed time |
|---|---|---|
| Keys recall from three hours earlier | Correct blue bowl/kitchen-door answer with source refs | 8.50s |
| Class notes and homework | Correct BFS/FIFO/unweighted paths and exercise7 | 7.71s |
| William conversation | Correct greenhouse/humidity/solar-panel discussion | 6.92s |
| Schedule 20-second reminder | Durable reminder receipt and confirmation | 5.80s |
| Code while reminder waits | Executed sum-of-squares calculation:338350 | 6.20s |
| Reminder wake | Separate LLM turn delivered stretch reminder | 22.47s from original request, about2.47s after due time |
| Fresh-camera interrupt | Jev requested one extra image; correct Room314/Robotics Lab answer | 9.21s |
| Person reminder creation | Bound Vitamin B reminder to Kenny's gallery UUID | 8.58s |
| Kenny reappears | New face evidence woke a separate LLM reminder turn | 5.03s |
| Browser/files | Downloaded CSV, computed totals, created/uploaded summary through browser | 25.20s |
| Upload verification | Fixture server received project `merged-demo`, category `Research`, correct CSV total94.40 | Content check passed |
| Cancel code | Running task changed to cancelled through memory-page proxy | 4ms API/state transition; process teardown is not included in this number |

All12 checks passed. The first run's printed summary counts six ordinary cases;
its separate reminder-wake record is the seventh. The script now counts wakes in
its summary too. The second run contains five checks. Raw synthetic results and
telemetry remain in ignored `agent/data/merged-perf/2026-09-20T07-57-12-560Z/` and
`2026-09-20T08-00-07-862Z/`. Run again with:

```sh
cd agent
bun scripts/merged-perf.ts --live
# Optional subsets:
bun scripts/merged-perf.ts --live --only person,browser,cancel
```

For the first run, mean Jev classification was282ms, mean delivery review213ms,
and mean OpenAI model turn2.49s across16 calls. The seven-to-nine-second answers
include multiple model/tool turns. These are sample means, not p95 guarantees.
The simple sign's image interpretation took3.61s; a complex real camera frame
can take much longer.

## Local perception through the merged proxy

- Local Whisper received real-time PCM through `:8082/ws/speech?backend=local`.
  Generated speech “The blue notebook is on the kitchen table” produced the
  correct final transcript with word offsets. Ready arrived at63ms, first partial
  at2.05s and final at3.96s after connection. This is generated speech, not a venue
  microphone accuracy trial.
- Local InsightFace received six frames through `:8082/ws/faces?backend=local`.
  An existing recorded image matched its existing gallery UUID. Frame round trips
  were93,41,59,48,42,41ms. No enrollment/gallery mutation occurred. This checks the
  local serving path, not recognition accuracy on unseen people or new conditions.
- Original source data was preserved; consistent pre-cutover SQLite backups and
  local probes are in the space's private `.context/merged-demo/`.

## Regression coverage and limits

At the initial integration checkpoint:443 Python tests,81 Bun tests,284 memory-service tests,
84 client tests. Typechecks/builds pass; Python ruff/pyright pass. Claude's isolated
browser QA passed27 checks before the final pure-state-machine race fixes. Those
fixes have dedicated client regressions. See [the UI report](MERGED_UI_VALIDATION.md).

Integration regressions cover durable outage/restart delivery, historical backfill
without activation, rollback, transcript revisions, stale/deleted source rejection,
gallery deletion propagation and late-name ordering, camera claim/session/expiry,
and invalid batch reuse recovery. JPEG writes now use `write-file-atomic`; history
scoring yields between queries and reports context/model/commit timing separately.

At the initial integration checkpoint, the sustained live scene writer had a substantial backlog. A sample
of150 recent provider operations showed complex image interpretation p50≈25.2s,
p95≈29.5s; writer calls p50≈12.0s, p95≈16.3s with7 failures among30 attempts.
Those are per-attempt provider timings, not full batch latency. Eight vision workers
helped clear the vision queue, but ordered writing/retries remain a bottleneck.
A copied-store probe spent6.76s building four-frame context, including6.57s in42
exact vector searches. Yielding improves request responsiveness, not search cost.

Historical photos, raw speech and fresh interpreted frames can support agent
answers independently of a completed scene update. This does not make the derived
current-state projection real-time. Do not claim iPhone Continuity Camera, physical
glasses, noisy-venue perception, background iOS push or robust long-run throughput
were verified by these checks.

## Throughput repair and rerun — September 20, 08:35 UTC

On a consistent private copy containing 1,740 captures, 739 entities and 37,290
active observations, the old attribute rebuild took **3,790 ms**. Scanning
supported attributes once, with unchanged entities left untouched, took **10 ms**.
Writer context now defaults to FTS5 literal word overlap, with the same continuity
and face identities. A four-frame lookup took **306 ms**, compared with the earlier
6.76-second embedding/exact-vector path. Source text and images are retained;
corrections and removed identities still filter retrieval. Vector search remains
an explicit optional UI/API mode, not the writer default.

Live batch commits after the change were about **200 ms**, versus approximately
12 seconds before. The existing backlog is being drained in source order under
ongoing capture rather than deleted or marked complete. Capture admission now
reserves capacity before disk I/O, so concurrent uploads cannot exceed the queue
bound. Provider inference latency remains and is separately logged.

The full real-provider fixture replay passed **12/12** again. Matching answers are
now required to belong to the task created for that specific request; a failed
case sets a nonzero process exit status. Private run directory:
`agent/data/merged-perf/2026-09-20T08-34-56-267Z/`.

| Check | Request-to-result |
|---|---:|
| Keys recall across hours | 5.65 s |
| Class review | 6.68 s |
| William conversation recall | 6.95 s |
| Schedule reminder | 5.40 s |
| Code while reminder waits | 7.14 s |
| Twenty-second reminder, separate LLM turn | 23.34 s from original request |
| Person reminder setup | 5.36 s |
| Confirmed-person appearance to reminder | 2.86 s |
| Browser download, calculation and upload | 24.73 s |
| Upload receipt/file content check | Passed, total 94.40 |
| Cancellation API/state transition | 3 ms |
| Fresh camera interpretation and answer | 10.92 s |

HTTPS integration verifies a trusted test-certificate handshake, shared HTTP/HTTPS
store and WSS-to-local-perception proxy. Push tests verify same-origin server-side
authentication, subscription/delete bodies, test delivery, owner-scoped counters,
retry/deduplication and expired endpoint removal. Browser/OS receipt is a separate
check; these transport fixtures do not establish Apple background delivery.

The current suites pass **443 Python, 84 agent, 293 memory and 107 client tests**,
plus **52 isolated browser checks**.
Its worker handles real browser push events injected through CDP; PushManager
registration is mocked in that browser test. The test covers synchronous
gesture-bound subscription, tag reuse without renotification, failed-display
handling, same-origin notification opening, hidden-tab acknowledgement behavior,
Start/Stop overlap, reconnects and absence of private API/media cache entries.

A separate test through the running merged server reached its existing real
**FCM** subscription: sent deliveries increased from **1 to 2**, pending/failed
remained zero. This is a real push-service acceptance, not a verified device
banner. Private receipt: `.context/merged-demo/live-push-test.json` in the space.

## Historical recovery — September 20, 09:20 UTC

All **91 previously failed captures** were retried through the normal validated
pipeline and committed successfully. The repair process submitted four at a time
only when the live queue had capacity. It retained the original photos and source
timestamps, did not delete rejected data, and did not stop ongoing capture.
At completion the service had **2,322 committed captures, 28 pending and zero
failed**; the agent bridge had no pending events or errors. The 28 pending records
were normal live work still catching up after the repairs, not lost records.
Private evidence is in the space's `.context/merged-demo/repair-results.json`
and `repair-complete-health.json`.

A live-only sample from **09:21:22 to 09:23:22 UTC** then accepted **24 new
captures and committed 36**, reducing the queue **26 → 14** and derived-memory
age **143 → 83 seconds**, with zero failed records and no reported pipeline
errors. Capture stayed running. This demonstrates catch-up in that two-minute
window, not instant scene updates or a long-run latency guarantee. The sample
is preserved privately in `.context/merged-demo/post-repair-soak.jsonl`.

## Ambient interface and full memory inspection — September 20

The primary flow is camera/scene, speech and fresh face evidence into Jev, then
agent work and useful updates. Recording does not wait for Jev. Manual Send is
an explicit Debug operation. Live, Memory and Debug share the same capture
controller; navigating between them must not reacquire devices or stop recording.

New read-only, cursor-paginated endpoints expose observations, retained photos,
transcripts across sessions, entities, state history, valid agent facts/graph
claims, and reminders in every state. Literal text and time filters apply across
the retained store. Source text, intervals and revision evidence remain available;
deleted identities and invalidated claims do not reappear as active knowledge.
See [the memory browser contract](MEMORY_BROWSER.md).

Backend checks passed **443 Python, 88 agent and 297 memory tests**. Added checks
cover paging beyond 100 records, stable page boundaries during backdated inserts,
filter-bound cursors, owner isolation, literal wildcard characters, cross-session
transcript revisions, deleted identities, source invalidation and read-only HTTP
access. All seven categories were also read through the running merged proxy.

A consistent private copy held 61,518 observations, 2,613 photos, 16 transcript
segments, 1,118 entities and 2,607 states. Reading one bounded page, including its
count, took **0–20 ms** by category. These are local database timings, not browser
rendering or end-to-end agent latency. Private evidence:
`.context/merged-demo/browse-probe-results.json` in the space.

The local perception process was found stopped and restarted with the existing
models/gallery. A generated speech fixture passed through the merged WebSocket
proxy to local Whisper: ready in **648 ms**, correct final text in **4,562 ms**.
This did not insert a real transcript or trigger an agent task. Private evidence:
`.context/merged-demo/local-speech-recheck.json`.

The real Mac browser listed its built-in camera/microphone, but no Continuity
iPhone camera during inspection. Reading the live Memory view did not start
recording. The older active capture session kept posting photos marked
audio/face unavailable after the outage; it needs Stop/reload/Start to reconnect
after exhausting its bounded retries. A healthy service alone does not prove
an existing browser run has reconnected all streams.
iPhone selection, physical capture quality, installation and OS push
banners remain device checks. Claude's UI and isolated browser results are in
[the ambient UI report](AMBIENT_MEMORY_UI_VALIDATION.md).
