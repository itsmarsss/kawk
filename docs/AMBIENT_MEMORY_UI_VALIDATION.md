# Ambient memory UI validation (Live / Memory / Debug shell)

Date: 2026-09-20. Author: Claude Code, model `claude-fable-5-1` (UI author per AGENTS.md).
Scope owned by this pass: `memory/client/**`, `memory/public/**`, this file. Nothing in `memory/src`, `agent/src`,
backend tests, secrets or the running services was edited, committed, pushed or restarted. The parent thread owns the
backend `browse` endpoints and general docs. First pass: built against the contract and QA'd on an isolated mock.
**Final review pass (same day):** the backend endpoints were live at `:8082`; the fixes below were applied and the page
was read against the real store with every non-GET request blocked (see “Live backend read-only check”).

## Final review pass: fixes applied

1. **Push auto-acknowledgement requires the Live view and a displayed banner.** `main.ts` now acknowledges a push only
   when the worker reports `displayed:true`, judged the window visible+focused, the page re-checks visibility/focus, and
   the selected view is Live. While Memory or Debug is shown the Live row is off-stage (unseen): the row gets its push
   marker but stays unacknowledged, and switching to Live later does not acknowledge it retroactively. A failed display
   (`displayed:false`) is never acknowledged and is listed under Debug → Errors (page-level errors are now counted there
   even when no Run exists; previously the summary stayed at 0 until a Start). A notification click (worker open message
   or `?notification=`) switches to Live, highlights the row, acknowledges it and never reloads (capture preserved).
   The first pass's browser assertion “foreground push in Memory is acknowledged” was reversed.
2. **Help text.** Live now says the three timestamped streams (photos every 5 s, speech, face identities) are saved
   continuously, that KAWK decides on its own when assistance is useful, and that updates arrive automatically. No
   “worth remembering” gating. Manual Send remains Debug-only (“Manual operation”).
3. **Task results.** `taskResultView()` parses the live bridge's JSON-encoded result strings (`{"text","refs",
   "confidence","notify","reviewRejected"}`) and structured objects: Live shows the answer text only (240-char cap);
   refs/confidence/review flags stay in a closed “Result details (diagnostic…)” expansion; an empty text (abstained)
   shows “no answer text in the result”, never invented content. The Tasks list is collapsed by default so completed
   work does not dominate Live. Regression: `agentFeed.test.ts` (encoded, abstained, non-JSON string, object without
   text) and a browser check on the mock's encoded `t0` result.
4. **Honest failure wording.** The Now block says `N failed (retained; retry needed)`; nothing implies an automatic retry.
5. **Readable source details.** Card text longer than 400 characters is shown as a labelled preview with an ellipsis
   (“preview of N characters · full text under Evidence & details”); the details start with “Full text (N characters)”
   followed by “Details from the record”; data values longer than 600 characters are marked “(truncated: N characters;
   full value in raw data)”. Raw JSON stays behind a closed toggle.

## What changed (user correction applied)

The page is no longer a single debug panel. It is one document with three views and a sticky header
(`Live · Memory · Debug` + a recording badge visible from every view):

- **Live** (landing view, wearer-facing): Start/Stop, camera / microphone / speech selectors, Refresh devices, preview
  with face boxes, introductions line, live transcript, a **Now** block (recording, camera + live faces, microphone,
  speech backend, photos taken/uploading/failed with oldest source age, memory pipeline age/backlog/failed, agent
  connection, last update age), **Updates from KAWK** (the automatic agent notifications + Ack, tasks + Cancel),
  **Notifications on this device** (unchanged push controls) and **Install as an app** (status + steps). The how-to now
  says: just talk and look around, no wake word, nothing to send, KAWK decides on its own and posts updates here.
- **Memory**: browse everything kept. Category chips `All · Observations · Photos · Speech · Entities · State · Agent
  facts · Reminders` (with server totals), literal text filter, from/to (`datetime-local` → epoch ms), “include
  superseded & revisions” (`history=true`), entity-kind selector (entities only), Apply / Reset / Refresh, Load more,
  Retry failed categories. Cards show kind tag, title, server status (tone only, text unchanged), text, `source time …`
  (or `recorded …` for agent facts/reminders) with age, photo/entity ids; Photos carry a lazily loaded thumbnail; every
  card has a closed “Evidence & details” (labelled facts from `data`, lazy source photo, `Load interpreted packet` via
  `/api/packets/:id(+/history)`, `Load entity history` via `/api/entities/:id`, and raw JSON behind a second closed
  toggle). Superseded items are struck through and only appear with history on. Current state, People & recognition
  (Delete/Reset unchanged) and the indexed keyword/semantic search live here too.
- **Debug**: “Manual operation” (the old Agent form + note, labelled debug-only), config line, component status rows,
  errors, capture submissions, server pipeline, recent 12 captures / recent 30 entities from the dashboard poll (kept
  as diagnostics, no longer the only way to browse), link to the lab's enrolled faces.

Navigation writes `#live|#memory|#debug` with `replaceState`, honours the hash on load, and only toggles presentation.
Live is kept painted off-stage (1 px, opacity 0, `inert`) instead of `display:none` so the video keeps decoding.
Opening a notification (`?notification=` / worker click) switches to Live. Memory loads on first open only (GET).

Contract used (as specified by the parent): `GET /api/memory/browse?kind=observations|captures|transcripts|entities|state`
and `GET /api/agent/memory/browse?kind=facts|reminders`, both with `query`, `from`, `to`, `limit≤40`, `cursor`,
`history`, `entityKind` (entities only) → `{kind, items:[{id,kind,at,title,text,status,captureId,entityId,data}],
nextCursor, total}`. Unreadable items are dropped and counted; a wrong page shape is a per-category error.

PWA: manifest now lists PNG icons (192, 512, maskable 512) plus the SVG; `apple-touch-icon.png` (180) and
Apple web-app meta tags added; icons rendered from the existing vector with headless Chromium. `sw.js` shell version
`v3` caches the icons, uses the PNG for notification icon/badge; push rules unchanged (every push →
`showNotification`, same tag + `renotify:false`, same-origin `url`, never caches `/api/*`, `/ws/*`, `/v1/*`,
`/static/*`). Install block states honestly: HTTP off-machine is not installable (HTTPS `:8443`), iOS needs Share → Add
to Home Screen and iOS 16.4+, Chromium shows an Install button only when `beforeinstallprompt` fired, and installing is
not proof of background push.

## Files

New: `memory/client/src/memoryBrowse.ts`, `views.ts`, `install.ts`; tests `client/test/memoryBrowse.test.ts`,
`views.test.ts`, `install.test.ts`; `memory/public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png`.
Modified: `memory/client/src/main.ts` (views, badge, Now block, browser rendering, install), `api.ts` (`api.browse`,
20 s timeout), `memory/public/index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `memory/client/qa/mockServer.mjs`
(browse fixture: 96 observations incl. an HTML-escaping item, 60 photos, 100 transcript revisions, 5 entities + one
hidden person, 12 state versions, 45 facts, 3 reminders; entity/packet routes; failure/delay injection; worklet served
read-only from the lab), `browserQa.mjs`, `memory/client/README.md`. `memory/public/client.js` rebuilt (gitignored).

## Verification (exact results, run from `memory/`)

| Check | Command | Result |
|---|---|---|
| Client typecheck | `npm run check:client` | clean |
| Client Node tests | `tsx --test --test-timeout=20000 client/test/*.test.ts` | **123 pass, 0 fail** (107 existing + 16 new; the review pass added assertions to `agentFeed` and `memoryBrowse` tests) |
| Server typecheck (unchanged sources) | `npm run check` | clean |
| Bundle | `npm run build:client` | `public/client.js` 218.5 kB |
| Browser QA (mock, random port) | `node client/qa/browserQa.mjs` | **102/102 pass** (95 first pass + 7 review checks); screenshots `/tmp/kawk-merged-ui-qa/{desktop,mobile}-{live,memory,debug}.png`, `live-after-run.png` |
| Live backend, read-only | `node client/qa/liveReadOnly.mjs http://localhost:8082` | pass: **0 writes attempted** (all non-GET aborted + reported), 0 page errors; screenshots `live-backend-{memory,live}.png` |

Review-pass browser checks (all on the isolated mock; push events injected into the real service worker via CDP,
worker→page messages for the failed-display and click cases dispatched synthetically because CDP cannot make
`showNotification` fail):

- push while **Memory** shown → banner shown, row marked `push hh:mm:ss`, **not** acknowledged; switching to Live
  afterwards still not acknowledged; the same id pushed while **Live** is shown+focused → acknowledged “displayed in the
  foreground via push”; a repeat → same tag replaced, no second ack.
- push while **Debug** shown → marked, not acknowledged.
- `displayed:false` while Live focused → row shown, never acknowledged, Debug → Errors goes 0 → 1 with the id.
- worker open message while Memory shown → Live selected, row `.opened`, acknowledged “opened from notification click”,
  page marker intact (no reload); `?notification=n1#memory` → same via URL.
- encoded task result → Live shows “Two meetings, coffee with Sam.” only; `confidence 0.92` / `evt-7` only inside the
  closed diagnostic `<pre>`; Tasks details closed by default.
- long text (1 392 chars) → 401-char preview ending in “…”, preview label, “Full text (1392 characters)” in details,
  700-char data value marked truncated.
- how-to wording and “retained; retry needed” wording asserted; “retried later” asserted absent.

## Live backend read-only check (real store, no mutation)

`liveReadOnly.mjs` opened `http://localhost:8082/#memory` in a fresh headless context with the service worker blocked
and a route that aborts every non-GET request. Result: no write was attempted by the page (no session, ack, task, push
subscription, search or delete). Memory loaded **180 cards of 76 115** across the seven categories (observations
69 124, photos 2 924, speech 16, entities 1 129, state 2 918, agent facts 1, reminders 3), statuses rendered verbatim
(`observing`, `reducing`, `committed`, `uncertain`, `recorded`, `person`, `partial`, `final`, `current`, `delivered`),
35 cards used the long-text preview. Expanded details on a real agent fact (“person · Bob”: sources, key, version,
created, active, refs, structured), observation (packet, observed/until, confidence, visual, superseded + lazy source
photo), speech (session/stream/segment/revision/final/start/until/received/words/timing) and photo (session, sequence,
captured, size, faces, audio status, received, status) were readable with raw JSON closed. Live showed “not recording”,
the Now block with the real pipeline backlog (`4 waiting (oldest 20.2 s) · 2899 committed`), agent connected, 0 pending
updates; Tasks (9, 0 active) showed answer texts only with 8 closed diagnostic expansions and no raw JSON visible. No
real notification was acknowledged and no task was sent. Because that context blocked service workers, the Live screenshot's
install/push blocks report “service worker registration failed” / “not-ready”: an artifact of the read-only harness, not of the
served page (the mock-server QA registers the real worker and passes). New helper: `memory/client/qa/liveReadOnly.mjs`.

Requested scenario → check:

- **Navigation while capture is running**: a REAL Start on Chromium's fake camera + microphone against the mock
  (`POST /api/sessions` once, `/static/speech-worklet.js` served read-only). Captures posted went 0 → 2+ while Memory
  then Debug were shown for > 5 s each; badge still “recording since …”; same `<video>` element with `srcObject`,
  `videoWidth 1280`, not paused; no reload; Stop from Live ended the Run (4 photos taken, 4 accepted). Face/speech
  sockets 404 on the socket-less mock and are reported in the status rows, not hidden.
- **Browse-all + paging beyond the old limits**: 7 parallel first pages → 169 cards “of 246”, Load more requests only
  kinds with a cursor (observations, photos, speech) → 239 → 246 “end of results”; Observations alone 40 → 80 → 87 via
  opaque cursors.
- **Filters**: `query=keys` literal (12 hits, all containing “keys”); `history=true` adds 2 struck-through superseded
  observations labelled `superseded`; from/to sent as epoch ms (10 hits inside a 10-minute window); Entities +
  `entityKind=person` → Sam only; the hidden person never renders in any view; Reset restores browse-all.
- **Stale async**: a 1.5 s-delayed “bowl” page arriving after “keys” was applied is dropped (list stays 12 × keys).
- **Errors / empty**: facts 500 → red note “1 category error(s): facts: … HTTP 500”, ✗ chip, Retry re-requests only
  facts; all kinds failing → “nothing could be loaded … Retry”; no-match query → “nothing matches this filter”.
- **Drilldown**: entity card → facts (`entity kind person`, `gallery id p_sam`) + `GET /api/entities/e3` history with
  the “Possible match — identity unconfirmed” label; observation card → labelled facts, lazy `img.photo` for
  `/api/frames/cap_2`, `GET /api/packets/cap_2` + `/history` render “Packet v1”; a queued photo says “no interpreted
  packet yet”. Raw JSON closed by default.
- **Escaping**: `<img onerror>` / `<script>` in title/text render literally; `window.__xss` undefined; no elements created.
- **Reads only**: no POST/DELETE to memory, entities, packets, people or search during browsing.
- **Debug manual form**: labelled “Manual operation · Debug only”; ask with camera stopped omits `sessionId`.
- **Unchanged behaviour**: agent GET+SSE dedupe, reconnect, Ack, task Cancel, keyword/semantic search bodies, push
  prepare-on-load, `subscribe()` synchronous in the click, test push, CDP push → one banner per id, cross-origin url
  replaced, `?notification=` ack + highlight (now also switches to Live), re-sync, Disable, denied and 503 paths.
- **Mobile (390 px)**: single column, no horizontal overflow, nav visible, 8 chips wrap.

## Limitations and open items

- Real status strings/`data` keys render through the generic labelled-facts path and the tone map; unknown statuses
  (e.g. `uncertain`, `recorded`, `person`) show verbatim with no tone. Writes, permissions, push and capture were only
  exercised on the isolated mock; the real-store check was strictly read-only.
- The failed-display and click-open cases are exercised with synthetic worker→page messages (the real worker's message
  shape); CDP cannot force `showNotification` to fail, so the worker's own failure branch is covered by its code path,
  not by a forced failure.
- Not verified here: physical iPhone, Continuity Camera, OS push banners, iOS background delivery, Safari's behaviour for
  an off-stage `<video>` (Chromium verified). Continuity Camera QA can start from the Live view: it appears as a camera
  in the Camera selector once macOS lists it; labels appear after the first permission grant; the page proves the
  selected device only through the preview and the photo counters.
- “All” merges each category's own pages, so the combined list is newest-first within what has loaded, not a global
  cursor across kinds; the note explains per-category progress.
- The mock's face/speech sockets do not exist, so the Live status shows socket errors in QA; real perception is untouched.
