// Page lifecycle guards: one Run per Start even under double clicks, Stop during a switch, and single-flight polls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunSwitcher, singleFlight } from '../src/runControl.ts';
import { SubmissionLedger, BoundedRevisionQueue } from '../src/submissions.ts';

class FakeRun {
  static created = 0;
  id = ++FakeRun.created;
  isActive = false;
  started = 0; stops: string[] = [];
  private release: (() => void) | null = null;
  constructor(private readonly slowStop = false) {}
  begin(): Promise<void> { this.started += 1; this.isActive = true; return Promise.resolve(); }
  stop(reason = 'stopped'): Promise<void> {
    this.stops.push(reason); this.isActive = false;
    if (!this.slowStop) return Promise.resolve();
    return new Promise<void>((r) => { this.release = r; });
  }
  finishStop(): void { this.release?.(); this.release = null; }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('double Start creates exactly one Run; a Start during the previous Run\'s Stop is ignored, not queued', async () => {
  FakeRun.created = 0;
  const sw = new RunSwitcher<FakeRun>();
  const [a, b] = await Promise.all([sw.start(() => new FakeRun(), (r) => r.begin()), sw.start(() => new FakeRun(), (r) => r.begin())]);
  assert.ok(a); assert.equal(b, null);
  assert.equal(FakeRun.created, 1); assert.equal(a!.started, 1); assert.equal(sw.run, a);
  // previous Run stops slowly (bounded by its own timeouts); meanwhile a second and third click arrive
  const slow = new FakeRun(true);
  const before = FakeRun.created;
  (sw as unknown as { current: FakeRun }).current = slow;
  const p = sw.start(() => new FakeRun(), (r) => r.begin(), 'replaced');
  await tick();
  assert.equal(sw.busy, true); assert.deepEqual(slow.stops, ['replaced']);
  assert.equal(await sw.start(() => new FakeRun(), (r) => r.begin()), null, 'ignored while switching');
  assert.equal(await sw.start(() => new FakeRun(), (r) => r.begin()), null);
  slow.finishStop();
  const next = await p;
  assert.ok(next); assert.equal(FakeRun.created, before + 1, 'only one new Run despite three clicks'); assert.equal(sw.run, next); assert.equal(sw.busy, false);
  assert.equal(sw.owns(a!), false); assert.equal(sw.owns(next!), true);
});

test('Stop during a switch targets the owned Run; a failing previous Stop does not block the next Start', async () => {
  const sw = new RunSwitcher<FakeRun>();
  const bad = new FakeRun();
  bad.stop = () => Promise.reject(new Error('stop exploded'));
  (sw as unknown as { current: FakeRun }).current = bad;
  const next = await sw.start(() => new FakeRun(), (r) => r.begin());
  assert.ok(next); assert.equal(sw.run, next);
  await sw.stop('user');
  assert.deepEqual(next!.stops, ['user']); assert.equal(next!.isActive, false);
  const empty = new RunSwitcher<FakeRun>();
  await empty.stop(); // nothing owned: no throw
  assert.equal(empty.run, null);
});

test('singleFlight: overlapping polls share one request; the next call after settling runs again', async () => {
  let calls = 0; let release: (() => void) | null = null;
  const poll = singleFlight(() => { calls += 1; return new Promise<number>((r) => { release = () => r(calls); }); });
  const a = poll(); const b = poll(); const c = poll();
  assert.equal(calls, 1); assert.equal(poll.inFlight, true); assert.equal(poll.skipped, 2);
  release!();
  assert.deepEqual(await Promise.all([a, b, c]), [1, 1, 1]);
  assert.equal(poll.inFlight, false);
  const d = poll(); release!();
  assert.equal(await d, 2); assert.equal(calls, 2);
  // a rejected poll clears the slot too
  const failing = singleFlight(async () => { throw new Error('down'); });
  await assert.rejects(failing(), /down/);
  assert.equal(failing.inFlight, false);
});

test('backlog source age: oldest unsettled capture and oldest queued transcript are exposed', async () => {
  let release: ((v: { ok: boolean; status: number; text: string }) => void) | null = null;
  const ledger = new SubmissionLedger<{ id: string }>({ send: () => new Promise((r) => { release = r; }), now: () => 10_000 });
  assert.equal(ledger.oldestUnsettledCapturedAt(), null);
  const p1 = ledger.submit('a', { id: 'a' }, 5000);
  assert.equal(ledger.oldestUnsettledCapturedAt(), 5000);
  const r1 = release!; const p2 = ledger.submit('b', { id: 'b' }, 7000);
  assert.equal(ledger.oldestUnsettledCapturedAt(), 5000);
  r1({ ok: true, status: 202, text: '' }); await p1;
  assert.equal(ledger.oldestUnsettledCapturedAt(), 7000, 'settled captures drop out');
  release!({ ok: true, status: 202, text: '' }); await p2;
  assert.equal(ledger.oldestUnsettledCapturedAt(), null);
  assert.equal(ledger.get('a')!.capturedAt, 5000);
  const q = new BoundedRevisionQueue<{ isFinal: boolean; at: number }>(3);
  assert.equal(q.peek(), undefined);
  q.push({ isFinal: false, at: 1 }); q.push({ isFinal: true, at: 2 });
  assert.equal(q.peek()!.at, 1); q.shift(); assert.equal(q.peek()!.at, 2);
});
