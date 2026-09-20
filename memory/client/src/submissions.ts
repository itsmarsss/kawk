// Once-only capture submission with bounded retries of the IDENTICAL body, and a bounded in-flight
// window so a slow or dead server cannot pile up unbounded requests. Counters are explicit: a capture
// is "accepted" only after the server answered 202; "failed" means it will never be remembered.
export type SubmissionStatus = 'pending' | 'submitting' | 'accepted' | 'failed';
export interface SubmissionCounts { pending: number; submitting: number; accepted: number; failed: number; total: number }
export interface SubmissionState { id: string; status: SubmissionStatus; attempts: number; error: string | null; acceptedAt: number | null; latencyMs: number | null }

export interface Sender<B> { (body: B): Promise<{ ok: boolean; status: number; text: string }> }

export class SubmissionLedger<B> {
  private states = new Map<string, SubmissionState>();
  private inFlight = 0;
  constructor(private readonly opts: {
    send: Sender<B>; maxAttempts?: number; retryDelayMs?: number; maxInFlight?: number;
    now?: () => number; sleep?: (ms: number) => Promise<void>; onChange?: (s: SubmissionState) => void;
  }) {}

  counts(): SubmissionCounts {
    const c: SubmissionCounts = { pending: 0, submitting: 0, accepted: 0, failed: 0, total: this.states.size };
    for (const s of this.states.values()) c[s.status] += 1;
    return c;
  }
  get(id: string): SubmissionState | undefined { return this.states.get(id); }
  recent(limit: number): SubmissionState[] { return [...this.states.values()].slice(-limit).reverse(); }

  /**
   * Submit `body` under `id` exactly once. A second call for the same id is a no-op returning 'duplicate'.
   * Retries resend the same body object; a retry can never swap in a different image.
   */
  async submit(id: string, body: B, capturedAt: number): Promise<SubmissionStatus | 'duplicate'> {
    if (this.states.has(id)) return 'duplicate';
    const state: SubmissionState = { id, status: 'pending', attempts: 0, error: null, acceptedAt: null, latencyMs: null };
    this.states.set(id, state);
    this.emit(state);
    const maxInFlight = this.opts.maxInFlight ?? 4;
    if (this.inFlight >= maxInFlight) {
      state.status = 'failed'; state.error = `dropped: ${this.inFlight} submissions already in flight`;
      this.emit(state); return state.status;
    }
    const maxAttempts = this.opts.maxAttempts ?? 3;
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.inFlight += 1;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        state.attempts = attempt; state.status = 'submitting'; this.emit(state);
        try {
          const res = await this.opts.send(body);
          if (res.ok) {
            state.status = 'accepted'; state.acceptedAt = now(); state.latencyMs = state.acceptedAt - capturedAt; state.error = null;
            this.emit(state); return state.status;
          }
          state.error = `HTTP ${res.status}: ${res.text.slice(0, 300)}`;
          if (res.status >= 400 && res.status < 500) break; // the server rejected this body; resending it cannot help
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
        }
        if (attempt < maxAttempts) await sleep((this.opts.retryDelayMs ?? 500) * attempt);
      }
      state.status = 'failed'; this.emit(state); return state.status;
    } finally {
      this.inFlight -= 1;
    }
  }

  private emit(s: SubmissionState): void { this.opts.onChange?.({ ...s }); }
}

/** Bounded FIFO for transcript revisions: finals are kept, oldest partials are dropped first. */
export class BoundedRevisionQueue<T extends { isFinal: boolean }> {
  private items: T[] = [];
  dropped = 0;
  constructor(private readonly max: number) {}
  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.max) {
      const idx = this.items.findIndex((t) => !t.isFinal);
      this.items.splice(idx >= 0 ? idx : 0, 1);
      this.dropped += 1;
    }
  }
  shift(): T | undefined { return this.items.shift(); }
  get length(): number { return this.items.length; }
}
