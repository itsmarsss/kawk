# htn2026

The product specification is in [AGENTS.md](AGENTS.md). GitHub's default branch
is `main`; William's work is on `chud3`.

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

Open http://127.0.0.1:8081/. The server listens on `0.0.0.0:8081`.
Mac camera/microphone access works on localhost. Other devices need trusted
HTTPS; the Devices page explains this and does not advertise an unavailable link.
Model loading happens before capture where possible; the first inference can
still warm native kernels. Local assets and enrollments stay out of git.

| Component | Local | Cloud |
|---|---|---|
| Objects | YOLO-World small, CPU, explicit vocabulary | SAM 3.1 Multiplex, experimental windowed mode where supported |
| Faces | buffalo_l, CoreML with CPU partitions | Same buffalo_l embedding space, Baseten HTTP |
| Speech | faster-whisper Small/int8 CPU + Silero ONNX | Whisper Large v3 streaming, Baseten WebSocket |
| Decisions | Injected synthetic answers for contract tests only | TypeSafe Jev; key required for live verification |

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
