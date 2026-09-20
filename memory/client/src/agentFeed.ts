// Agent answers/notifications and tasks: pure logic for the compact Agent section.
//   - notifications are keyed by id and deduplicated across the initial GET, the SSE stream and every
//     SSE reconnect; a repeated delivery never renders twice;
//   - acks are local only after the server confirmed `{acked:true}`;
//   - refs become links only for same-origin relative paths (artifact proxy routes, frames); anything
//     else is shown as text;
//   - the SSE connection is wrapped so its state is visible and a closed stream is reopened with backoff.
import type { Clock } from './types.ts';

export interface AgentNotification {
  id: string; taskId: string | null; text: string; createdAt: number | null; refs: unknown[]; acked: boolean; receivedAt: number; raw: Record<string, unknown>;
  /** When the service worker reported this id arriving by Web Push (null: seen via GET/SSE only). */
  pushAt: number | null;
  /** Why the page acknowledged it (null: not acked here — server-reported or manual Ack button). */
  ackReason: string | null;
}

export function parseNotification(raw: unknown, receivedAt: number): AgentNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const text = typeof o.text === 'string' ? o.text : typeof o.body === 'string' ? o.body : '';
  return {
    id: o.id, taskId: typeof o.taskId === 'string' ? o.taskId : null, text,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : null,
    refs: Array.isArray(o.refs) ? o.refs : [], acked: o.acked === true || typeof o.ackedAt === 'number', receivedAt, raw: o, pushAt: null, ackReason: null,
  };
}

export class NotificationLedger {
  private items = new Map<string, AgentNotification>();
  duplicates = 0;
  constructor(private readonly max = 100) {}
  /** Returns true when the notification is new. A repeat (same id) updates ack state only and counts as a duplicate. */
  add(n: AgentNotification): boolean {
    const prev = this.items.get(n.id);
    if (prev) { this.duplicates += 1; if (n.acked && !prev.acked) prev.acked = true; return false; }
    this.items.set(n.id, n);
    while (this.items.size > this.max) { const oldest = this.list().at(-1); if (!oldest) break; this.items.delete(oldest.id); }
    return true;
  }
  ack(id: string, reason: string | null = null): void { const n = this.items.get(id); if (n) { n.acked = true; if (reason) n.ackReason = reason; } }
  /** Service worker reported a push for this id. Returns false when the id is unknown to the ledger. */
  markPush(id: string, at: number): boolean { const n = this.items.get(id); if (!n) return false; if (n.pushAt === null) n.pushAt = at; return true; }
  get(id: string): AgentNotification | undefined { return this.items.get(id); }
  get size(): number { return this.items.size; }
  /** Newest first by createdAt (falling back to receipt time). */
  list(): AgentNotification[] { return [...this.items.values()].sort((a, b) => (b.createdAt ?? b.receivedAt) - (a.createdAt ?? a.receivedAt)); }
}

export interface RefView { label: string; href: string | null }
const sameOriginPath = (s: string): boolean => s.startsWith('/') && !s.startsWith('//');
const ARTIFACT_ID = /^[0-9a-f-]+$/; // the bridge proxies only /v1/artifacts/<lowercase hex/dash id>; anything else has no valid path
const artifactHref = (id: string): string | null => (ARTIFACT_ID.test(id) ? `/v1/artifacts/${id}` : null);
/**
 * Refs: `"/v1/artifacts/abc"`, `{url|href:"/…"}`, `{artifactId}`, `{type:"artifact",id}` → links when the path is valid;
 * `{captureId}` → the frame route; evidence refs `{eventId, revision}` and everything else → plain text (no invented links).
 */
export function refView(ref: unknown): RefView {
  if (typeof ref === 'string') return sameOriginPath(ref) ? { label: ref, href: ref } : { label: ref, href: null };
  if (!ref || typeof ref !== 'object') return { label: String(ref), href: null };
  const o = ref as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label : typeof o.title === 'string' ? o.title : null;
  for (const k of ['url', 'href']) { const v = o[k]; if (typeof v === 'string' && sameOriginPath(v)) return { label: label ?? v, href: v }; }
  if (typeof o.artifactId === 'string') return { label: label ?? `artifact ${o.artifactId}`, href: artifactHref(o.artifactId) };
  if (o.type === 'artifact' && typeof o.id === 'string') return { label: label ?? `artifact ${o.id}`, href: artifactHref(o.id) };
  if (typeof o.eventId === 'string') return { label: label ?? `evidence event ${o.eventId}${typeof o.revision === 'number' ? ` r${o.revision}` : ''}`, href: null };
  if (typeof o.captureId === 'string') return { label: label ?? `source image ${o.captureId}`, href: `/api/frames/${encodeURIComponent(o.captureId)}` };
  if (typeof o.type === 'string' && typeof o.id === 'string') return { label: label ?? `${o.type} ${o.id}`, href: null };
  return { label: label ?? JSON.stringify(o).slice(0, 80), href: null };
}

/** Statuses after which a task can no longer be cancelled. `abstained`/`superseded` are Jev-gated endings. */
const TERMINAL = new Set(['done', 'completed', 'complete', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled', 'aborted', 'expired', 'rejected', 'abstained', 'superseded']);
export function isActiveTask(status: unknown): boolean { return typeof status === 'string' && !TERMINAL.has(status.toLowerCase()); }
export function taskResultText(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') { const o = result as Record<string, unknown>; for (const k of ['text', 'summary', 'answer', 'message']) if (typeof o[k] === 'string') return o[k] as string; return JSON.stringify(result).slice(0, 300); }
  return String(result);
}

export interface AgentStatusView { text: string; tone: '' | 'ok' | 'warn' | 'bad' }
export function describeAgentConnection(status: { connected?: boolean; bridge?: { pending?: number; lastError?: string | null } | null; agent?: { running?: boolean; activeTurns?: number; lastError?: string | null } | null } | null, statusError: string | null, stream: StreamState, now: number | null = null): AgentStatusView {
  const age = now !== null && stream.lastEventAt !== null ? ` · last event ${Math.max(0, Math.round((now - stream.lastEventAt) / 1000))} s ago` : '';
  const streamText = (stream.phase === 'open' ? 'live updates on' : stream.phase === 'connecting' ? 'live updates connecting' : stream.phase === 'reconnecting' ? `live updates reconnecting (attempt ${stream.attempt}${stream.lastError ? `, ${stream.lastError}` : ''})` : stream.phase === 'closed' ? 'live updates off' : 'live updates idle') + age;
  if (statusError) return { text: `agent unreachable: ${statusError} · ${streamText}`, tone: 'bad' };
  if (!status) return { text: `agent status unknown · ${streamText}`, tone: '' };
  const a = status.agent; const b = status.bridge;
  const parts = [status.connected ? 'connected' : 'disconnected'];
  if (a) parts.push(`${a.running ? 'running' : 'not running'}${typeof a.activeTurns === 'number' ? ` · ${a.activeTurns} active turn(s)` : ''}`);
  if (b && typeof b.pending === 'number') parts.push(`${b.pending} pending`);
  const err = a?.lastError ?? b?.lastError ?? null;
  if (err) parts.push(`last error: ${err}`);
  parts.push(streamText);
  return { text: parts.join(' · '), tone: !status.connected ? 'bad' : err ? 'warn' : stream.phase === 'open' ? 'ok' : 'warn' };
}

// ---- SSE wrapper -------------------------------------------------------------------------------------------
export type StreamPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface StreamState { phase: StreamPhase; attempt: number; connections: number; lastEventAt: number | null; lastError: string | null }
export interface EventSourceLike {
  readyState: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((this: any, ev: any) => unknown) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((this: any, ev: any) => unknown) | null;
  addEventListener(type: string, fn: (ev: { data: string }) => void): void; close(): void;
}
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export class NotificationStream {
  private es: EventSourceLike | null = null;
  private active = false;
  private attempt = 0;
  private timer: unknown = null;
  private state: StreamState = { phase: 'idle', attempt: 0, connections: 0, lastEventAt: null, lastError: null };
  constructor(private readonly opts: {
    url: string; clock: Clock; create: (url: string) => EventSourceLike;
    onNotification: (n: AgentNotification) => void; onState: (s: StreamState) => void; onError?: (m: string) => void;
  }) {}
  get snapshot(): StreamState { return { ...this.state }; }
  start(): void { if (this.active) return; this.active = true; this.open(); }
  /**
   * The tab became visible again (or the network came back): a stream the browser silently dropped while
   * hidden is reopened NOW instead of after the remaining backoff. A healthy open stream is left alone.
   */
  wake(): void {
    if (!this.active) return;
    const dead = this.es === null || this.es.readyState === 2;
    if (!dead) return;
    if (this.timer !== null) { this.opts.clock.clearTimeout(this.timer); this.timer = null; }
    this.es?.close(); this.es = null;
    this.open();
  }
  stop(): void {
    this.active = false;
    if (this.timer !== null) this.opts.clock.clearTimeout(this.timer);
    this.timer = null;
    this.es?.close(); this.es = null;
    this.set({ phase: 'closed' });
  }
  private open(): void {
    if (!this.active) return;
    let es: EventSourceLike;
    try { es = this.opts.create(this.opts.url); } catch (e) { this.set({ lastError: e instanceof Error ? e.message : String(e) }); this.scheduleReopen(); return; }
    this.es = es;
    this.set({ phase: this.attempt ? 'reconnecting' : 'connecting', attempt: this.attempt });
    es.onopen = () => { if (this.es !== es) return; this.attempt = 0; this.set({ phase: 'open', attempt: 0, connections: this.state.connections + 1, lastError: null }); };
    es.onerror = () => {
      if (this.es !== es) return;
      // EventSource retries on its own while readyState is CONNECTING (0); only a CLOSED (2) stream needs our reopen.
      if (es.readyState === 2) { this.es = null; this.set({ phase: 'reconnecting', lastError: 'stream closed' }); this.scheduleReopen(); }
      else this.set({ phase: 'reconnecting', lastError: 'stream error; browser retrying' });
    };
    es.addEventListener('notification', (ev) => {
      if (this.es !== es) return;
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { this.opts.onError?.('unparseable notification event'); return; }
      const n = parseNotification(parsed, this.opts.clock.now());
      if (!n) { this.opts.onError?.('notification event without an id'); return; }
      this.set({ lastEventAt: this.opts.clock.now() });
      this.opts.onNotification(n);
    });
  }
  private scheduleReopen(): void {
    if (!this.active || this.timer !== null) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = this.opts.clock.setTimeout(() => { this.timer = null; this.open(); }, delay);
  }
  private set(patch: Partial<StreamState>): void { this.state = { ...this.state, ...patch }; this.opts.onState(this.snapshot); }
}
