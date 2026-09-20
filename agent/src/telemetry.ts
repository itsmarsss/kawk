import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface ModelDiagnostics {
  provider: "openai" | "codex" | "baseten";
  model: string;
  reasoning: string;
  totalMs: number;
  inputBytes: number;
  messageBytes: number;
  toolBytes: number;
  toolCount: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  phases: Record<string, number>;
  codex?: CodexEvent[];
  failedAttempts?: ModelDiagnostics[];
  telemetryStatus?: "enabled" | "disabled" | "unavailable";
  failureType?: string;
}
export interface CodexEvent {
  name: string;
  atMs?: number;
  fields: Record<string, string | number | boolean>;
}
export interface TelemetryEvent {
  sessionId: string;
  at: string;
  atMs: number;
  name: string;
  spanId?: string;
  taskId?: string;
  rootId?: string;
  eventId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

/** Local, bounded metadata log. Call sites omit prompts, tool args and credentials. */
export class Telemetry {
  readonly sessionId = crypto.randomUUID();
  private start = performance.now();
  dropped = 0;
  constructor(private sink?: (event: TelemetryEvent) => void) {}
  emit(name: string, fields: Record<string, unknown> = {}) {
    try {
      this.sink?.({
        ...fields,
        name,
        sessionId: this.sessionId,
        at: new Date().toISOString(),
        atMs: Math.round(performance.now() - this.start),
      });
    } catch {
      this.dropped++;
    }
  }
  async span<T>(name: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const spanId = crypto.randomUUID(),
      start = performance.now();
    this.emit(`${name}.start`, { ...fields, spanId });
    try {
      const result = await fn();
      this.emit(`${name}.end`, { ...fields, spanId, durationMs: performance.now() - start });
      return result;
    } catch (error) {
      this.emit(`${name}.error`, { ...fields, spanId, durationMs: performance.now() - start });
      throw error;
    }
  }
}

export function fileTelemetry(path: string, maxBytes = 10 * 1024 * 1024) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) chmodSync(path, 0o600);
  let size = existsSync(path) ? statSync(path).size : 0;
  return new Telemetry((event) => {
    const line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line) > maxBytes) throw new Error("Telemetry record exceeds log budget");
    if (size + Buffer.byteLength(line) > maxBytes && size) {
      renameSync(path, path + ".1");
      size = 0;
    }
    appendFileSync(path, line, { mode: 0o600 });
    size += Buffer.byteLength(line);
  });
}

/** Sequential parts of a single call; warmup events are deliberately excluded from the answer. */
export function modelLatency(d: ModelDiagnostics) {
  if (d.provider === "openai") {
    const { requestStartedMs: start, firstTokenMs: first, responseCompletedMs: end } = d.phases;
    if (
      start === undefined ||
      first === undefined ||
      end === undefined ||
      start < 0 ||
      first < start ||
      end < first ||
      d.totalMs < end
    )
      return null;
    return {
      setupMs: start,
      firstTokenWaitMs: first - start,
      streamingMs: end - first,
      shutdownMs: d.totalMs - end,
    };
  }
  const first = d.codex?.find((e) => e.name === "codex.turn_ttft" && e.atMs !== undefined);
  const completed = [...(d.codex ?? [])]
    .reverse()
    .find(
      (e) =>
        e.name === "codex.sse_event" &&
        e.fields["event.kind"] === "response.completed" &&
        typeof e.fields.ttft_ms === "number",
    );
  const request = [...(d.codex ?? [])]
    .reverse()
    .find(
      (e) =>
        e.name === "codex.websocket_request" &&
        e.atMs !== undefined &&
        first?.atMs !== undefined &&
        e.atMs <= first.atMs,
    );
  if (first?.atMs === undefined || completed?.atMs === undefined || request?.atMs === undefined)
    return null;
  const values = [
    request.atMs,
    first.atMs - request.atMs,
    completed.atMs - first.atMs,
    d.totalMs - completed.atMs,
  ];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return null;
  return {
    setupMs: values[0]!,
    firstTokenWaitMs: values[1]!,
    streamingMs: values[2]!,
    shutdownMs: values[3]!,
  };
}

export function modelTable(calls: { label: string; diagnostics: ModelDiagnostics }[]): string[] {
  const seconds = (value: number | undefined) =>
    value === undefined ? "—" : `${(value / 1000).toFixed(3)}s`;
  return [
    "| Call | Total | Setup to request | Request to first token | First token to complete | After response | Input / cached / output / reasoning tokens |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...calls.map(({ label, diagnostics: d }) => {
      const p = modelLatency(d);
      return `| ${label} (${d.provider}) | ${seconds(d.totalMs)} | ${seconds(p?.setupMs)} | ${seconds(p?.firstTokenWaitMs)} | ${seconds(p?.streamingMs)} | ${seconds(p?.shutdownMs)} | ${[d.inputTokens, d.cachedInputTokens, d.outputTokens, d.reasoningTokens].map((v) => v ?? "unknown").join(" / ")} |`;
    }),
    "",
    "Setup includes local request preparation; Codex also includes CLI startup and connection/prewarm. First-token wait includes network and provider work (OpenAI: first text/tool-argument delta observed). Server queueing versus prompt processing is not separately exposed. Streaming includes completion bookkeeping. After-response time includes stream cleanup; Codex also includes CLI shutdown and exporter flush. Missing timings are unknown, not zero. Parts sum to a call, not to wall time across parallel children.",
  ];
}
