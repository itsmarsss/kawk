import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchoredTicker, planNextTick } from '../src/cadence.ts';
import { FakeClock } from './fakes.ts';

test('ticks stay anchored to start + k*interval while the handler simulates slow inference', () => {
  const clock = new FakeClock();
  const fired: { index: number; dueAt: number; firedAt: number }[] = [];
  const ticker = createAnchoredTicker({ intervalMs: 5000, clock, onTick: (t) => {
    fired.push(t);
    clock.t += 1800; // handler work (drawing, encoding) that must NOT shift later ticks
  } });
  const anchor = clock.now();
  ticker.start(anchor);
  clock.advance(26000);
  ticker.stop();
  assert.deepEqual(fired.map((f) => f.index), [0, 1, 2, 3, 4, 5], 'tick 0 fires at the anchor');
  assert.deepEqual(fired.map((f) => f.dueAt - anchor), [0, 5000, 10000, 15000, 20000, 25000]);
  for (const f of fired) assert.equal(f.firedAt, f.dueAt, 'fired exactly at the anchored due time');
  assert.equal(clock.pending, 0, 'stop cleared the armed timer');
});

test('a long stall skips missed ticks and reports them instead of bursting', () => {
  assert.deepEqual(planNextTick(0, 5000, 2, 15100), { index: 3, dueAt: 15000, skipped: 0 }, 'small lateness is tolerated');
  assert.deepEqual(planNextTick(0, 5000, 2, 27600), { index: 6, dueAt: 30000, skipped: 3 });
  const clock = new FakeClock();
  const fired: { index: number; skipped: number; lateMs: number }[] = [];
  const ticker = createAnchoredTicker({ intervalMs: 5000, clock, onTick: (t) => { fired.push({ index: t.index, skipped: t.skipped, lateMs: t.lateMs }); if (t.index === 0) clock.t += 12_600; } });
  ticker.start(clock.now());
  clock.advance(20_000);
  ticker.stop();
  // tick 1 was already armed before the stall and fires late (reported); tick 2 is skipped, 3 and 4 are on time
  assert.deepEqual(fired, [
    { index: 0, skipped: 0, lateMs: 0 }, { index: 1, skipped: 0, lateMs: 7600 },
    { index: 3, skipped: 1, lateMs: 0 }, { index: 4, skipped: 0, lateMs: 0 },
  ]);
});
