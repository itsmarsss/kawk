import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Harness } from "../src/harness";
import { Store } from "../src/store";
import { Jev } from "../src/jev";
import { createModels } from "../src/providers";
import { LocalRunner, type Runner } from "../src/runner";
import { serve } from "../src/server";
import { KawkClient } from "../client";
import { ACTIVE, type Gate, type LanguageModel, type PerceptionEvent } from "../src/contracts";
import { fileTelemetry, modelTable, type ModelDiagnostics } from "../src/telemetry";

// Live model calls are opt-in. Sources/prompts below are synthetic; model/tool results are real.
if (!process.argv.includes("--live")) {
  console.error(
    "Usage: bun run perf --live [--only recall|code|browser|subagents|unknown|filler] [--prompt 'your task'] [--provider openai|codex|baseten] [--no-fallback]",
  );
  process.exit(1);
}
if (!process.env.TYPESAFE_API_KEY) throw new Error("Configure TYPESAFE_API_KEY in .env first");
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
interface Case {
  id: string;
  title: string;
  prompt: string;
  seeds?: {
    id: string;
    text: string;
    kind?: PerceptionEvent["kind"];
    personIds?: string[];
    agoMs?: number;
  }[];
  expected: "answer" | "abstain" | "observe";
  requiredTools?: string[];
  matches?: RegExp[];
  children?: number;
  reminder?: boolean;
}
const cases: Case[] = [
  {
    id: "wearer",
    title: "Seeing the owner does not establish wearer identity",
    prompt:
      "The camera sees the account owner. Does that prove someone else is wearing the glasses, or can we actually identify the wearer from this evidence?",
    seeds: [
      {
        id: "owner-visible",
        text: "The forward camera recognizes the account owner's face in view. There is no independent wearer identity signal.",
        personIds: ["account-owner"],
      },
    ],
    expected: "answer",
    matches: [
      /cannot|can't|not prove|does not prove|doesn.t prove|unknown|unverified|not enough|does not establish|doesn.t establish/i,
    ],
  },
  {
    id: "keys",
    title: "Original task: keys moved between sightings",
    prompt: "Where did I leave my keys?",
    seeds: [
      {
        id: "keys-old",
        text: "The wearer's distinctive red-tag keyring was seen on the kitchen counter.",
        agoMs: 1200000,
      },
      {
        id: "keys-new",
        text: "The same red-tag keyring was later seen inside the blue backpack's front pocket.",
        agoMs: 300000,
      },
    ],
    expected: "answer",
    requiredTools: ["grep_history"],
    matches: [/backpack/i, /front pocket/i],
  },
  {
    id: "class",
    title: "Original task: review a class from raw transcripts",
    prompt:
      "Review today's calculus class from the saved transcripts. What topics and homework did we cover?",
    seeds: [
      {
        id: "class-a",
        kind: "transcript",
        text: "Calculus class: today we covered derivatives and the chain rule.",
      },
      {
        id: "class-b",
        kind: "transcript",
        text: "For calculus homework, solve exercises 4 through 8 on page 72.",
      },
    ],
    expected: "answer",
    requiredTools: ["grep_history"],
    matches: [/chain rule/i, /72/],
  },
  {
    id: "person",
    title: "Original task: William conversation with unverified speaker",
    prompt:
      "Give me notes about William and what he said today. Check the saved transcripts, and distinguish what we know from uncertain speaker attribution.",
    seeds: [
      {
        id: "william-talk",
        kind: "transcript",
        personIds: ["william"],
        text: "Conversation while William was visible: I visited Iceland last week and enjoyed the hiking. The audio speaker was not identified.",
      },
    ],
    expected: "answer",
    requiredTools: ["grep_history"],
    matches: [
      /Iceland/i,
      /unverified|unidentified|uncertain|not identified|cannot|can't|not confirm|not verified/i,
    ],
  },
  {
    id: "graph",
    title: "Persist and retrieve a relationship graph",
    prompt:
      "Remember this as a knowledge graph: Maya works on Project Aurora. Create entities and their relationship, query the graph to check it, then confirm it was saved.",
    expected: "answer",
    requiredTools: ["remember_entity", "remember_relation", "query_graph"],
    matches: [/Maya/i, /Aurora/i],
  },
  {
    id: "reminder",
    title: "Create and actually deliver a timed reminder",
    prompt: "Remind me in 20 seconds to stretch.",
    expected: "answer",
    requiredTools: ["create_reminder"],
    matches: [/stretch/i],
    reminder: true,
  },
  {
    id: "recall",
    title: "Recall an older observation",
    prompt: "Where did I leave my blue notebook?",
    seeds: [
      {
        id: "notebook",
        text: "The wearer's blue notebook was seen in the front pocket of their backpack.",
      },
    ],
    expected: "answer",
    requiredTools: ["grep_history"],
    matches: [/front pocket/i, /backpack/i],
  },
  {
    id: "code",
    title: "Run a calculation in code",
    prompt:
      "Please run code to find the sum of squares of the integers from 1 through 1000, and tell me the result.",
    expected: "answer",
    requiredTools: ["run_code", "poll_process"],
    matches: [/333[,]?833[,]?500/],
  },
  {
    id: "browser",
    title: "Read a live web page",
    prompt:
      "Open https://example.com in the browser and tell me its page title and what the site says it is for.",
    expected: "answer",
    requiredTools: ["browser_goto"],
    matches: [/Example Domain/i, /documentation|illustrative/i],
  },
  {
    id: "subagents",
    title: "Delegate two memory lookups",
    prompt:
      "Have one subagent find where I parked and another subagent find the pickup code for my dry cleaning, then give me one concise answer with both.",
    seeds: [
      {
        id: "parking",
        text: "The wearer parked their car on level B2 in the green zone near lift C.",
      },
      { id: "dry-cleaning", text: "The pickup code for the wearer's dry cleaning is 7351." },
    ],
    expected: "answer",
    requiredTools: ["spawn_subagent"],
    matches: [/B2/i, /7351/],
    children: 2,
  },
  {
    id: "unknown",
    title: "Abstain when evidence is missing",
    prompt: "Where did I put my passport?",
    expected: "abstain",
    requiredTools: ["grep_history"],
  },
  { id: "filler", title: "Stay quiet on filler", prompt: "Okay, thanks.", expected: "observe" },
];
const prompt = arg("--prompt"),
  only = arg("--only");
const selected: Case[] = prompt
  ? [{ id: "custom", title: "Custom task", prompt, expected: "answer" }]
  : only
    ? cases.filter((c) => only.split(",").includes(c.id))
    : cases;
if (!selected.length) throw new Error("Unknown --only case");
const selectedProvider = arg("--provider");
const basetenOnly = selectedProvider === "baseten";
if (selectedProvider && !["openai", "codex", "baseten"].includes(selectedProvider))
  throw new Error("Unknown --provider");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const dir = resolve("data/perf", runId);
await mkdir(dir, { recursive: true, mode: 0o700 });
const store = new Store(join(dir, "evidence.sqlite"));
const jev = new Jev({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.KAWK_JEV_MODEL });
const models = createModels(
  {
    ...process.env,
    ...(selectedProvider && !basetenOnly ? { KAWK_MODEL_PROVIDER: selectedProvider } : {}),
    ...(process.argv.includes("--no-fallback") ? { BASETEN_API_KEY: undefined } : {}),
  },
  !process.argv.includes("--no-codex-telemetry"),
  basetenOnly,
);
const local = new LocalRunner();
type Trace = {
  case: string;
  kind: string;
  atMs: number;
  durationMs?: number;
  [key: string]: unknown;
};
const traces: Trace[] = [];
let current = "setup",
  started = performance.now();
const trace = (kind: string, details: Record<string, unknown> = {}) => {
  const item = { case: current, kind, atMs: Math.round(performance.now() - started), ...details };
  traces.push(item);
  console.log(JSON.stringify(item));
};
let sequence = 0;
const timed = async <T>(
  kind: string,
  details: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> => {
  const id = ++sequence,
    begin = performance.now();
  trace(`${kind}.start`, { id, ...details });
  try {
    const value = await fn();
    trace(`${kind}.end`, { id, ...details, durationMs: Math.round(performance.now() - begin) });
    return value;
  } catch (error) {
    trace(`${kind}.error`, {
      id,
      ...details,
      durationMs: Math.round(performance.now() - begin),
      error: error instanceof Error ? error.message : "failed",
    });
    throw error;
  }
};
const gate: Gate = {
  async decide(input, signal) {
    const result = await timed("jev", {}, () => jev.decide(input, signal));
    trace("decision", { ...result });
    return result;
  },
  async review(input, signal) {
    const result = await timed("review", {}, () => jev.review(input, signal));
    trace("delivery", { approved: result });
    return result;
  },
};
const model: LanguageModel = {
  async complete(messages, tools, signal) {
    const child = messages[0]?.content?.includes("You are a subagent") ?? false;
    const response = await timed("model", { child }, () =>
      models.model.complete(messages, tools, signal),
    );
    trace("usage", {
      child,
      provider: response.diagnostics?.provider ?? models.provider,
      tokens: response.tokens,
      reasoningTokens: response.reasoningTokens ?? null,
      diagnostics: response.diagnostics,
      requestedTools: response.message.tool_calls?.map((c) => c.function.name) ?? [],
    });
    return response;
  },
};
const runner: Runner = {
  call: (id, mode, action, args, signal) =>
    timed("runner", { taskId: id, mode, action }, () => local.call(id, mode, action, args, signal)),
  close: (id) => local.close(id),
  reap: (active) => local.reap(active),
  dispose: () => local.dispose(),
};
const harness = new Harness({
  store,
  gate,
  model,
  runner,
  artifactDir: join(dir, "artifacts"),
  telemetry: fileTelemetry(join(dir, "telemetry.jsonl")),
  transcriptDir: join(dir, "transcripts"),
  timeZone: "America/Toronto",
});
const execute = harness.tools.execute.bind(harness.tools);
harness.tools.execute = async (name, args, ctx) =>
  timed("tool", { name, taskId: ctx.task.id }, () => execute(name, args, ctx));
const event = (
  id: string,
  text: string,
  at = Date.now(),
  kind: PerceptionEvent["kind"] = "transcript",
): PerceptionEvent => ({
  id,
  text,
  deviceId: "perf",
  streamId: "perf",
  revision: 0,
  kind,
  final: true,
  sourceStart: at,
  sourceEnd: at,
  confidence: 0.99,
  speakerId: null,
  personIds: [],
  provenance: "synthetic-performance-suite",
});
const results: Record<string, any>[] = [];
const decodeResult = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : { text: value };
  } catch {
    return { text: value };
  }
};
const overall = performance.now();
harness.start();
try {
  for (const test of selected) {
    current = test.id;
    started = performance.now();
    const epoch = Date.now(),
      owner = `perf-${test.id}`;
    for (const seed of test.seeds ?? [])
      store.ingest(
        owner,
        {
          ...event(seed.id, seed.text, epoch - (seed.agoMs ?? 300000), seed.kind ?? "observation"),
          personIds: seed.personIds ?? [],
        },
        false,
      );
    const token = crypto.randomUUID() + crypto.randomUUID(),
      server = serve(harness, { token, owner, port: 0 }),
      client = new KawkClient(server.url, token);
    trace("case.start", { title: test.title, prompt: test.prompt });
    let notification:
      | Awaited<ReturnType<KawkClient["notifications"]>>["notifications"][number]
      | undefined;
    let reason = "",
      deadline = false;
    const stateLog = new Map<string, string>();
    try {
      await client.send([event(`question-${test.id}`, test.prompt)]);
      while (performance.now() - started < 190000) {
        // Snapshot completion before the HTTP read: a task may finish while that
        // read is in flight, leaving its notification for the next poll.
        const tasks = store.tasks(owner);
        const job = store.one<{ state: string; error: string | null }>(
          "SELECT state,error FROM gate_jobs WHERE owner=? ORDER BY id DESC LIMIT 1",
          owner,
        );
        notification = (await client.notifications()).notifications[0];
        if (notification) {
          trace("notification", { text: notification.text, refs: notification.refs });
          await client.ack(notification.id);
          if (test.reminder && !notification.id.startsWith("reminder-result:")) {
            notification = undefined;
            await Bun.sleep(50);
            continue;
          }
          break;
        }
        for (const task of tasks)
          if (stateLog.get(task.id) !== task.status) {
            stateLog.set(task.id, task.status);
            trace("task.state", {
              taskId: task.id,
              parentId: task.parentId,
              status: task.status,
              error: task.error,
            });
          }
        const root = tasks.find((t) => !t.parentId);
        if (root && !ACTIVE.includes(root.status)) {
          if (test.reminder && harness.reminders.list(owner).length) {
            await Bun.sleep(50);
            continue;
          }
          reason = root.error ?? root.status;
          break;
        }
        if (!root && job && (job.state === "done" || job.state === "failed")) {
          reason =
            job.state === "done" ? "No agent activation" : (job.error ?? "Classification failed");
          break;
        }
        await Bun.sleep(50);
      }
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs >= 190000) {
        deadline = true;
        reason = "Benchmark deadline";
        for (const t of store.tasks(owner, true)) harness.cancel(t.id);
      }
      const tasks = store.tasks(owner),
        root = tasks.find((t) => !t.parentId),
        children = tasks.filter((t) => t.parentId);
      const receipts = store.all<{ name: string; state: string; result: string | null }>(
        "SELECT name,state,result FROM receipts WHERE task_id IN (SELECT id FROM tasks WHERE owner=?)",
        owner,
      );
      const toolNames = receipts.filter((r) => r.state === "done").map((r) => r.name);
      const checkErrors: string[] = [];
      const finalJob = store.one<{ state: string }>(
        "SELECT state FROM gate_jobs WHERE owner=? ORDER BY id DESC LIMIT 1",
        owner,
      );
      if (finalJob?.state !== "done")
        checkErrors.push("Classification did not complete successfully");
      if (deadline) checkErrors.push(reason);
      if (test.expected === "answer" && !notification)
        checkErrors.push("No notification delivered");
      if (test.expected !== "answer" && notification) checkErrors.push("Unexpected notification");
      if (test.expected === "observe" && tasks.length)
        checkErrors.push("Filler activated agent work");
      if (
        test.expected === "abstain" &&
        (!root || !["completed", "abstained"].includes(root.status))
      )
        checkErrors.push("Missing-evidence task did not end cleanly");
      for (const name of test.requiredTools ?? [])
        if (!toolNames.includes(name)) checkErrors.push(`Required tool not completed: ${name}`);
      for (const pattern of test.matches ?? [])
        if (!notification || !pattern.test(notification.text))
          checkErrors.push(`Answer missing expected detail: ${pattern.source}`);
      if (test.children && children.filter((c) => c.status === "completed").length < test.children)
        checkErrors.push(`Fewer than ${test.children} completed subagents`);
      if (test.reminder && !notification?.id.startsWith("reminder-result:"))
        checkErrors.push("Scheduled reminder was not delivered");
      const spans = traces.filter((t) => t.case === test.id);
      const result = {
        id: test.id,
        title: test.title,
        prompt: test.prompt,
        expected: test.expected,
        passed: checkErrors.length === 0,
        errors: checkErrors,
        reason,
        elapsedMs,
        notificationMs: notification ? notification.createdAt - epoch : null,
        jevMs: spans
          .filter((t) => t.kind === "jev.end")
          .reduce((n, t) => n + (t.durationMs ?? 0), 0),
        reviewMs: spans
          .filter((t) => t.kind === "review.end")
          .reduce((n, t) => n + (t.durationMs ?? 0), 0),
        modelCalls: spans.filter((t) => t.kind === "model.start").length,
        modelMsSum: spans
          .filter((t) => t.kind === "model.end" || t.kind === "model.error")
          .reduce((n, t) => n + (t.durationMs ?? 0), 0),
        tokens: tasks.reduce((n, t) => n + t.tokens, 0),
        providers: [...new Set(spans.filter((t) => t.kind === "usage").map((t) => t.provider))],
        children: children.length,
        toolCounts: Object.fromEntries(
          [...new Set(toolNames)].map((name) => [name, toolNames.filter((n) => n === name).length]),
        ),
        answer: notification?.text ?? null,
        proposedResult: decodeResult(root?.result),
        tasks: tasks.map((t) => ({
          id: t.id,
          parentId: t.parentId,
          status: t.status,
          steps: t.steps,
          tokens: t.tokens,
          error: t.error,
        })),
      };
      results.push(result);
      trace("case.result", result);
      await writeFile(join(dir, "results.json"), JSON.stringify({ runId, results }, null, 2), {
        mode: 0o600,
      });
    } finally {
      await server.stop();
    }
    const drain = performance.now();
    while (harness.status().activeTurns && performance.now() - drain < 20000) await Bun.sleep(50);
  }
} finally {
  await harness.stop();
  await local.dispose();
  const payload = {
    runId,
    createdAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - overall),
    configuration: {
      primary: models.modelName,
      provider: models.provider,
      fallback: models.fallback && !basetenOnly ? process.env.KAWK_BASETEN_MODEL : undefined,
      reasoning: models.reasoning,
      codexTelemetry: models.provider === "codex" && !process.argv.includes("--no-codex-telemetry"),
      basetenReasoning: "provider default (not configured)",
      jev: process.env.KAWK_JEV_MODEL ?? "jev-1.13.0",
      runtime: Bun.version,
      deadlineMs: 180000,
      maxRootTokens: 80000,
      maxRootTurns: 32,
    },
    results,
    traces,
  };
  await writeFile(join(dir, "results.json"), JSON.stringify(payload, null, 2), { mode: 0o600 });
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const lines = [
    `# Live agent task run — ${runId}`,
    "",
    "Synthetic history/prompts; real Jev, OpenAI/Codex/Baseten and local /tmp code + Playwright tools. One sample per case, sequential roots; children may run concurrently. Latency starts at HTTP ingestion, not camera/audio capture. History is seeded directly into the ledger. No mock model or gate.",
    "",
    "| Task | Result | End to end | Jev | Turns | Children | Reported tokens |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...results.map(
      (r) =>
        `| ${r.title} | ${r.passed ? "PASS" : "FAIL"} | ${s(r.elapsedMs)} | ${s(r.jevMs)} | ${r.modelCalls} | ${r.children} | ${r.tokens.toLocaleString()} |`,
    ),
    "",
    `Total elapsed: ${s(payload.elapsedMs)}. Primary: ${payload.configuration.provider}/${payload.configuration.primary}. Reasoning: ${payload.configuration.reasoning}. Fallback: ${payload.configuration.fallback ?? "disabled/unconfigured"} (provider-default reasoning). Per-call provider-reported reasoning tokens are in results.json; null means unavailable. Tokens include repeated prompt input; these are not a dollar-cost estimate. Summed model time in JSON includes concurrent calls and can exceed elapsed time.`,
    "",
    "## Model latency breakdown",
    "",
    ...modelTable(
      traces
        .filter((t) => t.kind === "usage" && t.diagnostics)
        .map((t, i) => ({
          label: `${t.case} ${i + 1}${t.child ? " child" : ""}`,
          diagnostics: t.diagnostics as ModelDiagnostics,
        })),
    ),
    "",
    ...results.flatMap((r) => [
      `## ${r.title}`,
      "",
      `Prompt: ${r.prompt}`,
      "",
      r.answer ?? `No notification. ${r.reason}`,
      ...(!r.answer && r.proposedResult?.text
        ? ["", `Undelivered proposed answer: ${r.proposedResult.text}`]
        : []),
      "",
      `Tools: ${
        Object.entries(r.toolCounts)
          .map(([k, v]) => `${k} × ${v}`)
          .join(", ") || "none"
      }. Providers: ${r.providers.join(", ") || "none"}.`,
      ...(r.errors.length ? ["", `Failures: ${r.errors.join("; ")}`] : []),
      "",
    ]),
    "Full stage timings and task states: [results.json](results.json). The adjacent SQLite database retains tool receipts and transcripts for inspection.",
  ];
  await writeFile(join(dir, "REPORT.md"), lines.join("\n") + "\n", { mode: 0o600 });
  store.close();
  console.log(`REPORT ${join(dir, "REPORT.md")}`);
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
