import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, FakeWebSocket, installFakeWebSocket, bytes } from './fakes.ts';
import { CHUNK_BYTES, CHUNK_MS } from '../src/speechTiming.ts';
import type { Transcript } from '../src/types.ts';

installFakeWebSocket();
const { SpeechLink } = await import('../src/speechLink.ts');

function harness() {
  const clock = new FakeClock();
  const posted: Transcript[] = [];
  const errors: string[] = [];
  const phases: string[] = [];
  const link = new SpeechLink({ url: 'ws://localhost:8082/ws/speech?backend=baseten', sessionId: 'sess1', clock,
    onTranscript: (t) => posted.push(t), onStatus: (s) => phases.push(s.phase), onError: (m) => errors.push(m) });
  return { clock, link, posted, errors, phases, sockets: FakeWebSocket.instances };
}
const feedChunks = (h: ReturnType<typeof harness>, n: number) => { for (let i = 0; i < n; i += 1) { h.link.feed({ buffer: bytes(CHUNK_BYTES, 3), captureTsMs: h.clock.now() - CHUNK_MS }); h.clock.advance(CHUNK_MS); } };

test('PCM before ready is dropped, offsets anchor to the first chunk sent after ready, partials then finals post revisions', () => {
  const h = harness();
  h.link.start();
  const ws = h.sockets.at(-1)!;
  ws.serverOpen();
  feedChunks(h, 10); // 320 ms of microphone audio while the cloud is still connecting
  assert.equal(ws.binarySent.length, 0);
  assert.equal(h.link.current.chunksDroppedNotReady, 10);
  ws.serverSend({ type: 'ready', backend: 'baseten', model: 'Whisper', sample_rate: 16000, chunk_samples: 512 });
  const firstSentSource = h.clock.now() - CHUNK_MS;
  feedChunks(h, 100);
  assert.equal(ws.binarySent.length, 100);
  assert.equal(h.link.current.anchoredAt, null, 'status anchor is reported once a transcript maps words');
  ws.serverSend({ type: 'transcript', segment_id: '1', text: 'where are', is_final: false, words: [] });
  ws.serverSend({ type: 'transcript', segment_id: '1', text: 'where are', is_final: false, words: [] }); // identical partial
  ws.serverSend({ type: 'transcript', segment_id: '1', text: 'where are my keys', is_final: true,
    words: [{ word: 'where', start_time: 0.5, end_time: 0.8 }, { word: 'keys', start_time: 2.0, end_time: 2.4 }] });
  assert.equal(h.posted.length, 2, 'duplicate partial suppressed');
  assert.deepEqual(h.posted.map((t) => [t.revision, t.isFinal]), [[0, false], [1, true]]);
  const partial = h.posted[0]!;
  assert.equal(partial.startAt, firstSentSource, 'no-word partial is bounded by the anchor');
  assert.equal(partial.endAt, firstSentSource + 100 * CHUNK_MS, '…and by the current sent-audio position');
  const final = h.posted[1]!;
  assert.equal(final.words[0]!.startAt, firstSentSource + 500);
  assert.equal(final.words[1]!.endAt, firstSentSource + 2400);
  assert.equal(final.speakerId, null); assert.equal(final.timing, 'approximate'); assert.equal(final.sessionId, 'sess1');
  assert.equal(final.streamId, h.link.current.streamId);
  assert.equal(h.link.current.anchoredAt, firstSentSource);
});

test('a dropped connection reconnects into a NEW streamId with a fresh anchor; the old socket cannot post anymore', () => {
  const h = harness();
  h.link.start();
  const ws1 = h.sockets.at(-1)!;
  ws1.serverOpen(); ws1.serverSend({ type: 'ready' });
  const stream1 = h.link.current.streamId!;
  feedChunks(h, 20);
  ws1.serverSend({ type: 'error', message: 'Refreshing the speech connection' });
  ws1.serverClose();
  assert.equal(h.link.current.phase, 'reconnecting');
  ws1.serverSend({ type: 'transcript', segment_id: '1', text: 'ghost', is_final: true, words: [] });
  assert.equal(h.posted.length, 0, 'transcript on the dead socket is ignored');
  feedChunks(h, 5);
  assert.equal(h.link.current.chunksDroppedNotReady, 5, 'chunks are dropped, never queued, between attempts');
  h.clock.advance(1000);
  const ws2 = h.sockets.at(-1)!;
  assert.notEqual(ws2, ws1);
  ws2.serverOpen(); ws2.serverSend({ type: 'ready' });
  const stream2 = h.link.current.streamId!;
  assert.notEqual(stream2, stream1);
  const anchor2 = h.clock.now() - CHUNK_MS;
  feedChunks(h, 50);
  ws2.serverSend({ type: 'transcript', segment_id: '1', text: 'fresh', is_final: true, words: [{ word: 'fresh', start_time: 0.0, end_time: 0.5 }] });
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0]!.streamId, stream2);
  assert.equal(h.posted[0]!.revision, 0, 'segment "1" in the new namespace starts at revision 0');
  assert.equal(h.posted[0]!.words[0]!.startAt, anchor2, 'anchored to the first PCM sent on the NEW socket');
  assert.match(h.errors.join('\n'), /Refreshing the speech connection/);
});

test('sustained backpressure reconnects into a fresh namespace instead of shifting later words', () => {
  const h = harness();
  h.link.start();
  const ws1 = h.sockets.at(-1)!;
  ws1.serverOpen(); ws1.serverSend({ type: 'ready' });
  feedChunks(h, 10);
  ws1.bufferedAmount = 1_000_000;
  feedChunks(h, 40);
  assert.equal(ws1.binarySent.length, 10);
  assert.equal(h.link.current.phase, 'reconnecting');
  assert.ok(h.link.current.chunksDroppedBackpressure >= 31);
});

test('Stop sends ~500 ms of paced silence then {type:"stop"}, waits for the final, and releases the socket', async () => {
  const h = harness();
  h.link.start();
  const ws = h.sockets.at(-1)!;
  ws.serverOpen(); ws.serverSend({ type: 'ready' });
  feedChunks(h, 30);
  const stopping = h.link.stop();
  assert.equal(h.link.current.phase, 'stopping');
  feedChunks(h, 3); // microphone chunks after Stop are not forwarded
  h.clock.advance(16 * CHUNK_MS + 1);
  const zeros = ws.binarySent.slice(30);
  assert.equal(zeros.length, 16);
  assert.ok(zeros.every((b) => b.byteLength === CHUNK_BYTES && new Uint8Array(b).every((v) => v === 0)));
  assert.equal(ws.sent.at(-1), JSON.stringify({ type: 'stop' }));
  // the last final still arrives in the SAME namespace after stop was sent
  ws.serverSend({ type: 'transcript', segment_id: '2', text: 'bye', is_final: true, words: [{ word: 'bye', start_time: 0.5, end_time: 0.9 }] });
  assert.equal(h.posted.length, 1);
  ws.serverClose();
  await stopping;
  assert.equal(h.link.current.phase, 'stopped');
  assert.equal(ws.readyState, FakeWebSocket.CLOSED);
  assert.equal(h.clock.pending, 0, 'no timers left behind');
  // a new Start after Stop is a brand-new namespace
  h.link.start();
  const ws2 = h.sockets.at(-1)!;
  assert.notEqual(ws2, ws);
  ws2.serverOpen(); ws2.serverSend({ type: 'ready' });
  assert.notEqual(h.link.current.streamId, h.posted[0]!.streamId);
});

test('Stop while still connecting closes immediately without sending PCM; a permanent server error stops retrying', async () => {
  const h = harness();
  h.link.start();
  const ws = h.sockets.at(-1)!;
  ws.serverOpen();
  await h.link.stop();
  assert.equal(ws.sent.length, 0);
  assert.equal(h.link.current.phase, 'stopped');
  const h2 = harness();
  h2.link.start();
  const ws2 = h2.sockets.at(-1)!;
  ws2.serverOpen(); ws2.serverSend({ type: 'error', message: 'Audio must be exactly 512 samples', retryable: false }); ws2.serverClose();
  assert.equal(h2.link.current.phase, 'error');
  const socketsBefore = h2.sockets.length;
  h2.clock.advance(60_000);
  assert.equal(h2.sockets.length, socketsBefore, 'no reconnect after a permanent error');
});
