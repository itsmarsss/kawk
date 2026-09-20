import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Conflict,
  Id,
  RefSchema,
  refOf,
  type EvidenceRef,
  type Task,
  type ToolDefinition,
} from "./contracts";
import type { Store } from "./store";
import type { Runner } from "./runner";
import type { Telemetry } from "./telemetry";
import type { KnowledgeGraph } from "./knowledge";
import type { Capture } from "./capture";
import type { Reminders } from "./reminders";
import { registerMemoryTools } from "./memory-tools";
import { registerSceneTools, type SceneMemory } from "./scene-memory";

export interface ToolContext {
  task: Task;
  callId: string;
  signal: AbortSignal;
}
export interface ToolHost {
  scene?: SceneMemory;
  store: Store;
  runner: Runner;
  artifactDir: string;
  telemetry?: Telemetry;
  graph: KnowledgeGraph;
  reminders: Reminders;
  capture: Capture;
  verifyPerson(text: string, name: string, trackId: string, signal: AbortSignal): Promise<boolean>;
  timeZone: string;
  spawn(parent: Task, goal: string, context: string, callId: string): Task;
  cancel(id: string): void;
  verifyNotification(
    task: Task,
    text: string,
    refs: EvidenceRef[],
    signal: AbortSignal,
  ): Promise<boolean>;
}
interface Tool {
  schema: z.ZodType;
  definition: ToolDefinition;
  safe: boolean;
  execute: (args: any, ctx: ToolContext) => Promise<unknown>;
}
export type ToolRegistrar = (
  name: string,
  description: string,
  schema: z.ZodType,
  safe: boolean,
  execute: Tool["execute"],
) => unknown;
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  constructor(private host: ToolHost) {
    const { store } = host;
    const add = (
      name: string,
      description: string,
      schema: z.ZodType,
      safe: boolean,
      execute: Tool["execute"],
    ) =>
      this.tools.set(name, {
        schema,
        safe,
        execute,
        definition: {
          name,
          description,
          parameters: z.toJSONSchema(schema) as Record<string, unknown>,
        },
      });
    const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
    const refs = z.array(RefSchema).min(1).max(32);
    const bind = (task: Task, evidence: EvidenceRef[]) => {
      if (!store.valid(task.owner, evidence)) throw new Conflict("Evidence no longer current");
      store.depend("task", task.id, task.owner, evidence);
      store.depend("task", task.rootId, task.owner, evidence);
    };
    registerMemoryTools(add, host, bind);
    if (host.scene) registerSceneTools(add, host.scene, bind);
    add(
      "identify_person",
      "Find one stable source-time face in the camera buffer; returns gallery identity if recognized. Rejects ambiguous or changed targets.",
      object({ eventId: Id }),
      true,
      async ({ eventId }, { task }) => {
        const result = host.capture.identify(task.owner, eventId);
        bind(task, result.evidenceRefs);
        return {
          trackId: result.face.trackId,
          personId: result.personId,
          name: result.name,
          frameIds: result.frameIds,
          refs: result.evidenceRefs,
        };
      },
    );
    add(
      "enroll_person",
      "Save or rename the stable source-time person from a natural introduction. Jev independently validates the spoken name; mentions and ambiguous targets are rejected. Keeps a calibrated face image and the same gallery UUID on correction.",
      object({ eventId: Id, trackId: Id, name: z.string().min(1).max(100) }),
      true,
      async ({ eventId, trackId, name }, { task, signal }) => {
        const candidate = host.capture.identify(task.owner, eventId);
        if (candidate.face.trackId !== trackId) throw new Conflict("Target changed");
        if (!(await host.verifyPerson(candidate.source.text, name, trackId, signal)))
          throw new Conflict("Jev could not bind this introduction to the visible person");
        signal.throwIfAborted();
        bind(task, candidate.evidenceRefs);
        return host.capture.enroll(task.owner, eventId, name, trackId);
      },
    );
    add(
      "search_memory",
      "Keyword-only search of saved notes and evidence (SQLite FTS). Use grep_history first for original history. Returns source times and evidence references.",
      object({ query: z.string().min(1).max(300) }),
      true,
      async ({ query }, { task }) => {
        const result = store.search(task.owner, query);
        const citations = [
          ...result.evidence.map(refOf),
          ...result.memories.flatMap((m) => m.refs),
        ];
        if (citations.length) bind(task, citations);
        return result;
      },
    );
    add(
      "read_evidence",
      "Read a current source event by ID. A visible person is not necessarily its speaker.",
      object({ eventId: Id }),
      true,
      async ({ eventId }, { task }) => {
        const e = store.latest(task.owner, eventId);
        if (!e?.final) throw new Error("Finalized evidence not found");
        bind(task, [refOf(e)]);
        return e;
      },
    );
    add(
      "remember",
      "Store a fact, episode or intention supported by current evidence. Preserve uncertainty and source attribution; key identifies a versioned memory.",
      object({
        key: z.string().min(1).max(160),
        text: z.string().min(1).max(3000),
        kind: z.enum(["fact", "episode", "intention"]),
        refs,
      }),
      true,
      async (args, { task }) => {
        bind(task, args.refs);
        return store.remember(task.owner, args.key, args.text, args.kind, args.refs);
      },
    );
    add(
      "spawn_subagent",
      "Delegate a bounded independent task. Child receives only goal, supplied context and source references; use wait_for_subagents to collect results.",
      object({ goal: z.string().min(1).max(2000), context: z.string().max(8000) }),
      true,
      async ({ goal, context }, { task, callId }) => {
        const child = host.spawn(task, goal, context, callId);
        return { id: child.id, status: child.status };
      },
    );
    add(
      "subagent_status",
      "Read the status and result of your direct subagent.",
      object({ id: Id }),
      true,
      async ({ id }, { task }) => this.child(task, id),
    );
    add(
      "message_subagent",
      "Add context or requirements to a direct subagent at its next safe tool boundary.",
      object({ id: Id, text: z.string().min(1).max(4000) }),
      true,
      async ({ id, text }, { task, callId }) => {
        const child = this.child(task, id);
        if (!["queued", "running", "waiting"].includes(child.status))
          throw new Error("Subagent already ended");
        store.message(id, text, callId);
        return { queued: true };
      },
    );
    add(
      "cancel_subagent",
      "Cancel a direct subagent and release its execution resources.",
      object({ id: Id }),
      true,
      async ({ id }, { task }) => {
        this.child(task, id);
        host.cancel(id);
        return { cancelled: true };
      },
    );
    add(
      "wait_for_subagents",
      "Yield this turn until a child completes; the service continues ingesting events and running other work.",
      object({}),
      true,
      async (_, { task }) => {
        const children = store.children(task.id);
        if (children.some((t) => ["queued", "running", "waiting"].includes(t.status)))
          store.setTask(task.id, "waiting");
        return children.map((t) => ({
          id: t.id,
          status: t.status,
          result: t.result,
          error: t.error,
        }));
      },
    );
    add(
      "schedule_followup",
      "Schedule a future need for Jev to re-evaluate. Does not guarantee a notification. Provide an epoch millisecond dueAt and source references.",
      object({ text: z.string().min(1).max(2000), dueAt: z.number().finite(), refs }),
      true,
      async ({ text, dueAt, refs }, { task, callId }) => {
        if (dueAt <= store.now() || dueAt > store.now() + 30 * 86400000)
          throw new Error("Schedule must be within the next 30 days");
        bind(task, refs);
        store.run(
          "INSERT OR IGNORE INTO schedules VALUES(?,?,?,?,?,?,0)",
          callId,
          task.owner,
          task.id,
          dueAt,
          text,
          JSON.stringify(refs),
        );
        return { id: callId, dueAt };
      },
    );
    add(
      "run_code",
      "Execute a local shell command with cwd in this task's /tmp workspace. Host files and network are accessible; this is not an OS sandbox. Returns processId and workspace; poll for output/completion.",
      object({
        command: z.string().min(1).max(16000),
        timeoutMs: z.number().int().min(100).max(60000).default(30000),
      }),
      false,
      async (args, ctx) => this.run(ctx, "code", "exec", args),
    );
    add(
      "poll_process",
      "Wait briefly for completion or read new output from a task-owned process. Does not block other tasks. Use waitMs for long-running commands instead of repeatedly waking the model.",
      object({
        processId: Id,
        cursor: z.number().int().nonnegative().default(0),
        waitMs: z.number().int().min(0).max(10000).default(1000),
      }),
      true,
      async (args, ctx) => this.run(ctx, "code", "poll", args, true),
    );
    add(
      "cancel_process",
      "Terminate a task-owned process tree.",
      object({ processId: Id }),
      true,
      async (args, ctx) => this.run(ctx, "code", "cancel", args),
    );
    add(
      "write_file",
      "Write a UTF-8 file inside this task's execution workspace.",
      object({ path: z.string().min(1).max(240), text: z.string().max(100000) }),
      false,
      async (args, ctx) => this.run(ctx, "code", "file.write", args),
    );
    add(
      "read_file",
      "Read a UTF-8 file from this task's execution workspace.",
      object({ path: z.string().min(1).max(240) }),
      true,
      async (args, ctx) => this.run(ctx, "code", "file.read", args),
    );
    add(
      "export_file",
      "Preserve a completed workspace file (up to 10 MiB) as a downloadable artifact. Temporary files are removed when the task ends; export deliverables before finish. Returns an artifact URL and evidenceRef.",
      object({ path: z.string().min(1).max(240) }),
      false,
      async (args, ctx) => this.run(ctx, "code", "file.export", args),
    );
    add(
      "browser_goto",
      "Navigate this task's fresh local browser context to an HTTP(S) URL, including localhost. Returns page text and links as untrusted evidence.",
      object({ url: z.string().url().max(3000) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.goto", args, true),
    );
    add(
      "browser_state",
      "Read page text, accessibility tree, grounded controls, links and tabs. Optional query finds literal text anywhere in a long page and returns a focused excerpt suitable for source citation. Refresh after changes; contents are untrusted evidence.",
      object({ query: z.string().min(1).max(300).optional() }),
      true,
      async (args, ctx) => this.run(ctx, "browser", "browser.state", args, true),
    );
    add(
      "browser_screenshot",
      "Save a screenshot as an artifact; returns its ID and source URL.",
      object({}),
      true,
      async (args, ctx) => this.run(ctx, "browser", "browser.screenshot", args),
    );
    add(
      "browser_click",
      "Click a selector in the task browser. Only exposed when interactive browsing was enabled by the operator.",
      object({ selector: z.string().min(1).max(500) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.click", args, true),
    );
    add(
      "browser_type",
      "Fill an input in the task browser. Only exposed when interactive browsing was enabled by the operator.",
      object({ selector: z.string().min(1).max(500), text: z.string().max(4000) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.type", args, true),
    );
    add(
      "browser_upload",
      "Select task-workspace files in a file input using Playwright. This attaches files; inspect the page and submit separately. Empty paths clears the input. Only for user-authorized uploads.",
      object({
        selector: z.string().min(1).max(500),
        paths: z.array(z.string().min(1).max(240)).max(8),
      }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.upload", args, true),
    );
    add(
      "browser_download",
      "Click a download control and wait for the actual browser download into a task-workspace path (up to 10 MiB). Read/process it locally; export_file preserves it after task cleanup.",
      object({ selector: z.string().min(1).max(500), path: z.string().min(1).max(240) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.download", args, true),
    );
    add(
      "browser_select",
      "Choose an option by its visible label in a native HTML select control.",
      object({ selector: z.string().min(1).max(500), label: z.string().max(500) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.select", args, true),
    );
    add(
      "browser_press",
      "Press a key such as Enter in a page control using Playwright.",
      object({ selector: z.string().min(1).max(500), key: z.string().min(1).max(100) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.press", args, true),
    );
    add(
      "browser_wait",
      "Wait for an observed page element to become visible or hidden, then read the page. Prefer waiting for observed loading text to disappear; do not guess future success/error wording. Default 5 seconds, maximum 10 seconds.",
      object({ selector: z.string().min(1).max(500), state: z.enum(["visible", "hidden"]).default("visible"), timeoutMs: z.number().int().min(100).max(10000).default(5000) }),
      true,
      async (args, ctx) => this.run(ctx, "browser", "browser.wait", args, true),
    );
    add(
      "browser_switch_tab",
      "Switch to a tab index from browser_state. Popups become active automatically.",
      object({ index: z.number().int().min(0).max(30) }),
      false,
      async (args, ctx) => this.run(ctx, "browser", "browser.tab", args, true),
    );
    add(
      "finish",
      "Finish with a supported result or quietly abstain. notify=true requires useful text, current source references, high confidence and an assist task. Children return results only.",
      object({
        text: z.string().max(4000),
        refs: z.array(RefSchema).max(8),
        confidence: z.number().min(0).max(1),
        notify: z.boolean(),
      }),
      true,
      async (args, { task, signal }) => {
        if (
          store.children(task.id).some((c) => ["queued", "running", "waiting"].includes(c.status))
        )
          throw new Error("Wait for or cancel outstanding subagents before finishing");
        if (args.refs.length) bind(task, args.refs);
        let eligible =
          args.notify &&
          task.mode === "assist" &&
          !task.parentId &&
          args.text.trim() &&
          args.confidence >= 0.8 &&
          args.refs.length > 0;
        if (args.notify && !eligible && !task.parentId)
          throw new Error(
            "Notification needs an assist task, useful text and high-confidence evidence",
          );
        if (eligible) {
          eligible = await host.verifyNotification(task, args.text, args.refs, signal);
          if (
            !eligible &&
            !store.one(
              "SELECT 1 FROM receipts WHERE task_id=? AND name='finish' AND state='done' AND json_extract(result,'$.reviewRejected')=1",
              task.id,
            )
          ) {
            signal.throwIfAborted();
            return {
              reviewRejected: true,
              delivered: false,
              message:
                "Delivery review could not establish support. Retrieve missing source context, check dates and antecedents such as 'same', 'he' or 'it', and include the sources needed to identify the object/person. Correct unsupported claims. Do not merely reword to seek approval. If no further support exists, finish with notify=false. One evidence-repair attempt remains.",
            };
          }
        }
        signal.throwIfAborted();
        if (store.task(task.id)?.status !== "running")
          throw new Conflict("Task ended during delivery review");
        if (!store.valid(task.owner, store.refs("task", task.id)))
          throw new Conflict("Task evidence changed during delivery review");
        if (eligible) {
          const duplicate = store.one(
            "SELECT 1 FROM notifications WHERE owner=? AND text=? AND created_at>? AND state!='withdrawn'",
            task.owner,
            args.text,
            store.now() - 60000,
          );
          if (!duplicate) {
            const notification = store.notify(
              task,
              args.text,
              args.refs,
              host.reminders.isWake(task.id) ? 86400000 : 30000,
            );
            host.telemetry?.emit("notification.created", {
              taskId: task.id,
              rootId: task.rootId,
              notificationId: notification.id,
              taskAgeMs: store.now() - task.createdAt,
            });
          }
        }
        const result = {
          ...args,
          notify: Boolean(eligible),
          reviewRejected: Boolean(args.notify && !eligible && !task.parentId),
        };
        store.setTask(
          task.id,
          args.text.trim() ? "completed" : "abstained",
          JSON.stringify(result),
        );
        return { finished: true, ...result };
      },
    );
  }
  private child(parent: Task, id: string): Task {
    const task = this.host.store.task(id);
    if (!task || task.parentId !== parent.id || task.owner !== parent.owner)
      throw new Error("Unknown direct subagent");
    return task;
  }
  private async run(
    ctx: ToolContext,
    mode: "code" | "browser",
    action: string,
    args: Record<string, unknown>,
    evidence = false,
  ): Promise<unknown> {
    const result = (await this.host.runner.call(
      ctx.task.id,
      mode,
      action,
      args,
      ctx.signal,
    )) as Record<string, unknown>;
    ctx.signal.throwIfAborted();
    if (typeof result.base64 === "string") {
      const id = crypto.randomUUID();
      const filename = typeof result.filename === "string" ? result.filename : "screenshot.png";
      const mime = typeof result.mime === "string" ? result.mime : "application/octet-stream";
      await mkdir(this.host.artifactDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(this.host.artifactDir, id + (mime === "image/png" ? ".png" : ".bin")),
        Buffer.from(result.base64, "base64"),
        { mode: 0o600 },
      );
      this.host.store.run(
        "INSERT INTO artifacts(id,owner,task_id,created_at,filename,mime) VALUES(?,?,?,?,?,?)",
        id,
        ctx.task.owner,
        ctx.task.id,
        this.host.store.now(),
        filename,
        mime,
      );
      return this.recordEvidence(
        ctx,
        {
          artifactId: id,
          saved: true,
          filename,
          mime,
          bytes: Buffer.byteLength(result.base64, "base64"),
          contentPreview: mime.startsWith("text/") || mime === "application/json"
            ? Buffer.from(result.base64, "base64").toString("utf8").slice(0, 4000)
            : undefined,
          downloadUrl: `/v1/artifacts/${id}`,
          url: result.url,
        },
        `${mode}:${action}`,
      );
    }
    if (evidence && (mode !== "code" || result.exitCode === 0)) {
      return this.recordEvidence(ctx, result, `${mode}:${action}`, 0.8);
    }
    return result;
  }
  private recordEvidence(
    ctx: ToolContext,
    result: Record<string, unknown>,
    provenance: string,
    confidence = 1,
  ) {
    const id = `tool-${ctx.callId}`,
      at = this.host.store.now();
    const event = {
      id,
      deviceId: "agent",
      streamId: ctx.task.id,
      revision: 0,
      kind: "context" as const,
      final: true,
      sourceStart: at,
      sourceEnd: at,
      text: JSON.stringify(result).slice(0, 12000),
      confidence,
      speakerId: null,
      personIds: [],
      provenance,
    };
    // A repeated replay-safe read reuses its prior evidence, not a changed payload.
    if (!this.host.store.latest(ctx.task.owner, id))
      this.host.store.ingest(ctx.task.owner, event, false);
    this.host.store.depend(
      "derived_evidence",
      id,
      ctx.task.owner,
      this.host.store.refs("task", ctx.task.id).filter((r) => r.eventId !== id),
    );
    this.host.store.depend("task", ctx.task.id, ctx.task.owner, [refOf(event)]);
    this.host.store.depend("task", ctx.task.rootId, ctx.task.owner, [refOf(event)]);
    return { ...result, evidenceRef: refOf(event) };
  }
  names() {
    return [...this.tools.keys()];
  }
  definitions(task: Task): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => task.capabilities.includes(t.definition.name))
      .map((t) => t.definition);
  }
  async execute(name: string, argsText: string, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool || !ctx.task.capabilities.includes(name))
      throw new Error("Tool not allowed for this task");
    const args = tool.schema.parse(JSON.parse(argsText));
    const prior = this.host.store.receipt(ctx.callId);
    if (prior) {
      if (prior.name !== name || prior.args !== argsText || prior.task_id !== ctx.task.id)
        throw new Conflict("Tool call ID reused with different arguments");
      if (prior.state === "done") return JSON.parse(prior.result!);
      if (!tool.safe)
        throw new Conflict("Interrupted tool outcome unknown; automatic replay blocked");
    }
    this.host.store.beginTool(ctx.callId, ctx.task.id, name, argsText, tool.safe);
    let result = await tool.execute(args, ctx);
    if (
      [
        "remember",
        "remember_entity",
        "remember_relation",
        "cancel_reminder",
        "get_identity_context",
      ].includes(name)
    ) {
      const receipt = this.recordEvidence(
        ctx,
        { operation: name, completed: true, result },
        `receipt:${name}`,
      );
      result = { ...(result as Record<string, unknown>), evidenceRef: receipt.evidenceRef };
    }
    this.host.store.endTool(ctx.callId, result);
    return result;
  }
}
