import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasetenModel, CodexModel, FallbackModel, ProviderError } from "../src/models";
import type { LanguageModel } from "../src/contracts";

test("Codex sends explicit reasoning to the CLI and preserves reported reasoning usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kawk-codex-test-"));
  try {
    const binary = join(dir, "codex-fixture");
    await writeFile(
      binary,
      `#!${process.execPath}
const argv = process.argv.slice(2);
await Bun.stdin.text();
console.log(JSON.stringify({type: "thread.started", thread_id: "fixture"}));
console.log(JSON.stringify({type: "turn.started"}));
await Bun.sleep(10);
console.log(JSON.stringify({ type: "item.completed", item: {
  type: "agent_message", text: JSON.stringify({text: JSON.stringify(argv), calls: []})
}}));
console.log(JSON.stringify({ type: "turn.completed", usage: {
  input_tokens: 9, cached_input_tokens: 4, output_tokens: 2,
  ...(argv.includes('model_reasoning_effort="none"') ? {reasoning_output_tokens: 0} : {})
}}));
await Bun.sleep(30);
`,
      { mode: 0o700 },
    );
    for (const reasoning of [undefined, "low"] as const) {
      const model = new CodexModel({ binary, model: "fixture-model", reasoning });
      const response = await model.complete([], [], new AbortController().signal);
      const argv: string[] = JSON.parse(response.message.content!);
      expect(argv).toContain("--ignore-user-config");
      const index = argv.indexOf(`model_reasoning_effort="${reasoning ?? "none"}"`);
      expect(index).toBeGreaterThan(0);
      expect(argv[index - 1]).toBe("-c");
      expect(argv[argv.indexOf("-m") + 1]).toBe("fixture-model");
      expect(response.tokens).toBe(11);
      expect(response.reasoningTokens).toBe(reasoning ? undefined : 0);
      const d = response.diagnostics!;
      expect(d.inputTokens).toBe(9);
      expect(d.cachedInputTokens).toBe(4);
      expect(d.outputTokens).toBe(2);
      expect(d.phases.turnStartedMs).toBeLessThan(d.phases.answerCompletedMs!);
      expect(d.phases.processExitMs! - d.phases.turnCompletedMs!).toBeGreaterThan(20);
      expect(d.totalMs).toBeGreaterThanOrEqual(d.phases.processExitMs!);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex provider failures fall back once with a cooldown; cancellation does not fall back", async () => {
  let primary = 0,
    fallback = 0,
    now = 0;
  const first: LanguageModel = {
    async complete() {
      primary++;
      throw new ProviderError("subscription unavailable");
    },
  };
  const second: LanguageModel = {
    async complete() {
      fallback++;
      return { message: { role: "assistant", content: "ok" }, tokens: 3 };
    },
  };
  const model = new FallbackModel(first, second, () => now),
    signal = new AbortController();
  await model.complete([], [], signal.signal);
  await model.complete([], [], signal.signal);
  expect(primary).toBe(1);
  expect(fallback).toBe(2);
  expect(model.lastProvider).toBe("baseten");
  now = 61000;
  await model.complete([], [], signal.signal);
  expect(primary).toBe(2);
  const abort = new AbortController();
  const cancelling = new FallbackModel(
    {
      async complete() {
        abort.abort();
        throw new ProviderError("cancelled");
      },
    },
    second,
  );
  await expect(cancelling.complete([], [], abort.signal)).rejects.toBeDefined();
  expect(fallback).toBe(3);
});
test("programming errors do not silently switch providers", async () => {
  let calls = 0;
  const m = new FallbackModel(
    {
      async complete() {
        throw new Error("bug");
      },
    },
    {
      async complete() {
        calls++;
        throw new Error("should not run");
      },
    },
  );
  await expect(m.complete([], [], new AbortController().signal)).rejects.toThrow("bug");
  expect(calls).toBe(0);
});
test("Baseten tool call protocol uses configured model and keeps call IDs", async () => {
  let body: any;
  const model = new BasetenModel({
    apiKey: "fixture",
    model: "configured-model",
    fetch: async (_url, init) => {
      body = JSON.parse(init!.body as string);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "search_memory", arguments: '{"query":"keys"}' },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 9 },
      });
    },
  });
  const response = await model.complete(
    [{ role: "user", content: "keys?" }],
    [{ name: "search_memory", description: "search", parameters: { type: "object" } }],
    new AbortController().signal,
  );
  expect(body.model).toBe("configured-model");
  expect(body.tools[0].type).toBe("function");
  expect(response.message.tool_calls?.[0]?.id).toBe("call-1");
  expect(response.tokens).toBe(9);
});
