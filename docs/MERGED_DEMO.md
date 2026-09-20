# Merged demo — 2026-09-20

This checkpoint integrates the current “Build 4D video scene demo” code with the
ambient agent. The original brief calls for timestamped speech, same-image face
identities and image descriptions to update persistent people, objects, places and
events, plus a separate agent that answers questions and acts when useful.

```mermaid
flowchart TD
  A[Camera and microphone] --> B[Local Python faces and Whisper]
  A --> C[Scene memory service :8082]
  B --> C
  C --> D[SQLite sources and entity history]
  C --> E[Durable event outbox]
  E --> F[Jev activation in Bun :8091]
  F --> G[OpenAI agent turns]
  G --> H[History search, reminders, code, browser]
  G --> I[Extra camera request]
  I --> A
  H --> J[Live notification feed]
```

## Start

Requires Node22+, Bun1.3.2+, uv, ripgrep, the existing local perception models and
private `agent/.env` containing `OPENAI_API_KEY` and `TYPESAFE_API_KEY`.
Use the existing credential file; do not put keys in git or browser code.

```sh
# Repository root. Reuse the existing :8081 server if it is already running.
make serve-ui
# Separate terminal, repository root:
cd memory
npm ci
npm run build:client
cd ../agent
bun install --frozen-lockfile
bun run browser:install
bun run demo:stack
```

Open **http://localhost:8082**. The launcher connects memory and the agent with a
server-side token automatically. It refuses occupied ports, forces local speech
and disables Baseten. Ctrl-C stops its two children and leaves perception running.
Optional `MEMORY_DATA_DIR=/absolute/path/to/existing/memory/data` reuses an existing
scene store and photos. Stop its old memory process first: never run two writers
against that directory. Agent data defaults to `agent/data/`.

For pre-hardware QA, select iPhone Continuity Camera and the laptop microphone.
Opening the page does not begin capture; press Start. An iPhone opening the web
page directly needs trusted HTTPS for camera/mic permissions. Physical glasses
transport remains a separate integration step.

## What is connected

- Raw transcript revisions commit independently of Jev, then a transactional
  outbox retries delivery to the agent. Agent history remains searchable with
  ripgrep across hourly JSONL partitions and the active SQLite journal.
- Five-second photos keep source capture time, same-image face evidence and the
  rolling timestamped transcript. Vision descriptions reach the agent before the
  slower ordered memory writer completes. Capture cadence is not answer latency.
- The existing scene store retains entities, source observations, corrections and
  removals. Agent scene search defaults to literal keywords; its existing vector
  search remains optional. Imported notes are revalidated before delivery so a
  superseded/deleted note cannot support a new answer.
- Integrated Jev decisions can request a fresh camera frame. The browser claims
  the request once, preserving the normal capture schedule. Requested frames take
  the next vision-worker slot; they do not cancel an already running API call.
- One Python gallery owns face enrollment and identity. Its Jev name-binding guard
  remains separate from harness activation. A visible person is not a verified
  speaker or wearer. This demo assumes one wearer.
- Reminders are durable and wake an LLM turn. Related due reminders are grouped;
  turns share refreshed evidence and compact older context. Code/browser work runs
  locally in task-specific `/tmp` directories; no Docker or Kubernetes.

## Checkpoint verification

Backend checks: **443 Python, 81 agent and 284 memory tests passed**. This includes
outbox outage/restart and rollback behavior, transcript revisions, same gallery IDs,
fresh-camera claim/session/expiry checks, stale-source rejection, and recovery from
invalid memory batch reuse without rerunning image inference. UI checks are recorded
separately in `MERGED_UI_VALIDATION.md` when Claude's validation completes.

```sh
make test
cd agent && bun run check
cd ../memory && npm run check && npm test
npm run check:client && npm run test:client && npm run build:client
```

These are controlled tests, not evidence that iPhone capture or hardware is ready.
At integration time the older live memory process had about six minutes of backlog.
Source-time alignment and fresh-frame priority prevent treating an old scene as
current; they do not eliminate slow vision/writer calls. Existing batch failures
now retry individually. The [merged live-provider report](MERGED_E2E_VALIDATION.md)
records12 passing controlled checks, local perception probes and measured latency;
iPhone/hardware testing remains separate.

Next live acceptance cases: where are my keys; summarize today's class; recall
William's conversation; enroll/rename a person; remind me about Vitamin B when
Kenny appears; request a fresh visual answer between scheduled frames; run a browser
task while a 20-second reminder is pending; cancel a task; correct/delete a memory
and confirm it is no longer cited. See existing browser/file and single-wearer
benchmark reports for earlier component runs, not merged-device guarantees.

## Provenance and remaining limits

The scene app and latest local perception/name-binding changes were imported from
the user's `htn2026-chud3` worktree; that worktree and its private data were preserved.
PSI is an architectural reference only; no PSI implementation was imported.
The initial checkpoint does not claim live iOS background push, glasses display,
automatic wearer recognition, or reliable speech/face accuracy in venue conditions.
