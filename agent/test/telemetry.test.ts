import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeCodexTelemetry, collectCodexTelemetry } from "../src/codex-telemetry";
import {
  Telemetry,
  fileTelemetry,
  modelLatency,
  type ModelDiagnostics,
  type TelemetryEvent,
} from "../src/telemetry";
import { runProcess } from "../src/process";

test("OTLP collector retains timing but drops prompts, account IDs, headers, paths and unknown fields", async () => {
  const values = {
    "event.name": "codex.turn_ttft",
    duration_ms: "125",
    "event.timestamp": "2026-01-01T00:00:00.125Z",
    model: "gpt-5.6-sol",
    "user.email": "private@example.com",
    prompt: "private prompt",
    endpoint: "https://private?token=secret",
    "user.account_id": "account-secret",
    unknown: "secret",
  };
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [{ secret: "resource-secret" }] },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: Object.entries(values).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
  const collector = collectCodexTelemetry(Date.parse("2026-01-01T00:00:00Z"));
  try {
    const response = await fetch(collector.endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(response.ok).toBe(true);
    expect(collector.events).toEqual([
      { name: "codex.turn_ttft", atMs: 125, fields: { duration_ms: 125, model: "gpt-5.6-sol" } },
    ]);
    expect(JSON.stringify(collector.events)).not.toContain("secret");
    expect(
      (
        await fetch(collector.endpoint, {
          method: "POST",
          headers: { origin: "https://example.com" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(decodeCodexTelemetry({ resourceLogs: "invalid" }, 0)).toEqual([]);
  } finally {
    await collector.stop();
  }
});

test("latency breakdown uses the real request after warmup and preserves unknown measurements", () => {
  const d: ModelDiagnostics = {
    provider: "codex",
    model: "fixture",
    reasoning: "none",
    totalMs: 1000,
    inputBytes: 1,
    messageBytes: 1,
    toolBytes: 0,
    toolCount: 0,
    phases: {},
    codex: [
      { name: "codex.websocket_request", atMs: 100, fields: {} },
      {
        name: "codex.sse_event",
        atMs: 200,
        fields: { "event.kind": "response.completed", output_token_count: 0 },
      },
      { name: "codex.websocket_request", atMs: 300, fields: {} },
      { name: "codex.turn_ttft", atMs: 800, fields: { duration_ms: 700 } },
      {
        name: "codex.sse_event",
        atMs: 900,
        fields: { "event.kind": "response.completed", ttft_ms: 500 },
      },
    ],
  };
  expect(modelLatency(d)).toEqual({
    setupMs: 300,
    firstTokenWaitMs: 500,
    streamingMs: 100,
    shutdownMs: 100,
  });
  expect(modelLatency({ ...d, codex: [] })).toBeNull();
  expect(modelLatency({ ...d, totalMs: 850 })).toBeNull();
});

test("streaming process observer handles split UTF-8 and sees output before exit", async () => {
  const lines: string[] = [],
    times: number[] = [];
  const result = await runProcess(
    [
      process.execPath,
      "-e",
      `
const b = Buffer.from('hello é\\nlast');
process.stdout.write(b.subarray(0,7));
await Bun.sleep(10);
process.stdout.write(b.subarray(7));
await Bun.sleep(60);
`,
    ],
    {
      onStdoutLine(line) {
        lines.push(line);
        times.push(performance.now());
      },
    },
  );
  expect(lines).toEqual(["hello é", "last"]);
  expect(result.stdout).toBe("hello é\nlast");
  expect(times[1]! - times[0]!).toBeGreaterThan(30);
});

test("spans correlate concurrent calls, preserve thrown errors and tolerate a broken telemetry sink", async () => {
  const events: TelemetryEvent[] = [],
    t = new Telemetry((e) => events.push(e));
  const failure = new Error("private provider error");
  await Promise.allSettled([
    t.span("model", { taskId: "child-1", rootId: "parent" }, async () => {
      await Bun.sleep(5);
      return 42;
    }),
    t.span("model", { taskId: "child-2", rootId: "parent" }, async () => {
      throw failure;
    }),
  ]);
  expect(events.filter((e) => e.name === "model.start")).toHaveLength(2);
  for (const e of events.filter((e) => e.name !== "model.start"))
    expect(events.find((s) => s.spanId === e.spanId)?.taskId).toBe(e.taskId);
  expect(JSON.stringify(events)).not.toContain("private provider error");
  await expect(
    t.span("test", {}, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  const broken = new Telemetry(() => {
    throw new Error("disk full");
  });
  expect(await broken.span("test", {}, async () => 42)).toBe(42);
  expect(broken.dropped).toBe(2);
});

test("telemetry files rotate within a bound and use private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kawk-telemetry-test-")),
    path = join(dir, "trace.jsonl");
  try {
    const t = fileTelemetry(path, 600);
    for (let i = 0; i < 20; i++) t.emit("test", { i });
    expect((await stat(path)).size).toBeLessThanOrEqual(600);
    expect((await stat(path + ".1")).size).toBeLessThanOrEqual(600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1).i).toBe(19);
    t.emit("oversized", { payload: "x".repeat(700) });
    expect(t.dropped).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
