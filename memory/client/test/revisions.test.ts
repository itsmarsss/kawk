import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RevisionLedger } from '../src/revisions.ts';

const base = { sessionId: 's1', streamId: 'speech_a', segmentId: '3', startAt: 100, endAt: 900, receivedAt: 5000, words: [] };

test('revision increases only when text, finality or word timings change; identical partials are suppressed', () => {
  const l = new RevisionLedger();
  const r0 = l.apply({ ...base, text: 'where are', isFinal: false });
  assert.equal(r0?.revision, 0);
  assert.equal(l.apply({ ...base, text: 'where are', isFinal: false }), null, 'duplicate partial');
  assert.equal(l.apply({ ...base, text: 'where are', isFinal: false, receivedAt: 5100, endAt: 950 }), null, 'only receipt/interval changed → still same revision');
  const r1 = l.apply({ ...base, text: 'where are my', isFinal: false });
  assert.equal(r1?.revision, 1);
  const r2 = l.apply({ ...base, text: 'where are my', isFinal: true });
  assert.equal(r2?.revision, 2, 'finality change alone is a revision');
  assert.equal(r2?.isFinal, true);
  const r3 = l.apply({ ...base, text: 'where are my', isFinal: true, words: [{ text: 'where', startAt: 100, endAt: 300 }] });
  assert.equal(r3?.revision, 3, 'word timing change is a revision');
  assert.equal(l.apply({ ...base, text: 'where are', isFinal: false }), null, 'a final never regresses to a partial');
  assert.equal(l.suppressed, 3);
});

test('segment namespaces are independent per stream; the posted body carries the contract fields', () => {
  const l = new RevisionLedger();
  const a = l.apply({ ...base, text: 'hello', isFinal: true });
  const b = l.apply({ ...base, streamId: 'speech_b', text: 'hello', isFinal: true });
  assert.equal(a?.revision, 0); assert.equal(b?.revision, 0);
  assert.equal(l.size, 2);
  assert.deepEqual(a, { sessionId: 's1', streamId: 'speech_a', segmentId: '3', revision: 0, text: 'hello', isFinal: true, startAt: 100, endAt: 900, receivedAt: 5000, words: [], speakerId: null, timing: 'approximate' });
  const inverted = l.apply({ ...base, segmentId: '9', text: 'x', isFinal: false, startAt: 900, endAt: 100 });
  assert.equal(inverted?.endAt, 900, 'endAt is never before startAt');
});
