# Merged bridge verification — 2026-09-20

Two isolated runs used the real Node memory service, Bun harness, Jev API, OpenAI
Responses API, local code runner, Playwright and proxied SSE notifications.
Historical speech, face identities and a sign image were controlled fixtures.
These results measure request/observation submission to SSE receipt, not physical
speech onset, iPhone camera latency or OS push delivery. Each case ran once.

| Case | Result | Observed time |
|---|---|---|
| Keys recall from three hours earlier | Correct blue bowl/kitchen-door answer with source refs | 8.50s |
| Class notes and homework | Correct BFS/FIFO/unweighted paths and exercise7 | 7.71s |
| William conversation | Correct greenhouse/humidity/solar-panel discussion | 6.92s |
| Schedule 20-second reminder | Durable reminder receipt and confirmation | 5.80s |
| Code while reminder waits | Executed sum-of-squares calculation:338350 | 6.20s |
| Reminder wake | Separate LLM turn delivered stretch reminder | 22.47s from original request, about2.47s after due time |
| Fresh-camera interrupt | Jev requested one extra image; correct Room314/Robotics Lab answer | 9.21s |
| Person reminder creation | Bound Vitamin B reminder to Kenny's gallery UUID | 8.58s |
| Kenny reappears | New face evidence woke a separate LLM reminder turn | 5.03s |
| Browser/files | Downloaded CSV, computed totals, created/uploaded summary through browser | 25.20s |
| Upload verification | Fixture server received project `merged-demo`, category `Research`, correct CSV total94.40 | Content check passed |
| Cancel code | Running task changed to cancelled through memory-page proxy | 4ms API/state transition; process teardown is not included in this number |

All12 checks passed. The first run's printed summary counts six ordinary cases;
its separate reminder-wake record is the seventh. The script now counts wakes in
its summary too. The second run contains five checks. Raw synthetic results and
telemetry remain in ignored `agent/data/merged-perf/2026-09-20T07-57-12-560Z/` and
`2026-09-20T08-00-07-862Z/`. Run again with:

```sh
cd agent
bun scripts/merged-perf.ts --live
# Optional subsets:
bun scripts/merged-perf.ts --live --only person,browser,cancel
```

For the first run, mean Jev classification was282ms, mean delivery review213ms,
and mean OpenAI model turn2.49s across16 calls. The seven-to-nine-second answers
include multiple model/tool turns. These are sample means, not p95 guarantees.
The simple sign's image interpretation took3.61s; a complex real camera frame
can take much longer.

## Local perception through the merged proxy

- Local Whisper received real-time PCM through `:8082/ws/speech?backend=local`.
  Generated speech “The blue notebook is on the kitchen table” produced the
  correct final transcript with word offsets. Ready arrived at63ms, first partial
  at2.05s and final at3.96s after connection. This is generated speech, not a venue
  microphone accuracy trial.
- Local InsightFace received six frames through `:8082/ws/faces?backend=local`.
  An existing recorded image matched its existing gallery UUID. Frame round trips
  were93,41,59,48,42,41ms. No enrollment/gallery mutation occurred. This checks the
  local serving path, not recognition accuracy on unseen people or new conditions.
- Original source data was preserved; consistent pre-cutover SQLite backups and
  local probes are in the space's private `.context/merged-demo/`.

## Regression coverage and limits

Current automated suites:443 Python tests,81 Bun tests,284 memory-service tests,
84 client tests. Typechecks/builds pass; Python ruff/pyright pass. Claude's isolated
browser QA passed27 checks before the final pure-state-machine race fixes. Those
fixes have dedicated client regressions. See [the UI report](MERGED_UI_VALIDATION.md).

Integration regressions cover durable outage/restart delivery, historical backfill
without activation, rollback, transcript revisions, stale/deleted source rejection,
gallery deletion propagation and late-name ordering, camera claim/session/expiry,
and invalid batch reuse recovery. JPEG writes now use `write-file-atomic`; history
scoring yields between queries and reports context/model/commit timing separately.

The original sustained live scene writer still has a substantial backlog. A sample
of150 recent provider operations showed complex image interpretation p50≈25.2s,
p95≈29.5s; writer calls p50≈12.0s, p95≈16.3s with7 failures among30 attempts.
Those are per-attempt provider timings, not full batch latency. Eight vision workers
helped clear the vision queue, but ordered writing/retries remain a bottleneck.
A copied-store probe spent6.76s building four-frame context, including6.57s in42
exact vector searches. Yielding improves request responsiveness, not search cost.

Historical photos, raw speech and fresh interpreted frames can support agent
answers independently of a completed scene update. This does not make the derived
current-state projection real-time. Do not claim iPhone Continuity Camera, physical
glasses, noisy-venue perception, background iOS push or robust long-run throughput
were verified by these checks.
