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

## Web Push + reconnect/lifecycle pass (2026-09-20, ≈04:15–04:50)

Author: Claude Code, model `claude-fable-5-1`. Scope: `memory/client/**`, `memory/public/**`, this file. Nothing in
`memory/src`, `agent/src`, credentials, recordings, the gallery or running services was touched; nothing committed.
Codex is adding the same-origin proxy routes this page calls (`/api/agent/push/key|subscriptions|status|test`); until
they exist the page shows the proxy's 404/502 text in the push status line and never subscribes the browser.

### What changed

**Web Push (`push.ts`, `main.ts`, `index.html`, `sw.js`).** A “Notifications” block in the Agent section:
- Support is classified before anything happens: secure context (HTTPS or localhost), service worker, `PushManager`,
  `Notification`; on iPhone/iPad without `PushManager` the guidance says to Add to Home Screen first; a denied browser
  permission gets site-settings (or iOS Settings) guidance. The Enable button is disabled when push cannot work here.
- **Enable notifications** (a click, the only place permission is requested): `Notification.requestPermission()` →
  `GET /api/agent/push/key` → `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` (an existing
  subscription for a different key is dropped first, one for the same key is reused) → `POST
  /api/agent/push/subscriptions` with `subscription.toJSON()`. If the agent refuses, the browser subscription is rolled
  back so both sides stay consistent. A 503 from the key route reads “push is not configured on the agent”. No token
  is pasted anywhere; the routes are same-origin.
- **Disable notifications**: `subscription.unsubscribe()` then `DELETE /api/agent/push/subscriptions {endpoint}`;
  partial failures are stated (“agent may still list this device…” / “browser kept its subscription…”).
- **Send test push**: `POST /api/agent/push/test`; only the returned id is recorded (“nothing is assumed delivered”).
- **Delivery counters**: `GET /api/agent/push/status` every 5 s while subscribed and after a test, labelled
  `"sent" = accepted by the push service, not shown on a device`. **Clear status** resets text/errors only.
- Page load calls `refresh()` only: it reads the state and, if the browser already holds a subscription, re-posts it
  (idempotent upsert on the agent) so an agent restart does not silently lose the device. No prompt on load.
- `public/sw.js` now handles `push`: JSON payload validated (`id` string ≤200, `title` ≤120, `body` ≤2000, control
  characters stripped, `url` resolved and forced same-origin); one system notification per id (tag
  `kawk-notification:<id>`, `renotify:false`, plus an in-memory id set) — a re-push never shows a second banner;
  unreadable payloads show an honest generic banner (tag `…:unreadable`) instead of invented content; every open
  same-origin window gets a `kawk-push` message (`foreground` = some window visible+focused, `duplicate`).
  `notificationclick` closes the banner, then focuses an existing KAWK window and posts `kawk-notification-open` (no
  `navigate()`, so a running capture is not reloaded away); with no window it `openWindow`s `/?notification=<id>` on
  our origin only. `/sw.js` itself and all `/api/*`, `/ws/*`, `/v1/*`, `/static/*` remain uncached; cache version v2.
- **Acknowledgement policy**: the page never creates system notifications (no `new Notification`, no
  `showNotification` from the page), so a notification that arrives over SSE and by push renders once as a row with a
  `push HH:MM:SS` marker. Acks happen only on the Ack button, on opening a notification (click → message, or
  `?notification=<id>` on a fresh window, which is then stripped from the URL), and when the worker delivered a push
  while this page was visible **and** focused (the worker's judgement re-checked by the page). SSE arrival — hidden or
  visible — never acks. Acking closes the matching system banner via `getNotifications({tag})`.

**Reconnect / lifecycle fixes (`runControl.ts`, `agentFeed.ts`, `session.ts`, `submissions.ts`, `main.ts`).**
- Double Start race closed: previously a second click during `await current.stop(...)` created a parallel Run
  (second camera acquisition, second face/speech socket, second ticker). `RunSwitcher` owns exactly one Run; a Start
  during a switch is ignored (not queued); callbacks report only while `runs.owns(run)`. Start is disabled immediately.
- `pagehide` still stops the Run (camera/mic released); nothing restarts by itself on return — only a fresh Start.
- SSE stream: `wake()` on `visibilitychange → visible` reopens a stream the browser dropped while hidden (readyState
  CLOSED) immediately instead of waiting out the remaining backoff, cancelling the pending timer so no double
  reopen; a healthy stream is untouched; a stopped stream never reopens. The agent status line now shows `last event
  N s ago` and the reconnect reason. Visibility return also re-fetches notifications/status/tasks (ids dedupe).
- Polls are single-flight (`pollDashboard`, `pollAgentStatus`, `pollTasks`, `loadNotifications`): the 3 s / 2.5 s
  intervals with 5–8 s timeouts could stack requests on a slow bridge; overlapping calls now join the in-flight one.
- Backlog source age: the Captures row shows `backlog N photo(s), oldest source X old` (photos awaiting encode, face
  or HTTP, from `pending` + the submission ledger's new `capturedAt`), the Transcripts row shows the oldest queued
  revision's age; both turn amber past 15 s / 10 s. Reconnect states of the face/speech sockets were already
  explicit (`reconnecting (attempt n)`, bounded 6/5 attempts, new streamId per connection, explicit gaps) and are
  unchanged; the 5 s anchored cadence, immediate agent capture, Start/Stop and the device selectors are untouched.

### Tests added (Node, no browser/credentials; `client/test/`)

| File | Covers |
|---|---|
| `push.test.ts` (12) | support matrix + guidance (HTTPS, iOS not installed, denied, unsupported); VAPID key decode/compare; Enable happy path with 5 s delivery poll; denied/dismissed permission → no key/subscribe; 503 → not configured; agent refusal → browser rollback; browser subscribe failure visible; rotated key replaced / same key reused; `refresh()` reads only and re-syncs; disable paths incl. agent DELETE failure and browser refusal; test push + clearStatus; one operation at a time (three concurrent clicks → one permission prompt); no registration; `stop()`; worker-message and `?notification=` parsing |
| `sw.test.ts` (4) | the real `public/sw.js` in a `node:vm` sandbox: one banner per id, duplicate/foreground flags, foreign windows ignored, re-push after the user closed the banner blocked; payload validation (unreadable, no id, array, null, control chars, 2000-char bound, cross-origin and protocol-relative urls → root, non-string id); click → focus + message, hidden-only window focused, no window → `openWindow` same-origin with id, foreign `data.url` never navigated; fetch handler never intercepts `/api/*`, `/ws/*`, `/v1/*`, `/static/*`, `/sw.js`, foreign origins |
| `runControl.test.ts` (4) | double Start → one Run; Start during a slow previous Stop ignored (three clicks, one new Run); failing previous Stop does not block; `singleFlight` sharing/reset; ledger `oldestUnsettledCapturedAt`, queue `peek` |
| `agentFeed.test.ts` (+2) | `wake()` reopens a dropped stream immediately and cancels the backoff timer, ignores a healthy stream, recovers a CLOSED stream that never fired `onerror`, never reopens after `stop()`; push markers/ack reasons; last-event age text |

Results: `npm run check:client` clean · `npm run test:client` **106 pass, 0 fail** (84 before) · `npm run build:client`
`public/client.js` 180.5 kB · `npm run check` (memory server typecheck) clean.

### Browser QA (`node client/qa/browserQa.mjs`, isolated mock, random port) — **48/48**

Previous 27 checks unchanged and passing. New push/lifecycle checks, exact behaviour observed in headless Chromium
(**full `chromium` channel**; the Playwright headless *shell* reports `Notification.permission === 'denied'` regardless
of `grantPermissions`, which is why the driver prefers the full build and says so if it falls back):
- idle: `notifications: ready · permission granted · push not enabled on this device`, Enable enabled, **zero**
  `/api/agent/push/*` calls on load; guidance mentions the click and “No token is needed”.
- Enable (fake `PushManager` injected before page scripts — headless Chromium has no push service): order
  `GET key → POST subscriptions → GET status`; the mock agent holds 1 subscription with endpoint + `keys`; the
  subscribe call received the 65-byte `0x04…` key; Disable/Send test visible, counters `1 device(s)`.
- Send test push: one `POST /api/agent/push/test`; the test answer arrives as a row over SSE, **not** acked, no push
  marker (no push event happened); status says nothing is assumed delivered.
- CDP `ServiceWorker.deliverPushMessage` into the **real** registered worker: valid `{id:'n2',…}` → exactly one
  system notification (tag `kawk-notification:n2`, same-origin `data.url`); the page (visible, `hasFocus()` true)
  shows `push HH:MM:SS` and `acked (displayed in the foreground via push)` with one ack POST; the same id pushed
  again → still one banner and no second ack; `'this is not json'` → `…:unreadable` banner; `url:'https://evil…'` →
  `data.url` is our root; a push for an id never seen over SSE renders once; no duplicate rows; no `/api/*` in cache.
- `/?notification=n1` → row highlighted (`li.opened`), `acked (opened from notification)`, one ack POST, URL stripped;
  the reload re-synced the existing browser subscription (one extra `POST subscriptions`, no new `subscribe()`).
- Disable → `subscription.unsubscribe()` once, `DELETE {endpoint}`, mock has 0 subscriptions, Enable visible; Clear
  status resets the line.
- Context without permission grant: Enable → `permission denied`, denied guidance, **no** key/subscribe call.
- Mock with push disabled (503 on key): `error … push is not configured on the agent: … HTTP 503`, browser never
  subscribed, Enable still available.
- Screenshots `/tmp/kawk-merged-ui-qa/{desktop,mobile}.png`; no console/page errors.

### Still requires real devices / not proven here

- **Apple/iOS background delivery is not proven.** Nothing above sends through a push service: the browser
  subscription is a fake in QA, and the push events were injected by DevTools. Real checks need: the Codex proxy
  routes live; the page served over **HTTPS** (or the localhost origin on the Mac); on iPhone, KAWK **added to the Home
  Screen** and opened from there (Safari tab → guidance only, no `PushManager`); Enable pressed; **Send test push**;
  then observe (a) the system banner with the app closed/backgrounded, (b) `sent/failed` counters, (c) tapping the
  banner opens/focuses KAWK and the row shows `opened from notification`. Repeat with the app killed and after a
  device restart; iOS may throttle or revoke silent/unshown pushes — this worker always shows one banner per id.
- `notificationclick` focus/open behaviour ran only in the Node sandbox (CDP cannot click a banner); the message and
  `?notification=` paths it produces were exercised in the browser.
- The agent's real `/v1/push/*` payload shape and the `pending/sent/failed` semantics were taken from the request;
  the mock mirrors that contract, the real agent was not exercised from this pass.
- Foreground-ack relies on `WindowClient.focused` + `document.hasFocus()`; on desktop with the window unfocused the
  banner appears and nothing is acked (verified only in the sandbox via `focused:false`).
- Hidden-tab SSE eviction, bfcache and iOS app-switch behaviour of `pagehide`/`wake()` are covered by fake
  EventSource tests, not on a phone. Camera/mic/perception paths were not run (no Start in QA), as before.

## Final review fixes (2026-09-20, ≈04:50–05:10) — Safari activation, WebKit display rule, pipeline outcomes, how-to

Author: Claude Code, model `claude-fable-5-1`. Same scope (`memory/client/**`, `memory/public/**`, this file); nothing
committed, no backend/credential/recording/service changes, no live `:8082` runs (isolated mock QA only).

1. **Safari user-activation** (`push.ts`, `main.ts`, `index.html`). Apple requires `pushManager.subscribe()` inside
   the user gesture. The controller now has `prepare()` (page load and a **Retry push setup** button): fetches and
   caches the agent key, awaits the ready registration, drops a subscription made for a rotated key, re-syncs an
   existing one (idempotent upsert). The Enable button is enabled only when `prepared` is true. `enable()` calls
   `subscribe({userVisibleOnly, applicationServerKey: cachedKey})` **synchronously before its first await**; the
   browser prompts for permission inside that call (no separate `requestPermission()`); `NotAllowedError` with
   permission `denied` → denied state + settings guidance, dismissed prompt → “not granted; press Enable again”. The
   agent POST happens afterwards, rolled back on refusal. Setup failures (503 “not configured”, key unavailable, no
   registration) are visible with Enable disabled and Retry offered. No token/manual input anywhere.
   Tests: `push.test.ts` “subscribe() is invoked SYNCHRONOUSLY from the click … before any await” asserts the fake
   PushManager's synchronous marker is set before `enable()` returns and that no network call preceded it; browser QA
   clicks Enable inside `page.evaluate` and reads a counter the fake increments synchronously (`calledDuringClick: 1`).
2. **WebKit display rule** (`sw.js`). Every push now calls `showNotification`; a repeated id uses the **same tag with
   `renotify:false`**, so the banner is replaced without a new notification identity or alert — no silent return, no
   client-side suppression. The id is remembered only after a successful display (informational `duplicate` flag for
   the page); a rejected `showNotification` is not remembered, is reported to windows as `displayed:false`, and is
   rethrown to `waitUntil`. Windows are messaged **after** the display settles, so the page's reaction can no longer
   race the banner (this was a real ordering bug: the foreground ack used to close a banner that had not appeared yet).
   The foreground-display ack no longer closes the banner at all; only Ack/open do. Same-origin click focus and the
   no-cache rules are unchanged. Tests: `sw.test.ts` — repeat id → `showNotification` called again, one banner, updated
   body, `renotify:false`, page told `duplicate:true`; closed banner + re-push → shown again; rejected display → not
   marked, `displayed:false`, next push shows as a first display; browser QA “same id pushed again → … still one
   notification, no second ack” against the real worker.
3. **Pipeline outcomes** (`api.ts`, `main.ts`, `styles.css`). The existing Server pipeline line now leads with
   `failed N (old failures persist until repaired; raw photos/transcripts stay saved) · committed N · accepted N ·
   derived memory source X old` (from `/api/dashboard` `pipeline.failed/committed/accepted/latestMemoryAgeMs`, plus
   `oldest waiting` from `oldestPendingMs`), turns red when `failed > 0`; “no derived memory yet” when
   `latestMemoryAgeMs` is null. A shrinking queue alone no longer reads as success. No new dashboard.
   QA: mock reports failed 2 / committed 40 / accepted 43 / 95 s → text and red class asserted.
4. **How-to** (`index.html`). One visible line under the controls: Start = camera + microphone (photo every 5 s,
   live speech) until Stop; Agent box = questions/instructions; Memory search = stored history; nothing records until
   Start. The long “what happens when” paragraph moved into a collapsed Details. Push wording: `"sent" = accepted by
   the push service, not proof the OS displayed it; background receipt needs a real iPhone test`.

Results: `npm run check:client` clean · `npm run test:client` **107 pass, 0 fail** · `npm run build:client` 182.8 kB ·
browser QA **52/52** (screenshots refreshed in `/tmp/kawk-merged-ui-qa/`).

Remaining limitations: unchanged from the previous section — real Safari/iOS activation, OS/Apple background receipt,
banner taps and the live agent `/v1/push/*` routes are not exercised here; the synchronous-subscribe rule is proven
against a fake PushManager in Chromium and in Node, not in Safari itself.
