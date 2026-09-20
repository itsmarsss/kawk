import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Harness } from "../src/harness";
import { Store } from "../src/store";
import { Jev } from "../src/jev";
import { createModels } from "../src/providers";
import { LocalRunner } from "../src/runner";
import { serve } from "../src/server";
import { KawkClient } from "../client";
import { ACTIVE, type Gate, type Notification, type PerceptionEvent } from "../src/contracts";
import { Telemetry, type TelemetryEvent } from "../src/telemetry";
import { Temporal } from "@js-temporal/polyfill";

// Synthetic single-wearer replay, real providers/tools, actual client SSE receipt.
// No camera, microphone or physical display is exercised. Separate data directory.
if (!process.argv.includes("--live")) {
  console.error(
    "Usage: bun scripts/wearer-perf.ts --live [--only overlap,class,class-today,review,...]",
  );
  process.exit(1);
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Configure TYPESAFE_API_KEY in agent/.env");
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex < 0 ? null : new Set((process.argv[onlyIndex + 1] ?? "").split(","));
const allowed = [
  "overlap",
  "notebook",
  "class",
  "class-today",
  "person",
  "graph",
  "browser",
  "subagents",
  "unknown",
  "review",
];
if (only && [...only].some((id) => !allowed.includes(id))) throw new Error("Unknown --only case");
const selected = (id: string) => !only || only.has(id);
const timeZone = "America/Toronto";
const localDay = (epoch: number) =>
  Temporal.Instant.fromEpochMilliseconds(epoch)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const dir = resolve("data/wearer-perf", runId);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const owner = "one-synthetic-wearer";
const start = performance.now();
const now = () => Math.round(performance.now() - start);
function record(kind: string, fields: Record<string, unknown> = {}) {
  const item = { kind, atMs: now(), epochMs: Date.now(), ...fields };
  appendFileSync(join(dir, "replay.jsonl"), JSON.stringify(item) + "\n", { mode: 0o600 });
  if (["case.sent", "case.result", "sse.received", "probe.review"].includes(kind))
    console.log(JSON.stringify(item));
}
const store = new Store(join(dir, "evidence.sqlite"));
const spans: TelemetryEvent[] = [];
const telemetry = new Telemetry((e) => {
  spans.push(e);
  record("telemetry", { event: e });
});
const models = createModels({
  ...process.env,
  KAWK_MODEL_PROVIDER: "openai",
  BASETEN_API_KEY: undefined,
});
function measuredJev(context: Record<string, unknown>) {
  return new Jev({
    apiKey: apiKey!,
    model: process.env.KAWK_JEV_MODEL,
    fetch: async (url, init) => {
      const request = JSON.parse(String(init?.body));
      const began = now();
      // Record only synthetic request/response bodies, never authorization headers.
      record("jev.request", { ...context, request });
      const response = await fetch(url, init);
      const body = await response.clone().json();
      record("jev.response", {
        ...context,
        durationMs: now() - began,
        status: response.status,
        body,
      });
      return response;
    },
  });
}
const gate: Gate = {
  async decide(input, signal) {
    const decision = await measuredJev({ eventId: input.event.id }).decide(input, signal);
    record("decision", { eventId: input.event.id, decision });
    return decision;
  },
  async review(input, signal) {
    const approved = await measuredJev({ goal: input.goal, phase: "review" }).review(input, signal);
    record("review", { goal: input.goal, approved });
    return approved;
  },
};
let modelCall = 0;
const harness = new Harness({
  store,
  gate,
  telemetry,
  model: {
    async complete(messages, tools, signal) {
      const call = ++modelCall;
      record("model.context", { call, messages });
      const result = await models.model.complete(messages, tools, signal);
      record("model.response", { call, message: result.message, diagnostics: result.diagnostics });
      return result;
    },
  },
  runner: new LocalRunner(),
  artifactDir: join(dir, "artifacts"),
  transcriptDir: join(dir, "transcripts"),
  timeZone,
});
// Keep the generated client token in memory only.
const clientToken = crypto.randomUUID() + crypto.randomUUID();
const api = serve(harness, { owner, token: clientToken, port: 0 });
const client = new KawkClient(api.url, clientToken);
const received: { notification: Notification; atMs: number }[] = [];
const streamAbort = new AbortController();
const stream = (async () => {
  for await (const notification of client.watch(streamAbort.signal)) {
    const atMs = now();
    received.push({ notification, atMs });
    record("sse.received", {
      notification,
      receivedAtMs: atMs,
      transportMs: Date.now() - notification.createdAt,
    });
    await client.ack(notification.id);
  }
})().catch((error) => record("sse.error", { message: String(error) }));

function event(
  id: string,
  text: string,
  kind: PerceptionEvent["kind"] = "transcript",
  agoMs = 0,
): PerceptionEvent {
  const at = Date.now() - agoMs;
  return {
    id,
    text,
    kind,
    deviceId: "one-glasses",
    streamId: "wearer-replay",
    revision: 0,
    final: true,
    sourceStart: at,
    sourceEnd: at,
    confidence: 0.99,
    speakerId: null,
    personIds: [],
    provenance: "synthetic-one-wearer-benchmark",
  };
}
const seeds = [
  event(
    "notebook-source",
    "The wearer's blue notebook was seen in the front pocket of their backpack.",
    "observation",
    7200000,
  ),
  event(
    "keys-old",
    "The wearer's distinctive red-tag keyring was seen on the kitchen counter.",
    "observation",
    7200000,
  ),
  event(
    "keys-new",
    "The same red-tag keyring was later seen inside the blue backpack's front pocket.",
    "observation",
    3600000,
  ),
  event(
    "class-a",
    "Calculus class: today we covered derivatives and the chain rule.",
    "transcript",
    10800000,
  ),
  event(
    "class-b",
    "For calculus homework, solve exercises 4 through 8 on page 72.",
    "transcript",
    10799000,
  ),
  {
    ...event(
      "william",
      "Conversation while William was visible: I visited Iceland last week and enjoyed the hiking. The audio speaker was not identified.",
      "transcript",
      7200000,
    ),
    personIds: ["william"],
  },
  event(
    "parking",
    "The wearer parked their car on level B2 in the green zone near lift C.",
    "observation",
    7200000,
  ),
  event("pickup", "The pickup code for the wearer's dry cleaning is 7351.", "transcript", 7200000),
];
// Anchor the lesson to yesterday regardless of the hour this script runs.
const lessonAt = Temporal.Now.zonedDateTimeISO(timeZone)
  .subtract({ days: 1 })
  .with({ hour: 14, minute: 0, second: 0, millisecond: 0 }).epochMilliseconds;
for (const [index, id] of ["class-a", "class-b"].entries()) {
  const source = seeds.find((s) => s.id === id)!;
  source.sourceStart = source.sourceEnd = lessonAt + index * 1000;
}
for (const seed of seeds) store.ingest(owner, seed, false);
record("manifest", {
  runId,
  owner,
  synthetic: true,
  seeds,
  provider: models.provider,
  model: models.modelName,
  reasoning: models.reasoning,
  fallback: false,
  boundary:
    "Immediately before HTTP POST to client SSE notification receipt; no capture/perception/display",
  seededHistoryBypassesJev: true,
});

type Spec = {
  id: string;
  prompt: string;
  expected?: "answer" | "quiet" | "abstain" | "reminder";
  matches?: RegExp[];
  tools?: string[];
  children?: number;
  sourceDay?: string;
};
type Job = Spec & { sentAtMs: number; sourceEnd: number };
type Result = {
  id: string;
  passed: boolean;
  errors: string[];
  elapsedMs: number;
  clientMs: number | null;
  queueMs: number | null;
  modelCalls: number;
  modelMs: number;
  answer: string | null;
  [key: string]: unknown;
};
const jobs: Job[] = [];
const results: Result[] = [];
const rootFor = (id: string) => {
  const row = store.one<{ id: number }>(
    "SELECT id FROM gate_jobs WHERE owner=? AND event_id=? ORDER BY id DESC LIMIT 1",
    owner,
    id,
  );
  return row ? store.task(`gate-${row.id}`) : null;
};
async function send(spec: Spec): Promise<Job> {
  const source = event(spec.id, spec.prompt);
  const job = { ...spec, sentAtMs: now(), sourceEnd: source.sourceEnd };
  jobs.push(job);
  record("case.sent", { id: job.id, prompt: job.prompt, sourceEnd: job.sourceEnd });
  await client.send([source]);
  record("case.accepted", { id: job.id, httpMs: now() - job.sentAtMs });
  return job;
}
async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const until = now() + timeoutMs;
  while (now() < until) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}
async function finish(job: Job): Promise<Result> {
  let terminalAt: number | null = null;
  const expected = job.expected ?? "answer";
  const found = () => {
    const root = rootFor(job.id);
    return (
      root &&
      received.find((n) =>
        expected === "reminder"
          ? !!store.one(
              "SELECT 1 FROM reminder_wakes w JOIN reminders r ON r.id=w.reminder_id WHERE w.task_id=? AND r.task_id=?",
              n.notification.taskId,
              root.id,
            )
          : n.notification.taskId === root.id,
      )
    );
  };
  const ended = await waitUntil(
    () => {
      if (found()) return true;
      const root = rootFor(job.id);
      const gateRow = store.one<{ state: string }>(
        "SELECT state FROM gate_jobs WHERE owner=? AND event_id=? ORDER BY id DESC LIMIT 1",
        owner,
        job.id,
      );
      if (
        (root && !ACTIVE.includes(root.status)) ||
        (!root && gateRow && ["done", "failed"].includes(gateRow.state))
      ) {
        if (
          expected === "reminder" &&
          harness.reminders
            .list(owner)
            .some((r) => r.refs.some((ref: { eventId: string }) => ref.eventId === job.id))
        ) {
          terminalAt = null;
          return false;
        }
        terminalAt ??= now();
        // Leave two SSE ticks for queued delivery and observe silence for quiet cases.
        return now() - terminalAt >= 2100;
      }
      return false;
    },
    Math.max(1000, job.sentAtMs + 190000 - now()),
  );
  const root = rootFor(job.id);
  const notification = found() || null;
  const errors: string[] = [];
  if (!ended) {
    errors.push("Benchmark deadline");
    if (root) harness.cancel(root.id);
  }
  if (["answer", "reminder"].includes(expected) && !notification)
    errors.push("No SSE notification delivered");
  if (["quiet", "abstain"].includes(expected) && notification)
    errors.push("Unexpected notification");
  if (expected === "quiet" && root) errors.push("Filler activated a task");
  if (expected === "abstain" && (!root || !["completed", "abstained"].includes(root.status)))
    errors.push("No clean abstention");
  const names = root
    ? store
        .all<{ name: string }>(
          "SELECT r.name FROM receipts r JOIN tasks t ON t.id=r.task_id WHERE t.root_id=? AND r.state='done'",
          root.id,
        )
        .map((r) => r.name)
    : [];
  for (const name of job.tools ?? [])
    if (!names.includes(name)) errors.push(`Missing tool: ${name}`);
  for (const match of job.matches ?? [])
    if (!notification || !match.test(notification.notification.text))
      errors.push(`Missing answer detail: ${match.source}`);
  if (
    job.sourceDay &&
    notification &&
    !notification.notification.refs.some((ref) => {
      const source = store.latest(owner, ref.eventId);
      return (
        source &&
        ["class-a", "class-b"].includes(source.id) &&
        localDay(source.sourceEnd) === job.sourceDay
      );
    })
  )
    errors.push("Class answer does not cite a lesson from the requested local date");
  if (
    job.children &&
    (!root || store.children(root.id).filter((t) => t.status === "completed").length < job.children)
  )
    errors.push("Missing completed children");
  const relevant = spans.filter((s) => root && s.rootId === root.id);
  const firstRun = relevant.find((s) => s.name === "task.running" && s.taskId === root?.id);
  const modelSpans = relevant.filter((s) => s.name === "model.end" || s.name === "model.error");
  const result: Result = {
    id: job.id,
    passed: errors.length === 0,
    errors,
    elapsedMs: (notification?.atMs ?? terminalAt ?? now()) - job.sentAtMs,
    clientMs: notification ? notification.atMs - job.sentAtMs : null,
    queueMs: firstRun ? Number(firstRun.taskAgeMs) : null,
    modelCalls: relevant.filter((s) => s.name === "model.start").length,
    modelMs: Math.round(modelSpans.reduce((n, s) => n + (s.durationMs ?? 0), 0)),
    answer: notification?.notification.text ?? null,
    proposed: root?.result ?? null,
    status: root?.status ?? "no task",
    tools: names,
    rootId: root?.id ?? null,
    outboxMs: notification ? notification.notification.createdAt - job.sourceEnd : null,
    reminderLatenessMs:
      expected === "reminder" && notification
        ? notification.notification.createdAt - job.sourceEnd - 20000
        : null,
  };
  results.push(result);
  record("case.result", result);
  return result;
}
async function run(spec: Spec) {
  if (!selected(spec.id)) return;
  return finish(await send(spec));
}

harness.start();
let failure: string | null = null;
const reviewProbes: { label: string; text: string; approved: boolean; valid: boolean }[] = [];
try {
  await client.syncClock();
  if (selected("overlap")) {
    const reminder = await send({
      id: "reminder",
      prompt: "Remind me in 20 seconds to stretch.",
      expected: "reminder",
      tools: ["create_reminder"],
      matches: [/stretch/i],
    });
    await waitUntil(
      () => !!rootFor(reminder.id) && !ACTIVE.includes(rootFor(reminder.id)!.status),
      25000,
    );
    const reminderPending = harness.reminders.list(owner).length > 0;
    record("overlap.begin", { reminderPending, activeTurns: harness.status().activeTurns });
    const slow = await send({
      id: "slow-code",
      prompt:
        "Run a shell command that waits 12 seconds, then prints the sum of squares of the integers 1 through 1000. Poll until it completes and tell me the numeric result.",
      tools: ["run_code", "poll_process"],
      matches: [/333[,]?833[,]?500/],
    });
    await waitUntil(
      () =>
        !!rootFor(slow.id) &&
        !!store.one(
          "SELECT 1 FROM receipts WHERE task_id=? AND name='run_code' AND state='done'",
          rootFor(slow.id)!.id,
        ),
      20000,
    );
    const keys = await send({
      id: "keys",
      prompt: "Separate question: where did I leave my keys?",
      matches: [/backpack/i, /front pocket/i],
    });
    const filler = await send({ id: "filler", prompt: "Okay, thanks.", expected: "quiet" });
    await Promise.all([finish(reminder), finish(slow), finish(keys), finish(filler)]);
  }
  await run({
    id: "notebook",
    prompt: "Where did I leave my blue notebook?",
    matches: [/front pocket/i, /backpack/i],
    tools: ["grep_history"],
  });
  await run({
    id: "class",
    prompt:
      "Review yesterday's calculus class from saved transcripts. What topics and homework did we cover?",
    matches: [/chain rule/i, /72/],
    tools: ["grep_history"],
    sourceDay: localDay(lessonAt),
  });
  await run({
    id: "class-today",
    prompt:
      "What topics and homework did we cover in today's calculus class? Only use a class captured today in my local timezone.",
    expected: "abstain",
    tools: ["grep_history"],
  });
  await run({
    id: "person",
    prompt:
      "What do we know about William's Iceland conversation? Distinguish visible people from the actual audio speaker.",
    matches: [/Iceland/i, /unknown|unidentified|uncertain|not identified|cannot|can't|unverified/i],
  });
  await run({
    id: "graph",
    prompt:
      "Save a knowledge graph fact: Maya works on Project Aurora. Create the entities and relationship, query to verify it, then confirm.",
    matches: [/Maya/i, /Aurora/i],
    tools: ["remember_entity", "remember_relation", "query_graph"],
  });
  await run({
    id: "browser",
    prompt: "Open https://example.com in the browser and tell me the page title and its purpose.",
    matches: [/Example Domain/i, /documentation|illustrative/i],
    tools: ["browser_goto"],
  });
  await run({
    id: "subagents",
    prompt:
      "Have one subagent find where I parked and a second subagent find my dry-cleaning pickup code. Give me one answer with both.",
    matches: [/B2/i, /7351/],
    tools: ["spawn_subagent"],
    children: 2,
  });
  await run({
    id: "unknown",
    prompt: "Where did I put my passport?",
    expected: "abstain",
    tools: ["grep_history"],
  });

  // Re-run the old notebook review content, preserving failures and raw scores.
  // This diagnoses the reviewer independently; it is not counted as E2E success.
  const evidence = { ...seeds[0]!, receivedAt: Date.now(), owner };
  const probes = [
    ...Array.from({ length: 5 }, () => ({
      label: "old wording",
      valid: true,
      text: "Your blue notebook was in the front pocket of your backpack.",
    })),
    ...Array.from({ length: 3 }, () => ({
      label: "last-seen wording",
      valid: true,
      text: "Your blue notebook was last seen in the front pocket of your backpack.",
    })),
    {
      label: "unsupported location",
      valid: false,
      text: "Your blue notebook is in the refrigerator.",
    },
  ];
  for (const [trial, { label, valid, text }] of (selected("review") ? probes : []).entries()) {
    const approved = await measuredJev({ probe: "notebook-review", trial, valid }).review(
      {
        goal: "Where did I leave my blue notebook?",
        text,
        evidence: [evidence],
        completedTools: ["grep_history"],
      },
      AbortSignal.timeout(5000),
    );
    reviewProbes.push({ label, text, approved, valid });
    record("probe.review", { trial, label, valid, approved });
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  record("run.error", { message: failure });
} finally {
  streamAbort.abort();
  await stream;
  await api.stop();
  await harness.stop();
  const reminderRoot = rootFor("reminder"),
    slowRoot = rootFor("slow-code"),
    childRoot = rootFor("subagents");
  const reminderNotification = received.find(
    (r) => !!store.one("SELECT 1 FROM reminder_wakes WHERE task_id=?", r.notification.taskId),
  );
  const firedAt = reminderNotification?.notification.createdAt;
  const reminderEnded = spans.find(
    (s) =>
      s.name === "task.state" &&
      s.taskId === reminderRoot?.id &&
      !ACTIVE.includes(s.status as (typeof ACTIVE)[number]),
  );
  const slowStateAtFire =
    firedAt === undefined
      ? undefined
      : spans
          .filter(
            (s) =>
              s.taskId === slowRoot?.id &&
              ["task.running", "task.state"].includes(s.name) &&
              Date.parse(s.at) <= firedAt,
          )
          .at(-1);
  let activeChildren = 0,
    peakChildren = 0;
  for (const s of spans.filter((s) => s.rootId === childRoot?.id && s.child)) {
    if (s.name === "model.start") activeChildren++;
    if (s.name === "model.end" || s.name === "model.error") activeChildren--;
    peakChildren = Math.max(peakChildren, activeChildren);
  }
  const observations = {
    reminderFiredWhileCodeTaskRunning:
      firedAt === undefined ? null : slowStateAtFire?.name === "task.running",
    reminderModelCallsAfterOriginCompleted:
      !reminderEnded || firedAt === undefined
        ? null
        : spans.filter(
            (s) =>
              s.name === "model.start" &&
              (s.rootId === reminderRoot?.id ||
                !!store.one("SELECT 1 FROM reminder_wakes WHERE task_id=?", String(s.rootId))) &&
              Date.parse(s.at) > Date.parse(reminderEnded.at) &&
              Date.parse(s.at) <= firedAt,
          ).length,
    reminderOutboxLatenessMs: results.find((r) => r.id === "reminder")?.reminderLatenessMs ?? null,
    keysParentQueueMs: results.find((r) => r.id === "keys")?.queueMs ?? null,
    peakSimultaneousChildModelCalls: peakChildren,
  };
  const payload = {
    runId,
    owner,
    models: {
      provider: models.provider,
      model: models.modelName,
      reasoning: models.reasoning,
      fallback: false,
    },
    failure,
    results,
    reviewProbes,
    jobs,
    notifications: received,
    observations,
  };
  writeFileSync(join(dir, "results.json"), JSON.stringify(payload, null, 2), { mode: 0o600 });
  const seconds = (ms: number | null) => (ms === null ? "—" : (ms / 1000).toFixed(3) + "s");
  const lines = [
    "# Single-wearer SSE replay — " + runId,
    "",
    "Synthetic history; one account/device; real OpenAI/Jev and local tools. Fallback disabled. Timed from immediately before HTTP submission to client SSE receipt, or terminal task/gate state for no-delivery cases. No camera, STT, vision or physical display. Same session/history throughout; initial old history seeded without Jev. Failures remain in the denominator.",
    "",
    `Result: ${results.filter((r) => r.passed).length}/${results.length}; run error: ${failure ?? "none"}.`,
    "",
    "| Case | Result | Total | Client SSE | Parent queue | Model calls | Model time sum |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.passed ? "PASS" : "FAIL"} | ${seconds(r.elapsedMs)} | ${seconds(r.clientMs)} | ${seconds(r.queueMs)} | ${r.modelCalls} | ${seconds(r.modelMs)} |`,
    ),
    "",
    "Model time sums overlap for concurrent children. No percentiles are claimed from these individual cases. Reminder total includes its intended 20-second wait. Parent queue is task creation to first execution; classification queue is in replay telemetry.",
    "",
    "## Concurrency observations",
    "",
    "```json",
    JSON.stringify(observations, null, 2),
    "```",
    "",
    "Each parent keeps its own model history; Jev sees active parent goals/statuses. Parents receive recent source evidence, targeted updates and their own child messages, not automatic copies of other parents' complete conversations. Model context snapshots are retained for inspection.",
    "",
    ...results.flatMap((r) => [
      `## ${r.id}`,
      "",
      r.answer ?? "No delivered answer.",
      "",
      `Errors: ${r.errors.join("; ") || "none"}.`,
      `Outbox creation: ${seconds(r.outboxMs as number | null)}; reminder lateness: ${r.reminderLatenessMs ?? "n/a"} ms.`,
      "",
    ]),
    "## Notebook reviewer replay",
    "",
    ...["old wording", "last-seen wording", "unsupported location"].map(
      (label) =>
        `${label}: approved ${reviewProbes.filter((r) => r.label === label && r.approved).length}/${reviewProbes.filter((r) => r.label === label).length}.`,
    ),
    "These are isolated review calls, not additional E2E trials. Raw probability scores are in replay.jsonl.",
    "",
    "Raw Jev request/response bodies, model message contexts, scheduler events and SSE receipts: [replay.jsonl](replay.jsonl). Structured results: [results.json](results.json). Synthetic source/receipt state: evidence.sqlite.",
    "",
  ];
  writeFileSync(join(dir, "REPORT.md"), lines.join("\n"), { mode: 0o600 });
  store.close();
  console.log(`Report: ${join(dir, "REPORT.md")}`);
}
if (failure || results.some((r) => !r.passed)) process.exitCode = 1;
