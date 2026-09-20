# htn2026

The product specification is in [AGENTS.md](AGENTS.md). GitHub's default branch
is `main`; William's work is on `chud3`.

The current demo combines the `memory/` camera and scene-memory app with the
TypeScript/Bun agent in `agent/`. Local Python handles faces and speech; OpenAI
handles vision, memory writing and agent turns; Jev decides when to intervene.
The agent can search history, run code and browser tasks, schedule reminders,
and request an extra camera frame. Baseten is disabled for this demo.
Start with [the merged demo setup and verification](docs/MERGED_DEMO.md).
The older V1 interface below remains available; physical glasses and OS push
delivery have not been verified with this merged path.

## V1 product interface

Open `http://127.0.0.1:8081/` for the live camera and 240×240 device-display preview.
V1 connects the existing face, object and speech services to profiles, personal notes,
temporary encounters/reminders and playable camera/microphone clips. Person reminders
join by the real enrolled gallery UUID. The display uses the plan's card priorities
and expiry rules; it is a browser preview of the LCD, not a hardware connection.

V1 defaults to explicit speech commands, manual moment marking, and clips after
confirmed object disappearance. Say or type “remind me to ask Bob about dinner”
to attach a reminder to Bob's enrolled profile for the next encounter. Rules do
not provide general semantic directedness or significance judgments.

An optional direct Jev connection gates live commands, automatically selects useful
details from ordinary conversation for personal notes, and selects significant clips.
Conversation memory does not require “remember that” or assistant-directed speech.
Set `REMEMBER_V1_DECISIONS=typesafe`
and a private `TYPESAFE_API_KEY` in the server environment, then restart. It is
verified with offline fixtures and a bounded live Jev test on September 19: useful
conversation excerpts saved, repeated/filler inputs skipped, and identity guards
prevented ambiguous assignments. This was synthetic face/transcript input, not an
accuracy benchmark of real-world conversation or speech recognition.
Failures are explicit and do not silently run rule-based actions. Scripted Demo
mode remains separate from live data. See the
[UI integration guide](tools/perception_lab/REMEMBER_UI.md) for supported requests.

Use `make serve-ui` after the full setup below for local perception and the existing
cloud speech service. Real clip encoding also needs `ffmpeg` and `ffprobe` on PATH.
`make serve-product-ui` starts the lightweight UI/session service without installing
local ML packages; Demo mode needs no model weights, capture permission or cloud key.
Media starts only after Start. Existing component tests remain at `/lab`.

Personal notes persist in SQLite beside the selected face gallery, linked by the
enrolled person's UUID; `REMEMBER_MEMORY_PATH` overrides the file location. Edits
and deletions synchronize across open tabs. Selected speech is kept verbatim as
conversation context, with its source and time; visible faces do not establish who
spoke. Notes and face enrollments survive Reset, session expiry and server restarts.
Other live records and footage remain temporary: Stop preserves them for recall;
Reset or expiry removes them. The full production agent/DeviceLink harness remains
separate from this browser V1 implementation.

## Local/cloud R&D lab

The standalone [perception lab](tools/perception_lab/README.md) provides browser
pages for Objects, Faces, Speech and Devices. Each perception page has a
local/Baseten selector. It is separate from the full product hub: this change
implements Lanes C and D, not Lane A's memory/tasks or Lane B's device protocol.

```sh
uv sync --extra local --extra sim --extra lab --extra cloud
make fixtures
make fetch-local-models
make serve-ui
```

Open http://127.0.0.1:8081/lab. The server listens on `0.0.0.0:8081`.
Mac camera/microphone access works on localhost. Other devices need trusted
HTTPS; the Devices page explains this and does not advertise an unavailable link.
Model loading happens before capture where possible; the first inference can
still warm native kernels. Local assets and enrollments stay out of git.

| Component | Local | Cloud |
|---|---|---|
| Objects | YOLO-World small, CPU, explicit vocabulary | SAM 3.1 Multiplex, experimental windowed mode where supported |
| Faces | buffalo_l, CoreML with CPU partitions | Same buffalo_l embedding space, Baseten HTTP |
| Speech | faster-whisper Small/int8 CPU + Silero ONNX | Whisper Large v3 streaming, Baseten WebSocket |
| Decisions | Explicit V1 command and object rules | Optional TypeSafe Jev bridge; key required for live verification |

Objects and speech compare different model sizes/algorithms, so compare output
quality as well as speed. SAM's released multiplex predictor consumes finite
clips. A windowed experiment reinitializes from frames already received and
resets native track IDs; it is not verified persistent live tracking. That mode
requires an explicit `allow_windowed` setting (lab environment
`REMEMBER_SAM_ALLOW_WINDOWED=1`) and is labeled in the UI.

Cloud keys remain on the server. Export the variables in `.env.example` into
the server environment; files named `.env` are not automatically executed.
The lab and comparison script also accept the existing Baseten CLI
`h100-permanent` profile. They never fall back to the reserve credit profile.
Configuration is not a promise that a cloud deployment is active or warm.
The existing production Whisper ID defaults to `wdlg2oe3` in the lab; other
endpoints must be configured explicitly. Deployment instructions are under
`deployments/`.

## Repeatable component comparisons

See [measured R&D results](RND_RESULTS.md) for the same-input local/cloud
comparison, browser verification and startup/tracking limitations.

The three perception adapters implement the same typed interfaces. Select them
with `remember.toml` and `remember_hub.backends.create_sam/create_face/create_stt`.
`create_jev` selects the typed decision service separately. These factories use
environment credentials and validate missing keys before loading a vendor runtime.
The standalone lab uses its selectors and environment variables; `remember.toml`
applies to the factories and comparison runner, not the lab's live settings.

```sh
make test
make test-ui  # Node.js: browser lifecycle regression harness
make lint
make verify-local
make compare ARGS='speech --input data/fixtures/where_keys.wav --output data/speech-comparison.json --runs 3'
make compare ARGS='objects --input data/fixtures/bus.jpg --output data/objects-local.json --backends local --runs 10'
```

Supply the same <=640px JPEG to `compare face --input ...` for face comparisons.
The comparison script replays identical inputs serially, records initialization,
first call and warm median/p95 separately, and retains counts/transcripts to make
empty or incorrect outputs visible. Speech uses paced 16kHz PCM16, 512 samples
per packet. Its onset/offset timing is an acoustic-threshold estimate. Cloud
request time includes transport/routing/queueing; subtracting compute does not
produce a pure network measurement. A first request is not a controlled cold start.

See [LOCAL_BACKENDS.md](LOCAL_BACKENDS.md) for actual fixture measurements and
limitations. Tests use injected engines; they never download weights or call
paid services. Live comparisons are explicit commands. The mock factories are
empty/injected contract references, not a completed Remember scenario runner.

The interface is authored with Claude Code Fable 5.1. Camera and microphone
capture start only when you click Start. Enroll consenting participants.
