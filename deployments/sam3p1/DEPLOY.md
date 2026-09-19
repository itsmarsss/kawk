# SAM3.1 with bounded arriving-frame windows

This is an explicit R&D mode: **SAM3.1 (windowed, IDs reset)**. It consumes new
JPEGs sequentially and never passes unseen future frames to the model. Every
update reinitializes a finite 1–4-frame window; the default is one frame. This is
not a persistent streaming tracker. Consumers must use `tracker_generation` to
avoid interpreting a reset as an object disappearing or a stable identity.
Hub opt-in is `REMEMBER_SAM_ALLOW_WINDOWED=1`; the client/UI belongs to Lane D's
integrator. Start with at most three concepts while measuring latency.

## Model and implementation provenance

The [official Meta repository](https://github.com/facebookresearch/sam3/tree/2345a4ad109ac29c569da749c91d84f10dc08c40)
is pinned to `2345a4ad109ac29c569da749c91d84f10dc08c40`. The engine calls
`build_sam3_predictor(version="sam3.1")`, then strictly loads every model key.
The checkpoint is 3,502,755,717 bytes with SHA256
`0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6`.
The user-supplied public mirror `AEmotionStudio/sam3.1` is pinned to
`694239a1479aab8fd1317c87c433c58acd7c6eab`; the digest must match the official
`facebook/sam3.1` published checkpoint metadata. This does not change the model's
license requirements. No Hugging Face access token is needed by this mirror path.

Compatibility is narrow and explicit: derive real/imaginary RoPE buffers from
their saved complex buffers, then enforce strict loading; remove only the false
`offload_state_to_cpu` default from the common predictor call when the multiplex
signature lacks it. Actual state offloading is rejected. Eager BF16 is used;
future-dependent hotstart/masklet filters and batched grounding are disabled.
No compile speed or stable tracking claim is made.

For every update, each concept gets an independent `start_session` and prompt.
For a one-frame window the prompt result is already the newest frame. Longer
windows propagate only across already-arrived history and select its last frame.
Every opened session is closed in `finally`, including inference errors. No model
sessions survive between updates. Different concepts may overlap; no cross-label
deduplication is invented. Normalized upstream xywh boxes are converted to
absolute SENT-frame xyxy. JPEG dimensions must match metadata.

## Native Truss

`config.yaml` and `model/model.py` form a native Truss WebSocket package.
The [Baseten WebSocket contract](https://docs.baseten.co/development/model/websockets)
accepts the socket before `Model.websocket`; this method never calls `accept()`.
The entry file uses absolute `model.*` imports because the managed runtime loads
it directly, without a package context. A regression exercises that exact import
shape. Ordinary local package imports would not detect this deployment failure.
A build command downloads the pinned checkpoint into `/opt/sam31-model` at build
time; `SAM31_CHECKPOINT` points to that exact file and `load()` verifies its digest.
The explicit path avoids different HF cache locations in build and runtime.
A supplied
`SAM31_CHECKPOINT`/data-directory checkpoint is also supported. `SAM31_WINDOW_SIZE`
defaults to1 and accepts1–4. One active socket per engine is admitted; other
connections receive a busy error. The integration client should keep one frame
in flight and drop obsolete captures instead of queuing them.

The native configuration has been schema-validated locally. **A training-worker
smoke is not a deployed native Truss endpoint.** Native image build, endpoint
authentication, venue RTT and browser camera behavior remain separate gates.
When explicitly authorized to deploy, select the intended Baseten profile/team
and run `baseten model push` from this directory. Do not deploy by merely running
unit tests or importing modules.

The managed image exposes `python3` for build commands. The legacy `model_cache`
warmer failed on the commit-pinned mirror because it expected a nonexistent HF
`refs/` directory; the direct pinned build download avoids that path. Neither
packaging workaround relaxes checkpoint hashing or strict model loading.

For an authorized idle endpoint, set minimum replicas to 0, maximum to 1 and a
short scale-down delay using `baseten model deployment update-autoscaling`.
Verify the accepted settings and actual zero active replicas separately; an
accepted update alone does not establish that billing has stopped. A cold
endpoint also needs a longer connection-start budget than warm frame inference.

## Wire protocol

1. Send JSON `{"type":"start_session","vocabulary":["person","car","bicycle"]}`.
2. Receive `{"type":"ready","model_version":"sam3.1","streaming_mode":"windowed_reinitialization","tracking_persistent":false,"window_size":1}`.
3. Send JSON `{"type":"frame","frame_id":"capture-1","wh":[960,540]}`, then one binary JPEG.
4. Receive `{"type":"frame","frame_id":"capture-1","wh":[960,540],"tracker_generation":1,"objects":[{"track_id":"session:g1:c0:o1","label":"person","box_xyxy":[10,20,100,200],"score":0.9}],"timings_ms":{...},"window_frames":1,"concept_count":3,"memory":{...}}`.
5. `{"type":"add_concept","noun":"cup"}` receives `{"type":"concept_added","noun":"cup"}`. This affects the next update.
6. `{"type":"end_session"}` closes the socket. Errors use `{"type":"error","message":"..."}` and close it.

IDs are unique across connections and generations, not persistent identities.
Resolution changes clear history. Vocabulary is bounded to20 distinct concepts;
JPEGs to8MiB and12 megapixels. There is no application-level frame queue.
Cancellation waits for the in-flight model thread before releasing the worker,
so a disconnected client cannot let another socket concurrently use the predictor.

## Reproducible bounded GPU check

`training.py` uses the previously proven PyTorch2.10/CUDA12.8 runtime and one
H100. `bootstrap.py` locates that image's actual Torch interpreter; `cloud_run.py`
installs the pinned source, hashes weights and invokes `cloud_smoke.py` with a
finite timeout. The smoke starts a real loopback WebSocket server with the same
handler/engine, reads and sends each fixture JPEG only after the previous reply,
and checks newest-frame IDs, dimensions, bounded history and zero active model
sessions after each update. It measures window1/one concept, window1/three
concepts, and a growing window4/one concept; saves boxes, timings and GPU memory.
It uses prerecorded fixture images as live protocol inputs, **not a webcam**.
Its roundtrip is on the worker, **not Mac-to-cloud latency**.

`verification.json` contains the sanitized measured worker-loopback summary. Full
logs, overlays, credentials-free runtime IDs and temporary deadline guards are
kept in the ignored `results/` evidence folder, outside Git. The completed GPU
check established arriving-frame inference; native endpoint and Mac/UI results
are recorded separately. No throughput is inferred from older preloaded-video
benchmarks.

The native production endpoint also passed an authenticated Mac hub-client smoke:
two sequential copies of the raw 960×540 fixture, with three concepts, returned
four person boxes each and distinct generation namespaces. Request times were
859.4 and 901.4 ms; server inference totals were 565.5 and 617.7 ms. These are two
warm fixture updates, not a webcam or general accuracy evaluation. The first
native request exceeded the client's 10-second timeout; server logs show inference
finished and cleaned up afterward, then the warm retry passed. Native
`model.load()` took 80.334 seconds including imports/checkpoint work. A scale-to-zero
restart therefore needs a separate cold-start budget; warm latency is not the
time to the first usable result after inactivity.

Verified model ID: `w7m74v6w`; deployment: `w55ov5p`. The production socket is
`wss://model-w7m74v6w.api.baseten.co/environments/production/websocket`.
Set `BASETEN_SAM_MODEL_ID=w7m74v6w` and `REMEMBER_SAM_ALLOW_WINDOWED=1` in the
client environment, using the existing authorized Baseten credential resolver.
The recorded deployed instance uses minimum0 / maximum1 / idle60s autoscaling;
its final observed lifecycle state is recorded in `verification.json`.

The cold server log interval from the first prompt to final session cleanup was
about 11.64 seconds; it is not a measured client roundtrip. The integrator also checked
the actual browser route with a prerecorded fake camera: a person box rendered,
Start/Stop and the reset-ID notice worked, and there were no JavaScript errors.
That single browser reply took 794 ms, or 803 ms including capture/JPEG encoding.
An independent identical-input bus-fixture comparison (810×1080, three warm
frames) measured 44.91 ms median locally versus 842.10 ms through public SAM. The
two backends returned different object sets; this is a timing comparison, not an
accuracy ranking. The evidence paths and input scopes are in `verification.json`.

Offline tests (`hub/tests/test_cloud_sam_server.py`) use a fake predictor only to
verify protocol bounds, no-future-frame windows, ID reset, coordinate conversion,
per-concept cleanup and cancellation admission. They require no Torch/GPU/Pillow
and do not constitute model inference evidence.
