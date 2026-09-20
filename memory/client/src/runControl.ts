// Page-level lifecycle guards, kept DOM-free so the races they close are testable:
//   - RunSwitcher: exactly one Run per Start. A second Start while the previous Run is still stopping (or
//     while the new one is being created) is ignored instead of creating a parallel Run with its own camera,
//     sockets and ticker. Stop always targets the Run the page currently owns; a Run that was replaced can
//     never report into the page again;
//   - singleFlight: a polling function whose previous call has not settled is not started again (the fixed
//     3 s/2.5 s intervals with 5–8 s HTTP timeouts otherwise pile up requests on a slow bridge).
export interface RunLike { stop(reason?: string): Promise<void>; readonly isActive: boolean }

export class RunSwitcher<R extends RunLike> {
  private current: R | null = null;
  private switching = false;
  private seq = 0;
  /** The Run the page owns right now (may be stopped). */
  get run(): R | null { return this.current; }
  /** True while a Start is being processed (previous Run stopping / new Run starting). */
  get busy(): boolean { return this.switching; }
  owns(run: R): boolean { return this.current === run; }

  /**
   * Stop the previous Run (bounded by its own timeouts), create the next one, start it. Returns null when a
   * switch is already in progress — the caller shows nothing new; the first Start proceeds unchanged.
   */
  async start(create: () => R, begin: (run: R) => Promise<void>, replaceReason = 'replaced by a new Start'): Promise<R | null> {
    if (this.switching) return null;
    this.switching = true;
    const my = ++this.seq;
    try {
      const prev = this.current;
      if (prev) { try { await prev.stop(replaceReason); } catch { /* a failing Stop must not block the next Start */ } }
      if (my !== this.seq) return null; // superseded while the old Run was stopping (defensive; `switching` already prevents this)
      const next = create();
      this.current = next;
      await begin(next);
      return next;
    } finally { this.switching = false; }
  }

  /** Stop the owned Run only. Safe during a switch: the Run being started sees `stopped` on its next await. */
  async stop(reason = 'stopped by user'): Promise<void> { await this.current?.stop(reason); }
}

/** Wraps an async poll so at most one call runs at a time; overlapping calls resolve to the in-flight result. */
export function singleFlight<T>(fn: () => Promise<T>): (() => Promise<T>) & { readonly inFlight: boolean; readonly skipped: number } {
  let pending: Promise<T> | null = null;
  let skipped = 0;
  const wrapped = (() => {
    if (pending) { skipped += 1; return pending; }
    pending = fn().finally(() => { pending = null; });
    return pending;
  }) as (() => Promise<T>) & { inFlight: boolean; skipped: number };
  Object.defineProperties(wrapped, { inFlight: { get: () => pending !== null }, skipped: { get: () => skipped } });
  return wrapped;
}
