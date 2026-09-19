# Perception lab UI

Static browser pages for testing the face and speech components. No build step,
no dependencies, no keys in the browser. Everything lives in `static/`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Home: links to the three pages, server status from `/api/status`, one paragraph on what is stored. |
| `faces.html`, `faces.js` | Camera select, Start/Stop, preview with box overlay, per-face list, timing, enroll/cancel, gallery with per-row Delete. |
| `speech.html`, `speech.js` | Mic select, Start/Stop/Clear, level meter, connection timing, labeled delay estimates, partial/final transcript rows. |
| `speech-worklet.js` | AudioWorkletProcessor: RMS meter, resample to 16 kHz, emit exact 512-sample PCM16-LE chunks (transferred), silent output. Imports `resampler.js`. |
| `resampler.js` | Pure ES module: 63-tap Hamming-windowed sinc lowpass at the input rate + linear interpolation with fractional phase carried across blocks; chunker. Testable in Node. |
| `objects.html`, `objects.js` | Camera select, backend select, vocabulary input (≤20 comma-separated terms), Start/Stop, preview with boxes + labels + track IDs, objects list, timing details. |
| `devices.html` | Browser camera/mic lists, "grant access" for labels, phone/HTTPS guidance driven by `https_available`. |
| `common.js`, `styles.css` | Shared fetch/ws-url/status helpers, `setupBackendSelector`, `BACKEND_LABELS`, and the single stylesheet. |

## Routes the backend must serve

- `/` → `static/index.html`, `/faces` → `faces.html`, `/objects` → `objects.html`, `/speech` → `speech.html`, `/devices` → `devices.html`
- `/static/*` → files in this directory. The worklet is loaded with `audioWorklet.addModule('/static/speech-worklet.js')`, which
  itself imports `./resampler.js`, so both must be served as JavaScript (verified: `text/javascript`).
- `/api/status` (incl. `https_available` and `backends`), `/api/gallery`, `DELETE /api/gallery/{id}`, `/ws/faces?backend=`, `/ws/speech?backend=`, `/ws/objects?backend=&vocabulary=`.

## Backend selection (Faces, Objects, Speech)

- Each page has a `backend` select with fixed labels from `BACKEND_LABELS` in `common.js`:
  Face local buffalo_l CoreML / Face Baseten buffalo_l; Objects local YOLO-World / Objects Baseten SAM 3.1;
  Speech local Whisper Small int8 / Speech Baseten Whisper Large v3. Defaults: face `local`, objects `local`, speech `baseten`.
- On page load, on every backend change, and on "Recheck status", the page reads `/api/status.backends[kind][choice]`
  and shows `detail`. `configured:false` disables Start with an explanation; the text says configured means assets or
  endpoint settings exist, not that the model is loaded, warm, or verified. If `backends` is missing from status, Start stays allowed and the detail says so.
- Changing the backend ends any running session (same `endSession` path as Stop), clears results and metrics, and requires Start.
  The select is disabled while a session exists.
- The chosen backend is sent as `?backend=local|baseten` on the WebSocket URL. The ready message's `backend` and `model`
  (or `model_id`) are displayed as "model via backend".

## Objects page (`/ws/objects`)

- URL: `/ws/objects?backend=local|baseten&vocabulary=a,b,c` (terms trimmed, de-duplicated case-insensitively, 1–20 required; Start is disabled otherwise).
- Expects `{type:"loading"}` → `{type:"ready",backend,model,load_ms}` → `{type:"frame",frame_id,input_wh,objects:[{track_id,label,box_xyxy,score}],timings_ms:{request,inference?},session_generation?}`, plus `busy` and `{type:"error",message}`.
- Frames: longest side ≤ 1280, JPEG 0.7, one in flight, ≤ 10 fps. `busy` frees the slot.
- Watchdogs: 15 s from socket open to `ready` (else the session stops with an actionable message). The per-frame reply timeout
  is `ready.response_timeout_ms` clamped to 5000–15000 ms (5000 ms until ready arrives or if the field is missing/invalid);
  on expiry the session stops with a message naming the backend. Both timers are cleared by `endSession`.
- `ready.tracking_persistent === false` (cloud SAM 3.1 windowed re-initialization) shows a visible notice under the preview:
  IDs reset per window, it is not a continuous tracker, judge it by measured update speed. The notice is empty otherwise.
- `busy` means the server skipped the frame: the slot is freed, a "frames skipped by server" counter increments, and the
  last boxes and list stay on screen (a skip is not an absence).
- Default vocabulary is `person, keys, phone`.
- Boxes are absolute in the sent frame; the overlay canvas takes `input_wh` and is stretched over the video. Colour is chosen per track id from a fixed set. `inference` shows `n/a` when absent. `session_generation` is shown in timing details when present.
- Same session/cancellation guards as Faces (Stop during getUserMedia or CONNECTING, stale callbacks ignored, camera change is a full stop).

## Layout

- Speech: mic select → backend select → Start/Stop/Clear → status → level meter → **Transcript** → delay estimates → collapsed "Connection details".
- Faces: camera select → backend select → Start/Stop → status → **preview** with a one-line inference / round-trip readout → Enroll (name, Enroll, Cancel) → Faces in view → Enrolled people → collapsed "Timing details".
- Objects: camera select → backend select → vocabulary → Start/Stop → status → **preview** with request / inference / round-trip readout → Objects in view → collapsed "Timing details".
- Protocol and format details live in the collapsed `<details>` blocks or in this file, not ahead of the task.
- Pages are single-column with `overflow-wrap: anywhere`; stats grids collapse to one column under 480 px.

## Behaviour notes (client side)

Session model (both pages)
- One session object at a time, created on Start with a fresh id and an `ended` flag. Every
  awaited step (`getUserMedia`, `enumerateDevices`, `addModule`, `loadedmetadata`, `play`,
  `resume`) re-checks that the session is still current afterwards; if not, whatever that step
  acquired is released immediately (tracks stopped, AudioContext closed). Stale `catch`
  handlers and stale WebSocket/JPEG callbacks are ignored, so they never touch a newer session.
- `endSession` is idempotent. It detaches the socket's callbacks, closes it in any state
  including CONNECTING, releases media, clears every timer, and re-enables Start.
- Capability (no `getUserMedia`, no `AudioWorklet`) is decided once at load and `setButtons`
  respects it permanently.
- Changing the camera or microphone dropdown while running is a full stop with a status message;
  the user clicks Start for the new device. No live overlapping swaps.

Faces
- Nothing happens on load except `enumerateDevices` (labels may be blank) and `GET /api/gallery`.
- Start: `getUserMedia` for the chosen camera → refresh labels → open `/ws/faces` → wait for `ready` → frame loop.
- Loop: long edge ≤ min(640, `max_side`), JPEG 0.8, binary send, one request in flight, spacing 1000/`max_fps` ms.
  `busy` frees the slot and the loop retries on the next tick. `error` messages are shown in red; a non-fatal error also frees the slot.
- Response timeout: if no `frame`/`busy`/`error` arrives within 5 s of a send, the session ends with
  "No face reply within 5 seconds. Start again to reconnect." (socket closed, camera released). No second frame is ever
  sent on a socket with an unanswered request, so a late reply cannot be attributed to a later request. `onFrame` ignores
  a reply when the session is not current or nothing is in flight.
- `busy` means the server skipped the frame: the slot is freed, the "Frames skipped by server" counter (per session, reset
  on Start and backend change) increments, the last boxes stay on screen, and the loop continues. `reason:"cloud_timeout"`
  additionally shows the hint "Cloud frame timed out; trying the latest frame."
- Regression test: `node static/tests/faces_guard_test.mjs` drives `faces.js` with a fake DOM, fake timers, and a mock
  WebSocket to check the timeout path, the busy path, and the late-reply guard.
- Round trip shows two measured values: send → reply, and capture → reply (includes drawImage, JPEG encode and `arrayBuffer`).
- Overlay canvas is sized to `input_wh` and stretched over the video with CSS, so boxes align without per-box scaling. No mirroring.
- Label shows `stable_name` or `Unknown`; the list below shows the raw match and similarity separately.
- `detected_count > accepted_count` shows "move closer".
- Enroll sends `{type:"enroll",name}`; progress is read from `frame.enrollment`; on `complete` the gallery reloads. Cancel sends `{type:"cancel_enrollment"}`.
- Stop, socket close, track `ended`, camera change, and `pagehide` all end the session.

Speech
- Each Start clears the transcript and delay estimates, because Whisper numbers segments from 0 on every
  new connection and an old finalized row 0 would otherwise swallow the new row 0. The page says so.
- Start opens `/ws/speech` first; the microphone is acquired only after `ready`.
- `AudioContext({sampleRate:16000})` is requested but the worklet is told the actual `ctx.sampleRate` and resamples to `ready.sample_rate`.
- Each 1024-byte chunk is sent only if `ws.bufferedAmount ≤ 16384`; otherwise the page stops with a visible message.
- Transcript rows are keyed by `segment_id`; partials update in place, a row is finalized once and later snapshots for that ID are ignored. At most 100 rows.
- Stop while capturing: worklet/mic/context torn down immediately, then 500 ms of zero PCM paced at real time,
  then `{type:"stop"}`; the page ends the session itself after 3 s if the server has not closed.
  Stop in any other phase (including while the socket is still CONNECTING) closes the socket at once.
- Delay estimates use an adaptive RMS gate on this page and are labeled "(estimate)". "Sound start → first partial"
  is updated only by a row's first non-empty partial; a row that arrives already final never updates it.
  An utterance counter prevents pairing a final with the next utterance's sound. Unclear pairings show `n/a`.

Devices
- Reads `https_available` from `/api/status`. When false, no link is rendered; the page says phone access needs
  HTTPS setup and to use a camera or microphone connected to this Mac for now. When true, it lists
  `https://LAN:port/` per address and states that the other device must trust the certificate.

## Assumptions about the backend

1. Face `error` messages are treated as non-fatal: the in-flight slot is freed and the loop continues; a server-side close stops the page.
2. Speech `ready.connect_ms` is displayed as "server to Whisper, measured on server".
3. After `{type:"stop"}` the client waits 3 s for the server's close (`CLOSE_GRACE_MS` in `speech.js`).
4. Faces response timeout is 5 s (`RESPONSE_TIMEOUT_MS` in `faces.js`); lower it if the serialized queue never gets that deep.
5. DELETE gallery: the client re-fetches `/api/gallery` after each delete.

## Testing note

- Text inside a collapsed `<details>` (timing/connection details) is not returned by `innerText` while collapsed. Browser tests should read `textContent`, or open the details first.

## Verification done

- `node --check` on every `.js` file and on the inline module scripts extracted from the HTML; HTML tag balance, duplicate ids, labeled controls, and JS→HTML id references checked on all five pages. No `innerHTML` anywhere; dynamic data goes through `textContent`.
- `resampler.js` Node tests: exact 1024-byte chunks and correct total sample counts for 8k/16k/22.05k/44.1k/48k/96k input with 128/256/480-sample blocks; 1 kHz passes at ~0.99 gain, 11 kHz and 20 kHz suppressed; passthrough at 16 kHz is sample-exact; no discontinuities across block boundaries.
- Live server at `http://127.0.0.1:8081`: `/`, `/faces`, `/speech`, `/devices` return HTML; `/static/*.js` return `text/javascript`; `/api/status` reports `https_available:false`.
- Not done by the UI author: no camera or microphone was opened; live browser validation is the parent's headless run. Safari's behaviour with `import` inside an AudioWorklet module was not checked; if `addModule` fails there, inline `resampler.js` into the worklet.
