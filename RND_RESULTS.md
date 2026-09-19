# Local/cloud perception R&D — 2026-09-19

Both paths are implemented in the standalone browser lab. On these small
fixtures, local objects/faces have lower delay; cloud Whisper produces earlier
speech updates. The full Remember memory/task/device pipeline is outside this
change.

## Warm latency

Apple M5 Pro, Python 3.12.13, ONNX Runtime 1.22.0. Cloud perception uses one H100
per service. The same input is replayed serially through each backend, with the
first call or trial recorded separately and excluded from warm statistics.

| Measurement | Local median | Cloud median | Warm samples/backend |
|---|---:|---:|---:|
| Face request, same buffalo_l | 32.9 ms | 181.8 ms | 20 |
| Object request, YOLO-World / SAM 3.1 | 44.9 ms | 842.1 ms | 3 |
| Speech onset → first partial, Small/int8 / Large-v3 | 1,920 ms | 642 ms | 3 |
| Speech offset → final | 1,835 ms | 552 ms | 3 |

Face input is a 640×480 one-face JPEG. All calls returned one accepted face.
Local p95 was 35.2 ms; cloud p95 was 771.0 ms. The cloud's maximum of 9,634.2 ms
is retained, with an 8.4 ms server handler on that call. Request minus handler
time includes routing and queueing; it is not a pure network RTT.

Object input is the 810×1080 bus fixture, 137,419 bytes, with the three concepts
`person, keys, phone`. Local returned four people; SAM returned four people and
a phone. Labels were not manually scored. Warm ranges were 43.7–45.9 ms local
and 829.4–846.3 ms cloud. Cloud session/prompt/cleanup wall time was 614–661 ms,
including 311–336 ms of cleanup; this is not isolated CUDA compute. The native
deployment has one H100 80 GiB, 16 vCPUs and 118 GiB host RAM.

Speech input is synthetic “Where are my keys?” at 16 kHz mono PCM16, paced in
512-sample packets. All warm final transcripts were correct. Speech bounds use
an amplitude threshold rather than human annotation. Cloud warm finals ranged
478–574 ms after offset; local ranged 1,819–1,878 ms. Cloud GPU-only time is not
exposed. This compares different models and serving pipelines, not accuracy.

## SAM scope and startup

The exact SAM 3.1 multiplex predictor was verified on an H100 and through the
public Baseten endpoint. It processes bounded windows of already received frames,
reinitializing native sessions on each update. **IDs reset every update.** This
is an explicitly labeled R&D detector, not persistent incremental tracking.

The first native public inference took approximately 11.6 seconds and exceeded
the client's 10-second frame budget. Reconnecting succeeded; subsequent public
and browser calls returned boxes. Native model loading, including imports and
checkpoint loading, separately took 80.3 seconds. Neither includes the complete
deployment build/scheduling delay. These are not controlled full cold-start
benchmarks. Scaled-to-zero SAM may need a minute or more to start, followed by
first-inference warmup and another Start. See deployment verification JSON files for exact
evidence, model IDs and cleanup snapshots.

## Verification and reproduction

129 Python tests, clean Ruff/Pyright, and 20 UI lifecycle assertions passed.
Isolated Chrome fixture tests passed local/cloud object boxes, face enrollment
and recognition, speech transcription, Stop/restart and cancellation cleanup.
The SAM browser probe returned a person box in 794 ms send-to-reply (803 ms
including JPEG work), displayed the ID-reset notice, and stopped cleanly.
Camera fixtures use prerecorded fake media; actual venue conditions remain a
hands-on check. This is not a sustained multi-camera load or quality evaluation.

Use the local/cloud selectors at `http://127.0.0.1:8081/`, or repeat measurements
with `scripts/compare_backends.py`; see the README for setup and commands. Local
model assets, camera/audio fixtures, personal galleries and credentials are not
committed. Cloud keys stay in the server environment or primary Baseten profile.
Owned face/SAM deployments use minimum zero replicas and a 60-second idle delay.
The existing teammate Whisper deployment and its settings were left unchanged.

Jev's code and payload contracts are tested; no live TypeSafe key has been
supplied, so no live Jev latency or prediction claim is made.
