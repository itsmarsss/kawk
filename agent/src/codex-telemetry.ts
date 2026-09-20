import { z } from "zod";
import type { CodexEvent } from "./telemetry";

const Attribute = z.object({
  key: z.string(),
  value: z.object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
  }),
});
const Payload = z.object({
  resourceLogs: z
    .array(
      z.object({
        scopeLogs: z
          .array(
            z.object({
              logRecords: z
                .array(z.object({ attributes: z.array(Attribute).optional() }))
                .max(2000),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
const numeric = new Set([
  "duration_ms",
  "attempt",
  "http.response.status_code",
  "input_token_count",
  "output_token_count",
  "cached_token_count",
  "cache_write_token_count",
  "reasoning_token_count",
  "ttft_ms",
  "responses_duration_excl_engine_and_client_tool_time_ms",
  "inference_time_ms",
  "engine_iapi_ttft_ms",
  "engine_service_ttft_ms",
]);
const labels = new Set([
  "event.kind",
  "startup.phase",
  "startup.status",
  "model",
  "reasoning_effort",
  "model_reasoning_effort",
  "success",
  "auth.connection_reused",
]);
const names = new Set([
  "codex.api_request",
  "codex.conversation_starts",
  "codex.startup_phase",
  "codex.websocket_connect",
  "codex.websocket_request",
  "codex.websocket_event",
  "codex.sse_event",
  "codex.turn_ttft",
]);

export function decodeCodexTelemetry(body: unknown, epoch: number): CodexEvent[] {
  const parsed = Payload.safeParse(body);
  if (!parsed.success) return [];
  const events: CodexEvent[] = [];
  for (const r of parsed.data.resourceLogs ?? [])
    for (const s of r.scopeLogs ?? [])
      for (const log of s.logRecords) {
        const values = new Map(
          (log.attributes ?? []).map(({ key, value }) => [
            key,
            value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue,
          ]),
        );
        const name = values.get("event.name");
        if (typeof name !== "string" || !names.has(name)) continue;
        const fields: CodexEvent["fields"] = {};
        for (const [key, value] of values) {
          if (numeric.has(key) && value !== undefined && Number.isFinite(Number(value)))
            fields[key] = Number(value);
          if (
            labels.has(key) &&
            (typeof value === "boolean" ||
              (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value)))
          )
            fields[key] = value;
        }
        const stamp = values.get("event.timestamp");
        const at = typeof stamp === "string" ? Date.parse(stamp) : NaN;
        events.push({ name, ...(Number.isFinite(at) ? { atMs: at - epoch } : {}), fields });
      }
  return events;
}

/** Short-lived loopback collector; raw exports and account identifiers are never persisted. */
export function collectCodexTelemetry(epoch: number) {
  const events: CodexEvent[] = [],
    path = `/${crypto.randomUUID()}/v1/logs`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== path ||
        request.headers.has("origin")
      )
        return new Response(null, { status: 404 });
      try {
        const decoded = decodeCodexTelemetry(await request.json(), epoch);
        events.push(...decoded.slice(0, Math.max(0, 256 - events.length)));
      } catch {
        return new Response(null, { status: 400 });
      }
      return Response.json({});
    },
  });
  return { events, endpoint: new URL(path, server.url).href, stop: () => server.stop(true) };
}
