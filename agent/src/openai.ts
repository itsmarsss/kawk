import OpenAI from "openai";
import type {
  ResponseInputItem,
  Response as APIResponse,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { Stream } from "openai/core/streaming";
import type { ChatMessage, LanguageModel, ModelResponse, ToolDefinition } from "./contracts";
import type { ModelDiagnostics } from "./telemetry";
import { ProviderError } from "./models";

/** Replays our durable, owner-scoped transcript; no shared remote conversation state. */
export function responseInput(messages: ChatMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("Tool result requires a call ID");
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
    } else {
      if (message.content) input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls ?? [])
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
    }
  }
  return input;
}

export class OpenAIModel implements LanguageModel {
  readonly model: string;
  readonly reasoning = "none" as const;
  private client: OpenAI;
  constructor(
    private options: {
      apiKey: string;
      model?: string;
      timeout?: number;
      fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    },
  ) {
    if (!options.apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI provider");
    this.model = options.model ?? "gpt-5.6-sol";
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
      timeout: options.timeout ?? 45000,
      logLevel: "off",
      fetch: options.fetch,
      fetchOptions: { redirect: "error" },
    });
  }
  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    signal.throwIfAborted();
    const start = performance.now();
    const input = responseInput(messages);
    const body = {
      model: this.model,
      input,
      reasoning: { effort: this.reasoning },
      store: false,
      stream: true as const,
      max_output_tokens: 2048,
      // Our registry validates arguments and applies optional defaults locally.
      tools: tools.map((tool) => ({ type: "function" as const, ...tool, strict: false })),
      ...(tools.length ? { tool_choice: "required" as const } : {}),
    };
    const diagnostics: ModelDiagnostics = {
      provider: "openai",
      model: this.model,
      reasoning: this.reasoning,
      totalMs: 0,
      inputBytes: Buffer.byteLength(JSON.stringify(body)),
      messageBytes: Buffer.byteLength(JSON.stringify(input)),
      toolBytes: Buffer.byteLength(JSON.stringify(body.tools)),
      toolCount: tools.length,
      phases: {},
    };
    let stream: Stream<ResponseStreamEvent> | undefined;
    try {
      diagnostics.phases.requestStartedMs = performance.now() - start;
      const result = await this.client.responses
        .create(body, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeout ?? 45000)]),
        })
        .withResponse();
      diagnostics.phases.responseHeadersMs = performance.now() - start;
      stream = result.data;
      let completed: APIResponse | undefined;
      let bytes = 0;
      for await (const event of stream) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes > 2_000_000) throw new ProviderError("OpenAI response exceeded limit");
        if (
          (event.type === "response.output_text.delta" ||
            event.type === "response.function_call_arguments.delta") &&
          event.delta.length
        ) {
          diagnostics.phases.firstTokenMs ??= performance.now() - start;
        }
        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        )
          throw new ProviderError("OpenAI response failed or incomplete");
        if (event.type === "response.completed") {
          completed = event.response;
          diagnostics.phases.responseCompletedMs = performance.now() - start;
        }
      }
      signal.throwIfAborted();
      if (!completed || completed.status !== "completed")
        throw new ProviderError("OpenAI stream ended without completion");
      const calls: NonNullable<ChatMessage["tool_calls"]> = [];
      const text: string[] = [];
      for (const item of completed.output) {
        if (item.type === "function_call") {
          if (
            !item.call_id ||
            !tools.some((tool) => tool.name === item.name) ||
            item.arguments.length > 32000
          )
            throw new ProviderError("OpenAI returned an invalid host tool call");
          calls.push({
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          });
        } else if (item.type === "message") {
          for (const part of item.content) if (part.type === "output_text") text.push(part.text);
        } else if (item.type !== "reasoning")
          throw new ProviderError("OpenAI returned an unexpected native tool");
      }
      if (
        calls.length > 8 ||
        new Set(calls.map((c) => c.id)).size !== calls.length ||
        text.join("").length > 16000
      )
        throw new ProviderError("OpenAI response exceeded host limits");
      diagnostics.model = completed.model;
      diagnostics.inputTokens = completed.usage?.input_tokens;
      diagnostics.cachedInputTokens = completed.usage?.input_tokens_details?.cached_tokens;
      diagnostics.outputTokens = completed.usage?.output_tokens;
      diagnostics.reasoningTokens = completed.usage?.output_tokens_details?.reasoning_tokens;
      return {
        message: {
          role: "assistant",
          content: text.join("\n") || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        tokens:
          completed.usage?.total_tokens ??
          Math.ceil((diagnostics.inputBytes + JSON.stringify(completed.output).length) / 3),
        reasoningTokens: diagnostics.reasoningTokens,
        diagnostics,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      diagnostics.failureType =
        error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : "unknown";
      // SDK errors can echo request data. Persist only a safe status, never raw bodies/headers.
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              error instanceof OpenAI.APIError && error.status
                ? `OpenAI HTTP ${error.status}`
                : "OpenAI response unavailable or invalid",
            );
      failure.diagnostics = diagnostics;
      throw failure;
    } finally {
      stream?.controller.abort();
      diagnostics.totalMs = performance.now() - start;
    }
  }
}
