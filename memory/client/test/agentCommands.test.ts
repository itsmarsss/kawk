import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandPoller, isExpired, type AgentCommand, type CommandTransport, type InterruptState } from '../src/agentCommands.ts';
import { createAnchoredTicker } from '../src/cadence.ts';
import { SequenceAllocator } from '../src/sequence.ts';
import { FakeClock } from './fakes.ts';

const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
const deferred = <T,>(): Deferred<T> => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

function harness(opts: { sessionId?: string; intervalMs?: number } = {}) {
  const clock = new FakeClock();
  const polls: string[] = [];
  const claims: { id: string; sessionId: string }[] = [];
  const results: { id: string; body: { sessionId: string; captureId?: string; error?: string } }[] = [];
  const captures: string[] = [];
  const states: InterruptState[] = [];
  let queue: AgentCommand[] = [];
  let pollError: Error | null = null;
  let pollGate: Deferred<void> | null = null;
  let claimAnswer: boolean | Error = true;
  let claimGate: Deferred<void> | null = null;
  let captureImpl: (id: string) => Promise<string> = async (id) => `cap_for_${id}`;
  let pollsInFlight = 0; let maxPollsInFlight = 0;
  const transport: CommandTransport = {
    poll: async (sessionId) => {
      pollsInFlight += 1; maxPollsInFlight = Math.max(maxPollsInFlight, pollsInFlight);
      try {
        polls.push(sessionId);
        if (pollGate) await pollGate.promise;
        if (pollError) throw pollError;
        const out = queue; queue = [];
        return { commands: out };
      } finally { pollsInFlight -= 1; }
    },
    claim: async (id, sessionId) => { claims.push({ id, sessionId }); if (claimGate) await claimGate.promise; if (claimAnswer instanceof Error) throw claimAnswer; return { claimed: claimAnswer }; },
    result: async (id, body) => { results.push({ id, body }); return {}; },
  };
  const poller = new CommandPoller({ sessionId: opts.sessionId ?? 'sess_1', clock, transport, intervalMs: opts.intervalMs ?? 400,
    capture: (id) => { captures.push(id); return captureImpl(id); }, onState: (s) => states.push(s) });
  return {
    clock, poller, polls, claims, results, captures, states, transport,
    enqueue: (...c: AgentCommand[]) => { queue.push(...c); },
    setPollError: (e: Error | null) => { pollError = e; },
    gatePolls: () => { pollGate = deferred<void>(); return pollGate; },
    ungatePolls: () => { pollGate = null; },
    setClaim: (v: boolean | Error) => { claimAnswer = v; },
    gateClaims: () => { claimGate = deferred<void>(); return claimGate; },
    setCapture: (fn: (id: string) => Promise<string>) => { captureImpl = fn; },
    get maxPollsInFlight() { return maxPollsInFlight; },
    stage: () => states.at(-1)?.stage,
  };
}
const cmd = (id: string, extra: Partial<AgentCommand> = {}): AgentCommand => ({ id, type: 'capture', reason: 'agent wants a fresh look', createdAt: 0, ...extra });

test('interrupt between two anchored ticks: captured immediately, unique increasing sequence, ticks not shifted', async () => {
  const h = harness();
  const seq = new SequenceAllocator();
  const photos: { kind: string; sequence: number; at: number }[] = [];
  const ticker = createAnchoredTicker({ intervalMs: 5000, clock: h.clock, onTick: (t) => { photos.push({ kind: `tick${t.index}`, sequence: seq.next(), at: h.clock.now() }); } });
  h.setCapture(async (id) => { photos.push({ kind: `interrupt:${id}`, sequence: seq.next(), at: h.clock.now() }); return `cap_${id}`; });
  const anchor = h.clock.now();
  ticker.start(anchor);
  h.poller.start();
  await flush(); // first poll resolves; the next one is armed for +400 ms
  h.clock.advance(2000); await flush(); // t=2000: between tick 0 (t=0) and tick 1 (t=5000); polls at 400/800/… answered empty
  h.enqueue(cmd('c1', { expiresAt: h.clock.now() + 10_000 }));
  h.clock.advance(400); await flush(); // t=2400: the poll that sees c1
  assert.deepEqual(h.claims, [{ id: 'c1', sessionId: 'sess_1' }]);
  await flush(10);
  assert.deepEqual(h.captures, ['c1']);
  assert.equal(h.results.length, 1);
  assert.deepEqual(h.results[0], { id: 'c1', body: { sessionId: 'sess_1', captureId: 'cap_c1' } });
  assert.equal(h.stage(), 'captured');
  assert.match(h.states.at(-1)!.message, /interpretation pending/);
  h.clock.advance(3000); // reaches t=5400 → tick 1 fired at exactly anchor+5000
  ticker.stop(); h.poller.stop('test');
  assert.deepEqual(photos.map((p) => [p.kind, p.sequence, p.at - anchor]), [['tick0', 0, 0], ['interrupt:c1', 1, 2400], ['tick1', 2, 5000]]);
  const seqs = photos.map((p) => p.sequence);
  assert.deepEqual(seqs, [...new Set(seqs)], 'no duplicate sequence numbers');
  assert.ok(seqs.every((v, i) => i === 0 || v > seqs[i - 1]!), 'strictly increasing');
});

test('polling keeps exactly one request in flight and stops on Stop', async () => {
  const h = harness();
  const gate = h.gatePolls();
  h.poller.start();
  await flush();
  h.clock.advance(400); h.clock.advance(400); h.clock.advance(400); await flush();
  assert.equal(h.polls.length, 1, 'a slow poll blocks the next one; timers do not stack');
  gate.resolve(); h.ungatePolls(); await flush();
  h.clock.advance(400); await flush();
  assert.equal(h.polls.length, 2);
  assert.equal(h.maxPollsInFlight, 1);
  h.poller.stop('stopped by user');
  h.clock.advance(5000); await flush();
  assert.equal(h.polls.length, 2, 'no polls after Stop');
  assert.equal(h.stage(), 'stopped');
  assert.equal(h.clock.pending, 0, 'Stop cleared the armed timer');
});

test('stale/restart: Stop while claiming → no capture and no result for the dead session; a new session starts clean', async () => {
  const h = harness({ sessionId: 'old' });
  const claimGate = h.gateClaims();
  h.poller.start(); await flush();
  h.enqueue(cmd('c9'));
  h.clock.advance(400); await flush();
  assert.equal(h.claims.length, 1);
  h.poller.stop('replaced by a new Start');
  claimGate.resolve(); await flush(12);
  assert.deepEqual(h.captures, [], 'claim resolved after Stop: nothing is captured');
  assert.deepEqual(h.results, [], 'nothing reported for the dead session');
  // a stale capture resolving after Stop is dropped too
  const h2 = harness({ sessionId: 'old2' });
  const capGate = deferred<string>();
  h2.setCapture(() => capGate.promise);
  h2.poller.start(); await flush();
  h2.enqueue(cmd('c10'));
  h2.clock.advance(400); await flush(12);
  assert.deepEqual(h2.captures, ['c10']);
  h2.poller.stop('stopped');
  capGate.resolve('cap_late'); await flush(12);
  assert.deepEqual(h2.results, [], 'late capture result never reported');
  assert.equal(h2.stage(), 'stopped');
  // the new session's poller carries no state from the old one
  const h3 = harness({ sessionId: 'new' });
  h3.poller.start(); await flush();
  assert.deepEqual(h3.polls, ['new']);
  assert.equal(h3.claims.length, 0);
});

test('expired commands are ignored without a claim; not-claimed answers never capture', async () => {
  const h = harness();
  h.poller.start(); await flush();
  h.enqueue(cmd('expired', { expiresAt: h.clock.now() - 1 }));
  h.clock.advance(400); await flush(10);
  assert.equal(h.claims.length, 0);
  assert.equal(h.states.at(-1)!.counts.expired, 1);
  assert.equal(isExpired(cmd('x', { expiresAt: h.clock.now() }), h.clock.now()), true);
  assert.equal(isExpired(cmd('x'), h.clock.now()), false, 'missing expiry is not expired');
  h.setClaim(false);
  h.enqueue(cmd('taken'));
  h.clock.advance(400); await flush(10);
  assert.deepEqual(h.claims.map((c) => c.id), ['taken']);
  assert.deepEqual(h.captures, []);
  assert.equal(h.states.at(-1)!.counts.notClaimed, 1);
  assert.equal(h.stage(), 'polling');
  h.poller.stop();
});

test('duplicate delivery of the same command id is claimed and captured once', async () => {
  const h = harness();
  h.poller.start(); await flush();
  h.enqueue(cmd('dup'), cmd('dup'));
  h.clock.advance(400); await flush(10);
  h.enqueue(cmd('dup'));
  h.clock.advance(400); await flush(10);
  assert.deepEqual(h.claims.map((c) => c.id), ['dup']);
  assert.deepEqual(h.captures, ['dup']);
  assert.equal(h.results.length, 1);
  h.poller.stop();
});

test('capture failure is reported as an error result; claim failure is visible; a rejected type is ignored', async () => {
  const h = harness();
  h.poller.start(); await flush();
  h.setCapture(async () => { throw new Error('no video frame available'); });
  h.enqueue(cmd('bad'), { id: 'other', type: 'speak' });
  h.clock.advance(400); await flush(12);
  assert.deepEqual(h.results, [{ id: 'bad', body: { sessionId: 'sess_1', error: 'no video frame available' } }]);
  assert.equal(h.stage(), 'failed');
  assert.equal(h.states.at(-1)!.counts.ignored, 1);
  h.setClaim(new Error('HTTP 500'));
  h.enqueue(cmd('c2'));
  h.clock.advance(400); await flush(12);
  assert.equal(h.stage(), 'failed');
  assert.match(h.states.at(-1)!.message, /claim failed: HTTP 500/);
  assert.deepEqual(h.captures, ['bad'], 'a failed claim never captures (only the earlier command did)');
  assert.equal(h.results.length, 1, 'no result posted for a command that was never claimed');
  h.poller.stop();
});

test('endpoint unavailable: visible, backs off, keeps one request in flight, recovers', async () => {
  const h = harness();
  h.setPollError(new Error('GET /api/agent/commands → HTTP 404'));
  h.poller.start(); await flush();
  assert.equal(h.stage(), 'unavailable');
  assert.equal(h.states.at(-1)!.pollingHealthy, false);
  assert.match(h.states.at(-1)!.message, /HTTP 404/);
  h.clock.advance(400); await flush();
  assert.equal(h.polls.length, 1, 'first retry waits longer than the base interval');
  h.clock.advance(400); await flush();
  assert.equal(h.polls.length, 2);
  h.clock.advance(1600); await flush();
  assert.equal(h.polls.length, 3, 'backoff doubles');
  h.setPollError(null);
  h.clock.advance(3200); await flush();
  assert.equal(h.stage(), 'polling');
  assert.equal(h.states.at(-1)!.pollingHealthy, true);
  assert.equal(h.states.at(-1)!.lastPollError, null);
  h.clock.advance(400); await flush();
  assert.equal(h.maxPollsInFlight, 1);
  h.poller.stop();
});
