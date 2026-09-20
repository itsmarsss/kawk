# KAWK benchmarks

The goal is correct, timely memories and useful agent activations during ordinary
conversation. Higher FPS alone is not success. This suite keeps policy correctness,
actual model inference, and full-system timing separate.

## What runs now

| Command | Actual execution | Valid evidence |
|---|---|---|
| `policy` | Existing face/product/Jev-bridge policies with synthetic embeddings, observations, clocks and injected decisions | Debouncing, transcript finality, duplicate handling, temporal attribution and overload behavior |
| `component` | Existing local/Baseten adapters on one real JPEG or WAV | Serial same-input first-use and warm request timings; counts and transcripts |
| `trace` | Analysis of recorded, independently annotated JSONL spans | Completed/missed outcomes and measured per-stage latency, separated by warmth and outcome |

`policy` makes no network request and does not load models or touch real galleries.
Its virtual-clock durations are scenario time, **never inference latency**. A
positive injected Jev decision tests the host's behavior, not Jev's intelligence.
The known failures remain failed product expectations in the JSON and command status.

```sh
make test-bench
make bench-kawk
# For a baseline job that tolerates already documented gaps:
make bench-kawk ARGS='--allow-known-gaps'
```

`--allow-known-gaps` changes exit status only. It does not change failures into
passes. Unexpected runner errors still fail. The scenario definitions under
`fixtures/scenarios.json` describe targets independently of today's behavior.

## Real component replay

Local is the default. Existing model assets are required; no deployment is created.
Use the same input, configuration and run count for both backends.

```sh
uv run --extra local --extra sim --extra cloud python -m benchmarks.kawk component objects \
  --input data/fixtures/bus.jpg --output data/benchmarks/objects.json --runs 20

uv run --extra local --extra sim --extra cloud python -m benchmarks.kawk component speech \
  --input data/fixtures/where_keys.wav --output data/benchmarks/speech.json \
  --backends local baseten --runs 5
```

Adding `baseten` explicitly uses the configured existing endpoint and may consume
credits. Face comparisons require a JPEG at most 640 px on the long edge. Speech
requires 16 kHz mono PCM16 WAV. Keep consented real media and results under ignored
`data/`, not in fixtures or git. The face comparison must include labeled identities
and multiple poses before its output says anything about recognition accuracy.

These reuse `scripts/compare_backends.py`; a first request is not a controlled
deployment cold start. Speech boundaries in that existing probe are amplitude
estimates. Object/speech local-vs-cloud models differ. None of these commands
measures camera-to-memory or proves object-event/agent quality.

## Full-system traces

`TraceRecorder` in `record.py` is an opt-in adapter for a replay driver or the new
agent harness. It does not automatically instrument the current browser app.
That integration and a representative annotated camera/microphone recording are
still required before claiming full-system performance.

The JSONL file starts with a manifest containing:

- `type: manifest`, `schema_version: 1.0`, `mode: system_replay` or `model_replay`;
- `run_id`, `pipeline_revision`, actual source-manifest `input_sha256`;
- `synthetic`, `annotation_source`, nonempty `hardware`, `runtime`, and `models`;
- `clock: mapped_hub_monotonic_ms`, `clock_mapping_uncertainty_ms`.
- `trials`: every planned `trace_id`, `warmth`, independently labeled
  `expected_action`, and `required_terminal_stage` for expected actions. Missing
  trials stay in the denominator even when the pipeline emits no records.

Every remaining record has `trace_id`, `warmth` (`cold`, `first_call`, or `warm`),
and either a `stage` with `at_ms` or an independently labeled `outcome`.
Supported stages include capture, first/final speech, stable event, Jev start/end,
agent start/end, memory commit, and display receipt. Use one causal trace per
utterance/event, not one for the whole WebSocket connection. Repeated partial
stages stay on that utterance's trace; latency uses the first partial and the
report retains the partial-update count.

An outcome declares `result` (`correct`, `incorrect`, `timeout`, `dropped`, or
`abstained`), `expected_action`, and its `required_terminal_stage` for an expected
action. A claimed correct action without its completion stage becomes `incomplete`.
No-action success is labeled `correct` with `expected_action: false` and requires
input evidence plus `observation_complete`. An agent action, memory write, or
action display on that trace contradicts a no-action label. An abstention
is reported separately; it must not silently count as successful retrieval.

```sh
uv run python -m benchmarks.kawk trace --input data/benchmarks/run.jsonl \
  --output data/benchmarks/run-report.json
```

Never subtract browser `performance.now()` directly from server `perf_counter()`:
map clock origins and record mapping uncertainty. Speech partner association must
use the source utterance interval, not the eventual receipt time. No raw faces,
voice or transcript text is needed in latency records.

Reports keep cold/first/warm and correct/incorrect populations separate; include
failed, dropped and unlabeled traces in the outcome denominator; and mark absent
spans unmeasured. p95 is withheld below 20 observations and p99 below 100. Even
those counts are descriptive statistics, not proof of a production percentile SLA.
No pure network or GPU-only timing is inferred by subtracting unlike measurements.

## Acceptance plan for the agent harness

Replay identical annotated clips through each configuration. Start with one
stream, then 2/4 independent paced streams. Keep a held-out set with different
voices, phrasing, lighting and head/camera movement. Change one scheduler policy
at a time: baseline, bounded freshest-frame scheduling, adaptive refresh, then
temporal reuse. Microbatching only enters after single-stream correctness passes.

Score wrong-person writes, useful-need trigger precision/recall, false reminders,
memory correctness, duplicate actions, unknown/name flicker, false object
placement/disappearance, critical transcript errors, missed finals, queue depth,
observation age, deadline misses and requests per correct useful event. Separate
conversation-partner association from claims about the actual speaker.

Proposed initial warm p95 budgets (not measured results): first partial within
1 s of speech onset; final within 1 s of speech end; stable object event within
1 s of a usable observation; display within 2 s of final speech. Retention must
cover the whole source event while decisions/agent work finish. Quality gates,
especially wrong-person memory writes and dropped final speech, take priority
over averages or GPU utilization.

See [KAWK pipeline direction](../../docs/KAWK_PIPELINE.md) for the proposed Jev/
agent boundary and [recorded R&D measurements](../../RND_RESULTS.md) for the
historical model comparison. No scheduler speedup is claimed by this suite.
