# Single-wearer replay and remaining gaps

2026-09-20 UTC. Fresh runs on `chud3-ai-agent` with OpenAI `gpt-5.6-sol`, reasoning
`none`, real Jev and local code/Chromium. Baseten fallback disabled for attribution.
No runtime concurrency rules, prompts or delivery thresholds changed in this work.

The [fresh isolated baseline](../agent/data/perf/2026-09-20T04-43-06-103Z/REPORT.md)
passed **12/12** task checks. The subsequent shared-account replay passed its
initial keyword/tool checks **11/11**, but a source-date audit found a wrong-day
class answer: **10/11 audited task outcomes**. Both counts are retained; passing
the basic checks is not a complete answer-quality assessment.

## One wearer, one shared session

[Audited report](../agent/data/wearer-perf/2026-09-20T04-48-25-714Z/AUDITED_REPORT.md),
[structured audit](../agent/data/wearer-perf/2026-09-20T04-48-25-714Z/AUDITED_RESULTS.json),
[original automatic report](../agent/data/wearer-perf/2026-09-20T04-48-25-714Z/REPORT.md),
[raw replay](../agent/data/wearer-perf/2026-09-20T04-48-25-714Z/replay.jsonl).

One account/device shares history throughout. A reminder, a deliberately delayed
code job, a keys question and filler overlap. Later tasks use the same account.
History is synthetic and seeded directly in SQLite; new questions go through the
real HTTP event API. Delivery is received and acknowledged by `KawkClient.watch`
over SSE. The timer starts immediately before HTTP submission. This covers
ingestion → Jev → agent/tools → review → outbox → client receipt. It excludes
camera capture, speech/vision models and physical glasses display.

| Task | Audited outcome | HTTP submission → SSE receipt or terminal state |
|---|---|---:|
| Reminder requested for 20 seconds later | PASS | 21.020s |
| Code: wait 12 seconds, then calculate sum of squares | PASS | 21.984s |
| Keys question arriving during that code task | PASS answer; significant queue delay | 24.259s |
| Filler during active work | PASS; no new agent | 0.530s |
| Notebook recall from older history | PASS | 3.964s |
| Today's class topics/homework | **FAIL: answered using yesterday's class** | 4.957s |
| William conversation with unknown audio speaker | PASS | 5.965s |
| Save and query a relationship graph | PASS | 8.979s |
| Read example.com with browser | PASS | 5.985s |
| Two subagents: parking location and pickup code | PASS | 14.975s |
| Missing passport evidence | PASS; abstained | 6.707s |

These are individual trials, not percentiles. No-delivery cases measure terminal
state, with an additional observation window for unexpected SSE messages. Code's
12-second wait and the reminder's 20-second delay are intentional workload time.

## Reminder behavior and concurrency

Creating an explicit reminder uses an LLM task and `create_reminder`. Once saved,
the parent can finish. At the deadline, the scheduler writes the saved reminder
text directly to the outbox: **no new LLM turn or Jev decision**. A speculative
`schedule_followup` is different; it re-enters Jev and may start agent work.

Measured in the shared-account run:

- Reminder outbox creation: **20.028s**, 28 ms after the requested deadline.
- Client SSE receipt: **21.020s**, approximately another 992 ms of delivery delay.
- The code task was still running when the reminder fired.
- Reminder-root model calls after its scheduling task completed: **zero**.
- The keys parent queued for **19.749s** behind the code parent.
- Subagent phase: **two child model calls overlapped**.

Recording and Jev continue during agent execution; a waiting reminder occupies no
agent slot. However, the scheduler admits only one executing parent task per
account. Its execution loop includes multiple model/tool turns and process polls.
It releases its slot on completion or an explicit yield while waiting for children.
An ordinary long-running parent can therefore delay unrelated wearer questions.
This is a measured responsiveness gap, not proof of full parent parallelism.

## What context is shared

| Component | Context it actually receives |
|---|---|
| Jev input routing | New evidence, recent context, active parent goals/statuses |
| Parent agent | Own trigger/history, initial recent evidence, explicitly targeted updates, own children's messages/results |
| Child agent | Supplied goal/context and source references; separate model history |
| Other parent task | Its own history; shared evidence/memory can be searched, but peer model conversations are not automatically inserted |
| Pending reminder | Durable schedule state; `list_reminders` can retrieve it; firing does not open an agent conversation |

The inspected keys context included the reminder request, its scheduling receipt,
the code request and the keys question. It did not contain the other parent's
complete model/tool conversation. Later peer turns are not automatically broadcast.

## Why notebook recall was rejected

The original failed run retrieved the correct evidence and requested `notify:true`.
The host's Jev reviewer returned false, so `finish` stored `notify:false`. The old
trace did not preserve its probability; that exact historical score is unknown.

The new replay records raw Jev scores and varies only the answer wording against
the same evidence and question:

| Proposed answer | Scores | Approved at 0.80 |
|---|---|---:|
| “Your blue notebook was in the front pocket of your backpack.” | 0.76, 0.72, 0.72, 0.73, 0.73 | 0/5 |
| “Your blue notebook was last seen in the front pocket of your backpack.” | 0.82, 0.82, 0.81 | 3/3 |
| Unsupported refrigerator location | 0.03 | 0/1 |

The live notebook task used last-seen wording and scored 0.84. This supports a
diagnosis of wording-sensitive delivery review. Jev returns a score, not a reason,
so a more specific claim about its internal reasoning would be speculation.
These isolated reviewer trials are not extra E2E successes. Thresholds were not
lowered, and the suppressed supported paraphrase remains a quality defect.

## Date correctness and benchmark corrections

The shared-account class sources were captured on **September 19 in Toronto**;
the question was asked on **September 20**. The agent nevertheless described them
as today's class. Keyword checks found the expected homework/topic words and
missed the date mismatch. The audited result is failed. Jev review's `describe`
projection omits source timestamps, so the final reviewer did not receive the
information needed to verify that date claim.

The replay now anchors a lesson explicitly to yesterday with Temporal, checks
source-date citations on the positive case, and adds a negative case asking only
about today's class. Results of focused reruns are recorded separately; changing
the benchmark is not a fix to the agent's temporal reasoning.

The [focused date rerun](../agent/data/wearer-perf/2026-09-20T04-52-15-491Z/REPORT.md)
passed **1/2**: the agent correctly found yesterday's lesson, but its accurate
answer was suppressed by Jev (0.73; terminal result in 5.034s). The explicit
today-only negative case delivered no answer in 8.767s and passed its abstention
check. Its proposed text correctly said no class was captured today; Jev also
suppressed that limitation answer (0.76). These are additional evidence of the
reviewer's false negatives, not a fix or an all-green date evaluation.

The [first overlap replay](../agent/data/wearer-perf/2026-09-20T04-45-48-012Z/REPORT.md)
also exposed a benchmark wait-loop race: the origin task had completed long before
the reminder was due, and the scorer stopped before its SSE tick. The raw trace
does contain reminder delivery at 21.061s. The scorer was corrected and the full
shared-account replay rerun. The original artifact remains unchanged.

## Reproduction and current checks

From `agent/`, using the existing ignored credential configuration:

```sh
bun run perf --live --provider openai --no-fallback
bun run perf:wearer --live
bun run perf:wearer --live --only overlap
bun run perf:wearer --live --only class,class-today
bun run perf:wearer --live --only review
```

New runs write private `data/wearer-perf/<timestamp>/REPORT.md`, `results.json`,
`replay.jsonl`, SQLite evidence/receipts and transcript archives. The replay trace
contains synthetic model contexts, Jev request/response bodies and timing metadata;
authorization headers/provider credentials are excluded.

`bun run check`: **63 passed**, including real local runner/browser checks.
TypeScript checks also passed after the benchmark changes. Remaining priorities
are same-wearer parent scheduling, explicit shared task context, date-aware answer
validation, robust delivery scoring, and actual perception/glasses integration.
