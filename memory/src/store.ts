import Database from 'better-sqlite3';
import { load as loadVec } from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CaptureInputSchema, MemoryBatchSchema, MemoryDeltaSchema, TranscriptSchema, checkedVision, transcriptKey,
  type CaptureRecord, type CaptureStatus, type CurrentState, type Entity,
  type MemoryBatch, type MemoryContext, type MemoryDelta, type Observation, type Packet,
  type SearchFilter, type SearchHit, type Transcript, type Vision,
} from './contracts.js';
import { DEFAULT_EMBEDDING_MODEL } from './embeddings.js';
import { visualObservations } from './visual-evidence.js';
import { evaluateObjectIdentity, type CandidateObjectSighting, type ObjectAnchor, type ObjectEvidence } from './object-identity.js';
import { faceEntityId } from './face-identity.js';
import { BrowseCursor, type BrowseFilter, type BrowseItem } from './browse.js';

type Row = Record<string, unknown>;
export interface SessionRecord { id: string; startedAt: number }
export interface StateTransition extends CurrentState { packetVersion: number; superseded: boolean }
export interface EventRecord {
  entityId: string; startAt: number; endAt: number | null; lastObservedAt: number;
  status: 'ongoing' | 'ended'; summary: string; packetId: string;
  conflicts: { packetId: string; observedAt: number; summary: string }[];
}
export interface EncounterRecord {
  id: string; personId: string | null; entityId: string; sessionId: string;
  startAt: number; endAt: number | null; lastSeenAt: number; packetId: string;
}
type StoredFact = MemoryDelta['facts'][number] & {
  entityIds: string[]; candidateEntityIds?: string[]; sourceRef?: string;
  kind?: 'fact' | 'speech' | 'event' | 'object-sighting'; sourceSegments?: Transcript[];
};
export interface ObjectSighting {
  packetId: string; packetVersion: number; ref: string; observedAt: number;
  entityId: string | null; candidateEntityIds: string[];
  status: 'new' | 'supported' | 'candidate'; reason: string; matchedAnchorIds: string[];
  evidence: ObjectEvidence | null;
  modelAssessment?: NonNullable<MemoryDelta['objectMatches']>[number];
}
type ObjectDecision = ObjectSighting & { newAnchors: ObjectEvidence['anchors']; frozen: boolean };
type FrozenDraftIdentity = {
  entityId: string; frameLocalPerson: boolean;
  metadata: { label: string; description: string } | null;
};
export interface ObservationFilter extends SearchFilter { includeSuperseded?: boolean }
export interface TranscriptFilter { from?: number; to?: number; includeRevisions?: boolean }
type FaceCapture = Pick<CaptureRecord, 'id' | 'sessionId' | 'capturedAt' | 'faces'>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32)}`;
}
function parsed<T>(row: Row | undefined, field = 'body'): T | null {
  return row ? JSON.parse(String(row[field])) as T : null;
}
function boundedLimit(value: number | undefined, fallback = 50): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error('Limit must be between 1 and 10000');
  return value;
}
const emptyState = (): CurrentState => ({
  version: 0, observedAt: 0, location: null, activity: null,
  summary: '', uncertainties: [], packetId: null,
});

/** SQLite owns truth and the vector outbox; inference is never performed inside a transaction. */
export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string, readonly dimensions = 384, readonly embeddingModel = DEFAULT_EMBEDDING_MODEL) {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536) throw new Error('Invalid vector dimensions');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = FULL');
      loadVec(this.db);
      this.initialize();
    } catch (error) { this.db.close(); throw error; }
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, started_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS captures(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL,
        captured_at REAL NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(session_id, sequence));
      CREATE TABLE IF NOT EXISTS transcripts(
        session_id TEXT NOT NULL REFERENCES sessions(id), stream_id TEXT NOT NULL, segment_id TEXT NOT NULL,
        revision INTEGER NOT NULL, is_final INTEGER NOT NULL, start_at REAL NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(session_id, stream_id, segment_id, revision));
      CREATE TABLE IF NOT EXISTS packets(
        id TEXT NOT NULL REFERENCES captures(id), version INTEGER NOT NULL, session_id TEXT NOT NULL,
        captured_at REAL NOT NULL, committed INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
        PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS entities(
        id TEXT PRIMARY KEY, person_id TEXT UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_people(id TEXT PRIMARY KEY, removed_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_metadata_time(
        entity_id TEXT PRIMARY KEY REFERENCES entities(id), observed_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_metadata_history(
        entity_id TEXT NOT NULL REFERENCES entities(id), packet_id TEXT NOT NULL, packet_version INTEGER NOT NULL,
        observed_at REAL NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(entity_id,packet_id,packet_version));
      CREATE TABLE IF NOT EXISTS entity_refs(
        packet_id TEXT NOT NULL, packet_version INTEGER NOT NULL, ref TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id),
        PRIMARY KEY(packet_id, packet_version, ref));
      CREATE TABLE IF NOT EXISTS object_anchors(
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id), packet_id TEXT NOT NULL,
        ref TEXT NOT NULL, anchor_index INTEGER NOT NULL, body TEXT NOT NULL,
        UNIQUE(packet_id,ref,anchor_index));
      CREATE TABLE IF NOT EXISTS object_sightings(
        packet_id TEXT NOT NULL, ref TEXT NOT NULL, packet_version INTEGER NOT NULL,
        entity_id TEXT REFERENCES entities(id), body TEXT NOT NULL, PRIMARY KEY(packet_id,ref));
      CREATE TABLE IF NOT EXISTS observations(
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        packet_id TEXT NOT NULL, packet_version INTEGER NOT NULL, session_id TEXT NOT NULL,
        observed_at REAL NOT NULL, end_at REAL NOT NULL, entity_ids TEXT NOT NULL, text TEXT NOT NULL,
        confidence TEXT NOT NULL, visual INTEGER NOT NULL, transcript_keys TEXT NOT NULL,
        attribute TEXT, value TEXT, superseded INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'fact',
        FOREIGN KEY(packet_id, packet_version) REFERENCES packets(id, version));
      CREATE INDEX IF NOT EXISTS observation_time ON observations(observed_at);
      CREATE TABLE IF NOT EXISTS observation_sources(
        observation_id TEXT NOT NULL REFERENCES observations(id), session_id TEXT NOT NULL,
        transcript_key TEXT NOT NULL, PRIMARY KEY(observation_id, transcript_key));
      CREATE INDEX IF NOT EXISTS observation_source_lookup ON observation_sources(session_id, transcript_key);
      CREATE TABLE IF NOT EXISTS observation_source_coverage(
        observation_id TEXT NOT NULL REFERENCES observations(id), transcript_key TEXT NOT NULL,
        start_at REAL NOT NULL, end_at REAL NOT NULL, PRIMARY KEY(observation_id,transcript_key));
      CREATE TABLE IF NOT EXISTS state_history(
        version INTEGER PRIMARY KEY AUTOINCREMENT, packet_id TEXT NOT NULL, packet_version INTEGER NOT NULL,
        observed_at REAL NOT NULL, superseded INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
        UNIQUE(packet_id, packet_version));
      CREATE TABLE IF NOT EXISTS current_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_history(
        entity_id TEXT NOT NULL REFERENCES entities(id), packet_id TEXT NOT NULL, packet_version INTEGER NOT NULL,
        observed_at REAL NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(entity_id, packet_id, packet_version));
      CREATE TABLE IF NOT EXISTS encounters(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id),
        start_at REAL NOT NULL, end_at REAL, last_seen_at REAL NOT NULL, packet_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embedding_outbox(
        observation_id TEXT PRIMARY KEY REFERENCES observations(id));
    `);
    if (!(this.db.prepare('PRAGMA table_info(observations)').all() as Row[]).some(row => row.name === 'kind'))
      this.db.exec("ALTER TABLE observations ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'");
    if (!(this.db.prepare('PRAGMA table_info(observations)').all() as Row[]).some(row => row.name === 'candidate_entity_ids'))
      this.db.exec("ALTER TABLE observations ADD COLUMN candidate_entity_ids TEXT NOT NULL DEFAULT '[]'");
    // One persisted lexical index; no embedding inference on the writer's hot path.
    // Install and backfill together so an interrupted migration cannot lose history.
    this.db.transaction(() => {
      const indexed = this.db.prepare("SELECT 1 FROM metadata WHERE key='observation_fts_v1'").get();
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observation_text USING fts5(text, content='observations', content_rowid='rowid', tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS observation_text_insert AFTER INSERT ON observations BEGIN
          INSERT INTO observation_text(rowid,text) VALUES(new.rowid,new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS observation_text_delete AFTER DELETE ON observations BEGIN
          INSERT INTO observation_text(observation_text,rowid,text) VALUES('delete',old.rowid,old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS observation_text_update AFTER UPDATE OF text ON observations BEGIN
          INSERT INTO observation_text(observation_text,rowid,text) VALUES('delete',old.rowid,old.text);
          INSERT INTO observation_text(rowid,text) VALUES(new.rowid,new.text);
        END;
        CREATE INDEX IF NOT EXISTS observation_attributes ON observations(observed_at)
          WHERE superseded=0 AND attribute IS NOT NULL AND confidence!='uncertain';
        CREATE INDEX IF NOT EXISTS anchors_entity ON object_anchors(entity_id);
        CREATE INDEX IF NOT EXISTS capture_status_time ON captures(status,captured_at);
      `);
      if (!indexed) {
        this.db.exec("INSERT INTO observation_text(observation_text) VALUES('rebuild')");
        this.db.prepare("INSERT INTO metadata VALUES('observation_fts_v1','1')").run();
      }
    })();
    this.db.prepare("UPDATE observations SET kind='event' WHERE kind='fact' AND text LIKE 'Event context: %'").run();
    if (!(this.db.prepare('PRAGMA table_info(entity_refs)').all() as Row[]).some(row => row.name === 'packet_version')) this.db.transaction(() => {
      this.db.exec(`ALTER TABLE entity_refs RENAME TO legacy_entity_refs;
        CREATE TABLE entity_refs(packet_id TEXT NOT NULL, packet_version INTEGER NOT NULL, ref TEXT NOT NULL,
          entity_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(packet_id,packet_version,ref));
        INSERT INTO entity_refs SELECT r.packet_id,p.version,r.ref,r.entity_id FROM legacy_entity_refs r
          JOIN packets p ON p.id=r.packet_id;
        DROP TABLE legacy_entity_refs;`);
    })();
    const expected = { schema: '1', dimensions: String(this.dimensions), embeddingModel: this.embeddingModel };
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(expected)) {
        const existing = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as Row | undefined;
        if (existing && existing.value !== value) throw new Error(`Database ${key} mismatch: expected ${value}, got ${existing.value}`);
        this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run(key, value);
      }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observation_vectors USING vec0(embedding float[${this.dimensions}] distance_metric=cosine)`);
    })();
  }

  close(): void { this.db.close(); }

  createSession(id: string, startedAt: number): void {
    if (!id || !Number.isFinite(startedAt) || startedAt < 0) throw new Error('Invalid session');
    const previous = this.db.prepare('SELECT started_at FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (previous && previous.started_at !== startedAt) throw new Error('Session ID already has a different start time');
    this.db.prepare('INSERT OR IGNORE INTO sessions VALUES (?,?)').run(id, startedAt);
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare('SELECT id, started_at AS startedAt FROM sessions ORDER BY started_at DESC').all() as SessionRecord[];
  }

  insertCapture(capture: CaptureRecord): boolean {
    CaptureInputSchema.parse({ ...capture, jpegBase64: 'AAAA' });
    const previous = this.getCapture(capture.id);
    if (previous) {
      const identity = (c: CaptureRecord) => ({ id: c.id, sessionId: c.sessionId, sequence: c.sequence,
        capturedAt: c.capturedAt, width: c.width, height: c.height, sha256: c.sha256,
        imagePath: c.imagePath, faces: c.faces, audioStatus: c.audioStatus });
      if (canonical(identity(previous)) !== canonical(identity(capture))) throw new Error('Conflicting capture ID');
      return false;
    }
    if (capture.faces.frameId !== capture.id || capture.faces.capturedAt !== capture.capturedAt)
      throw new Error('Face evidence does not match capture');
    this.db.prepare('INSERT INTO captures VALUES (?,?,?,?,?,?)').run(capture.id, capture.sessionId,
      capture.sequence, capture.capturedAt, capture.status, JSON.stringify(capture));
    return true;
  }

  getCapture(id: string): CaptureRecord | null {
    return parsed(this.db.prepare('SELECT body FROM captures WHERE id=?').get(id) as Row | undefined);
  }

  listCaptures(limit = 50): CaptureRecord[] {
    return (this.db.prepare('SELECT body FROM captures ORDER BY captured_at DESC, id LIMIT ?').all(boundedLimit(limit)) as Row[])
      .map(row => parsed<CaptureRecord>(row)!);
  }

  /** Read-only source-time pagination, bounded independently of the recent dashboard. */
  browse(filter: BrowseFilter) {
    const { kind, query, from, to, history, entityKind, limit } = filter;
    const signature = createHash('sha256').update(JSON.stringify({ kind, query, from, to, history, entityKind })).digest('hex');
    let cursor: ReturnType<typeof BrowseCursor.parse> | undefined;
    if (filter.cursor) {
      try { cursor = BrowseCursor.parse(JSON.parse(Buffer.from(filter.cursor, 'base64url').toString())); }
      catch { throw new Error('Invalid memory cursor'); }
      if (cursor.filter !== signature) throw new Error('Memory filters changed; start a new page');
    }
    const args: (number | string)[] = [], conditions: string[] = [];
    let table: string, time: string, end: string, text: string;
    let item: (row: Row) => BrowseItem;
    const base = (row: Row, data: Record<string, unknown>): BrowseItem => ({
      id: String(data.id ?? row.rowid), kind, at: Number(row.browse_at), title: '', text: '',
      status: null, captureId: null, entityId: null, data,
    });
    if (kind === 'observations') {
      table = 'observations'; time = 'o.observed_at'; end = 'o.end_at'; text = 'o.text';
      const active = this.filterSql({});
      conditions.push(history ? active.sql.replace('o.superseded=0', '1') : active.sql);
      item = row => {
        const data = this.observation(row);
        return { ...base(row, { ...data, kind: row.kind }), title: 'Observation', text: data.text,
          status: data.superseded ? 'superseded' : data.confidence, captureId: data.packetId };
      };
    } else if (kind === 'captures') {
      table = 'captures'; time = end = 'o.captured_at';
      text = "coalesce(json_extract(o.body,'$.vision'),'')";
      item = row => {
        const { imagePath: _path, sha256: _hash, ...data } = parsed<CaptureRecord>(row)!;
        return { ...base(row, data), title: `Camera frame · ${data.status}`,
          text: data.vision?.scene ?? data.error ?? 'Saved image; interpretation pending',
          status: data.status, captureId: data.id };
      };
    } else if (kind === 'transcripts') {
      table = 'transcripts'; time = 'o.start_at'; end = "json_extract(o.body,'$.endAt')";
      text = "json_extract(o.body,'$.text')";
      if (!history) conditions.push(`o.revision=(SELECT MAX(n.revision) FROM transcripts n
        WHERE n.session_id=o.session_id AND n.stream_id=o.stream_id AND n.segment_id=o.segment_id)`);
      item = row => {
        const data = parsed<Transcript>(row)!;
        const latest = this.db.prepare('SELECT MAX(revision) revision FROM transcripts WHERE session_id=? AND stream_id=? AND segment_id=?')
          .get(data.sessionId, data.streamId, data.segmentId) as Row;
        return { ...base(row, data), id: `${data.sessionId}/${transcriptKey(data)}`, title: 'Speech · unknown speaker', text: data.text,
          status: data.revision < Number(latest.revision) ? 'superseded' : data.isFinal ? 'final' : 'partial' };
      };
    } else if (kind === 'entities') {
      table = 'entities'; time = end = "json_extract(o.body,'$.createdAt')";
      text = "json_extract(o.body,'$.label')||' '||json_extract(o.body,'$.description')||' '||json_extract(o.body,'$.attributes')";
      conditions.push(`(json_extract(o.body,'$.kind')!='person' OR (NOT EXISTS(SELECT 1 FROM removed_people rp WHERE rp.id=o.id)
        AND json_extract(o.body,'$.createdAt')>COALESCE((SELECT CAST(value AS REAL) FROM metadata WHERE key='people_reset_before'),-1)))`);
      if (entityKind) { conditions.push("json_extract(o.body,'$.kind')=?"); args.push(entityKind); }
      item = row => {
        const data = this.hydrateEntity(parsed<Entity>(row)!);
        return { ...base(row, { ...data }), title: data.label, text: data.description, status: data.kind, entityId: data.id };
      };
    } else {
      table = 'state_history'; time = end = 'o.observed_at';
      text = "json_extract(o.body,'$.summary')||' '||coalesce(json_extract(o.body,'$.location'),'')||' '||coalesce(json_extract(o.body,'$.activity'),'')";
      if (!history) conditions.push('o.superseded=0');
      // A person reset invalidates generated summaries, while original sources remain inspectable.
      conditions.push(`o.observed_at>max(COALESCE((SELECT CAST(value AS REAL) FROM metadata WHERE key='people_reset_before'),-1),
        COALESCE((SELECT CAST(value AS REAL) FROM metadata WHERE key='people_state_reset_before'),-1))`);
      item = row => {
        const data = parsed<CurrentState>(row)!;
        return { ...base(row, { ...data, packetVersion: row.packet_version, superseded: Boolean(row.superseded) }),
          id: `state-${row.version}`, title: data.location ?? 'Scene state', text: data.summary,
          status: row.superseded ? 'superseded' : 'recorded', captureId: data.packetId };
      };
    }
    if (query) { conditions.push(`instr(lower(${text}),lower(?))>0`); args.push(query); }
    if (from !== undefined) { conditions.push(`${end}>=?`); args.push(from); }
    if (to !== undefined) { conditions.push(`${time}<=?`); args.push(to); }
    const snapshot = cursor?.snapshot ?? Number((this.db.prepare(`SELECT coalesce(MAX(rowid),0) n FROM ${table}`).get() as Row).n);
    conditions.push('o.rowid<=?'); args.push(snapshot);
    const count = this.db.prepare(`SELECT COUNT(*) n FROM ${table} o WHERE ${conditions.join(' AND ')}`).get(...args) as Row;
    if (cursor) {
      conditions.push(`(${time}<? OR (${time}=? AND o.rowid<?))`);
      args.push(cursor.at, cursor.at, cursor.row);
    }
    const rows = this.db.prepare(`SELECT o.*,o.rowid AS rowid,${time} AS browse_at FROM ${table} o
      WHERE ${conditions.join(' AND ')} ORDER BY ${time} DESC,o.rowid DESC LIMIT ?`).all(...args, limit + 1) as Row[];
    const page = rows.slice(0, limit), last = page.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ filter: signature, snapshot,
      at: Number(last.browse_at), row: Number(last.rowid) })).toString('base64url') : null;
    return { kind, items: page.map(item), nextCursor, total: Number(count.n) };
  }

  capturesForSession(sessionId: string): CaptureRecord[] {
    return (this.db.prepare('SELECT body FROM captures WHERE session_id=? ORDER BY captured_at,sequence,id').all(sessionId) as Row[])
      .map(row => parsed<CaptureRecord>(row)!);
  }

  pendingCaptures(): CaptureRecord[] {
    return (this.db.prepare("SELECT body FROM captures WHERE status NOT IN ('committed','failed') ORDER BY captured_at,sequence,id").all() as Row[])
      .map(row => parsed<CaptureRecord>(row)!);
  }

  setCaptureStatus(id: string, status: CaptureStatus, error: string | null = null): void {
    const capture = this.getCapture(id);
    if (!capture) throw new Error('Unknown capture');
    capture.status = status; capture.error = error;
    this.db.prepare('UPDATE captures SET status=?,body=? WHERE id=?').run(status, JSON.stringify(capture), id);
  }

  saveVision(id: string, vision: Vision): void {
    const capture = this.getCapture(id);
    if (!capture) throw new Error('Unknown capture');
    capture.vision = checkedVision(vision, capture); capture.status = 'ready'; capture.error = null;
    this.db.prepare('UPDATE captures SET status=?,body=? WHERE id=?').run('ready', JSON.stringify(capture), id);
  }

  saveTranscript(input: Transcript): boolean {
    const transcript = TranscriptSchema.parse(input);
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT body FROM transcripts WHERE session_id=? AND stream_id=? AND segment_id=? AND revision=?')
        .get(transcript.sessionId, transcript.streamId, transcript.segmentId, transcript.revision) as Row | undefined;
      if (previous) {
        const original = parsed<Transcript>(previous)!;
        if (canonical({ ...original, receivedAt: 0 }) !== canonical({ ...transcript, receivedAt: 0 })) throw new Error('Conflicting transcript revision');
        return false;
      }
      // A completed segment cannot be demoted by a delayed streaming hypothesis.
      if (!transcript.isFinal && this.db.prepare(`SELECT 1 FROM transcripts
        WHERE session_id=? AND stream_id=? AND segment_id=? AND is_final=1 LIMIT 1`)
        .get(transcript.sessionId, transcript.streamId, transcript.segmentId)) return false;
      this.db.prepare('INSERT INTO transcripts VALUES (?,?,?,?,?,?,?)').run(transcript.sessionId, transcript.streamId,
        transcript.segmentId, transcript.revision, Number(transcript.isFinal), transcript.startAt, JSON.stringify(transcript));
      if (!transcript.isFinal) return true;
      const newer = this.db.prepare(`SELECT 1 FROM transcripts WHERE session_id=? AND stream_id=? AND segment_id=? AND revision>? LIMIT 1`)
        .get(transcript.sessionId, transcript.streamId, transcript.segmentId, transcript.revision);
      if (newer) return true;
      // A newer revision makes earlier dependent claims stale immediately; do not wait for inference.
      const older = this.db.prepare('SELECT body FROM transcripts WHERE session_id=? AND stream_id=? AND segment_id=? AND revision<?')
        .all(transcript.sessionId, transcript.streamId, transcript.segmentId, transcript.revision) as Row[];
      const dirty = new Set<string>();
      const invalid = new Map<string, { id: string; version: number }>();
      for (const row of older) {
        const key = transcriptKey(parsed<Transcript>(row)!);
        const dependents = this.db.prepare(`SELECT DISTINCT o.packet_id FROM observations o
          JOIN observation_sources s ON s.observation_id=o.id WHERE s.session_id=? AND s.transcript_key=? AND o.superseded=0`)
          .all(transcript.sessionId, key) as Row[];
        for (const dependent of dependents) dirty.add(String(dependent.packet_id));
        // State, event summaries and entity descriptions can consume speech without
        // emitting a fact. The immutable packet is their conservative dependency.
        const consumed = this.db.prepare(`SELECT DISTINCT p.id,p.version FROM packets p,
          json_each(p.body,'$.audio.segments') segment WHERE p.session_id=? AND p.committed=1
          AND p.version=(SELECT MAX(n.version) FROM packets n WHERE n.id=p.id AND n.committed=1)
          AND json_extract(segment.value,'$.isFinal')=1
          AND json_extract(segment.value,'$.streamId') || '/' || json_extract(segment.value,'$.segmentId') || '@' ||
            json_extract(segment.value,'$.revision')=?`).all(transcript.sessionId, key) as Row[];
        for (const packet of consumed) {
          const item = { id: String(packet.id), version: Number(packet.version) };
          dirty.add(item.id); invalid.set(canonical(item), item);
        }
        this.supersedeWhere(`id IN (SELECT observation_id FROM observation_sources WHERE session_id=? AND transcript_key=?)`,
          [transcript.sessionId, key]);
      }
      this.invalidateProjections([...invalid.values()]);
      this.rebuildAttributes();
      const anchor = this.db.prepare(`SELECT id FROM captures WHERE session_id=? AND captured_at>=?
        ORDER BY captured_at,sequence,id LIMIT 1`).get(transcript.sessionId, transcript.endAt) as Row | undefined;
      if (anchor) dirty.add(String(anchor.id));
      for (const id of dirty) {
        const capture = this.getCapture(id)!;
        if (capture.status === 'committed' || capture.status === 'failed')
          this.setCaptureStatus(id, capture.vision ? 'ready' : 'queued');
      }
      return true;
    })();
  }

  transcripts(sessionId: string, filter: TranscriptFilter = {}): Transcript[] {
    const conditions = ['t.session_id=?']; const args: (string | number)[] = [sessionId];
    if (!filter.includeRevisions) conditions.push(`revision=(SELECT MAX(revision) FROM transcripts n
      WHERE n.session_id=t.session_id AND n.stream_id=t.stream_id AND n.segment_id=t.segment_id)`);
    if (filter.from !== undefined) {
      if (!Number.isFinite(filter.from)) throw new Error('Invalid from time');
      conditions.push("json_extract(t.body,'$.endAt')>=?"); args.push(filter.from);
    }
    if (filter.to !== undefined) {
      if (!Number.isFinite(filter.to)) throw new Error('Invalid to time');
      conditions.push('t.start_at<=?'); args.push(filter.to);
    }
    return (this.db.prepare(`SELECT t.body FROM transcripts t WHERE ${conditions.join(' AND ')}
      ORDER BY start_at,stream_id,segment_id,revision`).all(...args) as Row[]).map(row => parsed<Transcript>(row)!);
  }

  savePacket(packet: Packet): void {
    const capture = this.getCapture(packet.id);
    if (!capture || capture.sessionId !== packet.sessionId || capture.capturedAt !== packet.capturedAt ||
      capture.sequence !== packet.sequence || capture.sha256 !== packet.sha256 || capture.imagePath !== packet.imagePath ||
      canonical(capture.faces) !== canonical(packet.faces)) throw new Error('Packet does not match immutable capture');
    if (!Number.isInteger(packet.version) || packet.version < 1) throw new Error('Invalid packet version');
    const previous = this.getPacket(packet.id, packet.version);
    if (previous) {
      if (canonical(previous) !== canonical(packet)) throw new Error('Conflicting packet version');
      return;
    }
    if (packet.version !== this.nextPacketVersion(packet.id)) throw new Error('Packet versions must be sequential');
    checkedVision(packet.vision, capture);
    for (const segment of packet.audio.segments) {
      TranscriptSchema.parse(segment);
      if (segment.sessionId !== packet.sessionId || segment.endAt > packet.capturedAt)
        throw new Error('Packet transcript is from another session or after capture');
    }
    this.db.prepare('INSERT INTO packets(id,version,session_id,captured_at,body) VALUES (?,?,?,?,?)')
      .run(packet.id, packet.version, packet.sessionId, packet.capturedAt, JSON.stringify(packet));
  }

  getPacket(id: string, version?: number): Packet | null {
    const row = version === undefined ? this.db.prepare('SELECT body FROM packets WHERE id=? ORDER BY version DESC LIMIT 1').get(id)
      : this.db.prepare('SELECT body FROM packets WHERE id=? AND version=?').get(id, version);
    return parsed(row as Row | undefined);
  }

  packetVersions(id: string): Packet[] {
    return (this.db.prepare('SELECT body FROM packets WHERE id=? ORDER BY version').all(id) as Row[]).map(row => parsed<Packet>(row)!);
  }

  packetsForSession(sessionId: string): Packet[] {
    return (this.db.prepare(`SELECT p.body FROM packets p WHERE session_id=? AND version=(SELECT MAX(version) FROM packets n WHERE n.id=p.id)
      ORDER BY captured_at,id`).all(sessionId) as Row[]).map(row => parsed<Packet>(row)!);
  }

  nextPacketVersion(id: string): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM packets WHERE id=?').get(id) as Row).version);
  }

  isPacketCommitted(id: string, version: number): boolean {
    return Boolean((this.db.prepare('SELECT committed FROM packets WHERE id=? AND version=?').get(id, version) as Row | undefined)?.committed);
  }

  hasCommittedPacket(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM packets WHERE id=? AND committed=1 LIMIT 1').get(id));
  }

  currentState(): CurrentState {
    const state = parsed<CurrentState>(this.db.prepare('SELECT body FROM current_state WHERE singleton=1').get() as Row | undefined) ?? emptyState();
    const cleared = this.db.prepare("SELECT value FROM metadata WHERE key='people_state_reset_before'").get() as Row | undefined;
    return state.observedAt <= Math.max(this.peopleResetBefore() ?? -1, cleared ? Number(cleared.value) : -1) ? emptyState() : state;
  }
  entities(): Entity[] { return (this.db.prepare('SELECT body FROM entities ORDER BY id').all() as Row[])
    .map(row => this.hydrateEntity(parsed<Entity>(row)!)).filter(e => !this.isPersonRemoved(e)); }

  peopleResetBefore(): number | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='people_reset_before'").get() as Row | undefined;
    return row ? Number(row.value) : null;
  }
  isPersonRemoved(entity: Entity): boolean {
    return entity.kind === 'person' && (entity.createdAt <= (this.peopleResetBefore() ?? -1) ||
      Boolean(this.db.prepare('SELECT 1 FROM removed_people WHERE id=?').get(entity.id)));
  }
  /** Reset active identities/retrieval, preserving original photos and transcript evidence.
   * Tombstones also cover delayed model results; reset's capture-time cutoff hides
   * provisional people created after the reset from already-pending old photos.
   */
  removePeople(ids: string[], reset = false, at = Date.now()): void {
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT INTO removed_people(id,removed_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING');
      for (const id of ids) insert.run(id, at);
      if (reset) this.db.prepare("INSERT INTO metadata(key,value) VALUES ('people_reset_before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(at));
      this.db.prepare("INSERT INTO metadata(key,value) VALUES ('people_state_reset_before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(at));
      // A generated summary may mention the removed identity, so rebuild it from
      // future evidence rather than leaving that stale name on the dashboard.
      this.db.prepare('DELETE FROM current_state').run();
    })();
  }
  entity(id: string): Entity | null {
    const entity = parsed<Entity>(this.db.prepare('SELECT body FROM entities WHERE id=?').get(id) as Row | undefined);
    return entity ? this.hydrateEntity(entity) : null;
  }
  private hydrateEntity(entity: Entity): Entity {
    if (entity.kind === 'object') {
      const distinct = new Map<string, ObjectAnchor>();
      const anchors = this.objectAnchors(entity.id).filter(anchor => anchor.active && anchor.kind !== 'generic')
        .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
      for (const anchor of anchors) {
        const signature = canonical([anchor.kind, anchor.quote.trim().replace(/\s+/gu, ' ')]);
        // Repeated sightings are not new identity information. Keep the original
        // source for a feature; history retains every later supporting sighting.
        if (!distinct.has(signature)) distinct.set(signature, anchor);
      }
      const values = [...distinct.values()];
      entity.identityAnchors = values.length <= 12 ? values : [...values.slice(0, 6), ...values.slice(-6)];
    }
    return entity;
  }
  private objectAnchors(entityId?: string): ObjectAnchor[] {
    const rows = entityId ? this.db.prepare('SELECT body FROM object_anchors WHERE entity_id=? ORDER BY id').all(entityId)
      : this.db.prepare('SELECT body FROM object_anchors ORDER BY id').all();
    return (rows as Row[]).map(row => parsed<ObjectAnchor>(row)!);
  }
  objectSightings(packetId?: string): ObjectSighting[] {
    const rows = packetId ? this.db.prepare('SELECT body FROM object_sightings WHERE packet_id=? ORDER BY ref').all(packetId)
      : this.db.prepare('SELECT body FROM object_sightings ORDER BY packet_id,ref').all();
    return (rows as Row[]).map(row => parsed<ObjectSighting>(row)!);
  }
  private candidateAnchorSources(evidence: ObjectEvidence | undefined): CandidateObjectSighting[] {
    const sources = new Map<string, CandidateObjectSighting>();
    for (const citation of evidence?.match?.anchors ?? []) {
      const reference = citation.anchor;
      if (!('packetId' in reference)) continue;
      const key = JSON.stringify([reference.packetId, reference.ref]);
      if (sources.has(key)) continue;
      const row = this.db.prepare(`SELECT s.body,p.body AS packet_body FROM object_sightings s
        JOIN packets p ON p.id=s.packet_id AND p.version=s.packet_version AND p.committed=1
        WHERE s.packet_id=? AND s.ref=?`).get(reference.packetId, reference.ref) as Row | undefined;
      if (!row) continue;
      const sighting = parsed<ObjectSighting>(row)!;
      if (sighting.status !== 'candidate' || sighting.entityId !== null || !sighting.evidence) continue;
      const packet = parsed<Packet>(row, 'packet_body')!;
      sources.set(key, { packet: { id: packet.id, capturedAt: packet.capturedAt, vision: packet.vision },
        packetVersion: packet.version, ref: sighting.ref, candidateEntityIds: sighting.candidateEntityIds,
        evidence: sighting.evidence });
    }
    return [...sources.values()];
  }
  context(): MemoryContext { return { state: this.currentState(), entities: this.entities(), related: [] }; }

  /** Small continuity fallback; anonymous people return through faces or retrieval. */
  recentContextEntities(limit = 24): Entity[] {
    return (this.db.prepare(`SELECT body FROM entities
      WHERE json_extract(body,'$.kind')!='person' OR person_id IS NOT NULL
      ORDER BY json_extract(body,'$.lastSeenAt') DESC,id LIMIT ?`).all(boundedLimit(limit)) as Row[])
      .map(row => this.hydrateEntity(parsed<Entity>(row)!));
  }

  /** Canonical references from the latest committed interpretation of one image. */
  packetEntities(packetId: string): Entity[] {
    return (this.db.prepare(`SELECT DISTINCT e.body FROM entity_refs r JOIN entities e ON e.id=r.entity_id
      WHERE r.packet_id=? AND r.packet_version=(SELECT MAX(version) FROM packets WHERE id=? AND committed=1)
      ORDER BY e.id`).all(packetId, packetId) as Row[]).map(row => this.hydrateEntity(parsed<Entity>(row)!));
  }

  private observation(row: Row): Observation {
    return { id: String(row.id), packetId: String(row.packet_id), packetVersion: Number(row.packet_version),
      entityIds: JSON.parse(String(row.entity_ids)), text: String(row.text), observedAt: Number(row.observed_at),
      candidateEntityIds: JSON.parse(String(row.candidate_entity_ids ?? '[]')),
      endAt: Number(row.end_at), confidence: String(row.confidence), visual: Boolean(row.visual),
      transcriptKeys: JSON.parse(String(row.transcript_keys)), superseded: Boolean(row.superseded) };
  }

  private filterSql(filter: SearchFilter, alias = 'o'): { sql: string; args: (string | number)[] } {
    // Visit only this observation's linked identities, not every known person for every row.
    const conditions = [`${alias}.superseded=0`, ...['entity_ids', 'candidate_entity_ids'].map(column => `NOT EXISTS (
      SELECT 1 FROM json_each(${alias}.${column}) linked JOIN entities ep ON ep.id=linked.value
      WHERE json_extract(ep.body,'$.kind')='person'
      AND (EXISTS(SELECT 1 FROM removed_people rp WHERE rp.id=ep.id) OR
        json_extract(ep.body,'$.createdAt') <= COALESCE((SELECT CAST(value AS REAL) FROM metadata WHERE key='people_reset_before'),-1)))`)];
    const args: (string | number)[] = [];
    if (filter.entityId) {
      conditions.push(`(EXISTS(SELECT 1 FROM json_each(${alias}.entity_ids) WHERE value=?) OR
        EXISTS(SELECT 1 FROM json_each(${alias}.candidate_entity_ids) WHERE value=?))`);
      args.push(filter.entityId, filter.entityId);
    }
    if (filter.from !== undefined) { if (!Number.isFinite(filter.from)) throw new Error('Invalid from time'); conditions.push(`${alias}.end_at>=?`); args.push(filter.from); }
    if (filter.to !== undefined) { if (!Number.isFinite(filter.to)) throw new Error('Invalid to time'); conditions.push(`${alias}.observed_at<=?`); args.push(filter.to); }
    return { sql: conditions.join(' AND '), args };
  }

  observations(filter: ObservationFilter = {}): Observation[] {
    const { sql, args } = this.filterSql(filter);
    const condition = filter.includeSuperseded ? sql.replace('o.superseded=0', '1') : sql;
    return (this.db.prepare(`SELECT o.* FROM observations o WHERE ${condition} ORDER BY observed_at DESC,rowid DESC LIMIT ?`)
      .all(...args, boundedLimit(filter.limit, 200)) as Row[]).map(row => this.observation(row));
  }

  keywordSearch(query: string, filter: SearchFilter = {}): SearchHit[] {
    const { sql, args } = this.filterSql(filter);
    return (this.db.prepare(`SELECT o.* FROM observations o WHERE ${sql}
      AND instr(lower(o.text),lower(?))>0 ORDER BY o.observed_at DESC,o.rowid DESC LIMIT ?`)
      .all(...args, query, boundedLimit(filter.limit, 20)) as Row[])
      .map(row => ({ ...this.observation(row), distance: 0 }));
  }

  /** Literal word overlap for writer context; results are candidates, never identity proof. */
  contextNotes(texts: string[], limit = 24): SearchHit[] {
    const terms = [...new Set(texts.flatMap(text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))];
    if (!terms.length) return [];
    const { sql, args } = this.filterSql({});
    const hits = new Map<string, { note: SearchHit; score: number }>();
    // Bound the MATCH expression while letting every source (including later rows) participate.
    for (let offset = 0; offset < terms.length; offset += 128) {
      const query = terms.slice(offset, offset + 128).map(term => `"${term}"`).join(' OR ');
      const rows = this.db.prepare(`SELECT o.*,rank AS lexical_rank FROM observation_text
        JOIN observations o ON o.rowid=observation_text.rowid
        WHERE observation_text MATCH ? AND ${sql}
        ORDER BY rank,o.observed_at DESC LIMIT ?`).all(query, ...args, boundedLimit(limit, 24)) as Row[];
      for (const row of rows) hits.set(String(row.id), { note: { ...this.observation(row), distance: 0 },
        score: (hits.get(String(row.id))?.score ?? 0) + Number(row.lexical_rank) });
    }
    return [...hits.values()].sort((a, b) => a.score - b.score || b.note.observedAt - a.note.observedAt)
      .slice(0, boundedLimit(limit, 24)).map(hit => hit.note);
  }

  currentObservation(id: string): Observation | null {
    const { sql, args } = this.filterSql({});
    const row = this.db.prepare(`SELECT o.* FROM observations o WHERE o.id=? AND ${sql}`).get(id, ...args) as Row | undefined;
    return row ? this.observation(row) : null;
  }

  forceSingleUpdate(id: string) {
    const capture = this.getCapture(id);
    if (!capture) throw new Error('Unknown capture');
    capture.singleUpdate = true; capture.status = 'ready'; capture.error = null;
    this.db.prepare("UPDATE captures SET status='ready',body=? WHERE id=?").run(JSON.stringify(capture), id);
  }

  /** Complete person/object/event history, including superseded evidence unless explicitly excluded. */
  entityHistory(entityId: string, filter: Omit<ObservationFilter, 'entityId' | 'limit'> = {}): Observation[] {
    const { sql, args } = this.filterSql({ ...filter, entityId });
    const condition = filter.includeSuperseded === false ? sql : sql.replace('o.superseded=0', '1');
    return (this.db.prepare(`SELECT o.* FROM observations o WHERE ${condition} ORDER BY observed_at,rowid`)
      .all(...args) as Row[]).map(row => this.observation(row));
  }

  /** Validate references first, then commit evidence and projections as one durable operation. */
  commitBatch(packets: Packet[], input: MemoryBatch): void {
    const batch = MemoryBatchSchema.parse(input);
    if (packets.length !== batch.updates.length || new Set(packets.map(p => p.id)).size !== packets.length)
      throw new Error('Batch packet count or identity mismatch');
    if (new Set(packets.map(p => p.sessionId)).size !== 1) throw new Error('Batch packets must share one session');
    for (const [index, packet] of packets.entries()) {
      const row = batch.updates[index]; const previous = packets[index - 1];
      if (row.packetId !== packet.id || row.packetVersion !== packet.version)
        throw new Error('Batch packet order or version mismatch');
      if (previous && (previous.capturedAt > packet.capturedAt ||
        (previous.capturedAt === packet.capturedAt && previous.sequence > packet.sequence)))
        throw new Error('Batch packets must be in capture order');
    }
    this.db.transaction(() => {
      // Shared model context contains these canonical identities. Register them at
      // their actual face-source times before resolving earlier reported mentions;
      // observations and encounters are still created only by each source row.
      for (const packet of packets) for (const entity of this.faceEntities(packet)) this.writeEntity(entity);
      for (const [index, packet] of packets.entries()) {
        const row = batch.updates[index]; const delta = structuredClone(row.delta);
        const candidateReuse = new Map<string, string[]>();
        const refs = new Map(delta.entities.map(entity => [entity.ref, entity]));
        if (refs.size !== delta.entities.length) throw new Error('Duplicate batch entity ref');
        const reused = new Set<string>();
        for (const link of row.reuse) {
          if (reused.has(link.ref)) throw new Error('Duplicate batch reuse ref');
          reused.add(link.ref);
          const proposal = refs.get(link.ref);
          if (!proposal) throw new Error('Unknown batch reuse ref');
          if (proposal.existingId !== null || proposal.personId !== null) throw new Error('Batch reuse conflicts with an explicit identity');
          const priorIndex = packets.findIndex(p => p.id === link.fromPacketId);
          if (priorIndex < 0 || priorIndex >= index) throw new Error('Batch reuse must reference a strictly earlier row');
          if (!batch.updates[priorIndex].delta.entities.some(entity => entity.ref === link.fromRef))
            throw new Error('Unknown earlier batch entity ref');
          const priorPacket = packets[priorIndex];
          const priorSighting = this.objectSightings(priorPacket.id).find(sighting => sighting.ref === link.fromRef);
          if (priorSighting?.status === 'candidate') {
            if (proposal.kind !== 'object') throw new Error('Batch candidate kind conflict');
            candidateReuse.set(link.ref, priorSighting.candidateEntityIds);
            continue;
          }
          const priorRef = this.db.prepare('SELECT entity_id FROM entity_refs WHERE packet_id=? AND packet_version=? AND ref=?')
            .get(priorPacket.id, priorPacket.version, link.fromRef) as Row | undefined;
          const prior = priorRef ? this.entity(String(priorRef.entity_id)) : null;
          if (!prior || prior.kind !== proposal.kind || prior.personId !== proposal.personId)
            throw new Error('Batch reuse entity kind or person identity conflict');
          proposal.existingId = prior.id;
        }
        const existing = delta.entities.flatMap(entity => entity.existingId ? [entity.existingId] : []);
        if (new Set(existing).size !== existing.length) throw new Error('Repeated batch entity identity');
        this.commitPacket(packet, delta, candidateReuse);
      }
    })();
  }

  /** Validate references first, then commit evidence and projections as one durable operation. */
  commit(packet: Packet, input: MemoryDelta): { observationIds: string[] } {
    return this.commitPacket(packet, input);
  }

  private commitPacket(packet: Packet, input: MemoryDelta, candidateReuse = new Map<string, string[]>()): { observationIds: string[] } {
    const delta = MemoryDeltaSchema.parse(input);
    return this.db.transaction(() => {
      this.savePacket(packet);
      const committed = this.db.prepare('SELECT committed FROM packets WHERE id=? AND version=?').get(packet.id, packet.version) as Row;
      if (committed.committed) return { observationIds: (this.db.prepare('SELECT id FROM observations WHERE packet_id=? AND packet_version=?').all(packet.id, packet.version) as Row[]).map(r => String(r.id)) };
      if (this.db.prepare('SELECT 1 FROM packets WHERE id=? AND version>? AND committed=1').get(packet.id, packet.version))
        throw new Error('Cannot commit an older packet revision');
      this.validateFinalSources(packet);
      const previous = this.db.prepare('SELECT id,version FROM packets WHERE id=? AND version<? AND committed=1')
        .all(packet.id, packet.version) as Row[];
      const hadPriorCommit = previous.length > 0;
      const frozenDraft = this.frozenDraftIdentities(packet, delta, previous);
      if (hadPriorCommit) this.invalidateProjections(previous.map(row => ({ id: String(row.id), version: Number(row.version) })));
      const decisions = this.objectDecisions(packet, delta, hadPriorCommit, candidateReuse);
      const personCandidates = new Map<string, string>();
      const refs = this.resolveEntities(packet, delta, decisions, personCandidates, frozenDraft);
      this.saveObjectDecisions(packet, decisions, refs);
      const facts = this.validateFacts(packet, delta, refs, decisions, personCandidates);
      for (const event of delta.events) {
        const entity = this.entity(refs.get(event.entityRef) ?? '');
        if (!entity || entity.kind !== 'event') throw new Error('Event must reference a declared event entity');
        const previous = this.events().find(e => e.entityId === entity.id);
        if (previous?.status === 'ended' && event.status === 'ongoing' && packet.capturedAt > previous.endAt!)
          throw new Error('A later event occurrence needs a new event entity');
      }
      if (hadPriorCommit) {
        this.supersedeWhere("packet_id=? AND packet_version<? AND (transcript_keys!=? OR kind='event')", [packet.id, packet.version, '[]']);
      }
      const ids: string[] = [];
      if (!hadPriorCommit) {
        const descriptions = new Map(visualObservations(packet.vision).filter(row => row.text.trim()).map(row => [row.text, row]));
        for (const { text, confidence } of descriptions.values()) ids.push(this.insertObservation(packet, {
          entityIds: [], entityRefs: [], text, attribute: null, value: null, visual: true,
          transcriptKeys: [], confidence,
        }));
        for (const decision of decisions.values()) {
          // Facts already retain this sighting with its typed candidate links. An
          // evidence-only row must also remain searchable without inventing an entity.
          if (delta.facts.some(fact => fact.visual && fact.entityRefs.includes(decision.ref))) continue;
          const text = decision.evidence?.quote;
          if (!text) continue;
          ids.push(this.insertObservation(packet, { entityIds: decision.entityId ? [decision.entityId] : [],
            candidateEntityIds: decision.candidateEntityIds, sourceRef: decision.ref, kind: 'object-sighting',
            entityRefs: [], text, visual: true, transcriptKeys: [], attribute: null, value: null,
            confidence: decision.status === 'candidate' ? 'uncertain' : 'observed' }));
        }
      }
      // Preserve the complete finalized utterance at its first eligible capture, even
      // when the rolling model context contains only its tail or emits no useful facts.
      for (const speech of this.finalSpeechAt(packet)) {
        const note: StoredFact = { kind: 'speech', entityIds: speech.entityIds, entityRefs: [],
          text: `Conversation transcript (speaker unknown): ${speech.transcript.text}`,
          visual: false, confidence: 'reported', transcriptKeys: [transcriptKey(speech.transcript)],
          attribute: null, value: null, sourceSegments: [speech.transcript] };
        if (!this.speechAlreadyCovered(packet, note)) ids.push(this.insertObservation(packet, note));
      }
      for (const fact of facts) {
        // Audio correction is not another visual sighting of the same frozen image.
        if (hadPriorCommit && fact.visual && !fact.transcriptKeys.length) continue;
        if (fact.transcriptKeys.length && this.speechAlreadyCovered(packet, fact)) continue;
        const id = this.insertObservation(packet, fact); ids.push(id);
      }
      if (!hadPriorCommit) {
        for (const face of packet.faces.faces) {
          const entityId = this.faceEntityId(packet, face);
          ids.push(this.insertObservation(packet, { entityIds: [entityId], entityRefs: [],
            text: `${face.identityStatus === 'confirmed' ? face.name ?? 'Enrolled person' : 'Unidentified person'} is visible in this frame.`, attribute: null, value: null,
            visual: true, transcriptKeys: [], confidence: 'observed' }));
        }
      }
      this.rebuildAttributes();
      this.saveState(packet, delta);
      for (const event of delta.events) {
        this.db.prepare(`INSERT INTO event_history VALUES (?,?,?,?,?,?,0)`)
          .run(refs.get(event.entityRef)!, packet.id, packet.version, packet.capturedAt, event.status, event.summary);
        const sources = packet.audio.segments.filter(t => t.isFinal).map(transcriptKey);
        const note: StoredFact = { kind: 'event', entityIds: [refs.get(event.entityRef)!], entityRefs: [], text: `Event context: ${event.summary}`,
          attribute: null, value: null, visual: !sources.length, transcriptKeys: sources, confidence: 'uncertain' };
        // Withheld partials cannot invalidate the final evidence in the same packet.
        // Without any final source, still avoid calling partial-only prose visual.
        if ((sources.length || !packet.audio.segments.some(t => !t.isFinal)) && event.summary.trim() &&
          (!sources.length || !this.speechAlreadyCovered(packet, note)))
          ids.push(this.insertObservation(packet, note));
      }
      this.db.prepare('UPDATE packets SET committed=1 WHERE id=? AND version=?').run(packet.id, packet.version);
      this.setCaptureStatus(packet.id, 'committed');
      if (!hadPriorCommit) this.rebuildEncounters(packet.sessionId);
      return { observationIds: [...new Set(ids)] };
    })();
  }

  private writeEntity(entity: Entity): void {
    const { identityAnchors: _anchors, ...body } = entity;
    this.db.prepare('INSERT INTO entities VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET person_id=excluded.person_id,body=excluded.body')
      .run(entity.id, entity.personId, JSON.stringify(body));
  }

  private objectDecisions(packet: Packet, delta: MemoryDelta, correction: boolean,
    candidateReuse: Map<string, string[]>): Map<string, ObjectDecision> {
    const declarations = new Map(delta.entities.map(entity => [entity.ref, entity]));
    if (declarations.size !== delta.entities.length) throw new Error('Duplicate entity ref');
    const modelMatches = new Map((delta.objectMatches ?? []).map(match => [match.ref, match]));
    if (modelMatches.size !== (delta.objectMatches?.length ?? 0)) throw new Error('Duplicate object match');
    for (const ref of modelMatches.keys()) if (declarations.get(ref)?.kind !== 'object') throw new Error('Object match needs a declared object');
    if (delta.objectMatches !== undefined && delta.objectEvidence?.length) throw new Error('Cannot mix AI object matches and anchor evidence');
    const evidence = new Map<string, ObjectEvidence>();
    for (const row of delta.objectEvidence ?? []) {
      if (evidence.has(row.ref)) throw new Error('Duplicate object evidence ref');
      if (declarations.get(row.ref)?.kind !== 'object') throw new Error('Object evidence needs a declared object');
      evidence.set(row.ref, row);
    }
    const anchors = this.objectAnchors();
    const visualRefs = new Set(delta.facts.filter(fact => fact.visual).flatMap(fact => fact.entityRefs));
    const frozen = correction ? this.objectSightings(packet.id) : [];
    // Known objects observed together can compete even before the current rows
    // are written. Pure validation runs first, so declaration order has no effect.
    const contemporaries: ObjectAnchor[] = [];
    if (!correction) for (const proposal of delta.entities) {
      if (proposal.kind !== 'object' || proposal.existingId || candidateReuse.has(proposal.ref)) continue;
      const source = evidence.get(proposal.ref);
      if (!source) continue;
      const result = evaluateObjectIdentity({ packet, candidateId: null, evidence: source, anchors });
      const id = stableId('object', [packet.sessionId, packet.id, packet.version, proposal.ref]);
      result.newAnchors.forEach((anchor, index) => contemporaries.push({ ...anchor,
        id: stableId('object-anchor', [packet.id, proposal.ref, index]), entityId: id,
        packetId: packet.id, packetVersion: packet.version, ref: proposal.ref, index,
        observedAt: packet.capturedAt, active: true }));
    }
    const decisions = new Map<string, ObjectDecision>();
    for (const proposal of delta.entities) {
      if (proposal.kind !== 'object') continue;
      const reportedOnly = delta.facts.some(fact => !fact.visual && fact.transcriptKeys.length && fact.entityRefs.includes(proposal.ref)) &&
        !visualRefs.has(proposal.ref) && !evidence.has(proposal.ref) && !modelMatches.has(proposal.ref) && !candidateReuse.has(proposal.ref);
      if (reportedOnly) continue;
      if (proposal.personId !== null) throw new Error('Only person entities may have gallery IDs');
      if (proposal.existingId && this.entity(proposal.existingId)?.kind !== 'object') throw new Error('Unknown existing object entity');
      const source = evidence.get(proposal.ref);
      if (correction) {
        const previous = frozen.find(sighting => sighting.ref === proposal.ref) ??
          frozen.find(sighting => proposal.existingId && sighting.entityId === proposal.existingId);
        if (previous) {
          if (previous.entityId && proposal.existingId && previous.entityId !== proposal.existingId)
            throw new Error('Correction conflicts with frozen object identity');
          decisions.set(proposal.ref, { ...previous, ref: proposal.ref, frozen: true, newAnchors: [] });
          continue;
        }
        // Legacy committed images predate the sighting ledger. Preserve an exact
        // prior alias; do not turn a new correction proposal into a new sighting.
        const legacy = this.db.prepare(`SELECT r.entity_id FROM entity_refs r JOIN packets p ON p.id=r.packet_id AND p.version=r.packet_version
          WHERE r.packet_id=? AND r.ref=? AND p.committed=1 ORDER BY p.version LIMIT 1`).get(packet.id, proposal.ref) as Row | undefined;
        const entityId = legacy && this.entity(String(legacy.entity_id))?.kind === 'object' ? String(legacy.entity_id) : null;
        decisions.set(proposal.ref, { packetId: packet.id, packetVersion: packet.version, ref: proposal.ref,
          observedAt: packet.capturedAt, entityId, candidateEntityIds: entityId ? [] : proposal.existingId ? [proposal.existingId] : [],
          status: entityId ? 'supported' : 'candidate', reason: entityId ? 'frozen_legacy_image' : 'correction_has_no_visual_identity',
          matchedAnchorIds: [], evidence: source ?? null, newAnchors: [], frozen: true });
        continue;
      }
      const inherited = candidateReuse.get(proposal.ref);
      const candidateId = proposal.existingId;
      if (delta.objectMatches !== undefined) {
        const assessment = modelMatches.get(proposal.ref);
        if (assessment && !candidateId && !inherited) throw new Error('Object match needs an existing target');
        const unresolved = inherited !== undefined || (candidateId !== null && assessment?.assessment !== 'same_instance');
        decisions.set(proposal.ref, { packetId: packet.id, packetVersion: packet.version, ref: proposal.ref,
          observedAt: packet.capturedAt, entityId: unresolved ? null : candidateId,
          candidateEntityIds: [...new Set(inherited ?? (unresolved && candidateId ? [candidateId] : []))].sort(),
          status: unresolved ? 'candidate' : candidateId ? 'supported' : 'new',
          reason: inherited ? 'earlier_batch_candidate' : !candidateId ? 'new_object' :
            !assessment ? 'missing_model_assessment' : `model_assessed_${assessment.assessment}`,
          matchedAnchorIds: [], evidence: null, newAnchors: [], frozen: false,
          ...(assessment ? { modelAssessment: assessment } : {}),
        });
        continue;
      }
      // Even inherited unresolved rows validate their current visual quote, but
      // cannot silently convert an earlier candidate into established identity.
      const result = evaluateObjectIdentity({ packet, candidateId: candidateId ?? inherited?.[0] ?? null,
        evidence: source, anchors: [...anchors, ...contemporaries], candidateSightings: this.candidateAnchorSources(source) });
      const unresolved = inherited !== undefined || result.status === 'candidate';
      decisions.set(proposal.ref, { packetId: packet.id, packetVersion: packet.version, ref: proposal.ref,
        observedAt: packet.capturedAt, entityId: unresolved ? null : candidateId,
        candidateEntityIds: [...new Set(inherited ?? (unresolved && candidateId ? [candidateId] : []))].sort(),
        status: unresolved ? 'candidate' : result.status, reason: inherited ? 'earlier_batch_candidate' : result.reason,
        matchedAnchorIds: result.matchedAnchorIds, evidence: result.resolvedEvidence,
        newAnchors: unresolved ? [] : result.newAnchors, frozen: false });
    }
    return decisions;
  }

  private saveObjectDecisions(packet: Packet, decisions: Map<string, ObjectDecision>, refs: Map<string, string>): void {
    for (const decision of decisions.values()) {
      if (decision.frozen) continue;
      decision.entityId = decision.status === 'candidate' ? null : refs.get(decision.ref)!;
      const { newAnchors, frozen: _frozen, ...sighting } = decision;
      this.db.prepare('INSERT INTO object_sightings VALUES (?,?,?,?,?)')
        .run(packet.id, decision.ref, packet.version, decision.entityId, JSON.stringify(sighting));
      if (!decision.entityId) continue;
      for (const [index, anchor] of newAnchors.entries()) {
        const value: ObjectAnchor = { ...anchor, id: stableId('object-anchor', [packet.id, decision.ref, index]),
          entityId: decision.entityId, packetId: packet.id, packetVersion: packet.version, ref: decision.ref, index,
          observedAt: packet.capturedAt, active: true };
        this.db.prepare('INSERT INTO object_anchors VALUES (?,?,?,?,?,?)')
          .run(value.id, value.entityId, packet.id, value.ref, index, JSON.stringify(value));
      }
    }
  }

  private faceEntityId(packet: FaceCapture, face: Packet['faces']['faces'][number]): string {
    return faceEntityId(packet, face);
  }

  /** Canonical face candidates for the model context; does not create or mutate database entities. */
  faceEntities(capture: FaceCapture): Entity[] {
    const faces = new Map(capture.faces.faces.map(f => [this.faceEntityId(capture, f), f]));
    const result: Entity[] = [];
    for (const [id, face] of faces) {
      const existing = this.entity(id);
      const personId = face.identityStatus === 'confirmed' ? face.personId : null;
      if (existing && (existing.kind !== 'person' || existing.personId !== personId)) throw new Error('Gallery ID conflicts with existing entity');
      const label = personId ? face.name ?? 'Enrolled person' : 'Unknown person';
      const entity: Entity = existing ?? { id, kind: 'person', label, description: personId ? '' : 'Provisional face-track identity; not linked to an enrolled person.',
        personId, createdAt: capture.capturedAt, lastSeenAt: capture.capturedAt, attributes: {} };
      if (capture.capturedAt >= entity.lastSeenAt) { entity.lastSeenAt = capture.capturedAt; entity.label = label; }
      result.push(entity);
    }
    return result;
  }

  /** A revised utterance cannot create another person/place from the same frozen image slot. */
  private frozenDraftIdentities(packet: Packet, delta: MemoryDelta, previous: Row[]): Map<string, FrozenDraftIdentity> {
    const result = new Map<string, FrozenDraftIdentity>();
    if (!previous.length) return result;
    const first = this.getPacket(packet.id, Math.min(...previous.map(row => Number(row.version))))!;
    if (!first.vision.visualDraft && !packet.vision.visualDraft) return result;
    if (!first.vision.visualDraft || !packet.vision.visualDraft || first.sha256 !== packet.sha256 ||
      canonical(first.faces) !== canonical(packet.faces) || canonical(first.vision) !== canonical(packet.vision))
      throw new Error('Correction changes frozen visual draft evidence');
    for (const proposal of delta.entities) {
      if (!/^d(?:0|[1-9][0-9]*)$/.test(proposal.ref)) continue;
      const declaration = first.vision.visualDraft.entities[Number(proposal.ref.slice(1))];
      if (!declaration || declaration.kind !== proposal.kind) throw new Error('Correction changes frozen draft slot');
      // Physical objects already have a frozen sighting ledger; face slots use the
      // unchanged exact-frame face gate. This rule adds no new path around either.
      if (declaration.kind === 'object' || declaration.faceIndex !== null) continue;
      const reference = this.db.prepare('SELECT entity_id FROM entity_refs WHERE packet_id=? AND packet_version=? AND ref=?')
        .get(first.id, first.version, proposal.ref) as Row | undefined;
      const entity = reference ? this.entity(String(reference.entity_id)) : null;
      if (!entity || entity.kind !== declaration.kind) throw new Error('Correction has no frozen draft identity');
      if ((proposal.existingId !== null && proposal.existingId !== entity.id) || proposal.personId !== entity.personId)
        throw new Error('Correction conflicts with frozen draft identity');
      const originalLocal = entity.id === stableId(declaration.kind, [first.sessionId, first.id, first.version, proposal.ref]);
      const metadata = this.db.prepare(`SELECT label,description FROM entity_metadata_history
        WHERE entity_id=? AND packet_id=? AND packet_version=? ORDER BY rowid DESC LIMIT 1`)
        .get(entity.id, first.id, first.version) as Row | undefined;
      // New d# metadata is copied by the decoder from this exact immutable source.
      // Do not use changed correction prose to restore metadata invalidated below.
      if (originalLocal && (!metadata || metadata.label !== declaration.label ||
        metadata.description !== [first.vision.scene, ...first.vision.observations][declaration.descriptionSourceIndex]))
        throw new Error('Frozen draft metadata does not match its visual source');
      result.set(proposal.ref, { entityId: entity.id,
        frameLocalPerson: declaration.kind === 'person' && entity.personId === null && originalLocal,
        // A reused old place may have no metadata row here because its earlier
        // source already supplied the same metadata. Preserve that older source.
        metadata: metadata ? { label: String(metadata.label), description: String(metadata.description) } : null });
    }
    return result;
  }

  private resolveEntities(packet: Packet, delta: MemoryDelta, decisions: Map<string, ObjectDecision>,
    personCandidates: Map<string, string>, frozenDraft: Map<string, FrozenDraftIdentity>): Map<string, string> {
    const refs = new Map<string, string>();
    const visiblePeople = new Set(packet.faces.status === 'ready'
      ? packet.faces.faces.map(face => this.faceEntityId(packet, face)) : []);
    const visualRefs = new Set(delta.facts.filter(fact => fact.visual).flatMap(fact => fact.entityRefs));
    const reportedRefs = new Set(delta.facts.filter(fact => !fact.visual && fact.transcriptKeys.length).flatMap(fact => fact.entityRefs));
    for (const entity of this.faceEntities(packet)) this.writeEntity(entity);
    for (const proposal of delta.entities) {
      if (refs.has(proposal.ref)) throw new Error('Duplicate entity ref');
      const decision = decisions.get(proposal.ref);
      if (decision?.status === 'candidate') {
        // Keep explicit existing IDs usable for separately sourced final speech,
        // but never persist a canonical alias/metadata from this visual guess.
        if (proposal.existingId) refs.set(proposal.ref, proposal.existingId);
        continue;
      }
      if (proposal.kind !== 'person' && proposal.personId !== null) throw new Error('Only person entities may have gallery IDs');
      let existing = decision?.entityId ? this.entity(decision.entityId) : proposal.existingId ? this.entity(proposal.existingId) : null;
      const frozen = frozenDraft.get(proposal.ref);
      if (frozen) {
        if (existing && existing.id !== frozen.entityId) throw new Error('Correction conflicts with frozen draft identity');
        existing = this.entity(frozen.entityId);
      }
      if (proposal.existingId && !existing) throw new Error(`Unknown existing entity ${proposal.existingId}`);
      if (proposal.personId !== null) {
        const known = this.entity(proposal.personId);
        if (!known || known.personId !== proposal.personId) throw new Error('Unverified gallery identity');
        if (existing && existing.id !== known.id) throw new Error('Conflicting person identity');
        existing = known;
      }
      const priorRef = this.db.prepare('SELECT entity_id FROM entity_refs WHERE packet_id=? AND packet_version=? AND ref=?')
        .get(packet.id, packet.version, proposal.ref) as Row | undefined;
      if (!existing && priorRef) existing = this.entity(String(priorRef.entity_id));
      if (existing && existing.kind !== proposal.kind) throw new Error('Cannot change entity kind');
      const id = existing?.id ?? stableId(proposal.kind, [packet.sessionId, packet.id, packet.version, proposal.ref]);
      if (priorRef && priorRef.entity_id !== id) throw new Error('Cannot rebind a packet entity ref');
      if (existing?.kind === 'person' && !visiblePeople.has(id) && !frozen?.frameLocalPerson &&
        (visualRefs.has(proposal.ref) || !reportedRefs.has(proposal.ref))) {
        // Appearance or a prior model alias cannot prove who is in this image.
        // Keep the alias available to separately sourced reported speech and
        // later batch rows; every visual row must pass this frame's face gate.
        personCandidates.set(proposal.ref, id); refs.set(proposal.ref, id);
        this.db.prepare('INSERT OR IGNORE INTO entity_refs VALUES (?,?,?,?)').run(packet.id, packet.version, proposal.ref, id);
        continue;
      }
      const entity: Entity = existing ?? { id, kind: proposal.kind, label: proposal.label, description: proposal.description,
        personId: null, createdAt: packet.capturedAt, lastSeenAt: 0, attributes: {} };
      this.writeEntity(entity); refs.set(proposal.ref, id);
      const priorMetadata = this.db.prepare(`SELECT label,description FROM entity_metadata_history WHERE entity_id=? AND superseded=0
        ORDER BY observed_at DESC,packet_version DESC,rowid DESC LIMIT 1`).get(id) as Row | undefined;
      const metadata = frozen ? frozen.metadata : { label: proposal.label, description: proposal.description };
      // Repeating current context is not independent evidence for its claims. Keep
      // the original provenance when an entity's interpreted metadata is unchanged.
      if (metadata && (!priorMetadata || priorMetadata.description !== metadata.description ||
        (!entity.personId && priorMetadata.label !== metadata.label)))
        this.db.prepare(`INSERT INTO entity_metadata_history(entity_id,packet_id,packet_version,observed_at,label,description)
          VALUES (?,?,?,?,?,?)`).run(id, packet.id, packet.version, packet.capturedAt, metadata.label, metadata.description);
      this.rebuildEntityMetadata(new Set([id]));
      this.db.prepare('INSERT OR IGNORE INTO entity_refs VALUES (?,?,?,?)').run(packet.id, packet.version, proposal.ref, id);
    }
    return refs;
  }

  private validateFinalSources(packet: Packet): void {
    const latest = new Map(this.transcripts(packet.sessionId).map(t => [canonical([t.streamId, t.segmentId]), t]));
    for (const selected of packet.audio.segments.filter(t => t.isFinal)) {
      const live = latest.get(canonical([selected.streamId, selected.segmentId]));
      if (!live || live.revision !== selected.revision || !live.isFinal || !this.selectedTranscript(selected, live))
        throw new Error('Packet references stale or unpersisted transcript evidence');
    }
  }

  private validateFacts(packet: Packet, delta: MemoryDelta, refs: Map<string, string>, decisions: Map<string, ObjectDecision>,
    personCandidates: Map<string, string>): StoredFact[] {
    const finalSegments = new Map(packet.audio.segments.filter(t => t.isFinal).map(t => [transcriptKey(t), t]));
    const latest = new Map(this.transcripts(packet.sessionId).map(t => [`${t.streamId}/${t.segmentId}`, t]));
    return delta.facts.map(fact => {
      if (Boolean(fact.attribute) !== (fact.value !== null)) throw new Error('Attribute and value must be supplied together');
      if (!fact.visual && !fact.transcriptKeys.length) throw new Error('Fact needs visual or finalized speech evidence');
      const candidates = new Set<string>();
      let candidate = false;
      const entityIds = [...new Set(fact.entityRefs.flatMap(ref => {
        const personCandidate = personCandidates.get(ref);
        if (personCandidate && fact.visual) {
          candidate = true; candidates.add(personCandidate); return [];
        }
        const decision = decisions.get(ref);
        if (decision?.status === 'candidate' && (fact.visual || !refs.has(ref))) {
          candidate = true; decision.candidateEntityIds.forEach(id => candidates.add(id)); return [];
        }
        const id = refs.get(ref); if (!id) throw new Error(`Unknown fact entity ref ${ref}`); return [id];
      }))].sort();
      for (const key of fact.transcriptKeys) {
        const segment = finalSegments.get(key);
        if (!segment) throw new Error('Facts may reference only final transcripts in this packet');
        const live = latest.get(`${segment.streamId}/${segment.segmentId}`);
        if (!live || live.revision !== segment.revision || !live.isFinal || !this.selectedTranscript(segment, live))
          throw new Error('Fact references stale or unpersisted transcript evidence');
      }
      // A relation can link several entities without declaring which one owns an
      // attribute. Preserve its text/links, but never project it onto every target.
      const oneTarget = fact.entityRefs.length === 1;
      return { ...fact, attribute: oneTarget ? fact.attribute : null, value: oneTarget ? fact.value : null,
        entityIds, candidateEntityIds: [...candidates].sort(),
        confidence: candidate ? 'uncertain' : !fact.visual && fact.confidence === 'observed' ? 'reported' : fact.confidence,
        transcriptKeys: [...new Set(fact.transcriptKeys)].sort() };
    });
  }

  private selectedTranscript(selected: Transcript, full: Transcript): boolean {
    if (selected.text === full.text && selected.startAt === full.startAt && selected.endAt === full.endAt) return true;
    const words = full.words.length ? full.words : full.text.trim().split(/\s+/).filter(Boolean).map((text, i, all) => ({
      text, startAt: full.startAt + (full.endAt - full.startAt) * i / all.length,
      endAt: full.startAt + (full.endAt - full.startAt) * (i + 1) / all.length,
    }));
    if (!selected.words.length || selected.text !== selected.words.map(w => w.text).join(' ') ||
      selected.startAt !== selected.words[0].startAt || selected.endAt !== Math.max(...selected.words.map(w => w.endAt))) return false;
    const target = canonical(selected.words);
    return words.some((_, index) => canonical(words.slice(index, index + selected.words.length)) === target);
  }

  private speechAlreadyCovered(packet: Packet, fact: StoredFact): boolean {
    const rows = this.db.prepare(`SELECT c.transcript_key,c.start_at,c.end_at FROM observations o
      JOIN observation_source_coverage c ON c.observation_id=o.id WHERE o.superseded=0 AND o.packet_id!=?
      AND o.session_id=? AND o.entity_ids=? AND o.candidate_entity_ids=? AND o.attribute IS ? AND o.kind=?`)
      .all(packet.id, packet.sessionId, JSON.stringify(fact.entityIds), JSON.stringify(fact.candidateEntityIds ?? []),
        fact.attribute, fact.kind ?? 'fact') as Row[];
    const selected = fact.sourceSegments ?? packet.audio.segments;
    return fact.transcriptKeys.every(key => {
      const segment = selected.find(t => transcriptKey(t) === key);
      return segment && rows.some(row => row.transcript_key === key && Number(row.start_at) <= segment.startAt && Number(row.end_at) >= segment.endAt);
    });
  }

  private finalSpeechAt(packet: Packet): { transcript: Transcript; entityIds: string[] }[] {
    const captures = this.capturesForSession(packet.sessionId);
    return this.transcripts(packet.sessionId).filter(t => t.isFinal && t.text.trim() && t.endAt <= packet.capturedAt &&
      captures.find(c => c.capturedAt >= t.endAt)?.id === packet.id).map(transcript => {
      const preceding = captures.filter(c => c.capturedAt <= transcript.startAt && c.capturedAt >= transcript.startAt - 5000).at(-1);
      const during = captures.filter(c => c.capturedAt > transcript.startAt && c.capturedAt <= transcript.endAt);
      const evidence = [...(preceding ? [preceding] : []), ...during];
      const sets = evidence.map(c => c.faces.faces.filter(f => f.identityStatus === 'confirmed').map(f => f.personId!).sort());
      const unambiguous = evidence.length && evidence.every(c => c.faces.status === 'ready' && c.faces.faces.every(f => f.identityStatus === 'confirmed')) &&
        sets.every(ids => ids.length === 1 && canonical(ids) === canonical(sets[0]));
      // Association is conversation context, never a claim that the visible person spoke.
      const entityIds = unambiguous ? sets[0].filter(id => this.entity(id)?.personId === id) : [];
      return { transcript, entityIds };
    });
  }

  private insertObservation(packet: Packet, fact: StoredFact): string {
    const segments = (fact.sourceSegments ?? packet.audio.segments).filter(t => fact.transcriptKeys.includes(transcriptKey(t)));
    const observedAt = fact.visual || !segments.length ? packet.capturedAt : Math.min(...segments.map(t => t.startAt));
    const endAt = fact.visual || !segments.length ? packet.capturedAt : Math.max(...segments.map(t => t.endAt));
    const id = stableId('observation', [packet.id, fact.transcriptKeys.length || fact.kind === 'event' ? packet.version : 0,
      fact.entityIds, fact.text, fact.attribute, fact.value, fact.visual, fact.transcriptKeys, fact.kind ?? 'fact',
      ...(fact.candidateEntityIds?.length || fact.sourceRef ? [fact.candidateEntityIds ?? [], fact.sourceRef ?? null] : [])]);
    const result = this.db.prepare(`INSERT OR IGNORE INTO observations(id,packet_id,packet_version,session_id,observed_at,end_at,
      entity_ids,text,confidence,visual,transcript_keys,attribute,value,kind,candidate_entity_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, packet.id,
        packet.version, packet.sessionId, observedAt, endAt, JSON.stringify(fact.entityIds), fact.text, fact.confidence,
        Number(fact.visual), JSON.stringify(fact.transcriptKeys), fact.attribute, fact.value, fact.kind ?? 'fact',
        JSON.stringify(fact.candidateEntityIds ?? []));
    if (!result.changes) {
      // A correction may restore the same fact after its dependencies were superseded.
      this.db.prepare('UPDATE observations SET superseded=0 WHERE id=?').run(id);
    }
    for (const key of fact.transcriptKeys) this.db.prepare('INSERT OR IGNORE INTO observation_sources VALUES (?,?,?)').run(id, packet.sessionId, key);
    for (const segment of segments) this.db.prepare('INSERT OR REPLACE INTO observation_source_coverage VALUES (?,?,?,?)')
      .run(id, transcriptKey(segment), segment.startAt, segment.endAt);
    this.db.prepare('INSERT OR IGNORE INTO embedding_outbox VALUES (?)').run(id);
    if (fact.visual) for (const entityId of fact.entityIds) {
      const entity = this.entity(entityId)!;
      entity.lastSeenAt = Math.max(entity.lastSeenAt, packet.capturedAt); this.writeEntity(entity);
    }
    return id;
  }

  private supersedeWhere(condition: string, args: (string | number)[]): void {
    const rows = this.db.prepare(`SELECT rowid,id FROM observations WHERE superseded=0 AND ${condition}`).all(...args) as Row[];
    for (const row of rows) {
      this.db.prepare('UPDATE observations SET superseded=1 WHERE id=?').run(row.id);
      this.db.prepare('DELETE FROM embedding_outbox WHERE observation_id=?').run(row.id);
      this.db.prepare('DELETE FROM observation_vectors WHERE rowid=?').run(BigInt(Number(row.rowid)));
    }
  }

  private invalidateProjections(packets: { id: string; version: number }[]): void {
    if (!packets.length) return;
    const entities = new Set<string>();
    const current = this.currentState();
    const source = this.db.prepare('SELECT packet_id,packet_version FROM state_history WHERE version=?')
      .get(current.version) as Row | undefined;
    let currentInvalid = false;
    for (const packet of packets) {
      // Aliases also cover legacy entity descriptors written before metadata history
      // existed. They cannot safely survive invalidation without a valid source.
      for (const row of this.db.prepare(`SELECT entity_id FROM entity_refs WHERE packet_id=? AND packet_version=?
        UNION SELECT entity_id FROM entity_metadata_history WHERE packet_id=? AND packet_version=?`)
        .all(packet.id, packet.version, packet.id, packet.version) as Row[]) entities.add(String(row.entity_id));
      this.db.prepare('UPDATE entity_metadata_history SET superseded=1 WHERE packet_id=? AND packet_version=?')
        .run(packet.id, packet.version);
      this.db.prepare('UPDATE state_history SET superseded=1 WHERE packet_id=? AND packet_version=?')
        .run(packet.id, packet.version);
      this.db.prepare('UPDATE event_history SET superseded=1 WHERE packet_id=? AND packet_version=?')
        .run(packet.id, packet.version);
      currentInvalid ||= source?.packet_id === packet.id && Number(source?.packet_version) === packet.version;
    }
    this.rebuildEntityMetadata(entities);
    if (currentInvalid) {
      // Retain the source-time cursor, not a known-invalid interpretation. An older
      // repaired photo must not become the apparent current physical scene.
      const pending: CurrentState = { ...current, location: null, activity: null, summary: '',
        uncertainties: ['Interpretation pending: a source transcript was corrected.'] };
      this.db.prepare('UPDATE current_state SET body=? WHERE singleton=1').run(JSON.stringify(pending));
    }
  }

  private rebuildEntityMetadata(ids: Set<string>): void {
    for (const id of ids) {
      const entity = this.entity(id);
      if (!entity) continue;
      const latest = this.db.prepare(`SELECT observed_at,label,description FROM entity_metadata_history
        WHERE entity_id=? AND superseded=0 ORDER BY observed_at DESC,packet_version DESC,rowid DESC LIMIT 1`).get(id) as Row | undefined;
      if (latest) {
        if (!entity.personId) entity.label = String(latest.label);
        entity.description = String(latest.description);
        this.db.prepare(`INSERT INTO entity_metadata_time VALUES (?,?)
          ON CONFLICT(entity_id) DO UPDATE SET observed_at=excluded.observed_at`).run(id, latest.observed_at);
      } else {
        // Gallery names come from verified face evidence and are not model prose.
        if (!entity.personId) entity.label = entity.kind === 'person' ? 'Unknown person' : `Unspecified ${entity.kind}`;
        entity.description = '';
        this.db.prepare('DELETE FROM entity_metadata_time WHERE entity_id=?').run(id);
      }
      this.writeEntity(entity);
    }
  }

  private rebuildAttributes(): void {
    // Scan supported attributes once, rather than scanning all observations for
    // every entity on every frame. Rebuild still handles historical corrections,
    // ties and retractions, including clearing the final supported attribute.
    const attributes = new Map<string, Entity['attributes']>();
    const rows = this.db.prepare(`SELECT id,entity_ids,attribute,value,observed_at FROM observations
      WHERE superseded=0 AND attribute IS NOT NULL AND confidence!='uncertain' ORDER BY observed_at,rowid`).all() as Row[];
    for (const row of rows) for (const id of JSON.parse(String(row.entity_ids)) as string[]) {
      const values = attributes.get(id) ?? {};
      values[String(row.attribute)] = {
        value: String(row.value), observedAt: Number(row.observed_at), observationId: String(row.id),
      };
      attributes.set(id, values);
    }
    for (const row of this.db.prepare('SELECT body FROM entities').all() as Row[]) {
      const entity = parsed<Entity>(row)!;
      if (this.isPersonRemoved(entity)) continue;
      const next = attributes.get(entity.id) ?? {};
      if (canonical(entity.attributes) === canonical(next)) continue;
      entity.attributes = next;
      this.writeEntity(entity);
    }
  }

  private saveState(packet: Packet, delta: MemoryDelta): void {
    const current = this.currentState();
    // The required state object is a complete source-time interpretation. Null
    // explicitly clears unsupported context; it must not resurrect an ended activity.
    const state: CurrentState = { ...delta.state, version: 0, observedAt: packet.capturedAt, packetId: packet.id };
    const row = this.db.prepare('INSERT INTO state_history(packet_id,packet_version,observed_at,body) VALUES (?,?,?,?)')
      .run(packet.id, packet.version, packet.capturedAt, '{}');
    state.version = Number(row.lastInsertRowid);
    this.db.prepare('UPDATE state_history SET body=? WHERE version=?').run(JSON.stringify(state), state.version);
    if (packet.capturedAt >= current.observedAt) this.db.prepare('INSERT INTO current_state VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body')
      .run(JSON.stringify(state));
  }

  private rebuildEncounters(sessionId: string): void {
    const captures = (this.db.prepare(`SELECT c.body FROM captures c WHERE c.session_id=? AND EXISTS(
      SELECT 1 FROM packets p WHERE p.id=c.id AND p.committed=1)
      ORDER BY c.captured_at,c.sequence,c.id`).all(sessionId) as Row[]).map(row => parsed<CaptureRecord>(row)!);
    this.db.prepare('DELETE FROM encounters WHERE session_id=?').run(sessionId);
    const open = new Map<string, string>();
    for (const capture of captures) {
      if (capture.faces.status !== 'ready') continue;
      const visible = new Set(capture.faces.faces.map(face => this.faceEntityId(capture, face)));
      const ambiguous = capture.faces.faces.some(face => face.identityStatus === 'unknown');
      for (const [entityId, id] of open) if (!visible.has(entityId) && !ambiguous) {
        this.db.prepare('UPDATE encounters SET end_at=? WHERE id=?').run(capture.capturedAt, id); open.delete(entityId);
      }
      for (const entityId of visible) {
        const id = open.get(entityId);
        if (id) this.db.prepare('UPDATE encounters SET last_seen_at=?,packet_id=? WHERE id=?')
          .run(capture.capturedAt, capture.id, id);
        else {
          const encounterId = stableId('encounter', [sessionId, entityId, capture.id]);
          this.db.prepare('INSERT INTO encounters VALUES (?,?,?,?,NULL,?,?)').run(encounterId, sessionId, entityId,
            capture.capturedAt, capture.capturedAt, capture.id);
          open.set(entityId, encounterId);
        }
      }
    }
  }

  history(): StateTransition[] {
    return (this.db.prepare('SELECT * FROM state_history ORDER BY observed_at,version').all() as Row[])
      .map(row => ({ ...parsed<CurrentState>(row)!, packetVersion: Number(row.packet_version), superseded: Boolean(row.superseded) }));
  }

  events(): EventRecord[] {
    const grouped = new Map<string, EventRecord>();
    const rows = this.db.prepare('SELECT * FROM event_history WHERE superseded=0 ORDER BY observed_at,packet_version').all() as Row[];
    for (const row of rows) {
      const id = String(row.entity_id); const at = Number(row.observed_at); const status = row.status as EventRecord['status'];
      const previous = grouped.get(id);
      const endAt = previous?.endAt ?? (status === 'ended' ? at : null);
      const conflicts = [...(previous?.conflicts ?? [])];
      const conflict = endAt !== null && status === 'ongoing' && at > endAt;
      if (conflict) conflicts.push({ packetId: String(row.packet_id), observedAt: at, summary: String(row.summary) });
      grouped.set(id, { entityId: id, startAt: previous?.startAt ?? at, endAt,
        lastObservedAt: at, status: endAt === null ? 'ongoing' : 'ended',
        summary: conflict ? previous!.summary : String(row.summary), packetId: conflict ? previous!.packetId : String(row.packet_id), conflicts });
    }
    return [...grouped.values()];
  }

  encounters(): EncounterRecord[] {
    return (this.db.prepare('SELECT * FROM encounters ORDER BY start_at,id').all() as Row[]).map(row => ({
      id: String(row.id), personId: this.entity(String(row.entity_id))?.personId ?? null, entityId: String(row.entity_id), sessionId: String(row.session_id),
      startAt: Number(row.start_at), endAt: row.end_at === null ? null : Number(row.end_at),
      lastSeenAt: Number(row.last_seen_at), packetId: String(row.packet_id),
    })).filter(row => { const e = this.entity(row.entityId); return !e || !this.isPersonRemoved(e); });
  }

  pendingEmbeddings(limit = 32): Observation[] {
    return (this.db.prepare(`SELECT o.* FROM observations o JOIN embedding_outbox q ON q.observation_id=o.id
      WHERE o.superseded=0 ORDER BY o.rowid LIMIT ?`).all(boundedLimit(limit)) as Row[]).map(row => this.observation(row));
  }

  private vector(value: number[]): Float32Array {
    if (value.length !== this.dimensions || value.some(x => !Number.isFinite(x)) || !value.some(x => x !== 0))
      throw new Error('Invalid embedding vector');
    return new Float32Array(value);
  }

  putEmbedding(observationId: string, vector: number[]): void {
    const floats = this.vector(vector);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT rowid,superseded FROM observations WHERE id=?').get(observationId) as Row | undefined;
      if (!row) throw new Error('Unknown observation');
      if (!row.superseded) {
        this.db.prepare('DELETE FROM observation_vectors WHERE rowid=?').run(BigInt(Number(row.rowid)));
        this.db.prepare('INSERT INTO observation_vectors(rowid,embedding) VALUES (?,?)').run(BigInt(Number(row.rowid)), floats);
      }
      this.db.prepare('DELETE FROM embedding_outbox WHERE observation_id=?').run(observationId);
    })();
  }

  search(vector: number[], filter: SearchFilter = {}): SearchHit[] {
    const floats = this.vector(vector); const { sql, args } = this.filterSql(filter);
    // Exact cosine scoring after relational filters preserves entity/time semantics for the local prototype.
    return (this.db.prepare(`SELECT o.*,vec_distance_cosine(v.embedding,?) AS distance FROM observations o
      JOIN observation_vectors v ON v.rowid=o.rowid WHERE ${sql} ORDER BY distance,o.observed_at DESC LIMIT ?`)
      .all(floats, ...args, boundedLimit(filter.limit, 10)) as Row[]).map(row => ({ ...this.observation(row), distance: Number(row.distance) }));
  }

  stats(): Record<string, number> {
    const count = (table: string, where = '') => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as Row).n);
    return { sessions: count('sessions'), captures: count('captures'), packets: count('packets'), entities: count('entities'),
      observations: count('observations', 'WHERE superseded=0'), superseded: count('observations', 'WHERE superseded=1'),
      indexed: count('observation_vectors'), pendingEmbeddings: count('embedding_outbox'),
      events: this.events().length, encounters: count('encounters') };
  }
}
