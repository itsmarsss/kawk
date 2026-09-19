# Local perception for R&D (Lane C)

These implement the frozen perception interfaces. They do not implement the world
model, persistent face gallery, Jev policy, device transport, or the application
from Lanes A and B. Local models are real; no plain-COCO replacement is hidden
behind the YOLO-World name.

## Setup and fixture verification

```sh
uv sync --extra local --extra sim
make fixtures
make fetch-local-models
make verify-local
```

The fetch command is the only model downloader. It writes weights and a
source/SHA256 manifest under ignored `data/models/`. On an existing machine,
`python scripts/fetch_local_models.py --face-cache /path/to/buffalo_l` copies and
verifies the two existing face models. `--only yolo|face|whisper|vad` limits a
fetch. YOLO-World requires the pinned Ultralytics CLIP dependency as well as its
local `clip/ViT-B-32.pt` text encoder; neither is installed or downloaded while
serving. Models are optional extras and all heavy imports are lazy.

`make fixtures` explicitly fetches Ultralytics' official `bus.jpg`, creates
seeded 640×480 RGB noise, and generates “Where are my keys?” using macOS `say`
(Samantha, 16 kHz mono PCM16). On other operating systems pass
`--speech-wav /path/to/where_keys.wav`; a tone is never substituted for speech.
Fixture origins are in `data/fixtures/manifest.json`.

`verify_local.py` checks at least one person on the bus, zero accepted faces on
noise, real Silero speech activation, and “keys” in a final Whisper transcript.
It uses paced 640-sample device packets, not a faster-than-real-time WAV dump.
Default face verification is CPU. To check CoreML and a consented face image:

```sh
uv run --extra local --extra sim python scripts/verify_local.py \
  --face-provider CoreMLExecutionProvider --face-image /path/to/face.jpg
```

The report goes to ignored `data/local-verification.json`. Cold initialization,
first inference, warm inference, speech-onset delay, and end-of-speech delay are
separate. No cloud or transport latency is included. These are smoke fixtures,
not recognition accuracy or long-running concurrency evaluations.

## Adapter APIs

```python
objects = LocalYoloBackend(model_path="data/models/yolov8s-worldv2.pt", device="cpu")
await objects.start_session(["person", "keys", "wallet"])
detections = await objects.push_frame("frame-1", jpeg, (width, height))
await objects.add_concept("cup")
await objects.end_session()
await objects.close()  # optionally release native models too

faces = LocalInsightFaceBackend(model_root="data/models", provider="CoreMLExecutionProvider")
await faces.load()  # optional explicit preload, otherwise lazy on first frame
observations = await faces.embed_faces(jpeg, (width, height))
await faces.close()

speech = LocalWhisperBackend(model_path="data/models/faster-whisper-small",
                            vad_model_path="data/models/silero_vad.onnx")
await speech.load()  # complete model+VAD load before enabling the microphone
async for segment in speech.stream(pcm16_chunks):
    replace_transcript_by_id(segment.seg_id, segment)
await speech.close()  # only after its stream has finished/closed
```

All three expose `load_ms` and `last_timings_ms`. Face also exposes actual session
`providers`. `load()` means sessions/weights are loaded; first inference may still
initialize native kernels. Pass an absolute model root if the process working
directory is not the repository root.

### Objects

YOLO-World v2 small uses explicit 1–20 concepts (each 1–3 words). Boxes stay in
absolute SENT-image coordinates. Same-label IoU matching gives session-scoped
stable IDs; overlapping duplicate detections are suppressed. Tracks expire after
2 seconds and at most 128 are retained. This lightweight association cannot
preserve identity through long occlusion or fast camera cuts like a full tracker.

Only one frame runs at a time. A concurrent `push_frame` returns an empty list;
callers must use newest-frame scheduling and must not interpret a dropped call
as evidence an object disappeared. Native work runs off the asyncio event loop.

### Faces

Only buffalo_l SCRFD `det_10g.onnx` and ArcFace `w600k_r50.onnx` are used, with
explicit provider checks. CoreML may legitimately retain CPU partitions. No
silent replacement by buffalo_s or a different embedding space occurs. Input
must already be ≤640px on its longest side and match the supplied SENT dimensions.
Faces under 80 px or score 0.5 are filtered. Output is a unit 512d vector. Gallery
storage, enrollment aggregation, similarity thresholds and identity voting belong
to the hub/test interface, not this stateless adapter. Concurrent face calls drop
instead of queuing; cancellation waits for native work before session reuse.

### Speech and VAD

Local STT is faster-whisper **small/int8 on CPU**, not the Baseten large-v3 service.
It re-decodes the current utterance about every 1 second, revises one stable ID,
and emits a final after the VAD hangover or input completion. Word times are
relative to `t_start_hub`; long-silence gaps are preserved in hub timestamps.
IDs are unique across utterances and stream restarts. Each instance permits only
one stream. Utterances are capped at 30 seconds; the default 64-packet queue holds
at most 2.56 seconds of audio and raises an actionable error if CPU falls behind.
This is a deliberately bounded local fallback, not a claim of equal live latency
to the cloud. There is no silent audio dropping.

Silero runs directly through ONNX Runtime on CPU; VAD does not import torch. Each
stream has isolated recurrent state and 64 samples of model context. Device
640-sample/40ms chunks are losslessly rebuffered to 512 samples / 32 ms. The gate keeps
320 ms of pre-roll and forwards 512 ms of actual input silence after speech, enough
for Baseten's 300 ms server-VAD finalization. It never substitutes fabricated
silence. A final incomplete frame is available only to local finalization.
`AudioState.speech_active` describes current speech, not hangover transport.

Use `SileroOnnxVad`, `VadGate`, `PcmReframer` directly for timestamped integration,
or `gated_pcm_stream(chunks, gate=..., on_state=...)` for a raw cloud stream. The
callback is synchronous and must be nonblocking. Sample-indexed gate frames let
a cloud adapter align server times around skipped long silences.

## Offline tests

`make test` never downloads models or imports heavy runtimes. Injected engines
exercise absolute coordinates, vocabulary/track IDs, duplicate suppression,
normalized face contracts, bounded inference, cancellation, explicit preloading,
partial/final revisions, stream restart IDs, utterance caps and audio overflow.
An injected ONNX session tests the exact 576-input / 512-new-sample / 64-context model
contract and recurrent state. Gate tests verify byte-for-byte original pre-roll,
real 512 ms silence, resumed speech, and preserved sample gaps.

## Measured fixture run (2026-09-19)

Apple M5 Pro, macOS, Python 3.12.13; Ultralytics 8.4.155, InsightFace 0.7.3,
ONNX Runtime **1.22.0**, faster-whisper 1.2.1, CTranslate2 4.8.2. Keep the ORT
1.22.0 pin: 1.30.0 completed inference but aborted at combined-runtime process
teardown; the identical verification with 1.22.0 finished with exit code 0.

| Component | Load / first use | Warm measurement | Input and checks |
|---|---|---|---|
| YOLO-World small, CPU | 1.88 s load; 114 ms first frame | p50 48.5 ms, p95 59.8 ms; 5 runs | 810×1080 bus, four concepts; four people each frame |
| buffalo_l, CoreML | 2.98 s load; first face 64.7 ms | p50 30.6 ms, p95 31.8 ms; 5 runs | 640×480, one accepted face, unit 512d embedding |
| buffalo_l noise, CoreML | first call including load 3.04 s | p50 30.0 ms, p95 31.7 ms; 5 runs | 640×480 noise, zero faces |
| Silero ONNX, CPU | 24.2 ms load | p50 0.07 ms; 78 warm frames | 16 kHz, exact 512-sample frames; speech detected |
| Whisper small/int8, CPU | 235 ms model load | partial after onset 1.55–1.58 s; final after speech end 1.43–1.50 s | Two paced trials of one synthetic “Where are my keys?” clip; both final texts correct |

The first Whisper trial is process/model-cold and the second reuses its weights;
a fresh VAD session is used for each stream. This short sample does not estimate
a p95 or support an accuracy claim. Local Whisper is visibly slower than the
existing streaming cloud service. No models, gallery data, or recordings are
committed. The full local JSON includes each sample and transcript revision.
