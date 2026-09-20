import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Conflict,
  EventSchema,
  parseJSON,
  type ChatMessage,
  type Decision,
  type Evidence,
  type EvidenceRef,
  type Memory,
  type Notification,
  type PerceptionEvent,
  type Task,
  type TaskState,
} from "./contracts";

type Binding = string | number | null;
interface EvidenceRow {
  owner: string;
  id: string;
  revision: number;
  payload: string;
  received_at: number;
  deleted: number;
}
interface TaskRow {
  id: string;
  owner: string;
  parent_id: string | null;
  root_id: string;
  goal: string;
  mode: Task["mode"];
  status: TaskState;
  messages: string;
  result: string | null;
  error: string | null;
  created_at: number;
  deadline: number;
  steps: number;
  tokens: number;
  capabilities: string;
}
export interface GateJob {
  id: number;
  owner: string;
  event_id: string;
  revision: number;
  attempts: number;
}
export interface Receipt {
  id: string;
  task_id: string;
  name: string;
  args: string;
  state: string;
  result: string | null;
  replay_safe: number;
}

export class Store {
  readonly db: Database;
  constructor(
    path: string,
    readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evidence(owner TEXT, id TEXT, revision INTEGER, payload TEXT NOT NULL, received_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,id,revision));
      CREATE TABLE IF NOT EXISTS tombstones(owner TEXT, id TEXT, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS gate_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, event_id TEXT, revision INTEGER, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, error TEXT, UNIQUE(owner,event_id,revision));
      CREATE INDEX IF NOT EXISTS gate_due ON gate_jobs(state,due_at);
      CREATE TABLE IF NOT EXISTS decisions(job_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL, goal TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', result TEXT, error TEXT, created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, steps INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, capabilities TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_queue ON tasks(status,created_at);
      CREATE TABLE IF NOT EXISTS dependencies(kind TEXT, subject_id TEXT, owner TEXT, event_id TEXT, revision INTEGER, PRIMARY KEY(kind,subject_id,owner,event_id,revision));
      CREATE INDEX IF NOT EXISTS dependency_source ON dependencies(owner,event_id,revision);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, owner TEXT, key TEXT, version INTEGER, text TEXT, kind TEXT, refs TEXT, created_at INTEGER, active INTEGER NOT NULL DEFAULT 1, UNIQUE(owner,key,version));
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(owner UNINDEXED, event_id UNINDEXED, revision UNINDEXED, text);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(owner UNINDEXED, memory_id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, replay_safe INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, text TEXT NOT NULL, refs TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, due_at INTEGER NOT NULL, text TEXT NOT NULL, refs TEXT NOT NULL, fired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS transcript_exports(owner TEXT NOT NULL, hour INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, exported_version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,hour));
      CREATE TABLE IF NOT EXISTS graph_nodes(owner TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, gallery_id TEXT, PRIMARY KEY(owner,id), UNIQUE(owner,key));
      CREATE TABLE IF NOT EXISTS scene_face_clock(owner TEXT NOT NULL, person_id TEXT NOT NULL, source_at INTEGER NOT NULL, PRIMARY KEY(owner,person_id));
      CREATE TABLE IF NOT EXISTS scene_removed_people(owner TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY(owner,person_id));
      CREATE TABLE IF NOT EXISTS graph_links(owner TEXT NOT NULL, memory_id TEXT PRIMARY KEY, subject TEXT NOT NULL, target TEXT);
      CREATE INDEX IF NOT EXISTS graph_subject ON graph_links(owner,subject);
      CREATE INDEX IF NOT EXISTS graph_target ON graph_links(owner,target);
      CREATE TABLE IF NOT EXISTS task_checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, messages TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reminder_wakes(reminder_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(reminder_id,task_id));
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER, person_id TEXT, refs TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', notification_id TEXT);
      PRAGMA user_version=1;`);
    const artifactColumns = this.all<{ name: string }>("PRAGMA table_info(artifacts)");
    if (!artifactColumns.some((c) => c.name === "filename"))
      this.db.exec(
        "ALTER TABLE artifacts ADD COLUMN filename TEXT NOT NULL DEFAULT 'screenshot.png'",
      );
    if (!artifactColumns.some((c) => c.name === "mime"))
      this.db.exec("ALTER TABLE artifacts ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/png'");
    // Retire old vector-service snapshots: without the removed bridge their
    // upstream versions cannot be checked. Preserve original payloads on disk,
    // but withdraw dependent claims using the existing invalidation lifecycle.
    if (this.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_sources'"))
      this.atomic(() => {
        for (const row of this.all<{ owner: string; event_id: string }>(
          "SELECT s.owner,s.event_id FROM memory_sources s WHERE EXISTS (SELECT 1 FROM evidence e WHERE e.owner=s.owner AND e.id=s.event_id AND e.deleted=0)",
        )) {
          this.invalidate(row.owner, row.event_id);
          this.run("UPDATE evidence SET deleted=1 WHERE owner=? AND id=?", row.owner, row.event_id);
          this.run(
            "DELETE FROM evidence_fts WHERE owner=? AND event_id=?",
            row.owner,
            row.event_id,
          );
        }
      });
  }
  all<T>(sql: string, ...params: Binding[]): T[] {
    return this.db.query(sql).all(...params) as T[];
  }
  one<T>(sql: string, ...params: Binding[]): T | null {
    return this.db.query(sql).get(...params) as T | null;
  }
  run(sql: string, ...params: Binding[]) {
    return this.db.query(sql).run(...params);
  }
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  close() {
    this.db.close();
  }
  lock(holder: string, ttl = 15000): boolean {
    return this.atomic(() => {
      this.run("DELETE FROM locks WHERE expires_at <= ?", this.now());
      this.run("INSERT OR IGNORE INTO locks VALUES ('runtime',?,?)", holder, this.now() + ttl);
      const lock = this.one<{ holder: string }>("SELECT holder FROM locks WHERE name='runtime'");
      if (lock?.holder !== holder) return false;
      this.run(
        "UPDATE locks SET expires_at=? WHERE name='runtime' AND holder=?",
        this.now() + ttl,
        holder,
      );
      return true;
    });
  }
  unlock(holder: string) {
    this.run("DELETE FROM locks WHERE holder=?", holder);
  }
  private decode(row: EvidenceRow): Evidence {
    return {
      ...EventSchema.parse(JSON.parse(row.payload)),
      owner: row.owner,
      receivedAt: row.received_at,
    };
  }
  latest(owner: string, id: string): Evidence | null {
    const row = this.one<EvidenceRow>(
      "SELECT * FROM evidence WHERE owner=? AND id=? ORDER BY revision DESC LIMIT 1",
      owner,
      id,
    );
    return row && !row.deleted ? this.decode(row) : null;
  }
  valid(owner: string, refs: EvidenceRef[]): boolean {
    return (
      refs.length > 0 &&
      refs.every((ref) => {
        const e = this.latest(owner, ref.eventId);
        return e?.revision === ref.revision && e.final;
      })
    );
  }
  ingest(
    owner: string,
    input: PerceptionEvent,
    trigger = true,
  ): { duplicate: boolean; current: boolean } {
    const event = EventSchema.parse(input);
    return this.atomic(() => {
      if (this.one("SELECT 1 FROM tombstones WHERE owner=? AND id=?", owner, event.id))
        throw new Conflict("Deleted evidence cannot be reimported");
      const prior = this.one<EvidenceRow>(
        "SELECT * FROM evidence WHERE owner=? AND id=? AND revision=?",
        owner,
        event.id,
        event.revision,
      );
      if (prior) {
        if (prior.payload !== JSON.stringify(event))
          throw new Conflict("Same evidence revision has different content");
        return {
          duplicate: true,
          current: this.latest(owner, event.id)?.revision === event.revision,
        };
      }
      const latest = this.latest(owner, event.id);
      if (
        latest &&
        (latest.streamId !== event.streamId ||
          latest.deviceId !== event.deviceId ||
          latest.kind !== event.kind)
      )
        throw new Conflict("Event identity changed");
      const receivedAt = this.now();
      this.run(
        "INSERT INTO evidence(owner,id,revision,payload,received_at) VALUES(?,?,?,?,?)",
        owner,
        event.id,
        event.revision,
        JSON.stringify(event),
        receivedAt,
      );
      if (event.kind === "transcript") this.dirtyTranscriptHour(owner, receivedAt);
      const current = !latest || latest.revision < event.revision;
      if (current) {
        this.invalidate(owner, event.id);
        this.run("DELETE FROM evidence_fts WHERE owner=? AND event_id=?", owner, event.id);
        if (event.final) {
          this.run(
            "INSERT INTO evidence_fts VALUES(?,?,?,?)",
            owner,
            event.id,
            event.revision,
            event.text,
          );
          if (trigger)
            this.run(
              "INSERT INTO gate_jobs(owner,event_id,revision,due_at) VALUES(?,?,?,?)",
              owner,
              event.id,
              event.revision,
              this.now(),
            );
        }
      }
      return { duplicate: false, current };
    });
  }
  depend(kind: string, id: string, owner: string, refs: EvidenceRef[]) {
    for (const ref of refs)
      this.run(
        "INSERT OR IGNORE INTO dependencies VALUES(?,?,?,?,?)",
        kind,
        id,
        owner,
        ref.eventId,
        ref.revision,
      );
  }
  refs(kind: string, id: string): EvidenceRef[] {
    return this.all<{ event_id: string; revision: number }>(
      "SELECT event_id,revision FROM dependencies WHERE kind=? AND subject_id=?",
      kind,
      id,
    ).map((r) => ({ eventId: r.event_id, revision: r.revision }));
  }
  private invalidate(owner: string, eventId: string) {
    this.run(
      "UPDATE gate_jobs SET state='superseded' WHERE owner=? AND event_id=? AND state IN ('queued','running')",
      owner,
      eventId,
    );
    for (const row of this.all<{ kind: string; subject_id: string }>(
      "SELECT kind,subject_id FROM dependencies WHERE owner=? AND event_id=?",
      owner,
      eventId,
    )) {
      if (row.kind === "task") {
        const task = this.task(row.subject_id);
        if (task) this.cancel(task.rootId, "Source evidence changed or was deleted");
      }
      if (row.kind === "memory") {
        this.run("UPDATE memories SET active=0 WHERE id=?", row.subject_id);
        this.run("DELETE FROM memory_fts WHERE memory_id=?", row.subject_id);
      }
      if (row.kind === "notification")
        this.run("UPDATE notifications SET state='withdrawn' WHERE id=?", row.subject_id);
      if (row.kind === "person")
        this.run("DELETE FROM people WHERE id=? AND owner=?", row.subject_id, owner);
      if (row.kind === "reminder")
        this.run("UPDATE reminders SET state='cancelled' WHERE id=?", row.subject_id);
      if (row.kind === "derived_evidence" && this.latest(owner, row.subject_id))
        this.deleteEvidence(owner, row.subject_id);
    }
  }
  deleteEvidence(owner: string, id: string) {
    this.atomic(() => {
      for (const row of this.all<{ received_at: number }>(
        "SELECT received_at FROM evidence WHERE owner=? AND id=? AND deleted=0 AND json_extract(payload,'$.kind')='transcript'",
        owner,
        id,
      ))
        this.dirtyTranscriptHour(owner, row.received_at);
      this.invalidate(owner, id);
      this.run("INSERT OR IGNORE INTO tombstones VALUES(?,?)", owner, id);
      this.run("UPDATE evidence SET deleted=1,payload='{}' WHERE owner=? AND id=?", owner, id);
      this.run("DELETE FROM evidence_fts WHERE owner=? AND event_id=?", owner, id);
      // Purge derived content, including dormant histories and task transcripts.
      const deps = this.all<{ kind: string; subject_id: string }>(
        "SELECT kind,subject_id FROM dependencies WHERE owner=? AND event_id=?",
        owner,
        id,
      );
      for (const d of deps) {
        if (d.kind === "reminder")
          this.run(
            "UPDATE reminders SET text='',refs='[]',state='cancelled' WHERE id=?",
            d.subject_id,
          );
        if (d.kind === "memory")
          this.run("UPDATE memories SET text='',refs='[]',active=0 WHERE id=?", d.subject_id);
        if (d.kind === "notification")
          this.run(
            "UPDATE notifications SET text='',refs='[]',state='withdrawn' WHERE id=?",
            d.subject_id,
          );
        if (d.kind === "task") {
          const task = this.task(d.subject_id);
          if (task) {
            this.run(
              "DELETE FROM task_checkpoints WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)",
              task.rootId,
            );
            this.run(
              "UPDATE tasks SET goal='[deleted evidence]',messages='[]',result=NULL WHERE root_id=?",
              task.rootId,
            );
            this.run(
              "DELETE FROM receipts WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)",
              task.rootId,
            );
            this.run(
              "DELETE FROM messages WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)",
              task.rootId,
            );
            this.run(
              "DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)",
              task.rootId,
            );
            this.run(
              "UPDATE artifacts SET deleted=1 WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)",
              task.rootId,
            );
          }
        }
      }
      this.run(
        "DELETE FROM graph_links WHERE owner=? AND memory_id IN (SELECT id FROM memories WHERE owner=? AND text='')",
        owner,
        owner,
      );
      this.run(
        "DELETE FROM graph_nodes WHERE owner=? AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.owner=graph_nodes.owner AND memories.key='graph.entity:'||graph_nodes.id AND text!='')",
        owner,
      );
    });
  }
  dirtyTranscriptHour(owner: string, receivedAt: number) {
    this.run(
      "INSERT INTO transcript_exports(owner,hour) VALUES(?,?) ON CONFLICT(owner,hour) DO UPDATE SET version=version+1",
      owner,
      Math.floor(receivedAt / 3600000) * 3600000,
    );
  }
  previousTranscript(owner: string, event: Evidence): Evidence | undefined {
    const row = this.one<EvidenceRow>(
      "SELECT e.* FROM evidence e WHERE owner=? AND id!=? AND deleted=0 AND json_extract(payload,'$.kind')='transcript' AND json_extract(payload,'$.final')=1 AND json_extract(payload,'$.sourceEnd')<=? AND revision=(SELECT MAX(revision) FROM evidence WHERE owner=e.owner AND id=e.id) ORDER BY json_extract(payload,'$.sourceEnd') DESC LIMIT 1",
      owner,
      event.id,
      event.sourceStart,
    );
    return row ? this.decode(row) : undefined;
  }
  transcripts(
    owner: string,
    filter: {
      query?: string;
      from?: number;
      to?: number;
      personId?: string;
      speakerId?: string;
      includeRevisions?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Evidence[] {
    const clauses = ["e.owner=?", "e.deleted=0", "json_extract(e.payload,'$.kind')='transcript'"];
    const values: Binding[] = [owner];
    if (!filter.includeRevisions)
      clauses.push(
        "e.revision=(SELECT MAX(revision) FROM evidence WHERE owner=e.owner AND id=e.id)",
        "json_extract(e.payload,'$.final')=1",
      );
    if (filter.from !== undefined) {
      clauses.push("json_extract(e.payload,'$.sourceEnd')>=?");
      values.push(filter.from);
    }
    if (filter.to !== undefined) {
      clauses.push("json_extract(e.payload,'$.sourceStart')<=?");
      values.push(filter.to);
    }
    if (filter.personId) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(e.payload,'$.personIds') WHERE value=?)");
      values.push(filter.personId);
    }
    if (filter.speakerId) {
      clauses.push("json_extract(e.payload,'$.speakerId')=?");
      values.push(filter.speakerId);
    }
    if (filter.query?.trim()) {
      const match = this.queryWords(filter.query);
      if (!match) return [];
      if (filter.includeRevisions) {
        // Historical revisions are not in the current FTS projection.
        clauses.push("instr(lower(json_extract(e.payload,'$.text')),lower(?))>0");
        values.push(filter.query);
      } else {
        clauses.push(
          "e.id IN (SELECT event_id FROM evidence_fts WHERE evidence_fts MATCH ? AND owner=?)",
        );
        values.push(match, owner);
      }
    }
    return this.all<EvidenceRow>(
      `SELECT e.* FROM evidence e WHERE ${clauses.join(" AND ")} ORDER BY json_extract(e.payload,'$.sourceStart'), e.id, e.revision LIMIT ? OFFSET ?`,
      ...values,
      Math.max(1, Math.min(100, filter.limit ?? 30)),
      Math.max(0, filter.offset ?? 0),
    ).map((r) => this.decode(r));
  }
  window(owner: string, from: number, to: number, limit = 100): Evidence[] {
    return this.all<EvidenceRow>(
      `SELECT e.* FROM evidence e WHERE e.owner=? AND e.deleted=0 AND json_extract(e.payload,'$.final')=1 AND e.revision=(SELECT MAX(revision) FROM evidence WHERE owner=e.owner AND id=e.id) AND json_extract(e.payload,'$.sourceStart')-COALESCE(json_extract(e.payload,'$.timing.uncertaintyMs'),0)<=? AND json_extract(e.payload,'$.sourceEnd')+COALESCE(json_extract(e.payload,'$.timing.uncertaintyMs'),0)>=? ORDER BY json_extract(e.payload,'$.sourceStart') LIMIT ?`,
      owner,
      to,
      from,
      Math.min(100, Math.max(1, limit)),
    ).map((r) => this.decode(r));
  }
  recent(owner: string, before = this.now(), window = 60000, limit = 24): Evidence[] {
    return this.all<EvidenceRow>(
      `SELECT e.* FROM evidence e WHERE e.owner=? AND e.deleted=0 AND e.revision=(SELECT MAX(revision) FROM evidence WHERE owner=e.owner AND id=e.id) AND json_extract(e.payload,'$.sourceStart')<=? AND json_extract(e.payload,'$.sourceEnd')>=? ORDER BY json_extract(e.payload,'$.sourceStart') DESC LIMIT ?`,
      owner,
      before,
      before - window,
      limit,
    )
      .map((r) => this.decode(r))
      .reverse();
  }
  private queryWords(text: string): string {
    return (text.match(/[\p{L}\p{N}_]+/gu) ?? [])
      .slice(0, 16)
      .map((w) => `"${w}"`)
      .join(" OR ");
  }
  search(owner: string, query: string, limit = 12): { evidence: Evidence[]; memories: Memory[] } {
    const match = this.queryWords(query);
    if (!match) return { evidence: [], memories: [] };
    const hits = this.all<{ event_id: string; revision: number }>(
      "SELECT event_id,revision FROM evidence_fts WHERE evidence_fts MATCH ? AND owner=? ORDER BY rank LIMIT ?",
      match,
      owner,
      limit,
    );
    const evidence = hits
      .map((h) => this.latest(owner, h.event_id))
      .filter((e): e is Evidence => !!e && e.final);
    const memories = this.all<{ memory_id: string }>(
      "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? AND owner=? ORDER BY rank LIMIT ?",
      match,
      owner,
      limit,
    )
      .map((h) => this.memory(owner, h.memory_id))
      .filter((m): m is Memory => !!m);
    return { evidence, memories };
  }
  memory(owner: string, id: string): Memory | null {
    const r = this.one<{
      id: string;
      key: string;
      text: string;
      version: number;
      kind: Memory["kind"];
      refs: string;
      created_at: number;
    }>("SELECT * FROM memories WHERE owner=? AND id=? AND active=1", owner, id);
    return r && this.valid(owner, JSON.parse(r.refs))
      ? { ...r, refs: JSON.parse(r.refs), createdAt: r.created_at }
      : null;
  }
  remember(
    owner: string,
    key: string,
    text: string,
    kind: Memory["kind"],
    refs: EvidenceRef[],
  ): Memory {
    return this.atomic(() => {
      if (!this.valid(owner, refs)) throw new Conflict("Memory needs current finalized evidence");
      const old = this.one<{
        id: string;
        version: number;
        text: string;
        refs: string;
        active: number;
      }>(
        "SELECT * FROM memories WHERE owner=? AND key=? ORDER BY version DESC LIMIT 1",
        owner,
        key,
      );
      if (old?.active && old.text === text && old.refs === JSON.stringify(refs))
        return this.memory(owner, old.id)!;
      if (old) {
        this.run("UPDATE memories SET active=0 WHERE owner=? AND key=?", owner, key);
        this.run("DELETE FROM memory_fts WHERE memory_id=?", old.id);
      }
      const memory: Memory = {
        id: crypto.randomUUID(),
        key,
        text,
        kind,
        refs,
        version: (old?.version ?? 0) + 1,
        createdAt: this.now(),
      };
      this.run(
        "INSERT INTO memories(id,owner,key,version,text,kind,refs,created_at) VALUES(?,?,?,?,?,?,?,?)",
        memory.id,
        owner,
        key,
        memory.version,
        text,
        kind,
        JSON.stringify(refs),
        memory.createdAt,
      );
      this.run("INSERT INTO memory_fts VALUES(?,?,?)", owner, memory.id, text);
      this.depend("memory", memory.id, owner, refs);
      return memory;
    });
  }
  forget(owner: string, id: string) {
    const memory = this.memory(owner, id);
    if (!memory) return false;
    for (const ref of memory.refs) {
      for (const dep of this.all<{ subject_id: string }>(
        "SELECT subject_id FROM dependencies WHERE kind='task' AND owner=? AND event_id=? AND revision=?",
        owner,
        ref.eventId,
        ref.revision,
      )) {
        const task = this.task(dep.subject_id);
        if (task) this.cancel(task.rootId, "A retrieved memory was removed");
      }
    }
    this.run(
      "UPDATE memories SET active=0,text='',refs='[]' WHERE owner=? AND key=?",
      owner,
      memory.key,
    );
    this.run(
      "DELETE FROM memory_fts WHERE owner=? AND memory_id IN (SELECT id FROM memories WHERE owner=? AND key=?)",
      owner,
      owner,
      memory.key,
    );
    return true;
  }
  nextGate(): GateJob | null {
    return this.atomic(() => {
      const job = this.one<GateJob>(
        "SELECT * FROM gate_jobs WHERE state='queued' AND due_at<=? ORDER BY id LIMIT 1",
        this.now(),
      );
      if (job)
        this.run("UPDATE gate_jobs SET state='running',attempts=attempts+1 WHERE id=?", job.id);
      return job ? { ...job, attempts: job.attempts + 1 } : null;
    });
  }
  gateCurrent(job: GateJob) {
    return (
      this.one<{ state: string }>("SELECT state FROM gate_jobs WHERE id=?", job.id)?.state ===
        "running" && this.valid(job.owner, [{ eventId: job.event_id, revision: job.revision }])
    );
  }
  finishGate(job: GateJob, decision: Decision) {
    this.run("INSERT OR REPLACE INTO decisions VALUES(?,?)", job.id, JSON.stringify(decision));
    this.run("UPDATE gate_jobs SET state='done',error=NULL WHERE id=?", job.id);
  }
  failGate(job: GateJob, error: string, maxAttempts = 5) {
    this.run(
      "UPDATE gate_jobs SET state=?,due_at=?,error=? WHERE id=? AND state='running'",
      job.attempts >= maxAttempts ? "failed" : "queued",
      this.now() + Math.min(30000, 1000 * 2 ** job.attempts),
      error,
      job.id,
    );
  }
  retryGates(owner: string) {
    return this.run(
      "UPDATE gate_jobs SET state='queued',attempts=0,due_at=?,error=NULL WHERE owner=? AND state='failed' AND EXISTS (SELECT 1 FROM evidence e WHERE e.owner=gate_jobs.owner AND e.id=gate_jobs.event_id AND e.revision=gate_jobs.revision AND e.deleted=0)",
      this.now(),
      owner,
    ).changes;
  }
  storageBytes() {
    const pages = this.one<{ page_count: number }>("PRAGMA page_count")!.page_count;
    const pageSize = this.one<{ page_size: number }>("PRAGMA page_size")!.page_size;
    const free = this.one<{ freelist_count: number }>("PRAGMA freelist_count")!.freelist_count;
    return (pages - free) * pageSize;
  }
  maintain(retentionMs: number, transcriptRetentionMs = retentionMs) {
    const cutoff = this.now() - retentionMs;
    this.atomic(() => {
      // Keep source evidence for active memories, tasks and unfired intentions.
      const expired = this.all<{ owner: string; id: string }>(
        `SELECT e.owner,e.id FROM evidence e WHERE e.deleted=0 GROUP BY e.owner,e.id HAVING MAX(e.received_at)<CASE WHEN json_extract(e.payload,'$.kind')='transcript' THEN ? ELSE ? END AND NOT EXISTS (SELECT 1 FROM dependencies d WHERE d.owner=e.owner AND d.event_id=e.id AND ((d.kind='memory' AND EXISTS (SELECT 1 FROM memories m WHERE m.id=d.subject_id AND m.active=1)) OR (d.kind='reminder' AND EXISTS (SELECT 1 FROM reminders r WHERE r.id=d.subject_id AND r.state IN ('pending','queued'))) OR (d.kind='task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=d.subject_id AND (t.status IN ('queued','running','waiting') OR EXISTS (SELECT 1 FROM schedules s WHERE s.task_id=t.id AND s.fired=0)))))) LIMIT 100`,
        transcriptRetentionMs > 0 ? this.now() - transcriptRetentionMs : -1,
        cutoff,
      );
      for (const e of expired) this.deleteEvidence(e.owner, e.id);
      this.run("UPDATE artifacts SET deleted=1 WHERE created_at<?", cutoff);
      for (const t of this.all<{ id: string }>(
        "SELECT id FROM tasks WHERE created_at<? AND status NOT IN ('queued','running','waiting') AND NOT EXISTS (SELECT 1 FROM schedules WHERE task_id=tasks.id AND fired=0) AND NOT EXISTS (SELECT 1 FROM reminders WHERE task_id=tasks.id AND state IN ('pending','queued')) LIMIT 100",
        cutoff,
      )) {
        for (const table of [
          "receipts",
          "messages",
          "schedules",
          "notifications",
          "task_checkpoints",
          "reminder_wakes",
        ])
          this.run(`DELETE FROM ${table} WHERE task_id=?`, t.id);
        this.run("DELETE FROM dependencies WHERE kind='task' AND subject_id=?", t.id);
        this.run("DELETE FROM tasks WHERE id=?", t.id);
      }
      this.run(
        "DELETE FROM decisions WHERE job_id IN (SELECT id FROM gate_jobs WHERE due_at<? AND state IN ('done','superseded'))",
        cutoff,
      );
      this.run("DELETE FROM gate_jobs WHERE due_at<? AND state IN ('done','superseded')", cutoff);
      this.run("DELETE FROM evidence WHERE deleted=1");
    });
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  createTask(input: {
    owner: string;
    goal: string;
    mode?: Task["mode"];
    refs: EvidenceRef[];
    parent?: Task;
    capabilities: string[];
    ttl?: number;
    id?: string;
  }): Task {
    if (!this.valid(input.owner, input.refs)) throw new Conflict("Task evidence is stale");
    const id = input.id ?? crypto.randomUUID();
    const existing = this.task(id);
    if (existing) return existing;
    this.run(
      "INSERT INTO tasks(id,owner,parent_id,root_id,goal,mode,status,created_at,deadline,capabilities) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
      id,
      input.owner,
      input.parent?.id ?? null,
      input.parent?.rootId ?? id,
      input.goal,
      input.mode ?? "assist",
      this.now(),
      Math.min(input.parent?.deadline ?? Infinity, this.now() + (input.ttl ?? 120000)),
      JSON.stringify(input.capabilities),
    );
    this.depend("task", id, input.owner, input.refs);
    if (input.parent) this.depend("task", input.parent.rootId, input.owner, input.refs);
    return this.task(id)!;
  }
  task(id: string): Task | null {
    const r = this.one<TaskRow>("SELECT * FROM tasks WHERE id=?", id);
    return r ? this.decodeTask(r) : null;
  }
  private decodeTask(r: TaskRow): Task {
    return {
      id: r.id,
      owner: r.owner,
      parentId: r.parent_id,
      rootId: r.root_id,
      goal: r.goal,
      mode: r.mode,
      status: r.status,
      messages: parseJSON(r.messages),
      result: r.result,
      error: r.error,
      createdAt: r.created_at,
      deadline: r.deadline,
      steps: r.steps,
      tokens: r.tokens,
      capabilities: parseJSON(r.capabilities),
    };
  }
  tasks(owner?: string, active = false): Task[] {
    return this.all<TaskRow>(
      `SELECT * FROM tasks WHERE (? IS NULL OR owner=?) ${active ? "AND status IN ('queued','running','waiting')" : ""} ORDER BY created_at DESC LIMIT 100`,
      owner ?? null,
      owner ?? null,
    ).map((r) => this.decodeTask(r));
  }
  children(id: string): Task[] {
    return this.all<TaskRow>("SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at", id).map(
      (r) => this.decodeTask(r),
    );
  }
  setTask(id: string, state: TaskState, result: string | null = null, error: string | null = null) {
    this.run("UPDATE tasks SET status=?,result=?,error=? WHERE id=?", state, result, error, id);
  }
  saveMessages(id: string, messages: ChatMessage[]) {
    this.run("UPDATE tasks SET messages=? WHERE id=?", JSON.stringify(messages), id);
  }
  usage(id: string, tokens: number, steps = 0) {
    this.run("UPDATE tasks SET tokens=tokens+?,steps=steps+? WHERE id=?", tokens, steps, id);
  }
  budget(root: string) {
    return this.one<{ tokens: number; steps: number }>(
      "SELECT COALESCE(SUM(tokens),0) tokens,COALESCE(SUM(steps),0) steps FROM tasks WHERE root_id=?",
      root,
    )!;
  }
  cancel(id: string, reason = "Cancelled") {
    this.run(
      "UPDATE tasks SET status='cancelled',error=? WHERE (id=? OR root_id=?) AND status IN ('queued','running','waiting')",
      reason,
      id,
      id,
    );
    this.run(
      "UPDATE notifications SET state='withdrawn' WHERE task_id IN (SELECT id FROM tasks WHERE id=? OR root_id=?)",
      id,
      id,
    );
  }
  message(id: string, text: string, key: string = crypto.randomUUID()) {
    const inserted = this.run(
      "INSERT OR IGNORE INTO messages VALUES(?,?,?,0,?)",
      key,
      id,
      text,
      this.now(),
    ).changes;
    if (inserted && this.task(id)?.status === "waiting")
      this.run("UPDATE tasks SET status='queued' WHERE id=?", id);
  }
  drainMessages(id: string): string[] {
    return this.atomic(() => {
      const rows = this.all<{ id: string; text: string }>(
        "SELECT id,text FROM messages WHERE task_id=? AND delivered=0 ORDER BY created_at",
        id,
      );
      for (const row of rows) this.run("UPDATE messages SET delivered=1 WHERE id=?", row.id);
      return rows.map((r) => r.text);
    });
  }
  receipt(id: string): Receipt | null {
    return this.one<Receipt>("SELECT * FROM receipts WHERE id=?", id);
  }
  beginTool(id: string, taskId: string, name: string, args: string, safe: boolean) {
    this.run(
      "INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,'started',NULL,?)",
      id,
      taskId,
      name,
      args,
      Number(safe),
    );
  }
  endTool(id: string, result: unknown) {
    this.run("UPDATE receipts SET state='done',result=? WHERE id=?", JSON.stringify(result), id);
  }
  notify(
    task: Task,
    text: string,
    refs: EvidenceRef[],
    ttl = 30000,
    id = `result:${task.id}`,
  ): Notification {
    if (!this.valid(task.owner, refs)) throw new Conflict("Notification evidence is stale");
    this.run(
      "INSERT OR IGNORE INTO notifications(id,owner,task_id,text,refs,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      id,
      task.owner,
      task.id,
      text,
      JSON.stringify(refs),
      this.now(),
      this.now() + ttl,
    );
    this.depend("notification", id, task.owner, refs);
    return this.notifications(task.owner).find((n) => n.id === id)!;
  }
  notifications(owner: string): Notification[] {
    this.run(
      "UPDATE notifications SET state='withdrawn' WHERE expires_at<=? AND state='pending'",
      this.now(),
    );
    return this.all<{
      id: string;
      task_id: string;
      text: string;
      refs: string;
      created_at: number;
      expires_at: number;
      state: Notification["state"];
    }>(
      "SELECT * FROM notifications WHERE owner=? AND state='pending' ORDER BY created_at LIMIT 100",
      owner,
    )
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        text: r.text,
        refs: JSON.parse(r.refs),
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        state: r.state,
      }))
      .filter((n) => this.valid(owner, n.refs));
  }
  ack(owner: string, id: string) {
    return (
      this.run(
        "UPDATE notifications SET state='acked' WHERE owner=? AND id=? AND state='pending'",
        owner,
        id,
      ).changes > 0
    );
  }
  recover() {
    this.run("UPDATE gate_jobs SET state='queued' WHERE state='running'");
    for (const task of this.tasks(undefined, true)) {
      if (task.deadline <= this.now()) {
        this.cancel(task.id, "Deadline passed during downtime");
        continue;
      }
      const unsafe = this.one(
        "SELECT 1 FROM receipts WHERE task_id=? AND state='started' AND replay_safe=0",
        task.id,
      );
      if (unsafe)
        this.setTask(
          task.id,
          "failed",
          null,
          "Interrupted tool outcome unknown; inspect before retrying",
        );
      else if (task.status === "running") this.setTask(task.id, "queued");
    }
  }
  stats() {
    return {
      events: this.one<{ n: number }>("SELECT COUNT(*) n FROM evidence WHERE deleted=0")!.n,
      storageBytes: this.storageBytes(),
      queuedDecisions: this.one<{ n: number }>(
        "SELECT COUNT(*) n FROM gate_jobs WHERE state IN ('queued','running')",
      )!.n,
      failedDecisions: this.one<{ n: number }>(
        "SELECT COUNT(*) n FROM gate_jobs WHERE state='failed'",
      )!.n,
      tasks: this.tasks().map((t) => ({
        id: t.id,
        status: t.status,
        parentId: t.parentId,
        error: t.error,
      })),
    };
  }
}
