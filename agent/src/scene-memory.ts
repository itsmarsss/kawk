import { createHash } from "node:crypto";
import { z } from "zod";
import { EventSchema, refOf, type Evidence, type PerceptionEvent } from "./contracts";
import type { Store } from "./store";
import type { ToolRegistrar } from "./tools";

const idFor = (kind: string, id: string) => `scene-${kind}-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
const Hit = z.object({ id: z.string(), packetId: z.string(), packetVersion: z.number().int().nonnegative(),
  text: z.string(), observedAt: z.number(), endAt: z.number(), confidence: z.string(),
  entityIds: z.array(z.string()), candidateEntityIds: z.array(z.string()).optional(), superseded: z.boolean() });

/** HTTP adapter to the existing camera-memory service; source timestamps and IDs survive the boundary. */
export class SceneMemory {
  constructor(readonly url: string, private store: Store, private fetcher = fetch) {}
  async request(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await this.fetcher(new URL(path, this.url), {
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20000)]), redirect: "error",
    });
    if (!response.ok) throw new Error(`Scene memory HTTP ${response.status}`);
    return response.json() as Promise<any>;
  }
  requestCamera(id: string, reason: string, deviceId?: string, signal?: AbortSignal) {
    return this.request("/api/agent/capture", { id, reason: reason.slice(0, 1000),
      ...(deviceId?.startsWith("memory-") && deviceId !== "memory-manual" ? { sessionId: deviceId.slice(7) } : {}) }, signal);
  }
  async camera(owner: string, id: string, reason: string, signal: AbortSignal, existing = false) {
    if (!existing) await this.requestCamera(id, reason, undefined, signal);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = await this.request(`/api/agent/capture/${encodeURIComponent(id)}`, undefined, signal);
      if (result.state === "completed") {
        const event = EventSchema.parse(result.event);
        this.store.ingest(owner, event, false);
        return { state: result.state, captureId: result.captureId, source: event, refs: [refOf(event)] };
      }
      if (["failed", "expired"].includes(result.state)) throw new Error(result.error ?? "Fresh camera capture expired");
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 200);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("Fresh camera interpretation timed out");
  }
  async search(owner: string, input: { query: string; mode?: string; from?: number; to?: number; entityId?: string; limit?: number }, signal: AbortSignal) {
    const result = await this.request("/api/search", { ...input, mode: input.mode ?? "keyword", limit: input.limit ?? 8 }, signal);
    const hits = z.array(Hit).parse(result.results).filter(h => !h.superseded);
    return hits.map(hit => {
      const event: PerceptionEvent = { id: idFor("note", hit.id), revision: hit.packetVersion,
        deviceId: "scene-memory", streamId: idFor("packet", hit.packetId), kind: "context", final: true,
        sourceStart: hit.observedAt, sourceEnd: hit.endAt, text: JSON.stringify(hit).slice(0, 29000),
        confidence: hit.confidence === "uncertain" ? 0.5 : 0.8, speakerId: null, personIds: [],
        provenance: `scene-memory:note:${hit.id}` };
      this.store.ingest(owner, event, false);
      return { ...hit, sourceUrl: `/api/frames/${hit.packetId}`, evidenceRef: refOf(event) };
    });
  }
  async current(owner: string, signal: AbortSignal) {
    const data = await this.request("/api/agent/context", undefined, signal);
    // Current state is derived and may lag. Keep it separate from fresh capture observations.
    return { ...data, warning: "State may lag capture. Use original capture times; a visible person is not a verified speaker." };
  }
  async currentEvidence(event: Evidence, signal: AbortSignal) {
    const prefix = "scene-memory:note:";
    if (!event.provenance.startsWith(prefix)) return true;
    const result = await this.request(`/api/agent/source/${encodeURIComponent(event.provenance.slice(prefix.length))}`, undefined, signal);
    return result.valid === true;
  }
}

export function registerSceneTools(add: ToolRegistrar, scene: SceneMemory,
  bind: (task: import("./contracts").Task, refs: import("./contracts").EvidenceRef[]) => void) {
  add("search_scene_memory", "Search the camera memory database for objects, people, classes/events and notes. Keyword is default; semantic is optional. Filter original source times. Read evidence and distinguish candidate identities from confirmed ones.",
    z.object({ query: z.string().min(1).max(500), mode: z.enum(["keyword", "semantic"]).optional(),
      from: z.number().optional(), to: z.number().optional(), entityId: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }).strict(), true,
    async (args, { task, signal }) => { const results = await scene.search(task.owner, args, signal); if (results.length) bind(task, results.map(r => r.evidenceRef)); return { results }; });
  add("get_scene_context", "Read the camera memory service's current state, known people and recent captures. Check timestamps and processing status; state may lag. Use search_scene_memory for citable historical details.",
    z.object({}).strict(), true, async (_, { task, signal }) => scene.current(task.owner, signal));
  add("capture_camera", "Request a fresh wearer-camera photo immediately, outside the five-second cadence, and await its interpretation. Requires an active capture page. If the trigger contains cameraRequest.id, pass that requestId to await that existing request, avoiding duplicate photos. This is the wearer camera, not a browser screenshot.",
    z.object({ reason: z.string().min(1).max(1000), requestId: z.string().optional() }).strict(), true,
    async ({ reason, requestId }, { task, signal, callId }) => { const result = await scene.camera(task.owner, requestId ?? `tool-${callId}`, reason, signal, Boolean(requestId)); bind(task, result.refs); return result; });
}
