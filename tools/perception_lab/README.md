# Perception testing lab

Standalone browser tests for objects, face recognition and live Whisper. This is
a component lab, separate from the full Remember world model and task pipeline.
Frontend implementation is delegated to Claude Code Fable 5.1. Work stays on
`chud3`; GitHub's default is `main`.

## Run

Use the repository's Python 3.12 environment:

```sh
uv sync --extra local --extra sim --extra lab --extra cloud
make fetch-local-models
make serve-ui
```

Optionally set `REMEMBER_FACE_MODEL_ROOT` (default `data`) to the directory containing
`models/buffalo_l/det_10g.onnx` and `models/buffalo_l/w600k_r50.onnx`. Models are not
downloaded automatically. Set `BASETEN_API_KEY` on the server or use the existing
Mac Baseten CLI profile `h100-permanent`; the reserve account is never selected.

Open http://127.0.0.1:8081/lab. The product UI preview lives at `/`; see
[its integration guide](REMEMBER_UI.md). The server listens on `0.0.0.0:8081`.
`PORT`, `REMEMBER_GALLERY_PATH`, `REMEMBER_FACE_PROVIDER`, and
`BASETEN_STT_MODEL_ID`, `BASETEN_FACE_MODEL_ID`, `BASETEN_SAM_MODEL_ID` and
`REMEMBER_MODEL_DIR` can override defaults. The default face provider is CoreML
(with supported ONNX graph partitions on CPU), not a remote GPU. CPU fallback
must be selected explicitly using `CPUExecutionProvider`.

For HTTPS, set `REMEMBER_TLS_CERT`, `REMEMBER_TLS_KEY`, `PORT=8443`, and
`REMEMBER_HTTPS_ENABLED=1` before launch. A phone requires a certificate trusted
by that phone; an ordinary LAN HTTP link cannot request its camera/microphone.
The localhost HTTP address works on the Mac. Plugged-in USB and available
Continuity cameras appear in the browser device selector after granting access.

## Behavior and measurements

- Faces: JPEG at most 640 pixels on the long edge, maximum 5 fps, one in flight;
  global inference serialization prevents GPU/CPU contention across cameras.
  Reject faces smaller than 80 pixels. Local explicit enrollment takes five
  consistent single-face frames, averages normalized buffalo_l embeddings, then
  renormalizes. Matching uses cosine >=0.40, with three consistent observations
  before changing the displayed identity. Tune accuracy in actual lighting.
- The Baseten face selector uses the same embedding model/gallery. A cloud HTTP
  frame times out after four seconds and is skipped; three consecutive timeouts
  end the session. Skips are shown in the UI. If the Mac fails to reply within
  five seconds, the browser closes the socket to avoid mixing old/new replies.
- Objects: local YOLO-World or configured SAM 3.1. The experimental cloud window
  mode requires `REMEMBER_SAM_ALLOW_WINDOWED=1`; it reinitializes from received
  frames, resets native track IDs and is labeled accordingly. It does not provide
  persistent incremental SAM tracking. Each camera sends one frame at a time.
- Only the enrolled name and embedding are persisted in ignored
  `data/gallery.npz`; no camera frames are saved. Embeddings stay on the server.
- Cloud speech: persistent browser → Mac → Baseten WebSocket. The existing production
  model is `wdlg2oe3` (H100 deployment `wldeyy7`, verified 2026-09-19). Exact
  512-sample chunks at 16 kHz mono PCM16LE. Metadata enables partials, word
  timestamps and the service's own VAD. No local Silero gate in this component
  latency tool: audio streams continuously while Start is active. This is a
  deliberate difference from the product's VAD-gated path.
- Local speech uses faster-whisper Small/int8 CPU with the real Silero ONNX gate.
  The models preload before the microphone starts. Local overload raises an
  error instead of building an unbounded audio queue or silently dropping words.
- Each browser session gets its own upstream Whisper socket; Stop/closed tab
  releases that socket. Sessions stop after ten minutes. No deployment changes
  are made and the teammate's deployment is never deactivated.
- Connection setup, face inference, face frame roundtrip, and any estimated
  acoustic-boundary speech delays are separate metrics. Browser RMS estimates
  are noise-sensitive; they are not isolated GPU time or an accuracy benchmark.
- Microphone audio is forwarded to Baseten only when cloud speech is selected;
  local speech stays on the Mac. This server does not save it or
  persist transcripts. Use consenting participants for face enrollment.

## API used by the UI

`GET /api/status`, `GET /api/gallery`, `DELETE /api/gallery/{id}`.
Each perception socket accepts `?backend=local|baseten`; Objects also takes
comma-separated `vocabulary`. Status reports assets/configuration, not a guarantee
that cloud replicas are active. Scale-to-zero can make the first Start time out;
wait for startup and retry. See `UI.md` for complete browser contracts.
`/ws/faces` accepts binary JPEGs and JSON `enroll`/`cancel_enrollment` controls;
responds with `ready`, `frame` (boxes/matches/timings/enrollment), `busy`, `error`.
`/ws/speech` responds with `connecting`, `ready`, then `transcript` messages.
Replace partials by `segment_id`; `is_final` fixes that utterance. Binary audio
messages must be 1024 bytes; after trailing silence, JSON `{"type":"stop"}`
waits up to two seconds for a final before closing.

`python -m pytest tools/perception_lab/test_backend.py -q` runs offline contract
tests. Live fixture probes are kept in the R&D workspace, not run by tests.
