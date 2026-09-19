# Cloud perception deployment and verification

The hub stays local. Cloud choices use typed adapters and explicit API keys;
importing them does not load a GPU/ML runtime or activate a model. A request to a
scaled-to-zero deployment can wake it and incur usage. Never print keys, commit
weights, or change another teammate's service.

| Backend | Implementation and actual verification |
|---|---|
| Whisper | Existing `wdlg2oe3` / `wldeyy7`. Two real-service fixture utterances returned correct finals through the new adapter; zero dropped frames. Keep teammate deployment untouched. [Details](stt/DEPLOY.md), [evidence](stt/verification.json). |
| Face | Existing owned `qvm6y6eq` / `32z5mm9`, exact `buffalo_l` pack and HTTP schema. Real new-adapter smoke passed, separately from warm performance measurements. Normally INACTIVE; temporary R&D activation is independently guarded and restored afterward. [Details](face/DEPLOY.md). |
| SAM3.1 | Explicit **windowed R&D**, not native persistent incremental tracking. Exact multiplex checkpoint; only received JPEGs enter the bounded window. IDs reset each update. GPU, loopback and public-endpoint verification are separate gates. See [details](sam3p1/DEPLOY.md) and its results; do not infer availability from a training job. |
| Jev | Official API verified, whole-bank requests and strict response parsing tested offline. No live inference or latency claim without a TypeSafe key. [Details](jev/DEPLOY.md). |

Cloud constructors are `BasetenSamBackend(model_id, api_key)`,
`BasetenFaceBackend(model_id, api_key)`, `BasetenWhisperBackend(model_id, api_key)`,
and `TypeSafeJevBackend(api_key, model="jev-1.13.0")`. All expose
`last_timings_ms`; server compute and client roundtrip remain separate metrics.
Close Face/Jev with `aclose()`, close SAM with `end_session()`, and close/cancel the
Whisper async generator on disconnect. Keys stay on the Mac server, never browser JS.

For windowed SAM, explicitly opt in with `allow_windowed=True` (the testing UI's
`REMEMBER_SAM_ALLOW_WINDOWED=1` enables this). Use a small three-concept vocabulary
and a measured response budget, e.g. 10 seconds for R&D startup. It must be labeled
“SAM3.1 (windowed, IDs reset)”; `tracking_persistent` remains false. The client
rejects SAM3.0 and rejects unannounced capability substitutions.

Video requests have at most one in flight; ignored frames have
`last_frame_accepted=False`. Never treat their empty return as observed absence.
`FaceRequestTimeout` signals a skippable slow frame; authentication, service-status,
and connection errors remain actionable failures. Bound consecutive timeout retries
in the caller rather than ending enrollment after one transient delay.
SAM's `recovering=True` and bounded `lifecycle_events` signal a tracker reset.
Freeze track-ending/LastSeen until IoU reassociation of the accepted frame, then
call `acknowledge_reassociation()`. Windowed mode requires reassociation every
update; it offers no native identity continuity guarantee.

Whisper partials replace by `seg_id`. IDs include stream and connection namespaces.
Audio is consumed only after initial metadata readiness. Unlike video, its bounded
buffer backpressures and reports overflow instead of silently discarding words.
The frozen bytes-only input has no device capture timestamps: hub anchors are
estimates and service word boundaries can include silence.

## Before a live demo

1. Run `make test`; keep a working local configuration before enabling cloud services.
2. Set the intended model IDs and server-side keys. Verify the exact deployment is
   ready; inactive/building is unavailable, not an empty detection result. Activate
   only owned services with an independent cleanup deadline. Leave teammate Whisper
   unchanged. A missing TypeSafe key leaves Jev live inference unverified.
3. Run each explicit fixture smoke below. For SAM, verify its advertised mode and
   reset behavior, then inspect boxes on the actual scene and vocabulary. The
   supplied R&D windowed mode does not meet the persistent-tracking requirement.
4. Grant camera/microphone permissions, enroll consenting participants, and test
   restart/cancellation plus the local/cloud selectors in the testing UI. Recheck
   face matching under venue lighting before choosing a similarity threshold.
5. Measure warm request latency separately from activation/startup and GPU handler
   time. Rehearse switching to local backends if the network is slow. Mock and
   prerecorded replay remain explicit demonstration fallbacks, not live evidence.

## Explicit smoke and enrollment

`make smoke` prints usage without sending data or waking GPUs. Choose a service
and explicit fixture, for example:

```sh
uv run --extra cloud python scripts/smoke_backends.py stt --wav fixture.wav
uv run --extra cloud python scripts/smoke_backends.py face --jpeg fixture.jpg --width 640 --height 480
uv run --extra cloud python scripts/smoke_backends.py sam --jpeg frame.jpg --width 640 --height 480 --allow-windowed
uv run --extra cloud python scripts/smoke_backends.py jev --live
```

Set the model ID environment variables and `BASETEN_API_KEY` / `TYPESAFE_API_KEY`.
For Baseten smoke commands only, explicit `--native-profile` reads the primary
`h100-permanent` profile. There is no reserve-profile fallback.

Enrollment is always user initiated and consented; no setup/test opens a camera:

```sh
uv run --extra local --extra sim python scripts/enroll.py --name Sarah --camera 0 --consent
```

The command requires 5–10 consistent single-face samples, rejects even small extra
detected faces, normalizes the centroid, and tags/persists a `buffalo_l` gallery
compatible with the existing testing UI. Restart the server after CLI enrollment
to reload its in-memory gallery. Camera/TCC capture itself remains human verified.

Keep independent absolute deadlines for owned GPU experiments. Restore only the
resources created/reactivated for the experiment; leave streaming Whisper alone.
Deployment build/activation/warmup time is excluded from steady inference claims.
