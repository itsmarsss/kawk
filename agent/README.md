# KAWK agent

An always-on Bun service for ambient glasses assistance. Finalized perception events
enter a durable ledger. Jev independently chooses memory work and useful agent work;
The agent investigates, and Jev reviews proposed notifications against their sources.
No wake word or mention is required. Idle time makes no model calls.

Main agents and children use the **OpenAI Responses API**, with `gpt-5.6-sol` and
reasoning `none`. One reusable official SDK client streams native function calls;
there is no CLI startup, thread prewarm or subprocess shutdown on this path.
Provider failures use a configured **Baseten tool-calling model**, with a 60-second
cooldown before retrying the primary. Python remains on the Baseten serving side.

## Run

Requires Bun 1.3.2+, ripgrep (`rg` on PATH), an OpenAI API key and local Playwright Chromium for browser tools.
On macOS, install ripgrep with `brew install ripgrep`.

```sh
cd agent
bun install --frozen-lockfile
cp .env.example .env
# Set OPENAI_API_KEY, TYPESAFE_API_KEY, BASETEN_API_KEY and KAWK_BASETEN_MODEL in .env.
# Use a Baseten model that supports tool calling. There is no guessed default.
bun run browser:install
bun start
```

Without Baseten configuration, startup explicitly reports that fallback is unavailable.
Without a TypeSafe key, startup fails. There is no production mock classifier.
`KAWK_RUNNER=disabled` starts memory/agent work without code/browser capabilities being
executable. The default `KAWK_RUNNER=local` runs commands directly on this computer.

The authenticated API listens on `127.0.0.1:8091`. Its device token is created at
`data/client-token` with mode 0600; provider keys remain in Bun. `KAWK_CLIENT_TOKEN`
can supply a token of at least 32 characters. Store `.env` privately and keep it out
of version control. `KAWK_OPENAI_MODEL` selects the API model. `KAWK_OPENAI_REASONING`
is explicitly `none`; higher effort is rejected until reasoning-item persistence is
implemented. Missing API credentials fail startup rather than silently selecting
subscription auth. Calls use `store:false`, replay the owner-scoped durable transcript,
and execute tools only after a complete validated response. Function-call IDs survive
restart and provider changes. Schema checks, receipts and local tool execution stay in KAWK.
SDK automatic retries are disabled so failures and fallback time remain observable.

For a legacy comparison, set `KAWK_MODEL_PROVIDER=codex` and authenticate Codex CLI
0.155.1+. `KAWK_CODEX_MODEL` selects its model, `KAWK_CODEX_REASONING` defaults to
`none`, and CLI user configuration/native tools/MCP/project rules remain disabled.
Baseten fallback uses its provider-default effort, labeled separately in reports.

On macOS, after configuration:

```sh
bun run service prepare   # validate a plist without installing or starting it
bun run service install   # start at login; restart after process failure
bun run service status
bun run service remove    # stop service; preserve evidence and memory
```

The service runs while the computer is awake;
it does not wake a sleeping computer. Logs are under `~/Library/Logs/KAWK`.
Linux can run `bun start` under its service supervisor. Do not run two daemons against
one data directory: a database lease rejects the second.

## Client integration

`client/index.ts` is a TypeScript SDK for a trusted desktop/device integration.
It accepts normalized transcripts/observations and consumes acknowledged SSE events.
A browser integration must be served through the same origin or a trusted desktop
transport; the service rejects cross-origin browser requests.

```ts
import { KawkClient } from "./client";
const client = new KawkClient("http://127.0.0.1:8091", deviceToken);
await client.send([{
  id: "utterance-1", deviceId: "glasses-1", streamId: "speech-session-1",
  revision: 0, kind: "transcript", final: true,
  sourceStart: capturedStartMs, sourceEnd: capturedEndMs,
  text: "Where did I leave my keys?", confidence: 0.96,
  speakerId: null, personIds: [], provenance: "baseten:your-speech-model"
}]);
for await (const notification of client.watch(abortController.signal)) {
  // Deduplicate by notification.id in your client, display, then acknowledge.
  await display(notification);
  await client.ack(notification.id);
}
```

Retries use the same event ID and revision. Changed text requires a higher revision.
Source intervals use epoch milliseconds, not arrival time. Finalized evidence is
searchable and classified; partials are retained but do not activate the agent.
Visible person IDs and verified speaker identity are separate fields.

The PWA connects camera/microphone capture to TypeScript perception adapters and
receives notifications through SSE and Web Push. Baseten is currently disabled
because of its outage; live face/speech and OS background push remain unverified.
The old Python app is a migration reference, not a required local interop service.
Physical glasses transport remains integration work. See the
[current verification scope](../docs/AMBIENT_INTEGRATION.md).

## Runtime and tools

- SQLite WAL stores original revisions, FTS retrieval, versioned facts/episodes/
  intentions, task state, child messages, tool receipts, schedules and notifications.
- Jev `jev-1.13.0` scores remembering independently from the single route
  `observe/start/update/cancel`. Starting work is derived from that route.
  Ambiguous routes and API failures do not invent work.
  Failed classifications retry up to five times with backoff; status exposes failures.
- Two executing parent tasks per owner, four task loops globally, two children per root,
  depth one. Each root shares 32 model turns, 160,000 accounted tokens and a three-minute
  deadline. A single in-flight response may exceed the token budget before cancellation.
- Main and child tools: source-backed memory, child spawn/status/message/cancel/wait,
  code execution with process handles/cursors/cancellation, workspace file I/O,
  durable file export, browser navigation/forms/uploads/downloads/tabs/screenshots,
  and scheduled follow-ups through Jev.
- Each task gets a fresh `/tmp/kawk-*` working directory. Code runs as the host user
  with network access; this directory is not an OS sandbox. Polling, cancellation,
  command deadlines and output limits remain. Provider credentials are not automatically
  passed in the child environment, but host files remain accessible.
- One local Playwright Chromium process is reused, with fresh browser contexts per task.
  HTTP(S) navigation includes localhost. Interactive click/type/select/key/upload/download require
  `KAWK_BROWSER_INTERACTION=1`.
- Model prose is never automatically delivered. `finish` requires current source refs,
  useful text and confidence >=0.8; production Jev independently reviews support and
  usefulness. Children return results only. This is a quality gate, not a proof of truth.

See [local runner behavior and measurements](../docs/LOCAL_RUNNER.md).
Code workspaces are ephemeral and expire with the task. `export_file` preserves a
deliverable as an owner-scoped downloadable artifact; files up to 10 MiB are supported.
Screenshots are also saved as artifacts; the model uses page text/accessibility,
not screenshot pixels. Browser state can search long pages for focused evidence excerpts.
See [actual file/browser agent tests](../docs/BROWSER_FILE_VALIDATION.md).
No semantic vector index, AV clip memory, V1 gallery/notes import, or arbitrary account
integrations are included in this first harness.

## Durability, retention and API

Corrections invalidate dependent work, derived memories and notifications. Evidence
deletion purges source and dependent task text and marks screenshots unavailable.
Deleting a memory summary leaves its original evidence; delete the evidence as well
when the original observation should be forgotten. SQLite/file deletion is logical
application deletion, not a claim of forensic erasure from storage or backups.

On restart, queued work resumes. Completed tool receipts are reused. An interrupted
side-effecting call with unknown outcome fails the task for inspection rather than
being replayed. Local process handles and browser contexts are ephemeral and do not reattach after
a service restart. Normal task completion/cancellation and shutdown clean up owned
processes, contexts and workspaces. An abrupt process crash can leave temporary files
or child processes; `/tmp` is not durable task storage.

Unpinned evidence and old terminal task content expire after seven days, configurable
with `KAWK_RETENTION_DAYS`. Active memory and future intentions pin their source
observations. `KAWK_STORAGE_MB` defaults to a 1 GiB **database admission watermark**:
new event IDs receive backpressure above it. It is not a total disk quota; SQLite WAL,
artifacts, tombstones and in-flight task writes need additional room. Artifact retention
uses the same age window. Notification lifetime is 30 seconds; reconnect replays only
pending unexpired IDs. Delivery is at least once until acknowledgement.

API routes accept `Authorization: Bearer <device-token>` for scripts or the PWA's
session cookie. `/health`, the static app and local session bootstrap are public:

| Route | Purpose |
|---|---|
| `POST /v1/events` | Atomic `{events:[...]}` ingestion; retries deduplicate |
| `GET /v1/status` | Tasks, queue failures, storage usage and runtime status |
| `POST /v1/decisions/retry` | Explicitly retry exhausted classification jobs |
| `POST /v1/history/grep` | Ripgrep over account-scoped history, source-time filters and cursor pagination |
| `GET /v1/memory/search?q=...` | Scoped source and memory retrieval |
| `DELETE /v1/memory/:id` | Remove memory versions and invalidate pending work |
| `DELETE /v1/evidence/:id` | Delete source and derived content; prevent reimport |
| `GET /v1/tasks`, `GET /v1/tasks/:id` | Inspect task state and transcript |
| `POST /v1/tasks/:id/message` | Queue `{id:UUID,text}` at a safe tool boundary |
| `POST /v1/tasks/:id/cancel` | Cancel task and children |
| `GET /v1/notifications`, `GET /v1/notifications/stream` | Poll or stream outbox |
| `POST /v1/notifications/:id/ack` | Acknowledge delivery |
| `GET /v1/artifacts/:id` | Retrieve an owned screenshot |

## Try tasks and measure performance

```sh
bun run perf --live
bun run perf --live --only browser
bun run perf --live --prompt "Run code to calculate the first 20 prime numbers."
bun run perf --live --only code --provider baseten
bun run perf --live --only recall --provider openai --no-fallback
bun run perf:wearer --live  # one wearer, overlapping work, client SSE timing
bun run perf:wearer --live --only class,class-today  # date-aware positive/negative cases
```

The default suite runs recall, code, browser and two-subagent tasks, followed by
missing-evidence and filler controls. Jev activation/review, models and local tools
are real. Only task inputs and seeded history are synthetic. OpenAI API and Baseten
calls use their respective API billing. Default task deadlines and shared
budgets remain in force; the script runs one root task at a time.

Live JSON lines show model turns, tool execution, child states and delivered answers.
Each run retains `data/perf/<timestamp>/REPORT.md`, detailed `results.json`, and a
SQLite database with transcripts and receipts, plus `telemetry.jsonl` with correlated
task/turn spans. The report breaks model calls into setup, request-to-first-token,
streaming/completion and cleanup. Results include failed/suppressed tasks,
not only successful answers. Custom prompts are recorded in those local files.

Install Playwright Chromium once. Code starts directly in a fresh task workspace;
the first browser call launches Chromium and later tasks reuse it with fresh contexts.
Model timings include provider response time and, in Codex mode, CLI overhead. Times begin at
normalized-event HTTP ingestion; camera, speech/vision inference and
physical display latency are outside the measurement. Each case is one sample,
not a latency distribution or general quality benchmark. Reported tokens include
repeated prompt input, and summed model time includes overlapping child calls.

## Telemetry

`bun start` enables local telemetry by default (`KAWK_TELEMETRY=0` disables it).
The runtime writes `data/telemetry.jsonl`, rotating at 10 MiB to one previous file.
Files use mode 0600. Records contain event/task/root IDs, timings, counts, tool names,
requested model/effort, provider-reported token/cache usage and sanitized Codex events.
Prompts, answers, tool arguments/results, account identifiers and credentials are not
included in this metadata log. The existing performance report/SQLite fixture artifacts
still contain their task inputs and outputs. `/v1/status` exposes dropped telemetry
records; a failing log sink does not interrupt task execution.

```sh
tail -f data/telemetry.jsonl
bun run telemetry                         # summarize the service log
bun run telemetry data/perf/<timestamp>/telemetry.jsonl
bun run perf --live --only recall          # direct API stream telemetry
bun run perf --live --only recall --provider codex --no-codex-telemetry  # legacy comparison
```

Direct API timing records request start, response headers, first text/tool-argument
delta, response completion and cleanup, plus input/cached/output/reasoning tokens.
Each concurrent call carries its own diagnostics; tasks never share remote conversation
state. Stream failures discard partial calls, and cancellation does not start fallback.

The optional Codex path uses the official [Codex OpenTelemetry exporter](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry),
directed to a temporary loopback collector per call, with prompt logging disabled.
Only an explicit list of timing/count/model fields is retained. Codex's own event
timestamps identify startup, connection/prewarm, real request, first token and
completion; export arrival time is not treated as generation time. Prewarm requests
are excluded from the answer's breakdown. Zero cache/reasoning usage is reported only
when the provider reports zero; missing fields stay unknown.

The first-token interval includes network and provider work. The exporter does not
separate server queuing from prompt processing here. Streaming includes completion
bookkeeping. After-response time includes CLI shutdown and telemetry flushing, which
can add measurement overhead. `--no-codex-telemetry` keeps local stage/CLI timestamps
without the exporter, so that overhead can be investigated. Baseten currently records
HTTP header/response timing, without claiming token-level streaming timing. Nested
tool/review spans and parallel children must not be summed as end-to-end latency.

## Verify

```sh
bun run check          # typecheck + all tests, including real local code/browser
bun run demo           # explicit fixture gate/model; real SQLite + HTTP + SDK flow
bun run test:runner    # six real local code/browser/lifecycle tests
bun run smoke         # configured API model, fixture gate; --live-jev for live gate
bun run smoke:codex    # real subscription model; synthetic evidence, fixture gate
bun run smoke:codex --live-jev  # real activation and delivery review as well
```

Historical checks before the local-runner migration on 2026-09-19 passed: 30 offline tests, three live Docker tests,
the fixture end-to-end demo, and a three-turn live Codex recall/notification/ack path.
The macOS plist was generated and validated, not installed. A subsequent credentialed
check passed live Jev activation → Codex retrieval → Jev delivery review → notification
acknowledgement. Baseten `openai/gpt-oss-120b` also returned the expected tool call
through the fallback adapter after an injected primary-provider failure. Four additional
Jev probes distinguished filler, recall, personal memory and quoted requests; unsupported
delivery was rejected. These are bounded synthetic checks, not an accuracy benchmark.
Credentials were loaded into the local ignored `.env` without being printed. These checks establish
protocol and lifecycle behavior, not ambient-model accuracy or glasses latency.

[Architecture and build scope](../docs/AI_AGENT_HARNESS.md) ·
[TypeSafe API](https://docs.typesafe.ai/api) ·
[Baseten tool calls](https://docs.baseten.co/inference/function-calling) ·
[Codex noninteractive execution](https://developers.openai.com/codex/noninteractive/) ·
[Codex authentication](https://developers.openai.com/codex/auth/) ·
[Playwright contexts](https://playwright.dev/docs/browser-contexts)

Direct API integration: [Responses API](https://developers.openai.com/api/docs/guides/text), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [streaming](https://developers.openai.com/api/docs/guides/streaming-responses).
## Ambient memory extension

See [identity, transcript archives, graph, reminders and clock alignment](../docs/AMBIENT_MEMORY.md).
Raw speech is persisted before Jev, exported to hourly JSONL files, and searchable
through `grep_history` (ripgrep regex/literal search) and `search_transcripts` (word/time filters).
Search includes the unexported current hour, reads only current final revisions, and
returns source citations. No semantic retrieval service or embedding index is used.
See [history search](../docs/HISTORY_SEARCH.md) for examples and verification.
This still assumes one configured account; seeing the
owner in the camera does not establish who is wearing the device.

## Current PWA and ambient integration

See [the current pipeline](../docs/PIPELINE_OVERVIEW.md) and [verification with measured limits](../docs/AMBIENT_INTEGRATION.md). `bun start` serves the PWA and API at http://127.0.0.1:8091. Open it and it connects automatically; no token entry is needed. The token in `data/client-token` remains available for scripts.

During the current Baseten outage, local `.env` sets `KAWK_BASETEN_ENABLED=0`; manual transcript input and OpenAI scene descriptions remain available. This also disables Baseten fallback. Restore to `1` when the existing face/Whisper services work. Background push uses persisted `data/vapid.json`; keep it and the database across restarts. Provider keys never go into browser assets.
