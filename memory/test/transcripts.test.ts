import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptWindow } from '../src/transcripts.js';
import { CaptureInputSchema, type Transcript } from '../src/contracts.js';

const t = (overrides: Partial<Transcript> = {}): Transcript => ({ sessionId: 'session', streamId: 'stream',
  segmentId: '1', revision: 1, text: 'old partial', isFinal: false, startAt: 1000, endAt: 2000,
  receivedAt: 9000, words: [], speakerId: null, timing: 'approximate', ...overrides });
test('rolling N words are selected by source time; revision replaces partial', () => {
  const rows = [t(), t({ revision: 2, text: 'I left my keys on the desk', isFinal: true }),
    t({ segmentId: '2', text: 'future room', startAt: 6000, endAt: 7000 })];
  const window = transcriptWindow(rows, 5000, 4, 'live');
  assert.equal(window.text, 'keys on the desk');
  assert.equal(window.wordCount, 4); assert.equal(window.segments.length, 1);
  assert.equal(window.segments[0].revision, 2); assert.equal(window.segments[0].isFinal, true);
  assert.equal(window.segments[0].speakerId, null);
});
test('delayed delivery never shifts speech into a new time interval', () => {
  const delayed = t({ text: 'the room is blue', isFinal: true, receivedAt: 900000 });
  assert.equal(transcriptWindow([delayed], 5000, 200, 'live').text, delayed.text);
  assert.equal(transcriptWindow([delayed], 150000, 200, 'live').text, delayed.text);
  assert.equal(transcriptWindow([delayed], 150000, 200, 'live', 120000).text, '');
});
test('cross-boundary words are clipped, untimed crossing segments excluded', () => {
  const timed = t({ endAt: 7000, words: [{ text: 'past', startAt: 1000, endAt: 2000 },
    { text: 'future', startAt: 6000, endAt: 7000 }] });
  assert.equal(transcriptWindow([timed], 5000, 200, 'live').text, 'past');
  assert.equal(transcriptWindow([t({ endAt: 7000 })], 5000, 200, 'live').text, '');
});
test('connection namespace prevents segment collision after reconnect', () => {
  const rows = [t({ text: 'first', isFinal: true }), t({ streamId: 'new-stream', text: 'second', startAt: 3000, endAt: 4000 })];
  assert.equal(transcriptWindow(rows, 5000, 200, 'live').segments.length, 2);
});
test('a mismatched face frame cannot enter a packet', () => {
  const base = { id: 'a', sessionId: 's', sequence: 1, capturedAt: 10, width: 1280, height: 720,
    jpegBase64: 'abcd', audioStatus: 'live', faces: { frameId: 'b', streamId: 'f', capturedAt: 10,
      status: 'ready', width: 640, height: 360, faces: [] } };
  assert.equal(CaptureInputSchema.safeParse(base).success, false);
  assert.equal(CaptureInputSchema.safeParse({ ...base, faces: { ...base.faces, frameId: 'a' } }).success, true);
  assert.equal(CaptureInputSchema.safeParse({ ...base, faces: { ...base.faces, frameId: 'a', height: 640 } }).success, false);
});
