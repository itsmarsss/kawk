import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, FakeWebSocket, installFakeWebSocket } from './fakes.ts';
import { FaceSlot } from '../src/faceSlot.ts';
import type { EnrollmentReply, IntroductionReply } from '../src/introductions.ts';

installFakeWebSocket();
const { FaceLink } = await import('../src/faceLink.ts');

const payload = { type: 'introduction' as const, text: 'this is Sam', is_final: true as const, segment_id: '7', revision: 1, stream_id: 'speech_a', start_at: 1000, end_at: 2500 };

function harness() {
  const clock = new FakeClock();
  const intros: { reply: IntroductionReply; epoch: number }[] = [];
  const enrollments: { reply: EnrollmentReply; epoch: number }[] = [];
  const errors: string[] = [];
  const phases: string[] = [];
  const slot = new FaceSlot({ clock, events: { send: (jpeg, epoch) => link.send(jpeg, epoch), onRegularResult: () => {}, onScheduledResult: () => {}, onGap: () => {}, onStaleReply: () => {}, requestReconnect: (r) => link.reconnect(r) } });
  const link: InstanceType<typeof FaceLink> = new FaceLink({ url: 'ws://localhost:8082/ws/faces?backend=local', slot, clock,
    onStatus: (s) => phases.push(s.phase), onError: (m) => errors.push(m),
    onIntroduction: (reply, epoch) => intros.push({ reply, epoch }), onEnrollment: (reply, epoch) => enrollments.push({ reply, epoch }) });
  return { clock, link, slot, intros, enrollments, errors, phases, sockets: FakeWebSocket.instances };
}
const controls = (ws: FakeWebSocket) => ws.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m) as { type: string });

test('introductions go out only on the ready socket whose epoch was bound; stale or unready epochs are refused', () => {
  const h = harness();
  h.link.start();
  const ws1 = h.sockets.at(-1)!;
  ws1.serverOpen();
  assert.equal(h.link.currentEpoch, 1);
  assert.equal(h.link.sendIntroduction(payload, 1), false, 'open but the server has not sent ready yet');
  ws1.serverSend({ type: 'ready', model: 'buffalo_l', backend: 'local' });
  assert.equal(h.link.isReady, true);
  assert.equal(h.link.sendIntroduction(payload, 0), false, 'epoch 0 was never a connection');
  assert.equal(h.link.sendIntroduction(payload, 1), true);
  assert.deepEqual(controls(ws1), [payload], 'the control message is the exact payload, as JSON text');
  ws1.serverSend({ type: 'introduction', status: 'deciding', message: 'Jev deciding' });
  ws1.serverSend({ type: 'introduction', status: 'nonsense' });
  assert.deepEqual(h.intros, [{ reply: { status: 'deciding', message: 'Jev deciding', name: null, personId: null }, epoch: 1 }]);
  assert.match(h.errors.join('\n'), /malformed introduction reply/);
  ws1.serverSend({ type: 'frame', frame_id: 3, faces: [], input_wh: [640, 360], enrollment: { status: 'collecting', name: 'Sam', collected: 1, required: 5 } });
  assert.deepEqual(h.enrollments, [{ reply: { status: 'collecting', name: 'Sam', personId: null, collected: 1, required: 5, message: null }, epoch: 1 }]);
});

test('a people reset recycles the connection now; the old epoch can never receive an introduction again', () => {
  const h = harness();
  h.link.start();
  const ws1 = h.sockets.at(-1)!;
  ws1.serverOpen(); ws1.serverSend({ type: 'ready', model: 'buffalo_l', backend: 'local' });
  h.link.resetConnection('people deleted');
  assert.equal(ws1.readyState, FakeWebSocket.CLOSED);
  assert.equal(h.link.current.phase, 'reconnecting');
  assert.equal(h.link.sendIntroduction(payload, 1), false, 'the bound epoch is gone with its socket');
  h.clock.advance(1000);
  const ws2 = h.sockets.at(-1)!;
  assert.notEqual(ws2, ws1);
  assert.equal(h.link.currentEpoch, 2);
  ws2.serverOpen();
  assert.equal(h.link.sendIntroduction(payload, 2), false, 'not ready yet on the new socket');
  ws2.serverSend({ type: 'ready', model: 'buffalo_l', backend: 'local' });
  assert.equal(h.link.sendIntroduction(payload, 1), false, 'an introduction bound to epoch 1 is never replayed into epoch 2');
  assert.equal(controls(ws2).length, 0);
  assert.equal(h.link.sendIntroduction(payload, 2), true);
  assert.equal(controls(ws2).length, 1);
  // replies from the dead socket are ignored
  ws1.serverSend({ type: 'introduction', status: 'complete', message: 'ghost' });
  assert.equal(h.intros.length, 0);
  h.link.stop();
  assert.equal(h.link.sendIntroduction(payload, 2), false);
  assert.equal(h.clock.pending, 0, 'no timers left behind');
});
