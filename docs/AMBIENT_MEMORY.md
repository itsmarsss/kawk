# Ambient memory and time

Implemented on `chud3-ai-agent`, 2026-09-19. This extends the harness; it does not
replace or claim to have ported the separate camera/memory UI on `chud3`.

## Identity assumptions

The local service belongs to one configured account (`KAWK_OWNER`). This is an
authorization boundary, **not evidence of who wears the glasses**. The front-facing
camera cannot by itself distinguish a borrowed pair of glasses from a reflection,
an image, or another camera arrangement. Recognizing the owner in view is not a
wearer switch. `KAWK_OWNER` is an account key, not an automatic binding to a face-gallery ID.
Automatic wearer detection is not implemented. Lending the device
requires an explicit account/wearer session boundary before exposing personal
memory; that device/session UI remains integration work.
The `get_identity_context` tool exposes these actual capabilities with a host receipt
so the agent can answer an identity-limit question without inventing a wearer.

`personIds` means confirmed visual identities supplied by the perception producer.
`speakerId` is a separately verified speaker, or null. A transcript recorded while
William is visible can support “conversation while William was present”; it cannot
support “William said …” without speaker verification. The host validates evidence
structure and provenance; citations do not independently establish model accuracy.

## Raw transcript journal

Every accepted transcript revision enters SQLite before Jev runs, including partials,
filler and speech not selected for memory. The WAL uses FULL synchronization.
Jev selects derived memories and tasks; it does not select what speech is recorded.
The storage admission limit still returns explicit backpressure rather than silently
discarding input. Reliable producers must retry rejected events using the same ID.

`data/transcripts/<account-hash>-YYYY-MM-DD-HH.jsonl` materializes the journal in UTC
**receipt-hour** partitions. Each line includes source start/end, receipt time,
revision, finality, word times when supplied, and timing/identity uncertainty.
Late results retain their original source times. The service checks once a minute
for completed UTC hours and flushes those partitions. Shutdown and explicit deletion
also flush the current hour. It avoids rewriting a growing file on every utterance;
the current hour is durable in SQLite, not buffered for an hour in RAM.
SQLite survives a crash before export. A durable dirty-version counter causes replay
after restart without duplicate lines. `write-file-atomic` handles replacement/fsync,
followed by directory fsync. Files are private (0600), directories 0700.

Source deletion redacts all revisions from SQLite and affected JSONL partitions.
The HTTP delete waits for that export. A failed export retains pending journal work
and returns an error rather than claiming the file was redacted. Copies/backups made
outside this managed directory are not tracked.

Raw transcript retention defaults to unlimited (`KAWK_TRANSCRIPT_RETENTION_DAYS=0`),
bounded by available/admitted storage. Other unpinned evidence defaults to seven days.
Set transcript retention explicitly to expire speech. Model telemetry remains a
separate content-free JSONL stream.

`search_transcripts` and `POST /v1/transcripts/search` support lexical query,
source-time `from/to`, `personId`, separately `speakerId`, limit and offset. The
agent receives current finalized revisions; archives preserve the complete history.

## Knowledge and retrieval

`remember_entity`, `remember_relation`, and `query_graph` add structured entity and
relationship storage on the existing SQLite/versioned-memory lifecycle. Entities
cover people, objects, places, events and topics. Gallery IDs anchor known people
across name changes; names or vector similarity do not prove identity. Relations
carry source references, validity intervals and observed/reported/uncertain status.
Updates to the same relation key preserve superseded history. Distinct episodes
should use distinct keys. SQLite recursive queries traverse up to two hops with
explicit result bounds. Corrections invalidate dependent claims; deletion purges
their stored claim text. Successful writes return evidence receipts for confirmation.

Retrieval starts with `grep_history`, modeled on psi's ripgrep history tool. It searches
case-insensitive regex or literal patterns over current finalized transcripts,
observations and tool/context evidence. The stream comes from SQLite's durable journal
in JSONL form, including the unexported current hour. The agent expands keywords itself
and reads source events plus nearby context; there is no embedding/semantic service.
Time and person/speaker filters, bounded results and cursor pagination keep searches
inspectable. `search_memory` remains lexical FTS over saved notes/evidence; the graph
remains structured, evidence-backed memory. See [history search](HISTORY_SEARCH.md).

The prior MiniLM bridge and `KAWK_MEMORY_URL` configuration were removed. Existing
imported snapshots are retired from retrieval on database open because upstream
revisions can no longer be checked; dependent claims/notifications are invalidated.
Their original imported payloads remain in SQLite. Local captured history is unchanged.
The separate `htn2026-chud3/memory` prototype remains untouched.

## Reminders and browser tools

`create_reminder` supports an explicit absolute `dueAt`, a relative `afterMs` anchored
to the original utterance's source end, or next encounter with a
gallery `personId`; `list_reminders` and `cancel_reminder` manage it. Only the parent
assist task creates explicit reminders. These are durable, at-most-once outbox writes
with repeatable delivery until acknowledgment. A due reminder does not ask another
model whether its explicit intent still exists. Time reminders remain deliverable
for one day after their due time; encounter reminders expire after one year.
Source correction/deletion cancels reminders and withdraws affected notifications.
Delayed relative requests catch up immediately if still inside the one-day delivery
window; model/network delay does not restart their countdown.
Multiple reminders and the initial confirmation use separate notification IDs.

Encounter delivery requires a new, current finalized visual observation with adequate
confidence and a reported timing bound of at most one second. An old result arriving
late, a transcript mentioning a person, or unknown timing does not trigger it.
This consumes normalized face evidence; it does not implement face recognition.
Speculative `schedule_followup` needs continue to re-enter Jev.

Calendar operations use pinned `@js-temporal/polyfill`, not custom DST arithmetic.
`get_current_time` supplies the configured IANA timezone (`KAWK_TIME_ZONE`, system
default). `resolve_local_time` rejects invalid dates, skipped/repeated local times
and conflicting offsets. Explicit valid offsets disambiguate repeated DST times.

Browser navigation/read/screenshot and code tools use the [local runner](LOCAL_RUNNER.md):
per-task `/tmp` workspaces and shared Chromium with separate task contexts. Browser
click/type requires the existing operator option. There is no Docker or Kubernetes.

## Capture time and uncertainty

`KawkClient.syncClock()` exchanges three client monotonic/server timestamp pairs.
`captureTimes()` maps the original capture interval to the server's epoch clock,
retaining session ID, monotonic endpoints and an error range. Resynchronize at least
once a minute and after reconnect/clock changes. The range assumes nonnegative
transit, a stable server clock during exchange and the configured drift allowance;
it is not an experimentally calibrated confidence percentage or proof of UTC accuracy.

Use original audio sample/chunk capture times plus transcription word offsets, and
the actual frame exposure interval. Preserve piecewise mappings if audio is skipped;
never reinterpret a network reply's time as when the wearer spoke. Camera frames and
audio should share a capture clock/session. The existing memory capture implementation
is the reference for integrating these adapters; this harness change does not wire
the physical capture pipeline.

`temporal_context` retrieves possible overlap using source intervals expanded by
reported error, limited to the same device. It reports possible overlap separately
from overlap under all reported bounds. Missing timing uncertainty remains unknown.
Overlap never proves speaker identity. Estimated arrival-minus-latency intervals can
be marked `latency-estimate`; average model latency alone cannot establish that range.
Five-second image sampling can miss brief actions even with perfect clock mapping.

## Verification commands

From `agent/`:

```sh
bun run check
bun run test:runner
bun scripts/eval-gate.ts --live
bun run perf --live --only keys,class,person,graph,reminder,code,browser,subagents,unknown,filler --provider openai --no-fallback
```

Offline cases cover revisions, hourly rollover, restart export, deletion, retention,
account scope, speaker ambiguity, clock bounds, DST gaps/repeats, graph history,
reminder recovery/acknowledgment, grep scoping/pagination, and retirement of old imports. Live runs use real
Jev/OpenAI and local tools with synthetic perception history. They measure ingestion-to-
result, not microphone/camera-to-glasses latency. The reminder case waits for the
actual due notification, not just a successful scheduling confirmation. Reports
retain failed attempts and classifier false negatives.

See [the verification results](AMBIENT_MEMORY_VERIFICATION.md) for measured results
and remaining failures, including the live source-service check with no search hits.
