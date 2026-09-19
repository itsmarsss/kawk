# Cloud buffalo_l face backend

The existing owned experiment is model `qvm6y6eq`, production deployment `32z5mm9`
on Team2. It is normally **INACTIVE**. Activation is billable; the scoped test
reactivates it temporarily and returns it to INACTIVE. Never change Whisper.

The included Truss preserves the already-verified service protocol:

- HTTP `POST https://model-{id}.api.baseten.co/environments/production/predict`;
  `Authorization: Api-Key <key>`.
- Request `{image_b64, min_face_size:80}` or `{op:"metadata"}`.
- Response `{faces:[{box,det_score,embedding_512}], detected_count,accepted_count,
  input_wh,model:"buffalo_l",providers,timings_ms}`.
- Coordinates are absolute pixels in the transmitted JPEG, longest side <=640.
  The client clips detector boxes at image edges, never rescales to a different image.
- `detected_count` includes small rejected faces. Enrollment must require it to equal 1,
  not merely one accepted embedding. Embeddings are 512-dimensional unit vectors.

`model.load()` imports Torch before ONNX Runtime, requests CUDAExecutionProvider,
checks the actual provider ordering, and logs model/provider/version metadata.
This detects a silent all-CPU fallback, although individual unsupported operators
can still run on CPU; the earlier R&D operator-placement audit is separate.

## Build and smoke

Obtain the research-only InsightFace `buffalo_l` weights under their license from
https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip.
The supplied `prepare_weights.py` verifies the exact SHA256 of detection and
recognition files against the already-measured local/cloud pack, then copies them
into `data/models/buffalo_l`. Those files are excluded from Git. No CDN download
happens during model startup.

```sh
uv run python deployments/face/prepare_weights.py /path/to/buffalo_l
baseten model push --dir deployments/face --profile h100-permanent --team 2
uv run --extra cloud python scripts/smoke_face.py --jpeg /path/to/640px.jpg \
  --width 640 --height 480 --model-id qvm6y6eq
```

Replace dimensions with the actual JPEG dimensions. Set `BASETEN_API_KEY` on the server;
the optional `--native-profile`
switch reads only the primary `h100-permanent` profile and never prints its key.
Keep deployment actions explicit: smoke scripts issue inference, not activation.

Deploying a new copy is optional; reusing the existing experiment avoids duplicate
H100 allocations. Use an independent deadline guard before activation. Deactivation:

```sh
baseten model deployment deactivate --model-id qvm6y6eq --deployment-id 32z5mm9 \
  --yes --profile h100-permanent
```

Model IDs are identifiers, not credentials.
Real cloud roundtrip/compute verification is reported separately from offline tests.
