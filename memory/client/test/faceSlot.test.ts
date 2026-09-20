import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FaceSlot, type ScheduledPhoto, type ScheduledResult, type RegularResult } from '../src/faceSlot.ts';
import { FakeClock, bytes } from './fakes.ts';

function harness(opts: { maxQueue?: number; responseTimeoutMs?: number; maxQueueWaitMs?: number } = {}) {
  const clock = new FakeClock();
  const sent: { jpeg: ArrayBuffer; epoch: number }[] = [];
  const scheduled: ScheduledResult[] = [];
  const regular: RegularResult[] = [];
  const gaps: string[] = [];
  const stale: string[] = [];
  const reconnects: string[] = [];
  let sendOk = true;
  const slot = new FaceSlot({ clock, ...opts, events: {
    send: (jpeg, epoch) => { if (!sendOk) return false; sent.push({ jpeg, epoch }); return true; },
    onRegularResult: (r) => regular.push(r),
    onScheduledResult: (r) => scheduled.push(r),
    onGap: (g) => gaps.push(g.reason),
    onStaleReply: (s) => stale.push(s.reason),
    requestReconnect: (r) => reconnects.push(r),
  } });
  return { clock, slot, sent, scheduled, regular, gaps, stale, reconnects, setSendOk: (v: boolean) => { sendOk = v; } };
}
const photo = (id: string, capturedAt: number, fill: number, enqueuedAt: number): ScheduledPhoto =>
  ({ id, sequence: 1, capturedAt, faceJpeg: bytes(64, fill), faceWidth: 640, faceHeight: 360, enqueuedAt });
const reply = (wh: [number, number], faces: unknown[] = []) => ({ type: 'frame' as const, frame_id: 1, faces: faces as never, input_wh: wh });

test('slow regular request at a photo tick: the scheduled photo waits and is sent unchanged at the next slot', () => {
  const h = harness();
  h.slot.socketReady(1, 'faces_a');
  assert.equal(h.slot.offerRegular(bytes(64, 9), { id: 'live1', capturedAt: h.clock.now(), width: 640, height: 360 }), true);
  const p = photo('cap1', h.clock.now() + 10, 7, h.clock.now() + 10);
  h.clock.advance(10);
  assert.equal(h.slot.enqueueScheduled(p), 'queued');
  assert.equal(h.sent.length, 1, 'nothing else sent while a request is outstanding');
  // a regular frame offered now must be refused: the photo has priority for the next slot
  assert.equal(h.slot.offerRegular(bytes(64, 8), { id: 'live2', capturedAt: h.clock.now(), width: 640, height: 360 }), false);
  h.clock.advance(900); // slow face model
  h.slot.onReply(reply([640, 360]), 1);
  assert.equal(h.regular.length, 1);
  assert.equal(h.sent.length, 2);
  assert.equal(new Uint8Array(h.sent[1]!.jpeg)[0], 7, 'the retained derivative bytes were sent, not a newer frame');
  h.slot.onReply(reply([640, 360], [{ track_id: 3, box: [10, 10, 50, 60], stable_id: 'uuid-1', stable_name: 'Sarah', match: { id: 'uuid-1', similarity: 0.7 } }]), 1);
  assert.equal(h.scheduled.length, 1);
  const r = h.scheduled[0]!;
  assert.equal(r.photo, p);
  assert.equal(r.evidence.frameId, 'cap1');
  assert.equal(r.evidence.capturedAt, p.capturedAt);
  assert.deepEqual([r.evidence.width, r.evidence.height], [640, 360]);
  assert.equal(r.evidence.status, 'ready');
  assert.equal(r.evidence.faces[0]!.personId, 'uuid-1');
  assert.equal(r.rttMs, 0);
});

test('reply with mismatched geometry never binds to a scheduled photo; it becomes explicit unavailable', () => {
  const h = harness();
  h.slot.socketReady(1, 'faces_a');
  const p = photo('cap2', h.clock.now(), 1, h.clock.now());
  assert.equal(h.slot.enqueueScheduled(p), 'sent');
  h.slot.onReply(reply([320, 180], [{ track_id: 1, box: [1, 1, 5, 5], stable_id: 'x', stable_name: 'X' }]), 1);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.evidence.status, 'unavailable');
  assert.equal(h.scheduled[0]!.evidence.faces.length, 0);
  assert.match(h.gaps[0]!, /geometry/);
});

test('stale replies (old socket epoch / nothing outstanding) cannot resolve a newer flight', () => {
  const h = harness();
  h.slot.socketReady(1, 'faces_a');
  h.slot.onReply(reply([640, 360]), 1);
  assert.equal(h.stale.length, 1, 'reply with nothing outstanding is stale');
  const p = photo('cap3', h.clock.now(), 2, h.clock.now());
  h.slot.socketReady(2, 'faces_b');
  assert.equal(h.slot.enqueueScheduled(p), 'sent');
  h.slot.onReply(reply([640, 360], [{ track_id: 1, box: [0, 0, 10, 10], stable_id: 'wrong', stable_name: 'Wrong' }]), 1);
  assert.equal(h.stale.length, 2);
  assert.equal(h.scheduled.length, 0, 'old-epoch reply did not resolve the new flight');
  h.slot.onReply(reply([640, 360]), 2);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.evidence.streamId, 'faces_b');
  assert.equal(h.scheduled[0]!.evidence.faces.length, 0);
});

test('face timeout: scheduled photo submitted unavailable, reconnect requested, late reply ignored', () => {
  const h = harness({ responseTimeoutMs: 1000 });
  h.slot.socketReady(1, 'faces_a');
  const p = photo('cap4', h.clock.now(), 3, h.clock.now());
  h.slot.enqueueScheduled(p);
  h.clock.advance(1000);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.evidence.status, 'unavailable');
  assert.equal(h.scheduled[0]!.evidence.frameId, 'cap4');
  assert.deepEqual(h.reconnects, ['face reply timeout after 1000 ms']);
  assert.equal(h.slot.isReady, false);
  h.slot.onReply(reply([640, 360], [{ track_id: 1, box: [0, 0, 5, 5], stable_id: 'late', stable_name: 'Late' }]), 1);
  assert.equal(h.stale.length, 1);
  assert.equal(h.scheduled.length, 1, 'the late reply produced no second result');
});

test('bounded queue: overflow is a visible gap and the overflowing photo is still submitted without faces', () => {
  const h = harness({ maxQueue: 1 });
  h.slot.socketReady(1, 'faces_a');
  const t = h.clock.now();
  assert.equal(h.slot.enqueueScheduled(photo('a', t, 1, t)), 'sent');
  assert.equal(h.slot.enqueueScheduled(photo('b', t + 5000, 2, t + 5000)), 'queued');
  assert.equal(h.slot.enqueueScheduled(photo('c', t + 10000, 3, t + 10000)), 'rejected');
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.photo.id, 'c');
  assert.equal(h.scheduled[0]!.evidence.status, 'unavailable');
  assert.match(h.gaps[0]!, /queue full/);
});

test('queued photo that waits too long expires as unavailable; drain on Stop reports every pending photo explicitly', () => {
  const h = harness({ maxQueueWaitMs: 3000 });
  h.slot.socketReady(1, 'faces_a');
  const t = h.clock.now();
  h.slot.enqueueScheduled(photo('a', t, 1, t));
  h.slot.enqueueScheduled(photo('b', t, 2, t));
  h.clock.advance(3500);
  h.slot.sweep();
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.photo.id, 'b');
  assert.match(h.scheduled[0]!.reason!, /waited/);
  h.slot.enqueueScheduled(photo('c', t, 3, h.clock.now()));
  h.slot.drain('stopped by user');
  assert.deepEqual(h.scheduled.slice(1).map((r) => [r.photo.id, r.evidence.status]), [['a', 'unavailable'], ['c', 'unavailable']]);
  assert.match(h.scheduled[1]!.reason!, /before face reply/);
  assert.equal(h.slot.busy, false);
  assert.equal(h.slot.queued, 0);
  // a reply arriving after drain is stale and produces nothing
  h.slot.onReply(reply([640, 360]), 1);
  assert.equal(h.scheduled.length, 3);
  // photo 'a' was outstanding at drain time → this socket owes a reply and is untrustworthy; a new epoch is required
  assert.equal(h.slot.isReady, false);
  assert.deepEqual(h.reconnects, ['stopped by user abandoned an outstanding face request']);
  assert.equal(h.slot.enqueueScheduled(photo('final', t, 9, h.clock.now())), 'queued');
  h.slot.socketReady(2, 'faces_b');
  assert.equal(h.sent.at(-1)!.epoch, 2);
  h.slot.onReply(reply([640, 360], [{ track_id: 1, box: [0, 0, 5, 5], stable_id: 'u', stable_name: 'U' }]), 2);
  assert.equal(h.scheduled[3]!.photo.id, 'final'); assert.equal(h.scheduled[3]!.evidence.status, 'ready');
});

test('socket loss with an outstanding scheduled photo reports unavailable under the socket that sent it', () => {
  const h = harness();
  h.slot.socketReady(1, 'faces_a');
  h.slot.enqueueScheduled(photo('a', h.clock.now(), 1, h.clock.now()));
  h.slot.socketLost(1, 'closed');
  assert.equal(h.scheduled[0]!.evidence.status, 'unavailable');
  assert.equal(h.scheduled[0]!.evidence.streamId, 'faces_a');
  // photo scheduled while disconnected waits, then goes out on the new socket
  h.slot.enqueueScheduled(photo('b', h.clock.now(), 2, h.clock.now()));
  assert.equal(h.sent.length, 1);
  h.slot.socketReady(2, 'faces_b');
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]!.epoch, 2);
  h.slot.onReply(reply([640, 360]), 2);
  assert.equal(h.scheduled[1]!.evidence.streamId, 'faces_b');
});

test('busy answer re-queues the scheduled photo (bounded) and drops a regular frame', () => {
  const h = harness();
  h.slot.socketReady(1, 'faces_a');
  h.slot.offerRegular(bytes(8), { id: 'l', capturedAt: h.clock.now(), width: 640, height: 360 });
  h.slot.onBusy(1);
  assert.equal(h.regular.length, 0);
  h.slot.enqueueScheduled(photo('a', h.clock.now(), 5, h.clock.now()));
  for (let i = 0; i < 6; i += 1) { h.slot.onBusy(1); h.clock.advance(200); }
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.evidence.status, 'unavailable');
  assert.match(h.gaps.at(-1)!, /busy/);
});

test('drain with an outstanding regular frame: its late reply arriving AFTER the final snapshot is queued never binds to it', () => {
  const h = harness();
  h.slot.socketReady(1, 'faces_a');
  h.slot.offerRegular(bytes(8, 1), { id: 'old-live', capturedAt: h.clock.now(), width: 640, height: 360 });
  h.slot.drain('user stop');
  assert.equal(h.slot.isReady, false, 'abandoned outstanding request makes the socket untrustworthy');
  assert.equal(h.reconnects.length, 1);
  h.clock.advance(3000); // speech flush
  const final = photo('final', h.clock.now(), 2, h.clock.now());
  assert.equal(h.slot.enqueueScheduled(final), 'queued', 'not sent on the tainted epoch');
  h.slot.onReply(reply([640, 360], [{ track_id: 1, box: [10, 10, 40, 50], stable_id: 'wrong-old-person', stable_name: 'Old' }]), 1);
  assert.equal(h.scheduled.length, 0, 'old reply produced no result');
  assert.equal(h.stale.length, 1);
  h.slot.socketReady(2, 'faces_b');
  assert.equal(h.sent.length, 2); assert.equal(h.sent[1]!.epoch, 2); assert.equal(new Uint8Array(h.sent[1]!.jpeg)[0], 2);
  h.slot.onReply(reply([640, 360], [{ track_id: 1, box: [10, 10, 40, 50], stable_id: 'wrong-old-person', stable_name: 'Old' }]), 1);
  assert.equal(h.scheduled.length, 0, 'a second old-epoch reply while the final is outstanding is also rejected');
  h.slot.onReply(reply([640, 360], [{ track_id: 4, box: [1, 1, 9, 9], stable_id: 'right-person', stable_name: 'Right' }]), 2);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]!.photo.id, 'final'); assert.equal(h.scheduled[0]!.evidence.streamId, 'faces_b');
  assert.equal(h.scheduled[0]!.evidence.faces[0]!.personId, 'right-person');
  // if no new socket comes in time, a Stop-side drain yields explicit unavailable rather than old data
  const h2 = harness(); h2.slot.socketReady(1, 'x');
  h2.slot.offerRegular(bytes(8, 1), { id: 'l', capturedAt: h2.clock.now(), width: 640, height: 360 });
  h2.slot.drain('user stop');
  h2.slot.enqueueScheduled(photo('final2', h2.clock.now(), 2, h2.clock.now()));
  h2.slot.drain('Stop face wait exceeded');
  assert.deepEqual([h2.scheduled[0]!.photo.id, h2.scheduled[0]!.evidence.status, h2.scheduled[0]!.evidence.faces.length], ['final2', 'unavailable', 0]);
});
