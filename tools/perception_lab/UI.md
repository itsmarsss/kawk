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
| `devices.html` | Browser camera/mic lists, "grant access" for labels, phone/HTTPS guidance driven by `https_available`. |
| `common.js`, `styles.css` | Shared fetch/ws-url/status helpers and the single stylesheet. |

## Routes the backend must serve

- `/` → `static/index.html`, `/faces` → `faces.html`, `/speech` → `speech.html`, `/devices` → `devices.html`
- `/static/*` → files in this directory. The worklet is loaded with `audioWorklet.addModule('/static/speech-worklet.js')`, which
  itself imports `./resampler.js`, so both must be served as JavaScript (verified: `text/javascript`).
- `/api/status` (incl. `https_available`), `/api/gallery`, `DELETE /api/gallery/{id}`, `/ws/faces`, `/ws/speech` as in the contract.

## Layout

- Speech: mic select → Start/Stop/Clear → status → level meter → **Transcript** → delay estimates → collapsed "Connection details".
- Faces: camera select → Start/Stop → status → **preview** with a one-line inference / round-trip readout → Enroll (name, Enroll, Cancel) → Faces in view → Enrolled people → collapsed "Timing details".
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
- Response timeout: if no `frame`/`busy`/`error` arrives within 5 s of a send, the slot is freed, a warning with a
  running count is shown, and the loop continues. A reply arriving after that shows the round trip as "n/a (late reply)".
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

## Verification done

- `node --check` on every `.js` file and on the inline module scripts extracted from the HTML; HTML tag balance and JS→HTML id references checked.
- `resampler.js` Node tests: exact 1024-byte chunks and correct total sample counts for 8k/16k/22.05k/44.1k/48k/96k input with 128/256/480-sample blocks; 1 kHz passes at ~0.99 gain, 11 kHz and 20 kHz suppressed; passthrough at 16 kHz is sample-exact; no discontinuities across block boundaries.
- Live server at `http://127.0.0.1:8081`: `/`, `/faces`, `/speech`, `/devices` return HTML; `/static/*.js` return `text/javascript`; `/api/status` reports `https_available:false`.
- Not done by the UI author: no camera or microphone was opened; live browser validation is the parent's headless run. Safari's behaviour with `import` inside an AudioWorklet module was not checked; if `addModule` fails there, inline `resampler.js` into the worklet.
