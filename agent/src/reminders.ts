import { z } from "zod";
import {
  Conflict,
  Id,
  RefSchema,
  refOf,
  type Evidence,
  type EvidenceRef,
  type Task,
} from "./contracts";
import type { Store } from "./store";

export const ReminderInput = z
  .object({
    text: z.string().min(1).max(2000),
    dueAt: z.number().finite().nonnegative().optional(),
    afterMs: z
      .number()
      .int()
      .positive()
      .max(366 * 86400000)
      .optional(),
    anchorEventId: Id.optional(),
    personId: Id.optional(),
    refs: z.array(RefSchema).min(1).max(16),
  })
  .strict()
  .refine(
    (a) => [a.dueAt, a.afterMs, a.personId].filter((v) => v !== undefined).length === 1,
    "Choose dueAt, afterMs or personId",
  )
  .refine(
    (a) => (a.afterMs === undefined) === (a.anchorEventId === undefined),
    "Relative reminders need an anchorEventId",
  );
interface ReminderRow {
  id: string;
  owner: string;
  task_id: string;
  text: string;
  due_at: number | null;
  person_id: string | null;
  refs: string;
  created_at: number;
  expires_at: number;
  state: string;
  notification_id: string | null;
}

export class Reminders {
  constructor(
    private store: Store,
    private wake?: (owner: string, event: Evidence, refs: EvidenceRef[], label: string) => Task,
  ) {}
  create(task: Task, id: string, input: z.input<typeof ReminderInput>) {
    const value = ReminderInput.parse(input),
      { store } = this;
    if (task.parentId || task.mode !== "assist")
      throw new Error("Only an assist parent can create explicit reminders");
    return store.atomic(() => {
      const old = store.one<ReminderRow>(
        "SELECT * FROM reminders WHERE id=? AND owner=?",
        id,
        task.owner,
      );
      if (old) return this.receipt(old);
      if (!store.valid(task.owner, value.refs)) throw new Conflict("Reminder evidence changed");
      if (value.afterMs !== undefined) {
        const anchor = store.latest(task.owner, value.anchorEventId!);
        if (
          !anchor?.final ||
          !value.refs.some((r) => r.eventId === anchor.id && r.revision === anchor.revision)
        )
          throw new Conflict("Relative reminder must cite its original utterance");
        value.dueAt = anchor.sourceEnd + value.afterMs;
      }
      if (
        value.dueAt !== undefined &&
        (value.dueAt <= store.now() - (value.afterMs === undefined ? 0 : 86400000) ||
          value.dueAt > store.now() + 366 * 86400000)
      )
        throw new Error(
          "Reminder must be within the next year; delayed relative reminders expire after one day",
        );
      store.run(
        "INSERT INTO reminders(id,owner,task_id,text,due_at,person_id,refs,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        task.owner,
        task.id,
        value.text,
        value.dueAt ?? null,
        value.personId ?? null,
        JSON.stringify(value.refs),
        store.now(),
        value.dueAt === undefined ? store.now() + 366 * 86400000 : value.dueAt + 86400000,
      );
      store.depend("reminder", id, task.owner, value.refs);
      const event = {
        id: `reminder-${id}`,
        deviceId: "scheduler",
        streamId: "reminder-receipts",
        revision: 0,
        kind: "context" as const,
        final: true,
        sourceStart: store.now(),
        sourceEnd: store.now(),
        text: `Reminder scheduled: ${value.text}. ${value.dueAt === undefined ? `When person ${value.personId} is next seen.` : `Due ${new Date(value.dueAt).toISOString()}.`}`,
        confidence: 1,
        speakerId: null,
        personIds: [],
        provenance: "reminder-receipt",
      };
      store.ingest(task.owner, event, false);
      store.depend("derived_evidence", event.id, task.owner, value.refs);
      return { ...value, id, state: "pending", evidenceRef: refOf(event) };
    });
  }
  private receipt(row: ReminderRow) {
    return {
      id: row.id,
      text: row.text,
      dueAt: row.due_at,
      personId: row.person_id,
      state: row.state,
      refs: JSON.parse(row.refs),
      evidenceRef: { eventId: `reminder-${row.id}`, revision: 0 },
    };
  }
  list(owner: string) {
    return this.store
      .all<ReminderRow>(
        "SELECT * FROM reminders WHERE owner=? AND state IN ('pending','queued','failed') ORDER BY due_at,created_at LIMIT 100",
        owner,
      )
      .map((r) => this.receipt(r));
  }
  cancel(owner: string, id: string) {
    return this.store.atomic(() => {
      const row = this.store.one<ReminderRow>(
        "SELECT * FROM reminders WHERE owner=? AND id=?",
        owner,
        id,
      );
      if (!row) return false;
      for (const wake of this.store.all<{ task_id: string }>(
        "SELECT task_id FROM reminder_wakes WHERE reminder_id=?",
        id,
      )) {
        this.store.cancel(wake.task_id, "Reminder cancelled");
        this.store.run(
          "UPDATE reminders SET state='pending' WHERE state='queued' AND id IN (SELECT reminder_id FROM reminder_wakes WHERE task_id=?)",
          wake.task_id,
        );
      }
      this.store.run("UPDATE reminders SET state='cancelled' WHERE id=?", id);
      if (row.notification_id)
        this.store.run(
          "UPDATE notifications SET state='withdrawn' WHERE id=? AND owner=?",
          row.notification_id,
          owner,
        );
      return true;
    });
  }
  fire(encounter?: Evidence) {
    const { store } = this;
    store.run(
      "UPDATE reminders SET state='expired' WHERE state='pending' AND expires_at<=?",
      store.now(),
    );
    // Late or uncertain visual results must not create a current encounter reminder.
    if (
      encounter &&
      (encounter.provenance.endsWith(":backfill") ||
        encounter.provenance === "insightface-track" ||
        encounter.kind !== "observation" ||
        !encounter.final ||
        encounter.confidence < 0.8 ||
        store.now() - encounter.sourceEnd > 10000 ||
        encounter.sourceEnd > store.now() + 1000 ||
        (encounter.timing?.uncertaintyMs ?? Infinity) > 1000)
    )
      return;
    const pending = encounter
      ? store.all<ReminderRow>(
          "SELECT * FROM reminders WHERE state='pending' AND owner=? AND person_id IS NOT NULL ORDER BY created_at LIMIT 1000",
          encounter.owner,
        )
      : store.all<ReminderRow>(
          "SELECT * FROM reminders WHERE state='pending' AND due_at<=? ORDER BY due_at LIMIT 100",
          store.now(),
        );
    if (!this.wake) return;
    const groups = new Map<string, ReminderRow[]>();
    for (const row of pending) {
      if (
        encounter &&
        (!row.person_id ||
          !encounter.personIds.includes(row.person_id) ||
          encounter.sourceStart <= row.created_at)
      )
        continue;
      if (row.expires_at <= store.now() || !store.valid(row.owner, JSON.parse(row.refs))) {
        store.run("UPDATE reminders SET state='expired' WHERE id=?", row.id);
        continue;
      }
      const key = `${row.owner}:${row.person_id ?? "time"}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values())
      store.atomic(() => {
        const owner = rows[0]!.owner;
        const refs: EvidenceRef[] = [
          ...new Map<string, EvidenceRef>(
            rows
              .flatMap((r) => JSON.parse(r.refs) as EvidenceRef[])
              .concat(encounter ? [refOf(encounter)] : [])
              .map((r) => [`${r.eventId}:${r.revision}`, r]),
          ).values(),
        ];
        const now = store.now();
        const event = {
          id: `reminder-wake-${crypto.randomUUID()}`,
          deviceId: "scheduler",
          streamId: "reminder-wakes",
          revision: 0,
          kind: "context" as const,
          final: true,
          sourceStart: now,
          sourceEnd: now,
          text: `These reminders are due now. Check current context, combine related items into one useful update and finish; do not schedule them again. ${JSON.stringify(rows.map((r) => ({ id: r.id, text: r.text, dueAt: r.due_at, personId: r.person_id })))}${encounter ? ` Current encounter: ${encounter.text}` : ""}`,
          confidence: 1,
          speakerId: null,
          personIds: encounter?.personIds ?? [],
          provenance: "reminder-wake",
        };
        store.ingest(owner, event, false);
        store.depend("derived_evidence", event.id, owner, refs);
        const task = this.wake!(
          owner,
          store.latest(owner, event.id)!,
          [...refs, refOf(event)],
          `Reminder: ${rows
            .map((r) => r.text)
            .join("; ")
            .slice(0, 2000)}`,
        );
        for (const row of rows) {
          store.run("INSERT INTO reminder_wakes VALUES(?,?)", row.id, task.id);
          store.run("UPDATE reminders SET state='queued' WHERE id=? AND state='pending'", row.id);
        }
      });
    this.reconcile();
  }
  labelForWake(taskId: string) {
    const rows = this.store.all<{ text: string }>(
      "SELECT r.text FROM reminders r JOIN reminder_wakes w ON w.reminder_id=r.id WHERE w.task_id=? AND r.text!=''",
      taskId,
    );
    return rows.length
      ? `Reminder: ${rows
          .map((r) => r.text)
          .join("; ")
          .slice(0, 2000)}`
      : null;
  }
  isWake(taskId: string) {
    return !!this.store.one("SELECT 1 FROM reminder_wakes WHERE task_id=?", taskId);
  }
  reconcile() {
    for (const row of this.store.all<{ id: string; task_id: string; status: string }>(
      "SELECT r.id,w.task_id,t.status FROM reminders r JOIN reminder_wakes w ON w.reminder_id=r.id JOIN tasks t ON t.id=w.task_id WHERE r.state='queued' AND t.status NOT IN ('running','queued','waiting')",
    )) {
      const notification = this.store.one<{ id: string }>(
        "SELECT id FROM notifications WHERE task_id=? AND state!='withdrawn'",
        row.task_id,
      );
      let rejected = false;
      try {
        rejected =
          JSON.parse(this.store.task(row.task_id)?.result ?? "null")?.reviewRejected === true;
      } catch {
        /* Free-form abstentions are not structured finish results. */
      }
      const state = rejected
        ? "failed"
        : notification
          ? "delivered"
          : row.status === "completed" || row.status === "abstained"
            ? "resolved"
            : row.status === "cancelled"
              ? "cancelled"
              : "failed";
      this.store.run(
        "UPDATE reminders SET state=?,notification_id=? WHERE id=?",
        state,
        notification?.id ?? null,
        row.id,
      );
    }
  }
}
