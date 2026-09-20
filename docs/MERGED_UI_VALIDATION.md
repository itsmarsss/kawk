# Merged demo UI validation (memory page + agent)

Date: 2026-09-20 (≈03:30–04:10 local). Author: Claude Code, model `claude-fable-5-1` (required by AGENTS.md for UI).
Scope owned by this pass: `memory/client/**`, `memory/public/**`, this file. Nothing in `memory/src`, `agent/src`,
secrets or running services was edited. Nothing was committed by this pass (see “Commit state”).

## What the page now does (localhost:8082, one primitive interface)

Preserved from the imported memory UI: Start/Stop, camera + microphone selectors, speech backend selector (local
Whisper default from `/api/config`), live preview with face boxes and names, spoken introductions through the face
socket, People list with confirmed Delete/Reset, current state with source times, server pipeline backlog line,
recent captures/packets with source photos, entities, and memory search with source-image cites and
“Possible match — identity unconfirmed” candidate labels.

Added:

- **Agent section** (top of the right column): one status line (`GET /api/agent/status` every 2.5 s + live-stream
  state + count of duplicate deliveries ignored), an input + Send (`POST /api/agent/ask`; `sessionId` attached only
  while a Run is running, otherwise omitted so manual send works with the camera stopped), answers/notifications
  (initial `GET /api/agent/notifications`, then SSE `GET /api/agent/events` event `notification`; ids are deduped
  across GET, stream and every reconnect; `Ack` posts `/api/agent/notifications/:id/ack` and flips the row only
  after `{acked:true}`), and a Tasks list (`GET /api/agent/tasks` every 2.5 s; `Cancel` on non-terminal tasks
  posts `/api/agent/tasks/:id/cancel`). Refs render as links only for same-origin paths (`/v1/artifacts/:id`,
  `{artifactId}`, `{type:'artifact',id}`, `{captureId}` → `/api/frames/:id`); anything else is plain text.
- **Search mode selector**: `keyword` (default) or `semantic`; `POST /api/search` body gains `mode`, other args
  unchanged. Per-row score shows `distance` only in semantic mode, `keyword match` otherwise.
- **Agent capture interrupts** (status row “Agent capture”): while a Run is running the page polls
  `GET /api/agent/commands?sessionId=<run session>` every 400 ms with exactly one request in flight (this is the
  camera heartbeat). A `capture` command is claimed (`POST …/claim {sessionId}`); only `claimed:true` for the same
  still-active Run leads to `Run.captureNow(commandId)`, which takes one full photo through the SAME path as a 5 s
  tick (same canvas draw, same 640 px face derivative, same face slot, same once-only submission) with
  `requestId` in the `POST /api/captures` body. `POST …/result {sessionId, captureId}` is sent only after the
  capture got HTTP 202; the row then says “captured for agent … accepted by server, interpretation pending”. Errors
  are reported with `{sessionId, error}`. Expired commands (`expiresAt <= now`) are never claimed; a repeated
  command id is handled once; Stop aborts polling and drops any late claim/capture result. Regular ticks stay
  anchored (never shifted); sequence numbers come from one strictly increasing allocator shared by ticks,
  interrupts and the Stop snapshot (so `sequence` no longer equals the tick index).
- **PWA**: `public/manifest.webmanifest`, `public/icons/icon.svg`, `public/sw.js` (network-first shell for
  `/`, `/index.html`, `/styles.css`, `/client.js`, manifest, icon; `/api/*`, `/ws/*`, `/v1/*`, `/static/*` are never
  intercepted or cached; no push handler). The header note says API/media are never cached and that phone push /
  hardware are not verified. No token or key input exists in the page.

## Changed paths

New: `memory/client/src/agentCommands.ts`, `memory/client/src/agentFeed.ts`, `memory/client/src/searchMode.ts`,
`memory/client/src/sequence.ts`, `memory/client/test/agentCommands.test.ts`, `memory/client/test/agentFeed.test.ts`,
`memory/client/test/searchMode.test.ts`, `memory/client/test/runInterrupt.test.ts`, `memory/client/qa/mockServer.mjs`,
`memory/client/qa/browserQa.mjs`, `memory/public/manifest.webmanifest`, `memory/public/sw.js`,
`memory/public/icons/icon.svg`, `docs/MERGED_UI_VALIDATION.md`.
Modified: `memory/client/src/session.ts` (`captureNow`, `SequenceAllocator`, `CommandPoller` wiring, `requestId` in
bodies, `interrupt` in the snapshot, `mediaDeps` test seam), `memory/client/src/main.ts`, `memory/client/src/api.ts`
(`agentApi`, `mode`), `memory/client/src/types.ts` (`requestId?`), `memory/client/README.md`, `memory/public/index.html`,
`memory/public/styles.css`; `memory/public/client.js` rebuilt (gitignored).

## Commit state (important)

Commit `005d14a` (“Integrate scene memory with the ambient agent harness”, 03:53:38, author willzeng274) was created
by the other thread while this work was in progress and swept the then-current `memory/` tree into git, including
most files above (`agentCommands.ts`, `agentFeed.ts`, `sw.js`, `session.ts` with `captureNow`, …). This pass did not
commit anything. Still uncommitted after that commit: the final `main.ts` tweak (idle text of the “Agent capture”
row), `memory/client/README.md`, `memory/client/qa/` and this document.

## Verification run (exact results)

Run from `memory/`:

| Check | Command | Result |
|---|---|---|
| Client typecheck (strict DOM) | `npm run check:client` | clean |
| Client bundle | `npm run build:client` | `public/client.js` 144 kB, ok |
| Client Node tests | `node_modules/.bin/tsx --test --test-timeout=20000 client/test/*.test.ts` | 84 pass, 0 fail (60 pre-existing + 15 from the first pass + 9 from the follow-ups below) |
| Headless browser QA (mock server, random port) | `node client/qa/browserQa.mjs` | 27/27 checks pass (re-run after the follow-up); screenshots `/tmp/kawk-merged-ui-qa/{desktop,mobile}.png` |

Scenario coverage requested → test:

- Interrupt between periodic ticks, unique sequence, ticks not shifted → `agentCommands.test.ts` (poller + anchored
  ticker + allocator: `[tick0 seq0 @0, interrupt seq1 @2400, tick1 seq2 @5000]`) and `runInterrupt.test.ts`
  (real `Run` with fake camera/face socket/fetch: interrupt body has `requestId`, `sequence 1`, `capturedAt` = draw
  time, face evidence bound to that photo id with the confirmed name; tick 1 still at anchor+5000; Stop snapshot
  continues the sequence at 3).
- Stale command / restart → `agentCommands.test.ts` (Stop while claiming: no capture, no result; late capture result
  dropped; a new session poller starts clean) and `runInterrupt.test.ts` (`captureNow` rejects with “run is
  idle/stopping/stopped”).
- Duplicate request → poller claims/captures once for a repeated command id; `Run.captureNow` returns the same
  promise for a repeated `requestId` (no second photo).
- Rejection / unavailable → HTTP 404 on the commands endpoint shows “unavailable”, backs off (400→800→1600 … ≤5 s),
  stays at one request in flight, recovers; `claimed:false` never captures; claim HTTP error and capture failure are
  reported (`{sessionId,error}`) and visible; server HTTP 400 on the capture rejects `captureNow` and is not retried.
- Search mode → `searchMode.test.ts` (keyword default, semantic explicit, invalid dates/limits omitted, clamp 50) and
  browser QA (bodies `{query:'keys',mode:'keyword',limit:10}` then `mode:'semantic'`; candidate label and source
  image cite preserved).
- Notification reconnect → `agentFeed.test.ts` (GET + SSE + replay after a closed stream: n1/n2/n3 rendered once,
  duplicates counted, late events from the dead stream ignored, browser-side retries do not open a second stream) and
  browser QA (server drops the SSE stream; after reconnect 3 distinct rows, `sseConnections=2`).
- PWA → browser QA: manifest served as `application/manifest+json`, service worker active, under SW control an
  `/api/agent/status` fetch still reaches the mock (log count increases), cache contains only the six shell paths.

## Follow-up (2026-09-20, ≈04:20–04:45): live face forwarding, terminal task states, evidence refs

Uncommitted on top of `005d14a`, to go out with the next push. Files: `memory/client/src/liveFaces.ts` (new),
`memory/client/test/liveFaces.test.ts` (new), `memory/client/src/session.ts`, `main.ts`, `api.ts`, `agentFeed.ts`,
`memory/client/test/agentFeed.test.ts`, `memory/client/qa/{mockServer,browserQa}.mjs`, `memory/client/README.md`,
`memory/public/client.js` (rebuilt, gitignored), this file.

**Live face forwarding** (`POST /api/agent/faces {sessionId, evidence}`; status row “Agent faces”). The regular
~5 fps face results (the same `FaceEvidence` objects that draw the overlay) are forwarded by `LiveFaceForwarder`,
one per Run, independent of the 5 s photos and of the memory writer:
- identity key = sorted confirmed gallery UUIDs (+ `unknown` flag), or `unknown` (unconfirmed faces only), or
  `none` (no face). A change is forwarded once the same key is seen on two consecutive results (a single-frame
  blip is counted, not sent); disappearance and unknown transitions are changes too.
- unchanged identity → heartbeat at most once every 3000 ms (`HEARTBEAT_MS`).
- exactly one POST in flight; while it is out only the newest candidate is kept (a pending change of the same key
  is not displaced by a heartbeat); a pending candidate older than 4000 ms (`MAX_AGE_MS`, server rejects > 5 s)
  is dropped, never sent. Evidence goes out unchanged (original `frameId`, `streamId`, `capturedAt`).
- failure (HTTP error, timeout 4 s, or `accepted:false`) is visible (`lastError`, `failed` count, red row); the
  failed body is never replayed. The same identity is retried only with fresh evidence after a growing delay
  (1 s, 2 s, 4 s … ≤ 15 s per consecutive failure, `retryNotBefore` in the state); a genuinely new stable identity
  gets one immediate try, after which it waits too (so alternating identities cannot bypass the backoff). After 3
  consecutive failures the heartbeat also backs off ×2 per failure (≤ 15 s). A success restores normal cadence.
- Stop ends forwarding before the cadence stops; an in-flight reply arriving later is ignored; offers after Stop
  are dropped; a stopped forwarder cannot restart, and a new Run gets a fresh forwarder bound to its own session.
  People delete/reset (`Run.resetFaces`) forgets the known key and bumps a generation: the physical in-flight
  request still bounds concurrency until it settles, but its reply can no longer acknowledge the forgotten
  identity, and only a current-generation candidate may drain afterwards.
- pending is latest-only in the strict sense: while a POST is out, a newer stable set replaces the pending
  candidate, and a return to the in-flight or acknowledged set drops it (the older set is never sent). Stable
  repeats of the in-flight change are not queued as a duplicate.
- Overlays and captures are untouched: the forwarder only observes `onRegularResult`.

**Tasks**: `isActiveTask` now also treats `abstained` and `superseded` (any case) as terminal, so Jev-gated
endings show no Cancel button.

**Refs**: bridge evidence refs `{eventId, revision}` render as plain text (“evidence event <id> r<n>”); artifact
refs become links only when the id matches the bridge's proxy pattern `^[0-9a-f-]+$` (`/v1/artifacts/<id>`),
otherwise plain text. No link is invented for anything without a valid same-origin path.

Exact extra tests (all with synthetic `FaceEvidence`; no camera, InsightFace, Whisper or agent process involved):

| File | Test |
|---|---|
| `liveFaces.test.ts` | identity keys: confirmed ids sorted, unknown flag, none, unavailable |
| `liveFaces.test.ts` | stable-ID transitions: first stable set is sent once, a single-frame blip is not, disappearance and unknown are sent with the original evidence |
| `liveFaces.test.ts` | heartbeat: an unchanged identity set is re-sent at most once every 3 s, independent of the 5 s photos (posts at 200, 3200, 6200 ms) |
| `liveFaces.test.ts` | one POST in flight; pending is latest-only; a stale pending candidate is dropped instead of sent |
| `liveFaces.test.ts` | Stop: nothing is sent afterwards and an in-flight reply is ignored; a new session forwarder starts clean |
| `liveFaces.test.ts` | errors: visible, never replayed; the same identity retries with fresh evidence after a growing delay (posts at 200, 1200, 3200, 7200 ms, then heartbeat at 10200); recovery sends the evidence of that moment; heartbeat 3000 → 6000 ms after 3 failures, restored on success; `accepted:false` counts as failure |
| `liveFaces.test.ts` | a new stable identity gets one immediate try while a failed identity is backing off; both then wait (review fix 3) |
| `liveFaces.test.ts` | reset while a request is in flight: the old reply cannot acknowledge the forgotten identity; the one-POST bound holds; only a current-generation candidate drains (review fix 1) |
| `liveFaces.test.ts` | pending tracks the latest stable result: a return to the in-flight or acknowledged set drops the pending candidate; in-flight change is not duplicated (review fix 2) |
| `agentFeed.test.ts` (extended) | `abstained` / `superseded` / `Superseded` are not active; `{eventId, revision}` → text; artifact ids `a b`, `ABC` → text, `3f2a-0b`, `e1` → proxy links |

Results after the follow-up: `npm run check:client` clean; 81/81 client tests pass; `npm run build:client` ok;
browser QA re-run 27/27 (the mock now sends an `{eventId}` ref and a lowercase artifact id).

**Review fixes (≈04:50–05:05, `liveFaces.ts` only, state machine unchanged elsewhere):** (1) `reset()` now uses a
generation marker — an in-flight reply from a forgotten generation is counted (`staleReplies`) and ignored for
acknowledgement while the one-POST bound is kept until the physical request settles; (2) latest-only pending
truly tracks the latest stable result, including a return to the in-flight/acknowledged key (older pending
dropped, `superseded` counted); (3) bounded per-identity retry backoff with fresh evidence only (`failedKeys` +
`retryNotBefore`), one immediate try for a genuinely new identity. Results: `npm run check:client` clean; 84/84
client tests pass (3 regression tests added, the error test rewritten to assert current evidence rather than
replay); `npm run build:client` ok. Browser QA was not re-run for these pure state-machine changes (no layout or
mock contract change). The Run-level
wiring (`Run` → forwarder → `agentApi.faces`) is exercised only by typecheck and by reading `session.ts`; no
live regular face results were produced in tests (the ~5 fps loop needs real timers and a camera). Live verification
against the running 8082/8091 services was deliberately not performed from this pass (no production people or
recordings were to be touched); Codex's full-bridge run is where the first real `POST /api/agent/faces` will show.

## Backend contract alignment (read-only inspection of `memory/src/agent-bridge.ts`, Codex-owned)

Routes exist for status, ask, commands, claim, result, and proxy `/api/agent/events|notifications|tasks` and
`/v1/artifacts/:id` to the Bun agent. `CaptureInputSchema` accepts `requestId`. Client behaviour matches the
server's rules: claim before capture, `requestId` only on claimed commands, result only after HTTP 202. Two
consequences to know: the server answers HTTP 404 “Unknown session” to command polls for a session it does not know
(the row shows “unavailable” with that message), and answers 409 to a `result` whose capture it has not yet marked
accepted — the client then shows “captured … but the result report failed; the agent may retry” and does not retry
itself. The server's own default `mode` is `semantic`; the page always sends `mode` explicitly (keyword by default).

## Not verified / limits

- No live camera, Continuity Camera, microphone, InsightFace or Whisper run in this pass; camera paths are covered by
  Node tests with fake media and an in-memory face socket. Codex owns the combined backend + real-provider QA.
- No real agent bridge was exercised: browser QA used `client/qa/mockServer.mjs`. Real-provider answers, artifact
  bodies and the Bun agent's task states were not observed.
- Phone push, background delivery and physical devices are not verified; the service worker has no push handler.
  Service-worker registration was tested on `http://127.0.0.1` only (secure-context rule allows localhost).
- Interrupt capture shares the face slot with the 5 s photos: if the face model is slow the interrupt photo waits in
  the same bounded queue (max 2, ≤6 s) and can be submitted with `faces.status:'unavailable'`, exactly like a tick.
- Agent notifications older than the 100 most recent are dropped client-side; tasks list shows at most 20.
- The task `Cancel` button treats any status not in {done, completed, complete, succeeded, success, failed, error,
  cancelled, canceled, aborted, expired, rejected} as active; unknown statuses therefore show Cancel.
