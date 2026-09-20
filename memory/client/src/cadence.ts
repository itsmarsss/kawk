// Anchored capture cadence: tick k is due at anchor + k*interval regardless of how long the previous
// tick's work (HTTP, face reply, encoding) takes. The handler is invoked synchronously and never awaited.
// Tick 0 fires at the anchor itself (first photo on Start). If the page falls behind by more than half
// an interval (tab throttling), missed ticks are skipped and reported as gaps rather than fired in a
// burst; a tick that fires late reports its lateness.
import type { Clock } from './types.ts';

export interface TickPlan { index: number; dueAt: number; skipped: number }

export function planNextTick(anchorMs: number, intervalMs: number, lastIndex: number, nowMs: number): TickPlan {
  let index = lastIndex + 1;
  let dueAt = anchorMs + index * intervalMs;
  let skipped = 0;
  if (dueAt < nowMs - intervalMs / 2) {
    const caughtUp = Math.ceil((nowMs - anchorMs) / intervalMs);
    skipped = caughtUp - index;
    index = caughtUp;
    dueAt = anchorMs + index * intervalMs;
  }
  return { index, dueAt, skipped };
}

export interface TickInfo { index: number; dueAt: number; firedAt: number; skipped: number; lateMs: number }

export function createAnchoredTicker(opts: {
  intervalMs: number; clock: Clock; onTick: (tick: TickInfo) => void;
}) {
  let anchor: number | null = null;
  let lastIndex = -1;
  let handle: unknown = null;
  let active = false;

  function arm(): void {
    if (!active || anchor === null) return;
    const now = opts.clock.now();
    const plan = planNextTick(anchor, opts.intervalMs, lastIndex, now);
    handle = opts.clock.setTimeout(() => {
      handle = null;
      if (!active) return;
      const firedAt = opts.clock.now();
      lastIndex = plan.index;
      arm(); // schedule the next tick BEFORE running the handler, so a slow handler cannot delay cadence
      opts.onTick({ index: plan.index, dueAt: plan.dueAt, firedAt, skipped: plan.skipped, lateMs: Math.max(0, firedAt - plan.dueAt) });
    }, Math.max(0, plan.dueAt - now));
  }

  return {
    start(anchorMs: number): void {
      if (active) return;
      active = true; anchor = anchorMs; lastIndex = -1;
      arm();
    },
    stop(): void {
      active = false;
      if (handle !== null) opts.clock.clearTimeout(handle);
      handle = null;
    },
    get running(): boolean { return active; },
    get anchor(): number | null { return anchor; },
  };
}
