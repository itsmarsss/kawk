import { expect, test } from "bun:test";
import { OpenAIModel } from "../src/openai";
import { FallbackModel, ProviderError } from "../src/models";
import { createModels } from "../src/providers";
import { modelLatency } from "../src/telemetry";
import type { ChatMessage, ToolDefinition } from "../src/contracts";

const tools: ToolDefinition[] = [
  {
    name: "search_memory",
    description: "search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];
const item = {
  type: "function_call",
  id: "fc_output",
  call_id: "call-memory",
  name: "search_memory",
  arguments: '{"query":"keys"}',
  status: "completed",
};
const completed = (output: unknown[] = [item]) => ({
  type: "response.completed",
  response: {
    id: "resp-fixture",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    output,
    usage: {
      input_tokens: 120,
      output_tokens: 10,
      total_tokens: 130,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  },
});
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
const delta = {
  type: "response.function_call_arguments.delta",
  delta: '{"query":',
  item_id: "fc_output",
  output_index: 0,
  sequence_number: 0,
};

test("direct Responses API uses native tools, none reasoning and replays call IDs across turns", async () => {
  const bodies: any[] = [];
  const m = new OpenAIModel({
    apiKey: "fixture-api-key",
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-api-key");
      expect(init?.redirect).toBe("error");
      bodies.push(JSON.parse(init?.body as string));
      return sse([delta, completed()]);
    },
  });
  const messages: ChatMessage[] = [
    { role: "system", content: "Private fixture instructions" },
    { role: "user", content: "keys?" },
  ];
  const first = await m.complete(messages, tools, new AbortController().signal);
  await m.complete(
    [
      ...messages,
      first.message,
      { role: "tool", tool_call_id: "call-memory", content: '{"evidence":"desk"}' },
    ],
    tools,
    new AbortController().signal,
  );
  expect(bodies[0].reasoning).toEqual({ effort: "none" });
  expect(bodies[0].store).toBe(false);
  expect(bodies[0].stream).toBe(true);
  expect(bodies[0].tool_choice).toBe("required");
  expect(bodies[0].tools[0]).toMatchObject({
    type: "function",
    name: "search_memory",
    strict: false,
  });
  expect(bodies[1].input.slice(-2)).toEqual([
    {
      type: "function_call",
      call_id: "call-memory",
      name: "search_memory",
      arguments: '{"query":"keys"}',
    },
    { type: "function_call_output", call_id: "call-memory", output: '{"evidence":"desk"}' },
  ]);
  expect(first.message.tool_calls?.[0]?.id).toBe("call-memory");
  expect(first.tokens).toBe(130);
  expect(first.reasoningTokens).toBe(0);
  expect(first.diagnostics).toMatchObject({
    provider: "openai",
    inputTokens: 120,
    cachedInputTokens: 64,
    outputTokens: 10,
    reasoningTokens: 0,
  });
  expect(modelLatency(first.diagnostics!)).not.toBeNull();
  expect(JSON.stringify(first.diagnostics)).not.toContain("Private fixture");
  expect(JSON.stringify(first.diagnostics)).not.toContain("fixture-api-key");
});

test("incomplete, truncated and unexpected-tool responses never execute partial calls", async () => {
  for (const events of [
    [delta],
    [delta, { type: "response.incomplete", response: { status: "incomplete" } }],
    [delta, { type: "response.failed", response: { error: { message: "private backend data" } } }],
    [completed([{ ...item, name: "unregistered" }])],
    [completed([item, { ...item, id: "fc_other" }])],
    [completed([{ type: "web_search_call" }])],
  ]) {
    const m = new OpenAIModel({
      apiKey: "fixture",
      fetch: async () => sse(events),
    });
    await expect(
      m.complete([{ role: "user", content: "fixture" }], tools, new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderError);
  }
});

test("HTTP failures have no hidden SDK retries, redact provider payloads and fall back", async () => {
  let requests = 0,
    fallbacks = 0;
  const primary = new OpenAIModel({
    apiKey: "fixture",
    fetch: async () => {
      requests++;
      return Response.json(
        {
          error: {
            message: "SECRET_PROMPT_AND_KEY",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        },
        { status: 429 },
      );
    },
  });
  const fallback = new FallbackModel(primary, {
    async complete() {
      fallbacks++;
      return { message: { role: "assistant", content: "ok" }, tokens: 1 };
    },
  });
  await fallback.complete([], tools, new AbortController().signal);
  expect(requests).toBe(1);
  expect(fallbacks).toBe(1);
  try {
    await primary.complete([], tools, new AbortController().signal);
    throw new Error("unexpected success");
  } catch (e) {
    expect((e as Error).message).toBe("OpenAI HTTP 429");
    expect(JSON.stringify(e)).not.toContain("SECRET");
  }
  expect(requests).toBe(2);
});

test("aborting an API request does not activate fallback", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const primary = new OpenAIModel({
    apiKey: "fixture",
    fetch: (_, init) =>
      new Promise((_, reject) => {
        const rejectAbort = () => reject(new DOMException("cancelled", "AbortError"));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
        started();
      }),
  });
  let fallback = 0;
  const m = new FallbackModel(primary, {
    async complete() {
      fallback++;
      throw new Error("must not run");
    },
  });
  const pending = m.complete([], tools, controller.signal);
  await ready;
  controller.abort(new Error("fixture cancellation"));
  await expect(pending).rejects.toThrow("fixture cancellation");
  expect(fallback).toBe(0);
});

test("one API client keeps concurrent task transcripts independent", async () => {
  const inputs: string[] = [];
  const m = new OpenAIModel({
    apiKey: "fixture",
    fetch: async (_, init) => {
      const body = JSON.parse(init?.body as string),
        text = body.input[0].content;
      inputs.push(text);
      await Bun.sleep(text === "owner-a" ? 15 : 1);
      return sse([
        completed([
          { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
        ]),
      ]);
    },
  });
  const responses = await Promise.all(
    ["owner-a", "owner-b"].map((content) =>
      m.complete([{ role: "user", content }], [], new AbortController().signal),
    ),
  );
  expect(responses.map((r) => r.message.content)).toEqual(["owner-a", "owner-b"]);
  expect(inputs).toEqual(["owner-a", "owner-b"]);
});

test("API is the default provider and missing credentials never silently select Codex", () => {
  expect(createModels({ OPENAI_API_KEY: "fixture" }).primary).toBeInstanceOf(OpenAIModel);
  expect(() => createModels({})).toThrow("OPENAI_API_KEY");
  expect(() => createModels({ OPENAI_API_KEY: "fixture", KAWK_OPENAI_REASONING: "high" })).toThrow(
    "KAWK_OPENAI_REASONING",
  );
  expect(createModels({ KAWK_MODEL_PROVIDER: "codex" }).provider).toBe("codex");
});
