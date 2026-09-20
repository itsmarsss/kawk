import { z } from "zod";
import { Id, refOf, type EvidenceRef, type Task } from "./contracts";
import { EntityInput, RelationInput } from "./knowledge";
import { ReminderInput } from "./reminders";
import { currentTime, interval, relateTime, resolveLocalTime } from "./temporal";
import type { ToolHost, ToolRegistrar } from "./tools";
import { grepHistory, HistoryQuery } from "./history";

export const TranscriptFilter = z
  .object({
    query: z.string().max(300).optional(),
    from: z.number().finite().nonnegative().optional(),
    to: z.number().finite().nonnegative().optional(),
    personId: Id.optional(),
    speakerId: Id.optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine(
    (v) => v.from === undefined || v.to === undefined || v.to >= v.from,
    "Invalid time window",
  );
export const GraphFilter = z
  .object({
    query: z.string().max(300).optional(),
    entityId: Id.optional(),
    from: z.number().finite().nonnegative().optional(),
    to: z.number().finite().nonnegative().optional(),
    history: z.boolean().default(false),
  })
  .strict();

export function registerMemoryTools(
  add: ToolRegistrar,
  host: ToolHost,
  bind: (task: Task, refs: EvidenceRef[]) => void,
) {
  const { store } = host;
  add(
    "get_identity_context",
    "Read the current account/wearer identity capabilities. Use before answering who wears the glasses. The account is configured; there is currently no verified wearer or automatic owner-to-face binding. A face in view does not change that.",
    z.object({}).strict(),
    true,
    async (_, { task }) => ({
      accountOwner: task.owner,
      verifiedWearerId: null,
      ownerGalleryId: null,
      automaticWearerDetection: false,
      automaticWearerSwitching: false,
      visibleFaceProvesWearer: false,
    }),
  );
  add(
    "grep_history",
    "Run ripgrep over this account's persisted history, including the current hour and speech Jev ignored. Case-insensitive regex by default; fixedStrings enables literal matching. Use keywords/alternatives, e.g. keys|keyring. Searches JSONL text and metadata; from/to filter original source times. personId means visible, speakerId means verified speaker. Returns current final evidence with citations in ingestion order. Returned source text/citations can be used directly. Use read_evidence for omitted word timing or temporal_context when surrounding events are needed. If truncated, pass nextCursor as after; no matches do not prove an event never happened.",
    HistoryQuery,
    true,
    async (args, { task, signal }) => {
      const result = await grepHistory(store, task.owner, args, signal);
      if (result.matches.length)
        bind(
          task,
          result.matches.map((m) => m.evidenceRef),
        );
      return result;
    },
  );
  add(
    "search_transcripts",
    "Search all captured final speech regardless of Jev. Filter source-time epoch milliseconds; personId means co-visible, speakerId means verified speaker. Results are chronological with offset pagination.",
    TranscriptFilter,
    true,
    async (args, { task }) => {
      const evidence = store.transcripts(task.owner, args);
      if (evidence.length) bind(task, evidence.map(refOf));
      return {
        evidence,
        nextOffset: evidence.length === args.limit ? args.offset + evidence.length : null,
      };
    },
  );
  add(
    "temporal_context",
    "Find observations/transcripts around an event's ORIGINAL source interval, accounting for reported timing error. Missing error bounds are unknown. Overlap never proves who spoke.",
    z.object({ eventId: Id, paddingMs: z.number().min(0).max(60000).default(0) }).strict(),
    true,
    async ({ eventId, paddingMs }, { task }) => {
      const event = store.latest(task.owner, eventId);
      if (!event?.final) throw new Error("Current finalized event required");
      const range = interval(event);
      const candidates = store
        .window(task.owner, range.start - paddingMs, range.end + paddingMs)
        .filter((e) => e.id !== eventId && e.deviceId === event.deviceId);
      bind(task, [refOf(event), ...candidates.map(refOf)]);
      return {
        source: event,
        range,
        candidates: candidates.map((e) => ({ event: e, ...relateTime(event, e) })),
        limitation:
          "Capture overlap is context only; it establishes neither wearer nor speaker identity.",
      };
    },
  );
  add(
    "remember_entity",
    "Create/update a stable graph entity with evidence. Reuse known keys; galleryId requires cited co-visible face identity. Similar appearance or name alone does not prove the same person/object.",
    EntityInput,
    true,
    async (args, { task }) => {
      bind(task, args.refs);
      return host.graph.entity(task.owner, args);
    },
  );
  add(
    "remember_relation",
    "Record an evidence-backed relationship/property with source validity and uncertainty. Same key supersedes an older claim, preserving history; use distinct keys for distinct historical episodes.",
    RelationInput,
    true,
    async (args, { task }) => {
      bind(task, args.refs);
      return host.graph.relation(task.owner, args);
    },
  );
  add(
    "query_graph",
    "Find entities and relationships up to two hops. Query matches names/aliases; history includes superseded claims, not current truth. Read cited evidence before attributing speech.",
    GraphFilter,
    true,
    async (args, { task }) => {
      const result = host.graph.query(task.owner, args);
      const refs = [
        ...result.entities.flatMap((e) => e?.refs ?? []),
        ...result.relations.flatMap((e) => e.refs),
      ] as EvidenceRef[];
      if (refs.length) bind(task, refs);
      return result;
    },
  );
  add(
    "get_current_time",
    "Get actual current epoch milliseconds, ISO time and wearer-configured timezone. Use for calendar questions and reminder dates; source timestamps are separate.",
    z.object({}).strict(),
    true,
    async () => currentTime(store.now(), host.timeZone),
  );
  add(
    "resolve_local_time",
    "Convert YYYY-MM-DDTHH:mm:ss in an IANA timezone to epoch milliseconds. Rejects nonexistent/ambiguous DST times; ask for an explicit offset if ambiguous.",
    z
      .object({
        local: z.string().min(1).max(100),
        timeZone: z.string().min(1).max(100).optional(),
      })
      .strict(),
    true,
    async ({ local, timeZone }) =>
      currentTime(resolveLocalTime(local, timeZone ?? host.timeZone), timeZone ?? host.timeZone),
  );
  add(
    "create_reminder",
    "Create an explicit durable reminder: for 'in N seconds/minutes' use afterMs plus anchorEventId of the ORIGINAL utterance, so processing delay does not shift the due time. For calendar times use dueAt (epoch milliseconds). Or use personId for the next verified visual encounter. Choose one mode. Due reminders deliver once without another Jev decision; speculative needs use schedule_followup.",
    ReminderInput,
    true,
    async (args, { task, callId }) => {
      bind(task, args.refs);
      const reminder = host.reminders.create(task, callId, args);
      bind(task, [reminder.evidenceRef]);
      return reminder;
    },
  );
  add(
    "list_reminders",
    "List this wearer's pending reminders and their IDs.",
    z.object({}).strict(),
    true,
    async (_, { task }) => host.reminders.list(task.owner),
  );
  add(
    "cancel_reminder",
    "Cancel a pending reminder by its ID and withdraw any unacknowledged notification.",
    z.object({ id: Id }).strict(),
    true,
    async ({ id }, { task }) => ({ cancelled: host.reminders.cancel(task.owner, id) }),
  );
}
