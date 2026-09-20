import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentAudioTimeline, mapWords, boundSegmentInterval, CHUNK_MS } from '../src/speechTiming.ts';

test('offsets anchor to the FIRST PCM actually sent, not to socket open or discarded pre-ready chunks', () => {
  const tl = new SentAudioTimeline();
  assert.equal(tl.anchoredAtMs, null);
  assert.equal(tl.toSourceMs(0.5), null, 'nothing sent → no mapping');
  // microphone chunks at t=1000,1032,1064 were produced while waiting for `ready` and never sent
  const firstSent = 1_000_000 + 3 * CHUNK_MS;
  for (let i = 0; i < 100; i += 1) tl.recordSent(firstSent + i * CHUNK_MS);
  assert.equal(tl.anchoredAtMs, firstSent);
  assert.equal(tl.toSourceMs(0), firstSent);
  assert.equal(tl.toSourceMs(1.0), firstSent + 1000);
  assert.equal(tl.runCount, 1);
  assert.equal(tl.sentEndMs, firstSent + 100 * CHUNK_MS);
  assert.equal(tl.toSourceMs(99), tl.sentEndMs, 'beyond sent audio clamps to the sent end');
});

test('a dropped stretch of microphone audio creates a new run; later words map to their true source time', () => {
  const tl = new SentAudioTimeline();
  const base = 2_000_000;
  for (let i = 0; i < 50; i += 1) tl.recordSent(base + i * CHUNK_MS); // 1.6 s sent
  // 1 s of chunks dropped (backpressure) → next sent chunk's source time jumps by 1000 ms
  const resume = base + 50 * CHUNK_MS + 1000;
  for (let i = 0; i < 50; i += 1) tl.recordSent(resume + i * CHUNK_MS);
  assert.equal(tl.runCount, 2);
  assert.equal(tl.chunksSent, 100);
  // cloud time is continuous over SENT chunks: 1.6 s = start of the second run
  assert.equal(tl.toSourceMs(1.6), resume);
  assert.equal(tl.toSourceMs(2.6), resume + 1000);
  assert.equal(tl.toSourceMs(1.0), base + 1000, 'words before the gap are unaffected');
  const words = mapWords([{ word: 'before', start_time: 0.5, end_time: 1.0 }, { word: 'after', start_time: 1.7, end_time: 2.0 }], tl);
  assert.deepEqual(words, [
    { text: 'before', startAt: base + 500, endAt: base + 1000 },
    { text: 'after', startAt: resume + 100, endAt: resume + 400 },
  ]);
});

test('jitter within tolerance does not fragment the timeline', () => {
  const tl = new SentAudioTimeline();
  let t = 3_000_000;
  for (let i = 0; i < 40; i += 1) { tl.recordSent(t); t += CHUNK_MS + (i % 2 ? 7 : -7); }
  assert.equal(tl.runCount, 1);
});

test('segments without word offsets are bounded by previous final and current sent position, not the wall clock', () => {
  const tl = new SentAudioTimeline();
  const base = 4_000_000;
  for (let i = 0; i < 100; i += 1) tl.recordSent(base + i * CHUNK_MS);
  const receivedAt = base + 999_999; // arbitrary later wall clock must not leak in
  assert.deepEqual(boundSegmentInterval([], { prevFinalEndMs: null, timeline: tl, receivedAt }), { startAt: base, endAt: base + 3200 });
  assert.deepEqual(boundSegmentInterval([], { prevFinalEndMs: base + 1500, timeline: tl, receivedAt }), { startAt: base + 1500, endAt: base + 3200 });
  const empty = new SentAudioTimeline();
  assert.deepEqual(boundSegmentInterval([], { prevFinalEndMs: null, timeline: empty, receivedAt }), { startAt: receivedAt, endAt: receivedAt }, 'only with nothing sent does receipt time bound the interval');
  const words = mapWords([{ word: 'a', start_time: 0.2, end_time: 0.1 }], tl);
  assert.equal(words[0]!.endAt >= words[0]!.startAt, true, 'inverted word offsets are repaired, never negative');
  assert.deepEqual(mapWords([{ word: 'x' }, { word: '', start_time: 0, end_time: 1 }], tl), [], 'words without offsets or text are dropped');
});
