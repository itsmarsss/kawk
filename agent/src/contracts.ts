import { z } from "zod";
import type { ModelDiagnostics } from "./telemetry";

export const Id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const RefSchema = z
  .object({ eventId: Id, revision: z.number().int().nonnegative() })
  .strict();
export type EvidenceRef = z.infer<typeof RefSchema>;
export const EventSchema = z
  .object({
    id: Id,
    deviceId: Id,
    streamId: Id,
    revision: z.number().int().nonnegative(),
    kind: z.enum(["transcript", "observation", "context"]),
    final: z.boolean(),
    sourceStart: z.number().finite().nonnegative(),
    sourceEnd: z.number().finite().nonnegative(),
    text: z.string().min(1).max(30000),
    confidence: z.number().min(0).max(1),
    speakerId: Id.nullable().default(null),
    personIds: z.array(Id).max(16).default([]),
    provenance: z.string().min(1).max(200),
    timing: z
      .object({
        method: z.enum(["capture", "clock-mapped", "latency-estimate"]),
        clockSessionId: Id,
        uncertaintyMs: z.number().finite().min(0).max(86400000),
        captureStart: z.number().finite().nonnegative().optional(),
        captureEnd: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .optional(),
    words: z
      .array(
        z
          .object({
            text: z.string().min(1).max(300),
            sourceStart: z.number().finite().nonnegative(),
            sourceEnd: z.number().finite().nonnegative(),
          })
          .strict()
          .refine((w) => w.sourceEnd >= w.sourceStart),
      )
      .max(2000)
      .optional(),
  })
  .strict()
  .refine((e) => e.sourceEnd >= e.sourceStart, "sourceEnd precedes sourceStart")
  .refine(
    (e) =>
      !e.words ||
      e.words.every((w) => w.sourceStart >= e.sourceStart && w.sourceEnd <= e.sourceEnd),
    "Words must fall within the source interval",
  )
  .refine(
    (e) =>
      !e.timing ||
      (e.timing.captureStart === undefined && e.timing.captureEnd === undefined) ||
      (e.timing.captureStart !== undefined &&
        e.timing.captureEnd !== undefined &&
        e.timing.captureEnd >= e.timing.captureStart),
    "Invalid monotonic capture interval",
  );
export type PerceptionEvent = z.infer<typeof EventSchema>;
export type Evidence = PerceptionEvent & { owner: string; receivedAt: number };
export const BatchSchema = z.object({ events: z.array(EventSchema).min(1).max(64) }).strict();

export const DecisionSchema = z
  .object({
    captureNow: z.boolean().optional(),
    remember: z.boolean(),
    act: z.boolean(),
    route: z.enum(["observe", "start", "update", "cancel"]),
    targetId: Id.nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;
export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "abstained"
  | "cancelled"
  | "failed";
export const ACTIVE: TaskState[] = ["queued", "running", "waiting"];
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface Task {
  id: string;
  owner: string;
  parentId: string | null;
  rootId: string;
  goal: string;
  mode: "assist" | "memory";
  status: TaskState;
  messages: ChatMessage[];
  result: string | null;
  error: string | null;
  createdAt: number;
  deadline: number;
  steps: number;
  tokens: number;
  capabilities: string[];
}
export interface Memory {
  id: string;
  key: string;
  text: string;
  version: number;
  kind: "fact" | "episode" | "intention";
  refs: EvidenceRef[];
  createdAt: number;
}
export interface Notification {
  id: string;
  taskId: string;
  text: string;
  refs: EvidenceRef[];
  createdAt: number;
  expiresAt: number;
  state: "pending" | "acked" | "withdrawn";
}
export interface GateInput {
  event: Evidence;
  context: Evidence[];
  tasks: Task[];
  now?: number;
  timeZone?: string;
  previousTranscript?: Evidence;
}
export interface Gate {
  bindPerson?(
    input: { text: string; name: string; trackId: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  decide(input: GateInput, signal: AbortSignal): Promise<Decision>;
  review?(
    input: {
      goal: string;
      text: string;
      evidence: Evidence[];
      completedTools?: string[];
      now?: number;
      timeZone?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelResponse {
  message: ChatMessage;
  tokens: number;
  /** Provider-reported reasoning usage; undefined means unavailable, not zero. */
  reasoningTokens?: number;
  diagnostics?: ModelDiagnostics;
}
export interface LanguageModel {
  complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelResponse>;
}
export class Conflict extends Error {}
export class Unavailable extends Error {}
export const refOf = (event: PerceptionEvent): EvidenceRef => ({
  eventId: event.id,
  revision: event.revision,
});
export const refKey = (ref: EvidenceRef) => `${ref.eventId}@${ref.revision}`;
export const parseJSON = <T>(value: string): T => JSON.parse(value) as T;
