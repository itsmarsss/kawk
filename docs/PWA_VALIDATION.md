# KAWK testing page validation

UI author: Claude Code Fable 5.1 (`claude-fable-5-1`). Scope: `agent/web/**` and this file only.
No backend modules, package files or tests were edited; no provider keys or `.env` were read;
Baseten was not called; ports 8091/8082 were not touched. Nothing was committed or deployed.

## Current flow (2026-09-20, token-free plain page)

The page at `/` is a plain single-column testing page. There is no token input, login form or
Disconnect button.

1. On load the page POSTs `/v1/client/session` with body `{}`, `credentials: same-origin` and
   **no Authorization header** (the browser sends `Origin`). The agent sets an HttpOnly cookie
   for the local page. Scripts can still use the bearer API.
2. On success the header shows **Connected**; the page syncs the clock, polls
   `/v1/status`, `/v1/capture/status`, `/v1/tasks`, `/v1/reminders`, `/v1/notifications`,
   `/v1/people` every 5 s and opens the `/v1/notifications/stream` EventSource.
3. If bootstrap fails (agent down, 5xx, network error) the header shows
   **Agent unavailable — retrying… (reason)** plus a **Retry** button, Send is disabled, and the
   page retries every 2 s. Exactly one bootstrap is in flight at a time.
4. If a request later gets **401** (stale cookie after a runtime restart) the page runs one new
   bootstrap and continues. 401s from requests started before the latest successful bootstrap are
   ignored; a 401 within 2 s of a fresh bootstrap backs off to the 2 s retry instead of looping.
   `/v1/status` answering 5xx or failing at the network level, or the SSE stream closing, also
   routes through the same single bootstrap path.
5. Camera, microphone and push are never started automatically.

Layout, top to bottom: `KAWK` + connection state · text box + **Send** (+ sent log) ·
**Notifications** with Acknowledge buttons and push enable/disable · collapsed **Capture**
(camera preview/start/stop, microphone start/stop/level, live transcript) · collapsed **Details**
(runtime diagnostics, pending reminders, tasks, people). Normal system font, plain borders, no
cards, shadows, chips or marketing text. Status words keep the `pill` class name for test
selectors but render as plain colored text.

Everything else is unchanged from the earlier review pass: clock sync with measured uncertainty,
manual utterance `uncertaintyMs = clock uncertainty + 50` (5000 ms when unsynced), camera JPEG
≤ 640 px at ~2 fps with one upload in flight, microphone start → ready → audio-start → PCM with
backpressure ending the session, readable task results, SSE-triggered reminder/task refresh,
global `[hidden]` rule. The service-worker cache version was bumped to `kawk-shell-v2` so open
tabs pick up the new shell; `/v1/*` is never intercepted or cached.

## Files

| File | Purpose |
|---|---|
| `agent/web/index.html`, `styles.css` | Plain page and stylesheet (light/dark via `color-scheme`). |
| `agent/web/app.ts` → `app.js` | Client. Build from `agent/`: `bun build web/app.ts --outfile web/app.js --target browser --format esm`; typecheck: `node_modules/.bin/tsc -p web/tsconfig.json`. |
| `agent/web/audio-worklet.js`, `resampler.js` | AudioWorklet PCM16 mono 16 kHz chunker (own prototype pattern, no PSI code). |
| `agent/web/sw.js` | Offline shell (`kawk-shell-v2`) + Web Push display; never touches `/v1/*`. |
| `agent/web/manifest.webmanifest`, `icons/*.svg` | Installable manifest, own icons. |
| `agent/web/validation/mock-server.ts` | Test-only mock API on a random 127.0.0.1 port. Cookie-only session when `Origin` matches and no Authorization header; bearer still accepted. `/__test/*` control plane: `notify`, `revoke` (drop all sessions), `availability` (503 for all `/v1/*`), `audio-mode`, `reset`, `state`. |
| `agent/web/validation/probe.ts` | The Playwright check suite (the old login-based `run.ts` was removed). |
| `agent/web/README.md` | Build notes. |

## Exact checks (`bun web/validation/probe.ts` from `agent/`)

Headless Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`;
mock server on a random port (the script aborts if the OS hands out 8082 or 8091).

Auto-connect and page shape (desktop 1280×900):
- Page reaches **Connected** on load with no token input.
- No `#token-input`, `#login-form`, `#login-panel`, `#logout-btn` or password input exists; body
  text never contains "client token" or "paste".
- Mock recorded exactly one session request, authorized, without a bearer header; cookie is
  HttpOnly.
- Camera and mic pills read `off`, `Notification.permission` is not `granted`, no frames or audio
  sessions were sent.
- Retry button and offline pill have computed `display: none`.
- Capture and Details `<details>` start closed; body height with them closed is 467 px.

Manual send and notifications:
- Send posts a contract-shaped final transcript (`deviceId pwa`, `streamId manual`,
  `provenance pwa-manual`, `confidence 1`, `revision 0`, `timing.method capture`,
  `uncertaintyMs = ceil(clock uncertainty + 50)` = 51 ms, `sourceStart` = corrected epoch);
  the sent log escapes HTML.
- SSE notification renders via `textContent` (injected `<img onerror>` stays text); reminders
  and tasks refresh 450 ms after the event (poll interval 5000 ms); nothing auto-acks; the
  Acknowledge button posts `/v1/notifications/{id}/ack` and removes the item.
- Task results: finish-JSON text + "(not delivered as a notification)", `Failed: …`, plain text
  verbatim; no raw JSON in the list.

Reconnect and unavailability:
- **Revoked session** (`/__test/revoke`, simulating a runtime restart): next 401 → exactly one
  new bootstrap → Connected, with no "unavailable" flash; bootstrap count stays at 2 for the
  following 2.5 s (no loop); Send and SSE work afterwards.
- **Agent goes down while connected** (`availability:false`): header shows
  "Agent unavailable — retrying…", Retry visible, Send disabled; 2 bootstrap attempts in 4.5 s;
  back to Connected within one interval after `availability:true`.
- **Unavailable at first load**: page renders with the retrying state and no token prompt;
  recovers to Connected automatically once the agent is up.

Capture (review fix 1 and normal path):
- Forced `WebSocket.bufferedAmount = 1 MB`: mic shows a backpressure error, `audio-start` was
  sent but 0 PCM packets, session closed, AudioContext closed, 0 live tracks, Start re-enabled.
- Fake camera: ≥ 3 JPEG frames 640×360, none rejected by the mock's contract validation.
- Fake mic: no binary before `ready` or before `audio-start`, 1024-byte even packets, final
  transcript replaces the partial; Stop releases camera tracks, mic tracks, AudioContext and
  socket, and no frames arrive after Stop.

PWA sanity and mobile:
- Manifest name KAWK, `standalone`, `start_url /`, both icons served.
- Service worker `activated`; cache name `kawk-shell-v2` only (v1 removed); cached paths are
  shell assets only, none under `/v1/`.
- Mobile 390×844 (DPR 2, touch): auto-connected, notification shown, no horizontal overflow.
- Zero page errors across all contexts.

## Results, 2026-09-20

- `tsc` strict: clean. `bun build`: `app.js` rebuilt.
- `probe.ts`: **33/33 passed.** Results in `agent/data/pwa-validation/plain-probe-results.json`.
- Screenshots (`agent/data/pwa-validation/`): `plain-desktop.png` (connected, collapsed),
  `plain-desktop-details.png` (Details open), `plain-desktop-unavailable.png` (retrying state),
  `plain-desktop-capture.png` (camera + mic streaming), `plain-mobile.png`. Earlier
  `review-*`, `desktop-*`, `mobile-*` and Codex's `integrated-*` screenshots predate this page.

## Gaps

- Claude's checks above used the mock API. Codex subsequently verified the real local
  backend: fresh token-free connection, exactly one automatic renewal after invalidation,
  recovery after two injected bootstrap 503s, live SSE, and a real LLM reminder through
  the simplified page. See [integration evidence and limits](AMBIENT_INTEGRATION.md).
- Web Push end to end is not exercised (mock returns 503 for `/v1/push/key`; headless Chromium
  has no push service and blocks notifications).
- Real camera/microphone hardware, phone HTTPS and Baseten transcripts remain unverified here;
  fake devices and mocked transcript frames only.
