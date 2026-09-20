# KAWK memory client (Live / Memory / Debug)

Browser page for `memory/` (port 8082): one document with three views. **Live** = Start/Stop, device + speech
selectors, preview, live transcript, the Now block, Updates from KAWK, device notifications and install status.
**Memory** = browse everything kept (`/api/memory/browse` + `/api/agent/memory/browse`), current state, People, indexed
search. **Debug** = manual agent form ("Manual operation"), component status rows, pipeline, recent captures/entities.
Switching views only toggles presentation (Live is kept painted off-stage, never `display:none`, so a running preview keeps
decoding); the Run and its sockets/timers live in module state. Source in `client/src`, pure-logic tests in `client/test`,
bundle in `public/client.js` (served with `public/index.html` and `public/styles.css`).

Commands (run from `memory/`):

```sh
node_modules/.bin/tsc -p client/tsconfig.json                     # strict DOM typecheck, no emit
node_modules/.bin/tsx --test client/test/*.test.ts                # Node tests (fake clock / fake WebSocket)
node_modules/.bin/esbuild client/src/main.ts --bundle --format=esm --target=es2022 \
  --platform=browser '--external:/static/*' --outfile=public/client.js
```

Module map: `cadence.ts` anchored 5 s ticker · `faceSlot.ts` single-outstanding face request + bounded
scheduled-photo queue · `faceBinding.ts` reply→FaceEvidence (stable_id only, geometry check) ·
`speechTiming.ts` sent-audio timeline (piecewise cloud-offset→source-time) · `revisions.ts` transcript
revision ledger · `submissions.ts` once-only capture POST with identical-body retries · `media.ts`
camera/mic/worklet · `faceLink.ts` / `speechLink.ts` sockets (face socket also carries the `introduction`
control plane) · `introductions.ts` final-only, once-per-segment, epoch-bound introduction forwarding +
reply parsing · `speechBackend.ts` local/baseten selection, honest labels, Live-transcript status line ·
`session.ts` one Run per Start (`start({speechBackend})`, `resetFaces()`, `captureNow(requestId)` agent interrupt photo
through the same draw/face/submission path) · `sequence.ts` one strictly increasing capture sequence shared by ticks,
interrupts and the Stop snapshot · `agentCommands.ts` CommandPoller (GET /api/agent/commands every 400 ms, one in
flight, claim → captureNow → result; Stop aborts) · `agentFeed.ts` notification ledger (id-deduped across GET/SSE/
reconnect), SSE wrapper, ref → same-origin link, task/status helpers · `liveFaces.ts` LiveFaceForwarder (regular ~5 fps face results → POST /api/agent/faces on
stable identity-set changes incl. unknown/no-face, ≤ 1-per-3 s heartbeat, one POST in flight, latest-only pending,
stale (> 4 s) dropped, no replay after failure, Stop ends it) · `searchMode.ts` keyword-default / semantic
search body · `people.ts` People ordering (enrolled first, then most recently seen; all rows rendered) +
person-specific Delete labels · `push.ts` Web Push (support classification incl. HTTPS/iOS-Home-Screen/denied
guidance, `PushController`: `prepare()` on load/Retry caches GET /api/agent/push/key + the ready registration, drops a
rotated-key subscription and re-syncs an existing one; `enable()` calls `pushManager.subscribe()` **synchronously from
the click** (Safari user-activation rule; the browser prompts there) then POSTs /api/agent/push/subscriptions with
rollback; Disable = unsubscribe + DELETE {endpoint}; test push; delivery counters; service-worker message parsing;
`?notification=` id) ·
`runControl.ts` `RunSwitcher` (exactly one Run per Start, a Start during a switch is ignored) + `singleFlight` polls ·
`views.ts` hash ↔ view + presentation (shown / offstage / hidden) · `memoryBrowse.ts` browse contract (URL builder for both
endpoints, lenient page parser, `BrowseController`: one generation per Apply with stale replies dropped, `all` fans out to
every kind with per-kind cursors/totals/errors, Load more / Retry, `describeStatus` honesty labels, `itemFacts` readable
details) · `install.ts` install status/steps (HTTPS, iOS Home Screen, Chromium prompt, Safari Add to Dock; never claims
push is verified) ·
`main.ts` DOM incl. the compact Agent section (status with last-event age, ask, answers + Ack + push marker/ack
reason, tasks + Cancel), the Notifications block (Enable/Disable/Send test push/Clear status), People list with
confirmed DELETE /api/people[/:id], the plain-language introduction line (`summarizeIntroduction`), backlog source
age in the Captures/Transcripts rows, visibility wake of the SSE stream, and service-worker registration.

`public/sw.js`: network-first shell only (never `/api/*`, `/ws/*`, `/v1/*`, `/static/*`, `/sw.js`) + `push`
(payload validation, EVERY push calls showNotification — WebKit rule — with one tag per id and `renotify:false` so a
repeat replaces the banner instead of alerting again; nothing is suppressed client-side; same-origin `url`; posts
`kawk-push {…, duplicate, displayed}` to open windows after the display settled) + `notificationclick` (focus an existing KAWK window and post `kawk-notification-open`
— no reload — else `openWindow('/?notification=<id>')`). The page never shows system notifications itself. Opening a
notification (click / `?notification=`) or a push displayed while the page is visible+focused acknowledges it;
SSE arrival never does.

Browser QA (isolated mock server on a random port with a synthetic browse fixture; Chromium fake media devices; needs
`../agent/node_modules/playwright`; the mock has no WebSocket server, so face/speech sockets report errors while photos still post):

```sh
node client/qa/browserQa.mjs        # 102 checks: navigation with a REAL Start on Chromium's fake camera/mic (captures keep
                                    # posting while Memory/Debug are shown), memory browser (paging past 40, literal/date/
                                    # category/entity-kind filters, history, stale replies, per-kind errors + Retry, empty,
                                    # drilldown, escaping), Debug manual form, agent feed, PWA icons, Web Push (fake
                                    # PushManager + CDP-injected push events into the real service worker; needs the full
                                    # Chromium channel for notification permission). Screenshots in /tmp/kawk-merged-ui-qa/
node client/qa/mockServer.mjs       # standalone mock of the memory+agent HTTP contract
node client/qa/liveReadOnly.mjs [url] # READ-ONLY check against a real server (default :8082): every non-GET request is aborted and
                                    # reported; loads Memory + Live, expands cards, screenshots live-backend-*.png. Never starts capture, acks or sends.
```
