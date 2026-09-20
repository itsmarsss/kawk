import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntroductionForwarder, introductionPayload, parseEnrollmentReply, parseIntroductionReply } from '../src/introductions.ts';
import type { Transcript } from '../src/types.ts';

const tr = (over: Partial<Transcript> = {}): Transcript => ({
  sessionId: 's1', streamId: 'speech_a', segmentId: '7', revision: 1, text: 'this is Sam', isFinal: true,
  startAt: 1_700_000_001_000, endAt: 1_700_000_002_500, receivedAt: 1_700_000_002_600, words: [], speakerId: null, timing: 'approximate', ...over,
});

function harness(sendOk = true) {
  const sent: { payload: ReturnType<typeof introductionPayload>; epoch: number }[] = [];
  const fwd = new IntroductionForwarder((payload, epoch) => { if (!sendOk) return false; sent.push({ payload, epoch }); return true; });
  return { fwd, sent };
}

test('only finals are forwarded, exactly once per stream+segment, on the face epoch bound at receipt', () => {
  const h = harness();
  assert.equal(h.fwd.forward(tr({ isFinal: false, revision: 0 }), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'not-final');
  assert.equal(h.sent.length, 0, 'a partial never reaches the face server');
  assert.equal(h.fwd.forward(tr(), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'sent');
  assert.equal(h.sent.length, 1);
  const p = h.sent[0]!;
  assert.equal(p.epoch, 1);
  assert.deepEqual(p.payload, { type: 'introduction', text: 'this is Sam', is_final: true, segment_id: '7', revision: 1, stream_id: 'speech_a',
    start_at: 1_700_000_001_000, end_at: 1_700_000_002_500 }, 'times are the original epoch-ms transcript times, not receive time');
  // a later revision of the same final segment is NOT sent again
  assert.equal(h.fwd.forward(tr({ revision: 2, text: 'this is Sam.' }), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'duplicate');
  // the same segment id in a NEW speech stream is a different utterance
  assert.equal(h.fwd.forward(tr({ streamId: 'speech_b' }), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'sent');
  assert.equal(h.sent.length, 2);
  assert.equal(h.fwd.sent, 2); assert.equal(h.fwd.skipped, 0);
});

test('a final whose face connection changed since receipt is never replayed into the new connection', () => {
  const h = harness();
  assert.equal(h.fwd.forward(tr(), { boundEpoch: 1, currentEpoch: 2, stopped: false }), 'face-changed');
  assert.equal(h.sent.length, 0);
  // and the segment is now decided: a retry with the new epoch does not smuggle it through
  assert.equal(h.fwd.forward(tr({ revision: 2 }), { boundEpoch: 2, currentEpoch: 2, stopped: false }), 'duplicate');
  assert.equal(h.sent.length, 0);
  assert.equal(h.fwd.forward(tr({ segmentId: '8' }), { boundEpoch: 0, currentEpoch: 0, stopped: false }), 'face-changed', 'epoch 0 = no face connection ever');
  assert.equal(h.fwd.skipped, 2);
});

test('post-Stop finals, empty text and a refused socket send are skipped without retry', () => {
  const h = harness();
  assert.equal(h.fwd.forward(tr(), { boundEpoch: 1, currentEpoch: 1, stopped: true }), 'stopped');
  assert.equal(h.fwd.forward(tr({ segmentId: '9', text: '   ' }), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'empty');
  const refused = harness(false);
  assert.equal(refused.fwd.forward(tr(), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'send-failed');
  assert.equal(refused.fwd.forward(tr({ revision: 2 }), { boundEpoch: 1, currentEpoch: 1, stopped: false }), 'duplicate', 'no second attempt for the same segment');
  assert.equal(h.sent.length, 0); assert.equal(refused.sent.length, 0);
});

test('server replies are parsed defensively; unknown statuses are rejected; person may be an id or {id,name}', () => {
  assert.deepEqual(parseIntroductionReply({ type: 'introduction', status: 'deciding', message: 'Jev deciding' }),
    { status: 'deciding', message: 'Jev deciding', name: null, personId: null });
  assert.deepEqual(parseIntroductionReply({ type: 'introduction', status: 'complete', message: 'Enrolled', name: 'Sam', person_id: 'uuid-1' }),
    { status: 'complete', message: 'Enrolled', name: 'Sam', personId: 'uuid-1' });
  assert.equal(parseIntroductionReply({ type: 'introduction', status: 'weird' }), null);
  assert.equal(parseIntroductionReply(null), null);
  assert.deepEqual(parseEnrollmentReply({ status: 'collecting', name: 'Sam', collected: 2, required: 5 }),
    { status: 'collecting', name: 'Sam', personId: null, collected: 2, required: 5, message: null });
  assert.deepEqual(parseEnrollmentReply({ status: 'complete', name: 'Sam', collected: 5, required: 5, person: { id: 'uuid-2', name: 'Sam' } })?.personId, 'uuid-2');
  assert.equal(parseEnrollmentReply(undefined), null);
  assert.equal(parseEnrollmentReply({ status: 'started' }), null);
});

// ---- plain-language summary shown next to the preview ----------------------------------------------
import { idleIntroduction, summarizeIntroduction, type IntroductionState } from '../src/introductions.ts';
const ago = (ms: number, now: number) => `${Math.round((now - ms) / 1000)} s ago`;
const st = (over: Partial<IntroductionState>): IntroductionState => ({ ...idleIntroduction(), ...over });

test('summary is a short user sentence per state; diagnostics (state/id/timestamp/counts) live only in detail', () => {
  const now = 1_700_000_010_000;
  assert.match(summarizeIntroduction(null, false, now, ago).text, /press Start/);
  assert.equal(summarizeIntroduction(st({ status: 'sent', message: 'forwarded final “this is Maya” to the face server; awaiting its decision', at: now - 2000, sent: 1 }), true, now, ago).text, 'Jev is checking the introduction');
  assert.equal(summarizeIntroduction(st({ status: 'deciding', message: 'matching the visible face' }), true, now, ago).text, 'Jev is checking the introduction');
  const learning = summarizeIntroduction(st({ status: 'collecting', name: 'Maya', personId: 'person-abc', collected: 3, required: 5, at: now - 1000, sent: 1 }), true, now, ago);
  assert.equal(learning.text, 'Learning Maya — 3 of 5 frames');
  assert.equal(learning.tone, 'warn');
  assert.doesNotMatch(learning.text, /person-abc|forwarded|skipped|ago/);
  assert.match(learning.detail, /person id person-abc/); assert.match(learning.detail, /updated 1 s ago/); assert.match(learning.detail, /forwarded 1 · skipped 0/);
  assert.equal(summarizeIntroduction(st({ status: 'collecting', name: 'Maya' }), true, now, ago).text, 'Learning Maya');
  const saved = summarizeIntroduction(st({ status: 'complete', name: 'Maya', personId: 'person-abc' }), true, now, ago);
  assert.equal(saved.text, 'Saved Maya'); assert.equal(saved.tone, 'ok');
  const failed = summarizeIntroduction(st({ status: 'error', name: 'Maya', message: 'face left the frame' }), true, now, ago);
  assert.equal(failed.text, 'Failed for Maya: face left the frame'); assert.equal(failed.tone, 'bad');
  assert.equal(summarizeIntroduction(st({ status: 'ignored', message: 'not an introduction' }), true, now, ago).text, 'Not treated as an introduction');
  const skipped = summarizeIntroduction(st({ status: 'skipped', message: 'final “…” not forwarded: the face connection changed since it was heard', skipped: 1 }), true, now, ago);
  assert.equal(skipped.tone, 'warn'); assert.match(skipped.detail, /face connection changed/);
  assert.equal(summarizeIntroduction(st({}), true, now, ago).text, 'Listening for an introduction');
});
