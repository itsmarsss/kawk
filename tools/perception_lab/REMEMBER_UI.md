# Remember product UI — Live V1, Demo, and the integration seam

`/` is the Remember product preview. It has two modes, chosen per browser and switched from the
footer (a switch reloads the page so the two never share a store):

- **Live V1 (default).** A real camera preview and a 240×240 logical **device display** side by
  side. One browser media acquisition feeds the existing perception sockets (`/ws/faces`,
  `/ws/objects`, `/ws/speech`) and a temporary server clip buffer. The server's V1 engine
  (`tools/perception_lab/product.py`, root-owned) turns percepts and a *small command grammar*
  into versioned state events and display actions. With the optional Jev backend the server also
  runs an **ambient memory gate**: Jev decides which useful facts, preferences, plans or topics
  from ordinary conversation become notes for the one recognised person in view (no "remember
  that" needed). Reminders, encounters, clips and object notes live only in a temporary session;
  **person notes are durable only when the server's status reports `memory_persistent: true`**
  (a SQLite store next to the gallery, keyed by the enrolled gallery UUID). The enrolled face
  gallery is always durable.
- **Demo.** Scripted fixture scenes for development (`providers/demo_provider.js`). Nothing in it
  performs inference. Its data lives in `localStorage['remember.ui.v1.demo']` and is never used
  as a fallback for live.

The component lab stays at `/lab`, `/faces`, `/objects`, `/speech`, `/devices`.

## Quickstart

```sh
make serve-product-ui           # uvicorn on 0.0.0.0:8081 (PORT overrides)
open http://127.0.0.1:8081/     # Live V1 home; footer → "Demo mode" / "Testing lab"
node tools/perception_lab/static/remember/tests/run.mjs   # browser checks, no dependencies (also: make test-ui)
```

**Explicit Start.** Nothing is captured on load. Press **Start** on Now; the browser asks for
camera/microphone permission. On macOS the permission belongs to the *browser app* (System
Settings → Privacy & Security → Camera / Microphone). Open **Setup** first to pick devices,
disable camera or microphone independently, and choose backends (defaults: local faces
`buffalo_l`, local YOLO-World objects, existing Baseten Whisper speech). Backends that
`/api/status` reports as not configured are shown as unavailable; no new deployments are made.

## Live walkthrough (what is real)

1. **Start** → one `getUserMedia` per enabled device (camera and mic separately, so one failure
   does not block the other) → `capture.status live/off` to the session → faces/objects streams
   open on the camera, speech on the mic. The component strip shows Session, Camera, Microphone,
   Faces, Objects, Speech, and the clip buffer counters. A model or socket failure names the
   component and leaves the others usable.

   While the faces stream runs, every fresh reply
   is drawn over the preview as a box per face with the server's `stable_name`, or *Unknown*;
   the raw match candidate is never shown as an identity. Boxes are mapped through the
   preview's `object-fit: cover` (and mirroring, if any), redrawn on resize, and cleared on empty
   detections, on face-stream failure, Stop, camera off, reset and disconnect. Freshness is
   measured from the frame's capture time: a reply already older than 1.5 s is ignored, a fresh
   one is kept only for its remaining lifetime, and an older observation never replaces a newer
   one. Name tags are clamped inside the preview (above, below, or pinned inside a face that
   fills the frame), long names are shortened with an ellipsis, and fully off-screen boxes are
   skipped. The overlay is a separate canvas: nothing is drawn into the JPEGs sent
   for inference or clips, and it is independent of the LCD.
2. **Known person.** The faces stream returns `stable_id` (the real gallery UUID) once the
   server's identity vote settles; the V1 engine emits `encounter.started` for that profile,
   and a `display.updated` profile card. A due reminder is drawn **above** the profile text on the
   device display and shown as a banner above the web card.
3. **Objects** are category profiles (`object:<label>`, source `live-perception`) with a
   descriptor that says ownership is not identified. "Where are my keys" answers from what the
   object stream saw in this session, not from a memory service.
3a. **Spoken or typed reminders.** "Remind me to ask Bob about dinner" (a speech final or the
   Ask box) resolves *Bob* against enrolled full names to a stable gallery UUID and saves a
   person reminder in the temporary session. A name that is missing or matches more than one
   enrolled person saves nothing and the answer asks for clarification. A reminder created
   while Bob is in view is suppressed for the current encounter and shows above his profile
   (web card and device display) the next time he is recognised. Manual create/edit on the
   Reminders page is unchanged.
3b. **Ambient memory (Jev backend only).** Every finalized speech segment reaches Jev, which
   decides independently of addressedness whether the ordinary conversation is worth keeping.
   When it is, and exactly one recognised person stays in view unchanged from receipt of the
   finalized transcript through decision application, the server saves a note for that person
   and the transcript line gets a second tag
   beside its directed tag (*Conversation* or *For Remember* — the memory gate is independent of
   addressedness, so a device-classified sentence with no supported command can still be saved):
   **Saved to Bob** (`memory.state: 'saved'`), **Already remembered** (`duplicate`), or nothing
   extra for `not_saved` (the reason is in the tag's title; this is normal, not an error). Being
   saved never turns a conversation into a command.
   The note is filed as **conversation context**: its text is a verbatim quote of what was heard
   (≤ 1000 chars, `source_text`), `speaker` is `unknown`, and the UI labels it *Heard with Bob ·
   saved automatically* (exact model and the speaker caveat in the title) — never "Bob said". Edit and Delete work
   as for any note; an edit re-sends the whole record so provenance is preserved, the server adds
   `edited_by_user: true`, and the original quote is shown under the edited text. The Heard card,
   the sidebar footer and the Reset hint state this only when the effective backend is Jev;
   **rules mode says explicitly that nothing is remembered automatically.** Typed Ask is never
   remembered automatically in either mode.
4. **Introduce someone.** With exactly one stable unknown face in view, say "Hi, I'm …" (speech
   stream on) or type the name and press **Introduce**. The engine sends a `v1.control enroll`
   with the bound `target_track_id`; the UI forwards it only to the *current* faces socket. States
   shown: listening → collecting (n/5 real filtered frames) → complete (profile with the new
   gallery UUID), or ambiguous / error / cancelled. **Cancel** is available while it runs.
   With one stable enrolled person in view, a Jev-validated introduction or name correction
   instead renames that person while retaining the gallery UUID and notes. The profile,
   device card and face label update together. This does not identify who spoke.
5. **Mark moment** saves a real clip: 5 s before and after now from the server ring buffer (JPEG
   ≤5 fps, 16 kHz PCM). The engine also saves a clip automatically when a repeatedly observed
   object category disappears in rules mode; Jev mode selects significant source events instead.
   The tile shows *Recording* until `moment.saved` arrives with the real
   `/api/v1/sessions/{id}/clips/{clip}.mp4`; the dialog is a native `<video>`; the device display
   pastes frames from the same clip at ≤10 fps when an answer references it.
6. **Stop / Cancel start** releases tracks, AudioContext, worklet, sockets and timers, sends
   `stream.state false` for each stream and `capture.status off/off`. While a Start is still
   waiting (browser permission prompt, or the server's `capture.status` ack) the same button reads
   *Cancel start*; a late `getUserMedia` result or ack is discarded and its tracks released.
   Reset, a mode switch and a lost control connection cancel a pending start the same way; no
   timer or late stream callback can restart capture. If a real media track ends (device
   unplugged, permission revoked) capture stops entirely, devices and streams are released and the
   server is told both sides are off; Start works again. The control connection and session
   stay, so notes/reminders/recall keep working and saved clips stay playable.
7. **Reset session** deletes the temporary session and its clips on the server (`DELETE`). It
   never touches the face gallery, and when `memory_persistent` is true it never touches saved
   person notes either (the confirm dialog and the Setup hint say which it is). Reload resumes
   the same session from per-tab `sessionStorage`; a 404 creates a new one.

### Honest limits of V1

- In rules mode, speech directedness and semantic significance are **not judged**. Finals that match the fixed
  grammar act (`where is/are my …`, `who is this?` / `who is that?` / `who am I talking to?` /
  `identify this person` — the currently recognised person's name, notes and prior encounter,
  never a guess for an unknown face — `remind me to <verb> <Enrolled Name> about <topic>`,
  `recall notes about …`, `remember that …`, `I'm …`, `clear the display`); everything else is
  shown as conversation. The same grammar applies to the typed Ask box. With the Jev backend,
  finalized speech waits for Jev's decision and a Jev error produces no fallback action (and
  nothing is remembered while Jev is unavailable).
- Automatic notes bind conversation *context*, not a speaker: a visible face is never treated as
  evidence of who spoke, and the UI copy never claims voice identification. The gate needs exactly
  one recognised person in view, unchanged from receipt of the finalized transcript through
  decision application. Two faces, an unknown face, or a replaced target yield `not_saved`.
  Binding does not reconstruct who was present at the start of the utterance.
- Manual **Mark moment** works in both modes. Rules mode also records confirmed object
  disappearance around its last observation. Jev mode instead selects significant source
  events with the hosted decision bridge. Its bounded fixture tests do not establish
  significance accuracy during natural use.
- Object labels are categories from a detector; they do not identify a specific keyring.
- Identity comes only from the gallery `stable_id`; names and track ids are never used as ids.
- Cloud speech (Baseten Whisper) may wake from zero. The browser allows 130 seconds for
  readiness and makes up to five bounded reconnects with fresh stream IDs. Stop cancels
  retries and stale audio is discarded. After retries are exhausted, press Start again.
- Windowed SAM 3.1 (if selected) resets track ids per window; the engine re-associates by IoU.
- **Audio/video timing in clips is approximate.** PCM chunks are stamped on the main thread as
  receipt time minus one 32 ms chunk; worklet buffering and message latency add tens of
  milliseconds of jitter. JPEGs are stamped before encode. Nothing is sample-accurate.
- Face identity confirmation (server): two agreeing positive matches within the latest three
  observations with positive support on the current one; a conflicting positive identity clears
  the old name; weak frames may coast for at most one second or fewer than three consecutive
  unknowns. Threshold 0.40 and the saved gallery are unchanged.

## File map

```
static/index.html                       shell: persistent #stage (camera + device) + re-rendered #page
static/remember/
  app.js                                modes, persistence policy, provider lifecycle, actions, render loop
  config.js                             mode (remember.ui.mode), live settings key, provider factory
  remember.css
  contracts/types.d.ts                  DTOs, EventMap, CommandMap, DisplayAction, EnrollmentState, Provider
  contracts/schema.json  contracts/envelope.js   envelope + payload validators, sanitizeSnapshot
                                        (DecisionStatus lives in types.d.ts; validated in live/v1_provider.js)
  store/store.js  store/persist.js      apply/bindSession/hydrate/restore, selectors; namespaces
  live/capture.js                       ONE getUserMedia; <video>; JPEG grabs; worklet → 512-sample PCM chunks
  live/perception.js                    faces/objects/speech socket clients (existing protocols, stream ids)
  live/v1_provider.js                   /api/v1 session + /ws/v1 control, media ring, forwarding, control
  live/lcd.js                           240×240 renderer: layoutCard() (pure) + createDeviceDisplay()
  live/overlay.js                       face boxes + stable name over the camera preview (mapBox, createFaceOverlay)
  providers/demo_provider.js            scripted demo (separate mode)
  providers/live_adapter.js             older generic example adapter (not used by Live V1)
  ui/views/live_now.js                  live Now page; createStage() persistent nodes
  ui/views/{now,profiles,moments,reminders}.js  ui/components.js  ui/dialogs.js  ui/dom.js  ui/router.js
  fixtures/                             demo illustrations + 10 s demo clips
  tests/run.mjs                         store, demo, live_adapter, live_capture, lcd, v1_provider suites
```

## Routes and messages used by the UI (source: product_routes.py, server.py)

| Route | Use |
|---|---|
| `POST /api/v1/sessions` | create temporary session → `{session_id, snapshot, websocket_url, limits}` |
| `GET /api/v1/sessions/{id}` | resume (Snapshot); 404 → create a new one |
| `DELETE /api/v1/sessions/{id}` | Reset session (clips gone; gallery untouched) |
| `GET /api/v1/sessions/{id}/clips/{clip}.mp4` | real Range-capable clip, only after `moment.saved` |
| `WS /ws/v1/{id}` | control + envelopes + media ring (one attached socket per session) |
| `WS /ws/faces?backend=`, `/ws/objects?backend=&vocabulary=`, `/ws/speech?backend=` | perception (existing lab contracts, `UI.md`) |
| `GET /api/status`, `GET /api/gallery` | backend availability; gallery is read by the server for seed people |

**Browser → `/ws/v1`:** first `{"type":"hello","device_ts_ms":<floor(performance.now()) mod 2^32>}`;
then `{"type":"command","request_id","command":{type,payload}}`, `{"type":"stream.state",kind,available,stream_id}`,
`{"type":"perception.faces|objects|speech",stream_id,capture_ts_ms?,data:<raw frame/transcript>}`,
`{"type":"enrollment.status",stream_id,data}`, `{"type":"ping"}` every 20 s. Binary: 8-byte
little-endian header `u8 type, u8 flags, u16 seq, u32 capture_ts_ms` + payload; `0x01` JPEG
(long edge 640, ≤5 fps, ≤ `limits.jpeg_max_bytes`, one in flight until `v1.frame_ack`), `0x02`
PCM16 16 kHz 512-sample chunks (timestamp = first sample = now − 32 ms). Audio is sent whenever
the mic is on, even with the speech stream disabled.

**Decision status (outside envelopes).** After the hello ack snapshot, and on every change, the
socket sends `{type:'v1.decision_status', status:{backend:'rules'|'typesafe', phase:'rules'|'idle'|
'ready'|'deciding'|'dropped'|'backoff'|'error'|'stopped', model:string|null, message, timings_ms?,
retry_after_s?, requires_reconfiguration?, reason?, event_id?}}`. The provider validates it
(`normalizeDecisionStatus`; unknown backend/phase or a missing message is ignored, unknown fields
are dropped, nothing secret is ever sent) and keeps it as **runtime** state on the live status,
not in the envelope store. It is cleared when the socket is replaced, on Stop and on Reset, so a
stale status cannot outlive its connection. Before any arrives, the Now status strip shows
`/api/status.decisions` (`{backend, configured, model, message}`; *configured* means the
environment is set, never verified live), else `rules`. Defaults: rules → "V1 command and object
rules; Jev is not connected"; typesafe starts idle → "Jev waits for capture". Error and backoff
(with retry seconds and reconfiguration hints) are shown plainly.

**`/ws/v1` → browser:** versioned envelopes (applied by the store), `v1.ack {request_id?,
receipt, snapshot?}` — every hello ack, including on reconnect, carries an authoritative
`ProductSession.snapshot()`; the provider delivers it to `onSnapshot` listeners *synchronously
before* marking the connection ready or accepting later envelopes, and the app hydrates the store
from it (envelopes queued server-side while disconnected are discarded, so no HTTP resync is
needed). Reconnect never restarts capture. `v1.error {message, request_id?}`
(rejects the pending command or shows a notice), `v1.frame_ack {seq, accepted}`, `v1.control
{control:{type:'enroll'|'cancel_enrollment', name?, target_track_id?}}` (forwarded to the current
faces socket; numeric-string track ids are sent as integers because `faces.py` requires an int;
if no faces stream is running the UI answers with `enrollment.status {data:{type:'error'}}`), `v1.pong`.

**Commands** (all handled server-side in `product.py`): `ask {text}` (fixed grammar incl. the
identify phrases and the reminder phrase; the receipt carries the answer and a `reminder.upserted` envelope follows when
one is saved), `note.save/delete`,
`reminder.save/delete/complete/snooze/dismiss`, `moment.delete`, `moment.mark {title?,
event_at?, profile_ids?}`, `display.clear {}`, `enrollment.cancel {}`,
`enrollment.introduction {name}`, `capture.status {camera, microphone}`.

Example envelope from the server:

```json
{ "schema_version":"1.0", "event_id":"<session>:57", "session_id":"<session>", "seq":57,
  "occurred_at":"2026-09-19T16:59:22.104Z", "type":"display.updated",
  "payload":{ "action":{ "schema_version":"1.0", "id":"display_…", "display":{"w":240,"h":240},
    "card":{ "template":"profile", "title":"Alex Chen", "body":"Last met: 2026-09-19T16:40:02Z",
             "image_ref":null, "reminder":{"id":"reminder_…","text":"Ask for the schematic"} },
    "blit":null, "ttl_ms":8000, "priority":10, "issued_at":"…", "expires_at":"…" } } }
```

## Contracts (schema_version 1.0)

Normative: `contracts/types.d.ts`; runtime checks: `contracts/envelope.js`. Additions for V1:
sources `live-perception` and `v1-rules` (`live-agent` = records a real decision backend
created; `live-memory` reserved);
`display.updated {action: DisplayAction}` and `enrollment.updated {enrollment}` events;
`Clip.audio {present, coverage: complete|partial|none, captured_duration_s}`; `Snapshot.display`.
`ProviderStatus.camera/microphone` may be `unknown` (a socket is not capture).

Ambient-memory additions, all **optional** so every older payload still validates:
`TranscriptSegment.memory {state: saved|duplicate|not_saved, note_id?, profile_id?,
profile_name?, reason?}` (a malformed `memory` rejects the segment; absence is fine);
`Note.attribution`, `speaker`, `decision_model`, `source_segment_id`, `source_session_id`,
`source_encounter_id`, `source_text` (≤ 1000), `edited_by_user` (boolean) — validators check
types but never strip fields, so provenance survives snapshot → store → restore → edit;
`ProviderStatus.memory_persistent` (boolean; absent means false and the UI says "temporary").

Validation gates in order (`store.apply`): shape → duplicate `event_id` → session binding →
`seq` monotonic → content staleness (obsolete answers, older revisions, moment status
monotonic, tombstoned moments, `display.updated` older than the shown action) → reducer in
try/catch. Rejections appear under *Developer diagnostics*.

## Provider lifecycle, sessions and ordering

`app.js`: create provider → `getSnapshot()` (live: POST/GET) → `store.hydrate` → `store.bindSession(provider.sessionId)`
→ `subscribe` → `provider.start()` (live: open `/ws/v1`, send hello). Every hello ack re-hydrates
from its snapshot before the connection is marked ready. `startCapture` is generation-safe: every
await re-checks a token that Stop/Cancel, reset, connection loss and a newer start bump. A
superseded start owns nothing: it never calls the shared `capture.stop()` or changes server
capture state (capture.js releases its own obsolete acquisition), and stream callbacks are bound
to the stream instance that reported, so a stale stream can only report its own shutdown under
its own stream id.
Only envelopes with the bound `session_id` are applied; a late `session.started` from another
session is rejected. Live V1 extra methods: `startCapture(settings)`, `stopCapture()`,
`destroySession()`, `onLiveStatus`, `onNotice`, `onSnapshot`, `limits`.

Server ordering the UI relies on: `session.started` → `profile.upserted` before its
`encounter.started` → `moment.recording` before `moment.saved`/`failed` → `answer.pending` before
`answer.resolved` → `session.stopped`; `display.updated` carries `issued_at` and the engine has
already applied priority (answer 30 > enroll_prompt/alert 20 > profile 10 > idle 0) and TTL.

## Device display policy (`live/lcd.js`)

Renders exactly the last `display.updated` action: reminder strip above the profile text, title
and wrapped body, TTL progress line, idle clock. Local fallback only: if `expires_at` passes with
no newer action, the renderer shows a local idle clock. A `card.clip_id` that resolves to a saved
same-origin clip is drawn from a hidden muted `<video>` at ≤10 rendered fps into the bottom
half, stopped and released on the next action, on clear, or on destroy. An `aria-live` mirror
carries the card text; the canvas has `role="img"` with the same label. The renderer never
re-judges priority or TTL — that is the server engine's job.

## Enabling the Jev bridge (server side, optional)

Set on the **server process** only, never in the browser or the repo:

```sh
export REMEMBER_V1_DECISIONS=typesafe
export TYPESAFE_API_KEY=…            # kept private; nothing reads a .env file automatically
make serve-product-ui                 # restart the server so the process sees both variables
```

`/api/status.decisions.configured` then turns true (environment configured, not verified), and
the Now status strip follows the socket's `v1.decision_status` from idle through ready/deciding,
or shows error/backoff with the server's reason. Leave the variables unset for `rules` mode.

## Data lifetime

| Data | Where | Lifetime |
|---|---|---|
| Face gallery (names + embeddings) | server `data/gallery.npz` | durable; enrollment adds, introductions can rename, and profile/lab deletion removes |
| Person notes (manual and automatic) when `status.memory_persistent` is true | server SQLite next to the gallery (`product_memory.py`), keyed by gallery UUID | durable: survives reload, Reset session and server restart; Delete removes it |
| Live session reminders/encounters/moments/clips/object notes (and all notes when `memory_persistent` is false) | server `BrowserSession` (memory + temp files) | until Reset, or 15 min idle server TTL |
| Live UI state | in-memory store; `sessionStorage['remember.ui.v1.live.session']` per tab | tab lifetime |
| Live settings (devices, toggles, backends) | `localStorage['remember.ui.v1.live.settings']` | until cleared |
| Demo data | `localStorage['remember.ui.v1.demo']` | until Reset demo |
| Mode | `localStorage['remember.ui.mode']` | until switched |

## What is simulated, what is real, what is pending

- **Real (Live V1):** camera/mic capture, face detection + gallery identity (`stable_id`),
  object categories, Whisper transcripts, the clip ring buffer and MP4 clips, session CRUD,
  device display actions, enrolment of one bound face into the real gallery.
- **Rule-based, not intelligent (rules mode):** the command grammar, foreground selection,
  coasting/ending timings, the disappeared-object clip rule, reminder surfacing, display
  priority/TTL — deterministic V1 rules in `product.py`.
- **Simulated (Demo mode only):** every scene, transcript, answer and clip.
- **Live-tested in a bounded fixture run: the optional Jev decision bridge.** The server can run
  `REMEMBER_V1_DECISIONS=typesafe`; then finalized live speech and significance are gated by Jev
  (`jev-1.13.0`) while typed Ask keeps the fixed grammar. A private server-side key was used
  on September 19 for actual hosted Jev tests with synthetic identity/transcript inputs;
  this is not a real-world speech or recognition accuracy benchmark. The UI follows current
  server status rather than treating configuration as proof of service health.
  In `rules` mode (default) the fixed commands and the
  disappeared-object clip rule apply. Moments created by a real decision backend carry
  `source: 'live-agent'` and `decision_model: 'jev-1.13.0'`; so do automatic conversation
  notes (plus `attribution: 'conversation_context'`, `speaker: 'unknown'`, `source_text`).
  The ambient-memory check covered 12 expected persistence outcomes plus four held-out
  statements (19 provider calls): useful details saved, filler/repeats skipped, and host
  identity guards prevented ambiguous assignments. One no-person case received a positive
  model memory vote; the host correctly blocked it. Persisted notes survived an actual
  staging-server restart; edit/delete and fresh-session retrieval were browser-verified.
- **Pending in this browser V1:** device-directedness beyond that gate, hardware
  DeviceLink to real glasses, any memory beyond person notes (reminders, encounters, clips and
  object notes are still session-temporary). When they arrive they replace `product.py`'s rules
  behind the same envelopes and commands.

## Tests

`node tools/perception_lab/static/remember/tests/run.mjs` (or `make test-ui`) covers contract validation
(incl. `display.updated`, `enrollment.updated`, clip audio coverage, snapshot display), store
ordering/session binding, demo scenes, generic live adapter, **capture lifecycle** (separate
camera/mic acquisition, chunk timestamps, stop releases, one-in-flight, watchdogs, stale
callbacks, stream ids, `target_track_id` coercion, speech stop flush, bounded backlog),
**LCD layout and policy** (reminder above title, wrapping, clip region, TTL fallback, ≤10 fps
clip painting, release on supersede), and **V1 provider** (session create/resume/404, hello
first, ack/error mapping, hello-snapshot delivered before ready and again on reconnect,
perception forwarding with stream ids and capture timestamps, media header/seq/ts, frame_ack
slot, oversized frame drop, PCM framing, control forwarding, stop keeps session, connection loss
stops capture and reconnects, reset deletes, **cancel during getUserMedia / during the
capture.status ack / on connection loss with no late restart**, Start after cancel, late stream
status ignored, **track ended → bounded stop and Start again**, **decision status: accept /
ignore unknown / update / clear on socket replacement, Stop and Reset / never enters the store**),
and **decision status rendering** (rules default, configured-not-verified label, runtime status
precedence, error and backoff styling with retry and reconfiguration hints), and **ambient
memory** (`tests/memory_render_test.mjs`: optional `segment.memory` / note provenance /
`memory_persistent` validate while old payloads still pass and malformed values are rejected;
provenance survives snapshot, store, restore and the edit payload; *Saved to Bob* / *Already
remembered* / plain *Conversation* tags with the not-saved reason in the title and never *For
Remember*; profile-page provenance labels, edited quote, Edit/Delete kept, hostile text rendered
as plain text; Heard/footer/reset copy claims automatic memory only for the Jev backend and
durability only when the flag is true). Browser end-to-end is run by root; a fake-device Playwright pass was used for targeted
verification during development.
