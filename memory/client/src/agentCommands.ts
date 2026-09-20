// Agent capture interrupts. While a Run is running, the page polls GET /api/agent/commands for the
// current session (~400 ms, ONE request in flight, ever). The poll doubles as the heartbeat that
// registers this camera as active. A `capture` command is claimed first; only a `claimed:true` answer
// for the SAME still-active session leads to one immediate full photo through the Run's normal
// capture path (`Run.captureNow`). The result is reported only after the server accepted the photo
// (HTTP 202); "accepted" is not "interpreted" — the backend separately awaits fresh vision.
// Stop aborts the poll loop and every pending step; a claim or capture that resolves afterwards is
// dropped, never handed to a newer session.
import type { Clock } from './types.ts';

export interface AgentCommand { id: string; type: string; reason?: string | null; createdAt?: number; expiresAt?: number }
export interface CommandTransport {
  poll(sessionId: string): Promise<{ commands?: AgentCommand[] | null }>;
  claim(id: string, sessionId: string): Promise<{ claimed?: boolean }>;
  result(id: string, body: { sessionId: string; captureId?: string; error?: string }): Promise<unknown>;
}

export type InterruptStage = 'idle' | 'polling' | 'unavailable' | 'claiming' | 'capturing' | 'reporting' | 'captured' | 'failed' | 'stopped';
export interface InterruptCounts { polls: number; pollErrors: number; seen: number; expired: number; ignored: number; claimed: number; notClaimed: number; captured: number; failed: number }
export interface InterruptState {
  stage: InterruptStage;
  /** One-line, user-facing description of the current stage (e.g. “capturing for agent”). */
  message: string;
  commandId: string | null; captureId: string | null; reason: string | null;
  at: number;
  /** Whether the last poll answered; false shows the endpoint is unreachable/unimplemented. */
  pollingHealthy: boolean; lastPollError: string | null;
  counts: InterruptCounts;
}

export interface CommandPollerOptions {
  sessionId: string; clock: Clock; transport: CommandTransport;
  /** Takes one immediate full photo through the normal capture path; resolves with the accepted capture id. */
  capture: (requestId: string) => Promise<string>;
  onState: (s: InterruptState) => void;
  intervalMs?: number; maxErrorBackoffMs?: number; maxSeen?: number;
}

const DEFAULT_INTERVAL_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 5000;

export function isCaptureCommand(c: unknown): c is AgentCommand {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o.id === 'string' && o.id.length > 0 && typeof o.type === 'string';
}
/** Expired when `expiresAt` is a finite number at or before `now`. Missing/invalid expiry = not expired. */
export function isExpired(c: AgentCommand, now: number): boolean {
  return typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt) && c.expiresAt <= now;
}

export class CommandPoller {
  private active = false;
  private stoppedReason: string | null = null;
  private timer: unknown = null;
  private inFlight = false;
  private consecutiveErrors = 0;
  private seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private state: InterruptState;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxSeen: number;

  constructor(private readonly opts: CommandPollerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxBackoffMs = opts.maxErrorBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxSeen = opts.maxSeen ?? 500;
    this.state = { stage: 'idle', message: 'not polling', commandId: null, captureId: null, reason: null, at: opts.clock.now(), pollingHealthy: false, lastPollError: null,
      counts: { polls: 0, pollErrors: 0, seen: 0, expired: 0, ignored: 0, claimed: 0, notClaimed: 0, captured: 0, failed: 0 } };
  }

  get snapshot(): InterruptState { return { ...this.state, counts: { ...this.state.counts } }; }
  get running(): boolean { return this.active; }

  start(): void {
    if (this.active || this.stoppedReason !== null) return;
    this.active = true;
    this.set({ stage: 'polling', message: 'polling for agent capture requests' });
    void this.pollOnce();
  }

  /** Aborts polling; nothing that resolves afterwards (poll, claim, capture) has any effect. */
  stop(reason = 'stopped'): void {
    if (!this.active && this.stoppedReason !== null) return;
    this.active = false; this.stoppedReason = reason;
    if (this.timer !== null) this.opts.clock.clearTimeout(this.timer);
    this.timer = null;
    this.set({ stage: 'stopped', message: `agent capture polling stopped (${reason})` });
  }

  private arm(delayMs: number): void {
    if (!this.active || this.timer !== null) return;
    this.timer = this.opts.clock.setTimeout(() => { this.timer = null; void this.pollOnce(); }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.active || this.inFlight) return;
    this.inFlight = true;
    let nextDelay = this.intervalMs;
    try {
      const res = await this.opts.transport.poll(this.opts.sessionId);
      if (!this.active) return;
      this.consecutiveErrors = 0;
      this.state.counts.polls += 1;
      const list = Array.isArray(res?.commands) ? res.commands : [];
      const quiet = this.state.stage === 'unavailable' || this.state.stage === 'polling';
      if (quiet) this.set({ stage: 'polling', message: 'polling for agent capture requests', pollingHealthy: true, lastPollError: null });
      else this.set({ pollingHealthy: true, lastPollError: null });
      for (const raw of list) {
        if (!isCaptureCommand(raw)) { this.state.counts.ignored += 1; continue; }
        if (this.seen.has(raw.id)) continue;
        this.remember(raw.id);
        this.state.counts.seen += 1;
        if (raw.type !== 'capture') { this.state.counts.ignored += 1; continue; }
        if (isExpired(raw, this.opts.clock.now())) { this.state.counts.expired += 1; this.set({ message: `ignored expired capture request ${raw.id}` }); continue; }
        this.chain = this.chain.then(() => this.handle(raw)).catch(() => {});
      }
    } catch (e) {
      if (!this.active) return;
      this.consecutiveErrors += 1;
      this.state.counts.pollErrors += 1;
      const m = e instanceof Error ? e.message : String(e);
      nextDelay = Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(6, this.consecutiveErrors));
      const stage = this.state.stage === 'polling' || this.state.stage === 'unavailable' ? 'unavailable' : this.state.stage;
      this.set({ stage, pollingHealthy: false, lastPollError: m, ...(stage === 'unavailable' ? { message: `agent command endpoint unavailable: ${m} (retry in ${nextDelay} ms)` } : {}) });
    } finally {
      this.inFlight = false;
      this.arm(nextDelay);
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.maxSeen) { const first = this.seen.values().next().value; if (first !== undefined) this.seen.delete(first); }
  }

  private async handle(cmd: AgentCommand): Promise<void> {
    if (!this.active) return;
    const sessionId = this.opts.sessionId;
    this.set({ stage: 'claiming', commandId: cmd.id, captureId: null, reason: cmd.reason ?? null, message: `claiming agent capture request${cmd.reason ? ` (${cmd.reason})` : ''}` });
    let claimed = false;
    try {
      const r = await this.opts.transport.claim(cmd.id, sessionId);
      claimed = r?.claimed === true;
    } catch (e) {
      if (!this.active) return;
      this.state.counts.failed += 1;
      this.set({ stage: 'failed', message: `claim failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (!this.active) return; // stopped while claiming: never capture for a dead session
    if (!claimed) { this.state.counts.notClaimed += 1; this.set({ stage: 'polling', message: `capture request ${cmd.id} was not claimed (another camera or expired)` }); return; }
    if (isExpired(cmd, this.opts.clock.now())) { this.state.counts.expired += 1; this.set({ stage: 'polling', message: `capture request ${cmd.id} expired before capture` }); void this.report(cmd.id, { sessionId, error: 'expired before capture' }); return; }
    this.state.counts.claimed += 1;
    this.set({ stage: 'capturing', message: `capturing for agent${cmd.reason ? ` (${cmd.reason})` : ''}` });
    let captureId: string;
    try {
      captureId = await this.opts.capture(cmd.id);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.state.counts.failed += 1;
      if (this.active) { this.set({ stage: 'reporting', message: `capture failed: ${m}; reporting` }); await this.report(cmd.id, { sessionId, error: m }); }
      if (this.active) this.set({ stage: 'failed', message: `capture for agent failed: ${m}` });
      return;
    }
    if (!this.active) return; // late capture: this session is over; a newer session must not inherit it
    this.set({ stage: 'reporting', captureId, message: `captured ${captureId}; reporting to agent` });
    const ok = await this.report(cmd.id, { sessionId, captureId });
    if (!this.active) return;
    this.state.counts.captured += 1;
    this.set({ stage: 'captured', captureId, message: ok ? `captured for agent (${captureId}) · accepted by server, interpretation pending` : `captured ${captureId} (accepted) but the result report failed; the agent may retry` });
  }

  private async report(id: string, body: { sessionId: string; captureId?: string; error?: string }): Promise<boolean> {
    try { await this.opts.transport.result(id, body); return true; }
    catch { return false; }
  }

  private set(patch: Partial<Omit<InterruptState, 'counts'>>): void {
    this.state = { ...this.state, ...patch, at: this.opts.clock.now(), counts: this.state.counts };
    this.opts.onState(this.snapshot);
  }
}
