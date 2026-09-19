// Tiny dependency-free test harness + fake clock. Usage: node tests/run.mjs
export let failures = 0;
export let passes = 0;
export function check(cond, msg) { if (cond) { passes++; console.log('ok    ' + msg); } else { failures++; console.log('FAIL  ' + msg); } }
export function eq(a, b, msg) { check(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

/** Deterministic clock with the shape providers accept (now/setTimeout/clearTimeout). */
export function fakeClock(startMs = Date.parse('2026-09-19T14:00:00.000Z')) {
  let now = startMs;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = seq++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Advance time, firing timers in order (timers scheduled while firing are honoured). */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
      }
      now = target;
    },
  };
}
