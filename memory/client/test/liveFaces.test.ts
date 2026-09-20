// Live face forwarding to POST /api/agent/faces. All face evidence here is synthetic (no camera, no
// InsightFace); the forwarder only sees FaceEvidence objects like the ones the regular ~5 fps loop produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveFaceForwarder, identityKey, type LiveFaceState } from '../src/liveFaces.ts';
import type { FaceEvidence, FaceEvidenceFace } from '../src/types.ts';
import { FakeClock } from './fakes.ts';

const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
const deferred = <T,>(): Deferred<T> => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

let frame = 0;
const face = (personId: string | null, name: string | null = personId ? `Name ${personId}` : null, track = '1'): FaceEvidenceFace =>
  ({ trackId: track, personId, name, similarity: personId ? 0.7 : 0.2, box: [10, 10, 100, 120], identityStatus: personId ? 'confirmed' : 'unknown' });
const evidence = (capturedAt: number, faces: FaceEvidenceFace[], status: FaceEvidence['status'] = 'ready'): FaceEvidence =>
  ({ frameId: `live_${++frame}`, streamId: 'faces_a', capturedAt, status, width: 640, height: 360, faces });

function harness(opts: { sessionId?: string } = {}) {
  const clock = new FakeClock();
  const posts: { sessionId: string; evidence: FaceEvidence; at: number }[] = [];
  const states: LiveFaceState[] = [];
  let gate: Deferred<void> | null = null;
  let failWith: Error | null = null;
  let answer: unknown = { accepted: true };
  const fwd = new LiveFaceForwarder({ sessionId: opts.sessionId ?? 'sess_1', clock, onState: (s) => states.push(s),
    send: async (body) => { posts.push({ ...body, at: clock.now() }); if (gate) await gate.promise; if (failWith) throw failWith; return answer; } });
  fwd.start();
  /** Regular results every 200 ms for `ms` with the given faces. */
  const stream = async (faces: FaceEvidenceFace[], ms: number) => { for (let t = 0; t < ms; t += 200) { fwd.offer(evidence(clock.now(), faces)); await flush(); clock.advance(200); } };
  return { clock, fwd, posts, states, stream, gate: () => { gate = deferred<void>(); return gate; }, ungate: () => { gate = null; }, setFail: (e: Error | null) => { failWith = e; }, setAnswer: (a: unknown) => { answer = a; }, last: () => states.at(-1)! };
}

test('identity keys: confirmed ids sorted, unknown flag, none, unavailable', () => {
  assert.equal(identityKey(evidence(0, [])), 'none');
  assert.equal(identityKey(evidence(0, [face(null)])), 'unknown');
  assert.equal(identityKey(evidence(0, [face('b'), face('a', 'A', '2'), face(null, null, '3')])), 'people:a,b+unknown');
  assert.equal(identityKey(evidence(0, [face('a'), face('a', 'A', '2')])), 'people:a', 'same person twice is one id');
  assert.equal(identityKey(evidence(0, [], 'unavailable')), 'unavailable');
});

test('stable-ID transitions: first stable set is sent once, a single-frame blip is not, disappearance and unknown are sent with the original evidence', async () => {
  const h = harness();
  const t0 = h.clock.now();
  h.fwd.offer(evidence(t0, [face('sam')])); await flush();
  assert.equal(h.posts.length, 0, 'one sighting is not yet stable');
  h.clock.advance(200);
  const second = evidence(h.clock.now(), [face('sam')]);
  h.fwd.offer(second); await flush();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0]!.evidence, second, 'the evidence object is forwarded unchanged (frameId/streamId/capturedAt preserved)');
  assert.equal(h.posts[0]!.sessionId, 'sess_1');
  assert.equal(h.last().identityKey, 'people:sam'); assert.equal(h.last().stage, 'sent');
  // a single frame with nobody, then Sam again: a blip, not a change
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [])); await flush();
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [face('sam')])); await flush();
  assert.equal(h.posts.length, 1, 'blip suppressed'); assert.equal(h.last().counts.blips, 1);
  // Sam leaves for good → "none" after two results
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [])); await flush();
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [])); await flush();
  assert.equal(h.posts.length, 2); assert.deepEqual(h.posts[1]!.evidence.faces, []); assert.equal(h.last().identityKey, 'none');
  // an unknown person appears
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [face(null)])); await flush();
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [face(null)])); await flush();
  assert.equal(h.posts.length, 3); assert.equal(h.last().identityKey, 'unknown');
  assert.equal(h.posts[2]!.evidence.faces[0]!.identityStatus, 'unknown'); assert.equal(h.posts[2]!.evidence.faces[0]!.personId, null);
  // Sam joins the unknown person: a new set
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [face(null), face('sam', 'Sam', '2')])); await flush();
  h.clock.advance(200); h.fwd.offer(evidence(h.clock.now(), [face(null), face('sam', 'Sam', '2')])); await flush();
  assert.equal(h.posts.length, 4); assert.equal(h.last().identityKey, 'people:sam+unknown');
  assert.equal(h.last().counts.changes, 4); assert.equal(h.last().counts.heartbeats, 0);
});

test('heartbeat: an unchanged identity set is re-sent at most once every 3 s, independent of the 5 s photos', async () => {
  const h = harness();
  const t0 = h.clock.now();
  await h.stream([face('sam')], 9000); // results every 200 ms for 9 s
  const times = h.posts.map((p) => p.at - t0);
  assert.deepEqual(times, [200, 3200, 6200], 'change at the 2nd result, then heartbeats every 3000 ms');
  assert.equal(h.last().counts.changes, 1); assert.equal(h.last().counts.heartbeats, 2);
  assert.equal(h.last().lastSentKind, 'heartbeat');
  // each post carried the evidence current at that moment, never an older one
  for (const p of h.posts) assert.equal(p.evidence.capturedAt, p.at);
});

test('one POST in flight; pending is latest-only; a stale pending candidate is dropped instead of sent', async () => {
  const h = harness();
  const g = h.gate();
  h.clock.advance(0);
  await h.stream([face('sam')], 400); // → first POST (change) is now blocked in flight
  assert.equal(h.posts.length, 1); assert.equal(h.last().inFlight, true);
  // while blocked: Sam → nobody → Ana, all stable; only the newest may follow
  await h.stream([], 400);
  await h.stream([face('ana')], 400);
  assert.equal(h.posts.length, 1, 'nothing else sent while in flight');
  assert.equal(h.last().pending, true);
  assert.ok(h.last().counts.superseded >= 1, 'the intermediate "none" candidate was superseded');
  g.resolve(); h.ungate(); await flush(10);
  assert.equal(h.posts.length, 2);
  assert.equal(identityKey(h.posts[1]!.evidence), 'people:ana', 'only the latest pending candidate went out');
  assert.equal(h.last().identityKey, 'people:ana');
  // a pending candidate that ages past 4 s while a POST is stuck is dropped, not replayed
  const g2 = h.gate();
  await h.stream([face('sam')], 400); // change → in flight (blocked)
  await h.stream([face('bo')], 400); // pending change
  assert.equal(h.posts.length, 3);
  h.clock.advance(4500);
  g2.resolve(); h.ungate(); await flush(10);
  assert.equal(h.posts.length, 3, 'stale pending evidence was not sent');
  assert.equal(h.last().counts.staleDropped, 1);
  assert.match(h.last().message, /dropped: evidence \d+ ms old/);
  // the next fresh stable result of that set is a change again
  await h.stream([face('bo')], 400);
  assert.equal(h.posts.length, 4); assert.equal(identityKey(h.posts[3]!.evidence), 'people:bo');
});

test('Stop: nothing is sent afterwards and an in-flight reply is ignored; a new session forwarder starts clean', async () => {
  const h = harness({ sessionId: 'old' });
  const g = h.gate();
  await h.stream([face('sam')], 400);
  assert.equal(h.posts.length, 1);
  await h.stream([face('ana')], 400); // pending
  h.fwd.stop('stopped by user');
  assert.equal(h.last().stage, 'stopped'); assert.equal(h.last().pending, false);
  g.resolve(); h.ungate(); await flush(10);
  assert.equal(h.posts.length, 1, 'the pending candidate was not sent after Stop');
  assert.equal(h.last().stage, 'stopped', 'the late reply did not change the state');
  h.fwd.offer(evidence(h.clock.now(), [face('ana')])); h.fwd.offer(evidence(h.clock.now(), [face('ana')])); await flush();
  assert.equal(h.posts.length, 1, 'offers after Stop are ignored');
  h.fwd.start();
  assert.equal(h.last().stage, 'stopped', 'a stopped forwarder cannot be restarted');
  const h2 = harness({ sessionId: 'new' });
  await h2.stream([face('ana')], 400);
  assert.equal(h2.posts.length, 1); assert.equal(h2.posts[0]!.sessionId, 'new');
  assert.equal(h2.last().counts.offered, 2, 'no state carried over from the old session');
});

test('errors: visible, never replayed; the same identity retries with fresh evidence after a growing delay; recovery sends current evidence; heartbeat backs off', async () => {
  const h = harness();
  const t0 = h.clock.now();
  h.setFail(new Error('POST /api/agent/faces → HTTP 502'));
  await h.stream([face('sam')], 400); // change at +200 → fails
  assert.equal(h.posts.length, 1); assert.equal(h.last().stage, 'failed');
  assert.match(h.last().lastError!, /HTTP 502/); assert.equal(h.last().identityKey, null, 'the server still knows nothing');
  assert.equal(h.last().retryNotBefore, t0 + 1200, 'first retry no earlier than 1 s after the failure');
  await h.stream([face('sam')], 600); // stable sam at 400/600/800: held back, not retried at 5 fps
  assert.equal(h.posts.length, 1, 'no retry inside the backoff window');
  assert.ok(h.last().counts.retryDeferred >= 3);
  await h.stream([face('sam')], 600); // 1000 deferred, 1200 retry (fails), 1400 deferred
  assert.equal(h.posts.length, 2);
  assert.notEqual(h.posts[1]!.evidence.frameId, h.posts[0]!.evidence.frameId, 'not a replay of the failed body');
  assert.equal(h.posts[1]!.evidence.capturedAt, h.posts[1]!.at, 'fresh evidence: captured at the moment of the retry');
  assert.equal(h.last().retryNotBefore, t0 + 3200, 'second delay doubles');
  await h.stream([face('sam')], 2200); // retry at 3200 fails → 3rd consecutive
  assert.equal(h.posts.length, 3);
  assert.equal(h.last().consecutiveFailures, 3);
  assert.equal(h.last().heartbeatMs, 6000, 'heartbeat backed off after 3 consecutive failures');
  assert.equal(h.last().retryNotBefore, t0 + 7200);
  h.setFail(null);
  await h.stream([face('sam')], 4200); // retry at 7200 succeeds with the evidence of that moment
  assert.equal(h.posts.length, 4);
  assert.equal(h.posts[3]!.evidence.capturedAt, t0 + 7200, 'current evidence, not a replay');
  assert.equal(h.last().stage, 'sent'); assert.equal(h.last().identityKey, 'people:sam');
  assert.equal(h.last().consecutiveFailures, 0); assert.equal(h.last().lastError, null); assert.equal(h.last().retryNotBefore, null);
  assert.equal(h.last().heartbeatMs, 3000, 'a success restores the normal heartbeat');
  await h.stream([face('sam')], 3400); // heartbeat at 7200 + 3000
  assert.equal(h.posts.length, 5);
  assert.deepEqual(h.posts.map((p) => p.at - t0), [200, 1200, 3200, 7200, 10200]);
  // accepted:false is a failure too; a genuinely new identity is tried once immediately
  h.setAnswer({ accepted: false });
  await h.stream([face('ana')], 400);
  assert.equal(h.posts.length, 6); assert.equal(h.last().stage, 'failed'); assert.match(h.last().lastError!, /accepted:false/);
  assert.equal(h.last().counts.failed, 4);
});

test('a new stable identity gets one immediate try while a failed identity is backing off; both then wait', async () => {
  const h = harness();
  const t0 = h.clock.now();
  h.setFail(new Error('HTTP 503'));
  await h.stream([face('sam')], 400); // sam fails at 200 → sam waits until 1200
  await h.stream([face('ana')], 400); // ana is new → tried once at 600, fails → both wait until 600 + 2000
  assert.deepEqual(h.posts.map((p) => p.at - t0), [200, 600]);
  assert.equal(h.last().retryNotBefore, t0 + 2600);
  await h.stream([face('sam')], 400);
  await h.stream([face('ana')], 400);
  assert.equal(h.posts.length, 2, 'alternating identities do not bypass the backoff once each has failed');
  assert.ok(h.last().counts.retryDeferred >= 2);
  h.setFail(null);
  await h.stream([face('ana')], 1400); // reaches 2600 → ana retried with fresh evidence and accepted
  assert.equal(h.posts.length, 3); assert.equal(h.posts[2]!.at, t0 + 2600); assert.equal(h.last().identityKey, 'people:ana');
});

test('reset while a request is in flight: the old reply cannot acknowledge the forgotten identity; the one-POST bound holds; only a current-generation candidate drains', async () => {
  const h = harness();
  const g = h.gate();
  await h.stream([face('sam')], 400); // sam change in flight (blocked)
  assert.equal(h.posts.length, 1);
  h.fwd.reset('people deleted');
  const afterReset = h.states.length;
  assert.equal(h.last().identityKey, null); assert.equal(h.last().inFlight, true, 'the physical request is still out');
  await h.stream([face('ana')], 400); // new generation: ana stable → pending (bound: nothing sent yet)
  assert.equal(h.posts.length, 1, 'no second POST while the old one is out');
  assert.equal(h.last().pending, true);
  g.resolve(); h.ungate(); await flush(10); // old reply: accepted, but for a forgotten generation
  assert.equal(h.posts.length, 2, 'the current-generation candidate drained after the old request settled');
  assert.equal(identityKey(h.posts[1]!.evidence), 'people:ana');
  assert.equal(h.last().identityKey, 'people:ana');
  assert.equal(h.last().counts.staleReplies, 1);
  assert.ok(h.states.slice(afterReset).every((s) => s.identityKey !== 'people:sam'), 'the pre-reset person never became acknowledged again');
  // reset with nothing new afterwards: the old reply leaves the identity unknown
  const g2 = h.gate();
  await h.stream([face('bo')], 400);
  h.fwd.reset('face connection recycled');
  g2.resolve(); h.ungate(); await flush(10);
  assert.equal(h.last().identityKey, null); assert.equal(h.last().inFlight, false); assert.equal(h.last().counts.staleReplies, 2);
  await h.stream([face('bo')], 400); // re-sent on the fresh generation
  assert.equal(h.posts.length, 4); assert.equal(h.last().identityKey, 'people:bo');
});

test('pending tracks the latest stable result: a return to the in-flight or acknowledged set drops the pending candidate', async () => {
  const h = harness();
  const g = h.gate();
  await h.stream([face('sam')], 400); // sam change in flight (blocked)
  await h.stream([face('bo')], 400); // bo stable → pending
  assert.equal(h.last().pending, true);
  await h.stream([face('sam')], 400); // faces return to sam (the in-flight set) before the request settles
  assert.equal(h.last().pending, false, 'older bo candidate dropped');
  assert.ok(h.last().counts.superseded >= 1);
  g.resolve(); h.ungate(); await flush(10);
  assert.equal(h.posts.length, 1, 'bo was never sent'); assert.equal(h.last().identityKey, 'people:sam');
  // same with an acknowledged set and an in-flight heartbeat
  h.clock.advance(3000);
  const g2 = h.gate();
  await h.stream([face('sam')], 200); // heartbeat in flight (blocked)
  assert.equal(h.posts.length, 2); assert.equal(h.posts[1]!.evidence.faces[0]!.personId, 'sam');
  await h.stream([face('ana')], 400); // pending ana
  assert.equal(h.last().pending, true);
  await h.stream([face('sam')], 400); // back to the acknowledged set
  assert.equal(h.last().pending, false);
  g2.resolve(); h.ungate(); await flush(10);
  assert.equal(h.posts.length, 2, 'ana was never sent');
  // stable repeats of the in-flight change are not queued as a duplicate change
  const g3 = h.gate();
  await h.stream([face('bo')], 400); // bo change in flight
  await h.stream([face('bo')], 1000); // bo keeps being stable
  assert.equal(h.last().pending, false, 'no duplicate of the in-flight change');
  g3.resolve(); h.ungate(); await flush(10);
  assert.equal(h.posts.length, 3);
});
