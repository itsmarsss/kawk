import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Express } from 'express';
import { z } from 'zod';
import type { Store } from './store.js';
import type { CaptureRecord, Transcript } from './contracts.js';
import { FaceEvidenceSchema } from './contracts.js';

const eventId = (kind: string, id: string) => `scene-${kind}-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
type Row = { seq: number; kind: string; source_id: string; revision: number; body: string };
type Camera = { id: string; session_id: string; state: string; reason: string; created_at: number; expires_at: number; capture_id: string | null; error: string | null };
export interface BridgeOptions { url: string; tokenFile: string; fetch?: typeof fetch; now?: () => number; autoStart?: boolean }

/** A transactional SQLite outbox shares the evidence commit, so an agent outage loses no accepted input. */
export function initializeAgentJournal(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,source_id,revision));
    CREATE INDEX IF NOT EXISTS agent_outbox_pending ON agent_outbox(delivered,seq);
    CREATE TABLE IF NOT EXISTS agent_camera(id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      state TEXT NOT NULL, reason TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL,
      capture_id TEXT, error TEXT);
    CREATE TRIGGER IF NOT EXISTS agent_transcript AFTER INSERT ON transcripts BEGIN
      INSERT OR IGNORE INTO agent_outbox(kind,source_id,revision,body)
      VALUES('transcript',NEW.session_id||'/'||NEW.stream_id||'/'||NEW.segment_id,NEW.revision,NEW.body);
    END;
    CREATE TRIGGER IF NOT EXISTS agent_faces AFTER INSERT ON captures BEGIN
      INSERT OR IGNORE INTO agent_outbox(kind,source_id,revision,body) VALUES('faces',NEW.id,0,NEW.body);
    END;
    CREATE TRIGGER IF NOT EXISTS agent_vision AFTER UPDATE ON captures
      WHEN json_extract(NEW.body,'$.vision') IS NOT NULL
        AND json_extract(NEW.body,'$.vision') IS NOT json_extract(OLD.body,'$.vision') BEGIN
      INSERT INTO agent_outbox(kind,source_id,revision,body)
      SELECT 'vision',NEW.id,COALESCE(MAX(revision)+1,0),NEW.body FROM agent_outbox
      WHERE kind='vision' AND source_id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS agent_note_invalidated AFTER UPDATE OF superseded ON observations
      WHEN NEW.superseded=1 AND OLD.superseded=0 BEGIN
      INSERT OR IGNORE INTO agent_outbox(kind,source_id,revision,body)
      VALUES('invalidate',OLD.id,0,'{}');
    END;
  `);
}

export function wireEvent(row: Row) {
  const value = JSON.parse(row.body);
  if (row.kind === 'event') return value;
  if (row.kind === 'invalidate') return null;
  if (row.kind === 'transcript') {
    const t = value as Transcript;
    if (!t.text.trim()) return null;
    return { id: eventId('speech', row.source_id), revision: t.revision,
      deviceId: `memory-${t.sessionId}`, streamId: eventId('stream', t.streamId), kind: 'transcript',
      final: t.isFinal, sourceStart: t.startAt, sourceEnd: t.endAt, text: t.text,
      confidence: 0.8, speakerId: null, personIds: [], provenance: 'scene-memory:speech',
      timing: { method: 'clock-mapped', clockSessionId: eventId('clock', t.streamId), uncertaintyMs: t.timing === 'exact' ? 150 : 1500 },
      words: t.words.filter(w => w.text && w.text.length <= 300 && w.startAt >= t.startAt && w.endAt <= t.endAt).slice(0, 2000)
        .map(w => ({ text: w.text, sourceStart: w.startAt, sourceEnd: w.endAt })) };
  }
  const c = value as CaptureRecord;
  const people = c.faces.faces.filter(f => f.identityStatus === 'confirmed' && f.personId);
  const content = row.kind === 'faces'
    ? { type: 'face-observation', captureId: c.id, visiblePeople: people.map(f => ({ personId: f.personId, name: f.name })), unknownFaces: c.faces.faces.filter(f => !f.personId).length, faceStatus: c.faces.status }
    : { type: 'camera-interpretation', captureId: c.id, frameUrl: `/api/frames/${c.id}`, vision: c.vision,
      visiblePeople: people.map(f => ({ personId: f.personId, name: f.name })), requestId: c.requestId ?? null };
  return { id: eventId(row.kind, c.id), revision: row.revision, deviceId: `memory-${c.sessionId}`,
    streamId: eventId('session', c.sessionId), kind: 'observation', final: true,
    sourceStart: c.capturedAt, sourceEnd: c.capturedAt, text: JSON.stringify(content).slice(0, 29000),
    confidence: row.kind === 'faces' ? 0.85 : 0.7, speakerId: null,
    personIds: people.map(f => f.personId).slice(0, 16), provenance: `scene-memory:${row.kind}`,
    timing: { method: 'capture', clockSessionId: eventId('session', c.sessionId), uncertaintyMs: 250 } };
}

export class AgentBridge {
  private token: string;
  private timer?: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  private cameras = new Map<string, number>();
  private lastError: string | null = null;
  private nextAttempt = 0;
  private now: () => number;
  private fetch: typeof fetch;
  constructor(readonly store: Store, readonly options: BridgeOptions) {
    initializeAgentJournal(store);
    this.token = readFileSync(options.tokenFile, 'utf8').trim();
    if (this.token.length < 32) throw new Error('Agent bridge token is missing');
    this.now = options.now ?? Date.now; this.fetch = options.fetch ?? fetch;
    if (options.autoStart !== false) this.timer = setInterval(() => { void this.flush(); }, 100);
  }
  async stop() { clearInterval(this.timer); await this.sending; }
  status() {
    return { pending: (this.store.db.prepare('SELECT count(*) AS n FROM agent_outbox WHERE delivered=0').get() as { n: number }).n, lastError: this.lastError };
  }
  async request(path: string, init: RequestInit = {}) {
    return this.fetch(new URL(path, this.options.url), { ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${this.token}` },
      signal: init.signal ?? AbortSignal.timeout(5000), redirect: 'error' });
  }
  flush() {
    if (this.sending) return this.sending;
    this.sending = this.deliver().finally(() => { this.sending = undefined; });
    return this.sending;
  }
  private async deliver() {
    if (this.now() < this.nextAttempt) return;
    let rows = this.store.db.prepare('SELECT * FROM agent_outbox WHERE delivered=0 ORDER BY seq LIMIT 32').all() as Row[];
    if (!rows.length) return;
    try {
      let bytes = 0;
      rows = rows.filter(row => { bytes += Buffer.byteLength(JSON.stringify(wireEvent(row))); return bytes < 800000; });
      const events = rows.map(wireEvent).filter(Boolean);
      const invalidatedIds = rows.filter(r => r.kind === 'invalidate').map(r => eventId('note', r.source_id));
      const response = await this.request('/v1/integration/events', { method: 'POST', body: JSON.stringify({ events, invalidatedIds }) });
      if (!response.ok) throw new Error(`Agent bridge HTTP ${response.status}`);
      this.store.db.transaction(() => {
        const mark = this.store.db.prepare('UPDATE agent_outbox SET delivered=1 WHERE seq=?');
        for (const row of rows) mark.run(row.seq);
      })();
      this.lastError = null;
    } catch (error) { this.lastError = error instanceof Error ? error.message : 'Agent unavailable'; this.nextAttempt = this.now() + 1000; }
  }
  cameraRequest(id: string, reason: string, sessionId?: string) {
    const existing = this.store.db.prepare('SELECT * FROM agent_camera WHERE id=?').get(id) as Camera | undefined;
    if (existing) return this.cameraResult(existing.id);
    const active = [...this.cameras].filter(([, at]) => this.now() - at < 5000).sort((a, b) => b[1] - a[1]);
    const session = sessionId ?? active[0]?.[0];
    if (!session || !active.some(([s]) => s === session)) throw new Error('No active camera; press Start on the memory page');
    const pending = this.store.db.prepare("SELECT count(*) AS n FROM agent_camera WHERE state IN ('pending','claimed','captured') AND expires_at>?").get(this.now()) as { n: number };
    if (pending.n >= 4) throw new Error('Camera request queue is full');
    this.store.db.prepare("INSERT INTO agent_camera VALUES (?,?,'pending',?,?,?,NULL,NULL)")
      .run(id, session, reason, this.now(), this.now() + 45000);
    return this.cameraResult(id);
  }
  cameraResult(id: string) {
    const row = this.store.db.prepare('SELECT * FROM agent_camera WHERE id=?').get(id) as Camera | undefined;
    if (!row) throw new Error('Unknown camera request');
    const capture = row.capture_id ? this.store.getCapture(row.capture_id) : null;
    const state = capture?.vision ? 'completed' : row.state === 'failed' ? 'failed' : row.expires_at <= this.now() ? 'expired' : row.state;
    return { id, state, captureId: row.capture_id, reason: row.reason, error: row.error,
      createdAt: row.created_at, expiresAt: row.expires_at,
      ...(capture?.vision ? { event: wireEvent({ seq: 0, kind: 'vision', source_id: capture.id,
        revision: ((this.store.db.prepare("SELECT MAX(revision) AS n FROM agent_outbox WHERE kind='vision' AND source_id=?").get(capture.id) as { n: number }).n ?? 0), body: JSON.stringify(capture) }) } : {}) };
  }
  captureAccepted(capture: CaptureRecord) {
    if (!capture.requestId) return;
    const row = this.store.db.prepare('SELECT * FROM agent_camera WHERE id=?').get(capture.requestId) as Camera | undefined;
    if (row?.session_id === capture.sessionId && row.capture_id === capture.id) return;
    if (!row || row.session_id !== capture.sessionId || row.expires_at <= this.now() || !['claimed', 'captured'].includes(row.state)) throw new Error('Stale or unclaimed camera request');
    if (row.capture_id && row.capture_id !== capture.id) throw new Error('Camera request already has a capture');
    this.store.db.prepare("UPDATE agent_camera SET state='captured',capture_id=? WHERE id=?").run(capture.id, row.id);
  }
  validateCapture(input: { requestId?: string; sessionId: string; id: string }) {
    if (!input.requestId) return;
    const row = this.store.db.prepare('SELECT * FROM agent_camera WHERE id=?').get(input.requestId) as Camera | undefined;
    if (!row || row.session_id !== input.sessionId || !['claimed', 'captured'].includes(row.state) ||
      (!row.capture_id && row.expires_at <= this.now()) || (row.capture_id && row.capture_id !== input.id)) throw new Error('Stale or conflicting camera request');
  }
  routes(app: Express) {
    app.post('/api/agent/faces', (req, res) => {
      const body = z.object({ sessionId: z.string(), evidence: FaceEvidenceSchema }).parse(req.body);
      if (!this.store.listSessions().some(s => s.id === body.sessionId)) throw new Error('Unknown session');
      if (Math.abs(this.now() - body.evidence.capturedAt) > 5000) throw new Error('Stale live faces');
      const faces = body.evidence;
      if (faces.faces.some(f => (f.identityStatus === 'confirmed') !== Boolean(f.personId))) throw new Error('Unconfirmed face identity');
      const c = { id: `live:${faces.frameId}`, sessionId: body.sessionId, capturedAt: faces.capturedAt, faces };
      this.store.db.prepare("INSERT OR IGNORE INTO agent_outbox(kind,source_id,revision,body) VALUES('faces',?,0,?)").run(c.id, JSON.stringify(c));
      void this.flush(); res.json({ accepted: true });
    });
    app.get('/api/agent/status', async (_req, res) => {
      try { const r = await this.request('/v1/status'); res.json({ connected: r.ok, bridge: this.status(), agent: r.ok ? await r.json() : null }); }
      catch { res.json({ connected: false, bridge: this.status() }); }
    });
    app.post('/api/agent/ask', (req, res) => {
      const body = z.object({ text: z.string().trim().min(1).max(12000), sessionId: z.string().max(160).optional() }).parse(req.body);
      const id = `manual-${randomUUID()}`, now = this.now();
      const event = { id, revision: 0, deviceId: body.sessionId ? `memory-${body.sessionId}` : 'memory-manual', streamId: 'manual',
        kind: 'transcript', final: true, sourceStart: now, sourceEnd: now, text: body.text,
        confidence: 1, speakerId: null, personIds: [], provenance: 'scene-memory:manual' };
      this.store.db.prepare("INSERT INTO agent_outbox(kind,source_id,revision,body) VALUES('event',?,0,?)").run(id, JSON.stringify(event));
      void this.flush(); res.status(202).json({ eventId: id });
    });
    app.get('/api/agent/commands', (req, res) => {
      const session = z.string().min(1).max(160).parse(req.query.sessionId);
      if (!this.store.listSessions().some(s => s.id === session)) { res.status(404).json({ error: 'Unknown session' }); return; }
      this.cameras.set(session, this.now());
      for (const [s, at] of this.cameras) if (this.now() - at > 60000) this.cameras.delete(s);
      const rows = this.store.db.prepare("SELECT * FROM agent_camera WHERE session_id=? AND state='pending' AND expires_at>? ORDER BY created_at").all(session, this.now()) as Camera[];
      res.json({ commands: rows.map(r => ({ id: r.id, type: 'capture', reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at })) });
    });
    app.post('/api/agent/commands/:id/claim', (req, res) => {
      const session = z.string().parse(req.body.sessionId);
      const r = this.store.db.prepare("UPDATE agent_camera SET state='claimed' WHERE id=? AND session_id=? AND state='pending' AND expires_at>?")
        .run(req.params.id, session, this.now()); res.json({ claimed: r.changes === 1 });
    });
    app.post('/api/agent/commands/:id/result', (req, res) => {
      const b = z.object({ sessionId: z.string(), captureId: z.string().optional(), error: z.string().max(500).optional() }).parse(req.body);
      const row = this.store.db.prepare('SELECT * FROM agent_camera WHERE id=? AND session_id=?').get(req.params.id, b.sessionId) as Camera | undefined;
      if (!row) { res.status(404).json({ error: 'Unknown command' }); return; }
      if (b.error && row.state === 'claimed') this.store.db.prepare("UPDATE agent_camera SET state='failed',error=? WHERE id=?").run(b.error, row.id);
      if (b.captureId && row.capture_id !== b.captureId) { res.status(409).json({ error: 'Capture has not been accepted for this request' }); return; }
      res.json({ accepted: true });
    });
    app.post('/api/agent/capture', (req, res) => {
      const b = z.object({ id: z.string().min(1).max(160), reason: z.string().min(1).max(1000), sessionId: z.string().optional() }).parse(req.body);
      res.json(this.cameraRequest(b.id, b.reason, b.sessionId));
    });
    app.get('/api/agent/capture/:id', (req, res) => res.json(this.cameraResult(req.params.id)));
    app.get('/api/agent/context', (_req, res) => res.json({ state: this.store.currentState(),
      people: this.store.entities().filter(e => e.kind === 'person' && !this.store.isPersonRemoved(e)),
      captures: this.store.listCaptures(5).map(c => ({ id: c.id, capturedAt: c.capturedAt, status: c.status, faces: c.faces, vision: c.vision })) }));
    app.get('/api/agent/source/:id', (req, res) => res.json({ valid: Boolean(this.store.currentObservation(req.params.id)) }));
    app.use(async (req, res, next) => {
      const path = req.path === '/api/agent/events' ? '/v1/notifications/stream'
        : req.path.startsWith('/api/agent/notifications') ? req.path.replace('/api/agent', '/v1')
        : req.path.startsWith('/api/agent/tasks') ? req.path.replace('/api/agent', '/v1')
        : /^\/v1\/artifacts\/[0-9a-f-]+$/.test(req.path) ? req.path : null;
      if (!path) { next(); return; }
      const ctl = new AbortController(); res.on('close', () => ctl.abort());
      try {
        const upstream = await this.request(path, { method: req.method, signal: ctl.signal,
          ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}) });
        res.status(upstream.status);
        for (const key of ['content-type', 'content-disposition', 'cache-control']) { const v = upstream.headers.get(key); if (v) res.setHeader(key, v); }
        if (!upstream.body) { res.end(); return; }
        const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
        stream.on('error', () => { if (!res.destroyed) res.end(); });
        stream.pipe(res);
      } catch { if (!res.headersSent) res.status(502).json({ error: 'Agent unavailable' }); else res.end(); }
    });
  }
}
