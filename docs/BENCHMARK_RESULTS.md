# Harness benchmark evidence

Newer evidence: [fresh single-wearer replay and audited outcomes](SINGLE_WEARER_BENCHMARK.md).
It includes a 12/12 current baseline, shared-account SSE timing, reminder/code
overlap, notebook review scores, and a wrong-day answer missed by keyword checks.
The historical runs below remain preserved for comparison.

Reviewed 2026-09-20 UTC against saved reports and `agent/scripts/perf.ts`.
This summarizes existing runs; no new model requests were made for this review.

We have live-provider task checks with synthetic perception history, plus local
regression tests. We do not yet have camera-to-glasses latency measurements or a
representative accuracy/throughput benchmark for continuous ambient use.

## What the timings include

The benchmark sends a question through the real HTTP event API, runs Jev,
the agent/tool loop and delivery review, then polls the notification API every
50 ms and acknowledges the result. A quiet/abstaining case ends at its terminal
gate/task state. A rejected answer's time is time to completion without delivery.

Reports call this ingestion-to-result latency. Precisely, the timer starts just
before seeding the small history fixture and creating the local HTTP server, so
it includes that setup as well as prompt ingestion and result handling. Seeded
history goes directly into SQLite and bypasses its own Jev classification.

These runs use real OpenAI `gpt-5.6-sol`, reasoning `none`, and real Jev. Baseten
fallback was disabled. Tools ran for real. Each report has one sample per case,
with sequential parent tasks; the subagent case exercises concurrent children.
They do not exercise sustained capture, transcription, vision, SSE scheduling,
physical display receipt, or concurrent incoming-event load.

Pass/fail checks expected delivery or abstention, required tool receipts, expected
answer details through regexes, and child count where requested. These are narrow
task acceptance checks, not a blind human evaluation of general answer quality.

## Initial local-runner run

[Saved report](../agent/data/perf/2026-09-20T04-00-13-103Z/REPORT.md) and
[raw timings](../agent/data/perf/2026-09-20T04-00-13-103Z/results.json).
This was the first run after replacing Docker with local `/tmp` execution.

| Case | Outcome | Total | Initial Jev | Model calls | Model time | Delivery review |
|---|---|---:|---:|---:|---:|---:|
| Recall an older notebook observation | FAIL: correct answer suppressed | 6.618s | 0.641s | 2 | 5.467s | 0.259s |
| Calculate sum of squares, 1 through 1000 | PASS: 333,833,500 delivered | 7.397s | 0.268s | 3 | 6.747s | 0.222s |
| Open example.com and describe its title/purpose | PASS | 4.288s | 0.200s | 2 | 3.412s | 0.265s |

**2/3 passed.** The notebook evidence was retrieved and the proposed answer was
correct; Jev's delivery review rejected it. This remains a real failure, not a
successful user-visible recall. The sample is too small to estimate accuracy.

Model spans account for about 91% of the code case and 80% of the browser case.
The code task spent three separate model calls choosing the command, polling its
process, and returning the answer. Reported reasoning tokens were zero. Waiting
for the first text/tool-argument delta still took 1.216–3.320s per call across
this run; provider queueing, prompt processing and network time are not separated.

| Local operation | Measured tool span |
|---|---:|
| `grep_history` for notebook | 16 ms |
| First `run_code` dispatch | 11 ms |
| `poll_process` | 3 ms |
| First `browser_goto`, including launch/navigation | 280 ms |

Code dispatch is not total command runtime. Browser timing includes navigation
and varies with network/cache. These are individual samples, not percentiles.
Delivery review is nested inside `finish`; do not add both spans. Model totals
here are sequential; summing concurrent child calls does not give wall time.

## History-grep tasks

The [post-guidance run](../agent/data/perf/2026-09-20T03-22-38-318Z/REPORT.md)
passed all four cases after moving retrieval to `grep_history`:

| Case | Result | Total |
|---|---|---:|
| Keys moved between two sightings | PASS | 6.56s |
| Review calculus topics and homework from transcripts | PASS | 8.61s |
| Recall William conversation while preserving unknown speaker | PASS | 6.40s |
| Recall older notebook observation | PASS | 3.81s |

The [preceding run](../agent/data/perf/2026-09-20T03-20-50-408Z/REPORT.md)
was 3/4: correct keys recall was suppressed. Guidance then removed unnecessary
source rereads when grep already returned complete evidence. Jev thresholds did
not change; 4/4 on the rerun does not establish that suppression is fixed.
The six grep calls in the preceding run took 10–16 ms on tiny fixtures.
These runs predate the local-runner change, but their tasks did not use code/browser.

## Broader historical task coverage

An [earlier ten-case run](../agent/data/perf/2026-09-20T03-00-27-177Z/REPORT.md)
passed 10/10 after iteration. It predates both the grep migration and local runner,
so it is coverage evidence, not a fresh full-suite result for today's configuration.
Additional historical/focused cases include:

| Case | Result | Total | Source |
|---|---|---:|---|
| Create entities and relationship, then query graph | PASS | 9.496s | Ten-case run |
| Delegate parking and dry-cleaning recall to two children | PASS | 13.281s | Ten-case run |
| Abstain on missing passport evidence | PASS | 4.639s | Ten-case run |
| Stay quiet on filler | PASS; no agent call | 0.266s | Ten-case run |
| Deliver a reminder requested for 20 seconds later | PASS | 20.097s | [Focused timing run](../agent/data/perf/2026-09-20T03-03-06-937Z/REPORT.md) |
| Explain that seeing the owner does not identify the wearer | PASS | 4.237s | [Focused identity run](../agent/data/perf/2026-09-20T03-10-57-635Z/REPORT.md) |

The reminder total includes its intended 20-second wait: observed delivery was
about 97 ms beyond that requested interval in this sample. Earlier runs retained
in [ambient verification](AMBIENT_MEMORY_VERIFICATION.md) include activation and
delivery failures. A focused Jev check passed 11/12, with a valid qualified
speaker-identity answer falsely suppressed. Do not combine selected passing
reruns into an overall accuracy rate.

## Regression checks and unmeasured areas

Latest recorded `bun run check`: **63 passed**, including six real local
code/browser/lifecycle tests. This checks behavior such as persistence, source
invalidation, history search, reminders and tool cleanup; it is not a model-quality
or latency score. See [local runner verification](LOCAL_RUNNER.md).

Still unmeasured: repeated-trial latency distributions; Jev trigger precision/
recall on representative conversations; missed/false notifications over hours;
large-history grep cost; sustained event-queue delay and throughput; Baseten
fallback performance in the current configuration; actual audio/video timing
alignment; and capture-to-physical-display latency. The live benchmark uses API
polling, whereas the service's SSE loop checks every second, potentially adding
roughly one second of delivery scheduling delay.

A useful next benchmark is a repeated full task suite on the current runner,
followed by a paced mixed-event replay with enough history to expose queueing and
retrieval costs. Annotated camera/audio replay is required for full-product E2E.
