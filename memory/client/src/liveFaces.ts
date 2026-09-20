// Live face forwarding to the agent bridge (POST /api/agent/faces {sessionId, evidence}).
// Input: the ~5 fps REGULAR face results (already vote-stabilised by the face server), independent of the
// 5 s photos and of the memory writer. Rules:
//   - an identity-set change (sorted confirmed gallery UUIDs + "unknown face present" + "no face") is
//     forwarded once it has been seen on two consecutive results (a single-frame blip is not a change);
//     disappearance ("no face") and unknown-only transitions count as changes;
//   - otherwise a heartbeat forwards the latest evidence at most once every HEARTBEAT_MS;
//   - at most ONE POST in flight; while it is out, at most one pending candidate is kept and it always reflects
//     the LATEST stable result: a newer stable set replaces it, and a return to the in-flight/acknowledged set
//     drops it. Pending evidence older than MAX_AGE_MS is dropped instead of sent (the server rejects > 5 s);
//   - the evidence object is forwarded unchanged (original frameId / streamId / capturedAt);
//   - a failure is visible (lastError, counters) and never replayed: the same identity is retried only with fresh
//     evidence after a bounded, growing delay; a genuinely new stable identity gets one immediate try; after
//     repeated failures the heartbeat backs off too. A success restores normal cadence;
//   - reset() (people deleted / face connection recycled) bumps a generation: the physical in-flight request still
//     bounds concurrency until it settles, but its reply can no longer acknowledge an identity, and only a
//     current-generation candidate may drain afterwards;
//   - stop() ends everything: no send afterwards, and an in-flight reply is ignored. One forwarder per Run.
import type { Clock, FaceEvidence } from './types.ts';

export interface LiveFaceTransport { (body: { sessionId: string; evidence: FaceEvidence }): Promise<{ accepted?: boolean } | unknown> }
export type LiveFaceStage = 'idle' | 'watching' | 'sending' | 'sent' | 'failed' | 'stopped';
export interface LiveFaceCounts { offered: number; changes: number; heartbeats: number; sent: number; accepted: number; failed: number; superseded: number; staleDropped: number; blips: number; staleReplies: number; retryDeferred: number }
export interface LiveFaceState {
  stage: LiveFaceStage; message: string;
  /** Identity key the server has acknowledged in the current generation, e.g. `people:uuid-a,uuid-b`, `unknown`, `none`. */
  identityKey: string | null; lastSentAt: number | null; lastSentKind: 'change' | 'heartbeat' | null;
  inFlight: boolean; pending: boolean; consecutiveFailures: number; lastError: string | null; heartbeatMs: number;
  /** Earliest time an already-failed identity may be retried (null when no retry is being held back). */
  retryNotBefore: number | null;
  counts: LiveFaceCounts;
}

export const HEARTBEAT_MS = 3000;
export const MAX_AGE_MS = 4000;
const STABLE_RESULTS = 2;
const HEARTBEAT_BACKOFF_AFTER = 3;
const MAX_HEARTBEAT_MS = 15000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

/** Identity key of one result: confirmed gallery UUIDs (sorted, deduped) + unknown-face flag; `none` when no face. */
export function identityKey(e: FaceEvidence): string {
  if (e.status !== 'ready') return 'unavailable';
  if (!e.faces.length) return 'none';
  const ids = [...new Set(e.faces.filter((f) => f.identityStatus === 'confirmed' && f.personId).map((f) => f.personId as string))].sort();
  const unknown = e.faces.some((f) => f.identityStatus !== 'confirmed' || !f.personId);
  if (!ids.length) return 'unknown';
  return `people:${ids.join(',')}${unknown ? '+unknown' : ''}`;
}

interface Candidate { evidence: FaceEvidence; key: string; kind: 'change' | 'heartbeat'; at: number; generation: number }

export class LiveFaceForwarder {
  private active = false;
  private stopped = false;
  private generation = 0;
  private inFlight: Candidate | null = null;
  private pending: Candidate | null = null;
  private candidateKey: string | null = null;
  private candidateRun = 0;
  /** Identities tried (and failed) since the last success: they wait for `retryNotBefore`; others get one try. */
  private failedKeys = new Set<string>();
  private state: LiveFaceState;
  constructor(private readonly opts: { sessionId: string; clock: Clock; send: LiveFaceTransport; onState: (s: LiveFaceState) => void; heartbeatMs?: number; maxAgeMs?: number }) {
    this.state = { stage: 'idle', message: 'not started', identityKey: null, lastSentAt: null, lastSentKind: null, inFlight: false, pending: false, consecutiveFailures: 0, lastError: null, heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_MS, retryNotBefore: null,
      counts: { offered: 0, changes: 0, heartbeats: 0, sent: 0, accepted: 0, failed: 0, superseded: 0, staleDropped: 0, blips: 0, staleReplies: 0, retryDeferred: 0 } };
  }
  get snapshot(): LiveFaceState { return { ...this.state, counts: { ...this.state.counts } }; }

  start(): void { if (this.stopped || this.active) return; this.active = true; this.set({ stage: 'watching', message: 'watching live face results' }); }
  stop(reason = 'stopped'): void {
    if (this.stopped) return;
    this.active = false; this.stopped = true; this.pending = null;
    this.set({ stage: 'stopped', message: `live face forwarding stopped (${reason})`, pending: false });
  }
  /**
   * People were deleted / the face connection recycled: forget the acknowledged identity and start a new
   * generation. An in-flight request keeps the one-POST bound until it physically settles, but its reply is
   * ignored for acknowledgement; the next stable result of the new generation is forwarded.
   */
  reset(reason: string): void {
    if (!this.active) return;
    this.generation += 1;
    this.candidateKey = null; this.candidateRun = 0; this.pending = null; this.failedKeys.clear();
    this.set({ identityKey: null, lastSentAt: null, lastSentKind: null, pending: false, retryNotBefore: null, consecutiveFailures: 0, lastError: null, heartbeatMs: this.effectiveHeartbeatMs(0),
      message: `identity forgotten (${reason}); next stable result will be forwarded${this.inFlight ? ' after the current request settles' : ''}` });
  }

  /** Offer one regular face result. Decides change / heartbeat / nothing, then sends or keeps latest-only pending. */
  offer(evidence: FaceEvidence): void {
    if (!this.active) return;
    this.state.counts.offered += 1;
    const now = this.opts.clock.now();
    const key = identityKey(evidence);
    const acknowledged = this.state.identityKey;
    // The in-flight change (same generation) counts as provisionally known: stable repeats of it are not new changes.
    const provisional = this.inFlight && this.inFlight.generation === this.generation && this.inFlight.kind === 'change' ? this.inFlight.key : acknowledged;
    if (key === this.candidateKey) this.candidateRun += 1;
    else {
      if (this.candidateKey !== null && this.candidateKey !== provisional && this.candidateRun < STABLE_RESULTS) this.state.counts.blips += 1; // a set seen once, then gone: not a change
      this.candidateKey = key; this.candidateRun = 1;
    }
    const stable = this.candidateRun >= STABLE_RESULTS;
    // Latest-only: a pending candidate for another set is obsolete as soon as a different set is stable again,
    // including a return to the in-flight or acknowledged set.
    if (stable && this.pending && this.pending.key !== key) { const dropped = this.pending.key; this.pending = null; this.state.counts.superseded += 1; this.set({ pending: false, message: `pending ${dropped} dropped: a newer stable result shows ${key}` }); }
    let kind: Candidate['kind'] | null = null;
    if (stable && key !== provisional) {
      if (this.failedKeys.has(key) && this.state.retryNotBefore !== null && now < this.state.retryNotBefore) {
        this.state.counts.retryDeferred += 1;
        this.set({ message: `${key} still unacknowledged after ${this.state.consecutiveFailures} failure(s); retry with fresh evidence in ${Math.round(this.state.retryNotBefore - now)} ms` });
        return;
      }
      kind = 'change';
    } else if (key === acknowledged && !this.inFlight && (this.state.lastSentAt === null || now - this.state.lastSentAt >= this.effectiveHeartbeatMs())) kind = 'heartbeat';
    if (!kind) { this.opts.onState(this.snapshot); return; } // awaiting confirmation, same as in-flight, or heartbeat not due: counters only
    const c: Candidate = { evidence, key, kind, at: now, generation: this.generation };
    if (kind === 'change') this.state.counts.changes += 1; else this.state.counts.heartbeats += 1;
    if (this.inFlight) {
      if (this.pending) this.state.counts.superseded += 1;
      this.pending = c; // the newest stable candidate; anything older is gone
      this.set({ pending: true, message: `${describe(c)} waiting: one POST already in flight` });
      return;
    }
    void this.dispatch(c);
  }

  private effectiveHeartbeatMs(f = this.state.consecutiveFailures): number {
    const base = this.opts.heartbeatMs ?? HEARTBEAT_MS;
    return f >= HEARTBEAT_BACKOFF_AFTER ? Math.min(MAX_HEARTBEAT_MS, base * 2 ** (f - HEARTBEAT_BACKOFF_AFTER + 1)) : base;
  }
  private retryDelayMs(failures: number): number { return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1)); }

  private async dispatch(c: Candidate): Promise<void> {
    if (!this.active) return;
    const maxAge = this.opts.maxAgeMs ?? MAX_AGE_MS;
    if (this.opts.clock.now() - c.evidence.capturedAt > maxAge) { this.state.counts.staleDropped += 1; this.set({ message: `${describe(c)} dropped: evidence ${Math.round(this.opts.clock.now() - c.evidence.capturedAt)} ms old (max ${maxAge})` }); this.drainPending(); return; }
    this.inFlight = c;
    this.state.counts.sent += 1;
    this.set({ stage: 'sending', inFlight: true, message: `sending ${describe(c)}` });
    let ok = false; let error: string | null = null;
    try {
      const r = await this.opts.send({ sessionId: this.opts.sessionId, evidence: c.evidence });
      ok = !r || typeof r !== 'object' || (r as { accepted?: unknown }).accepted !== false;
      if (!ok) error = 'server answered accepted:false';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    if (this.inFlight !== c) return; // stopped meanwhile: this reply is irrelevant
    this.inFlight = null;
    if (!this.active) return;
    if (c.generation !== this.generation) {
      // reset() happened while this was out: the identity it carried is from a forgotten generation.
      this.state.counts.staleReplies += 1;
      this.set({ inFlight: false, message: `${ok ? 'accepted' : 'failed'} reply for ${describe(c)} ignored: identity was reset while it was in flight` });
      this.drainPending();
      return;
    }
    if (ok) {
      this.state.counts.accepted += 1; this.failedKeys.clear();
      this.set({ stage: 'sent', inFlight: false, identityKey: c.key, lastSentAt: c.at, lastSentKind: c.kind, consecutiveFailures: 0, lastError: null, retryNotBefore: null, heartbeatMs: this.effectiveHeartbeatMs(0), message: `${describe(c)} accepted (journaled; not yet interpreted)` });
    } else {
      this.state.counts.failed += 1;
      const failures = this.state.consecutiveFailures + 1;
      const delay = this.retryDelayMs(failures);
      if (c.kind === 'change') this.failedKeys.add(c.key);
      // Never replayed: the server still knows the previous identity; the same set is retried only with fresh evidence after `delay`.
      this.set({ stage: 'failed', inFlight: false, consecutiveFailures: failures, lastError: error, retryNotBefore: this.opts.clock.now() + delay, lastSentAt: c.kind === 'heartbeat' ? c.at : this.state.lastSentAt,
        heartbeatMs: this.effectiveHeartbeatMs(failures),
        message: `${describe(c)} failed: ${error} (${failures} consecutive; same identity retries with fresh evidence after ${delay} ms, a new identity is tried once${failures >= HEARTBEAT_BACKOFF_AFTER ? `; heartbeat backed off to ${this.effectiveHeartbeatMs(failures)} ms` : ''})` });
    }
    this.drainPending();
  }

  private drainPending(): void {
    const p = this.pending; this.pending = null;
    if (!p || !this.active || p.generation !== this.generation) { if (this.state.pending) this.set({ pending: false }); return; }
    this.set({ pending: false });
    void this.dispatch(p);
  }
  private set(patch: Partial<Omit<LiveFaceState, 'counts'>>): void { this.state = { ...this.state, ...patch, counts: this.state.counts }; this.opts.onState(this.snapshot); }
}

const describe = (c: Candidate): string => `${c.kind} → ${c.key} (${c.evidence.faces.length} face(s), frame ${c.evidence.frameId})`;
