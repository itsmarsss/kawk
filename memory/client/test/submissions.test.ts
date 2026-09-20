import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubmissionLedger, BoundedRevisionQueue } from '../src/submissions.ts';

test('a capture is submitted once; retries resend the identical body; a second submit for the same id is a duplicate', async () => {
  const bodies: { id: string; jpegBase64: string }[] = [];
  let calls = 0;
  const ledger = new SubmissionLedger<{ id: string; jpegBase64: string }>({
    send: async (b) => { bodies.push(b); calls += 1; return calls === 1 ? { ok: false, status: 503, text: 'busy' } : { ok: true, status: 202, text: '' }; },
    retryDelayMs: 0, sleep: async () => {}, now: () => 10_500,
  });
  const body = { id: 'cap1', jpegBase64: 'AAAA' };
  assert.equal(await ledger.submit('cap1', body, 10_000), 'accepted');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'the retry sent the very same body object');
  assert.equal(ledger.get('cap1')?.latencyMs, 500);
  assert.equal(await ledger.submit('cap1', { id: 'cap1', jpegBase64: 'DIFFERENT' }, 10_000), 'duplicate');
  assert.equal(bodies.length, 2, 'the duplicate never reached the network');
  assert.deepEqual(ledger.counts(), { pending: 0, submitting: 0, accepted: 1, failed: 0, total: 1 });
});

test('4xx rejections are not retried and count as failed; in-flight overflow is dropped visibly', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const ledger = new SubmissionLedger<{ id: string }>({
    send: async (b) => { calls += 1; if (b.id === 'bad') return { ok: false, status: 400, text: 'Invalid face box' }; await gate; return { ok: true, status: 202, text: '' }; },
    maxInFlight: 1, retryDelayMs: 0, sleep: async () => {},
  });
  assert.equal(await ledger.submit('bad', { id: 'bad' }, 0), 'failed');
  assert.equal(calls, 1);
  assert.match(ledger.get('bad')!.error!, /HTTP 400/);
  const slow = ledger.submit('slow', { id: 'slow' }, 0);
  assert.equal(await ledger.submit('overflow', { id: 'overflow' }, 0), 'failed');
  assert.match(ledger.get('overflow')!.error!, /in flight/);
  release();
  assert.equal(await slow, 'accepted');
});

test('bounded transcript queue drops the oldest partial first and keeps finals', () => {
  const q = new BoundedRevisionQueue<{ id: number; isFinal: boolean }>(3);
  q.push({ id: 1, isFinal: false }); q.push({ id: 2, isFinal: true }); q.push({ id: 3, isFinal: false }); q.push({ id: 4, isFinal: false });
  assert.equal(q.dropped, 1);
  assert.deepEqual([q.shift()?.id, q.shift()?.id, q.shift()?.id], [2, 3, 4]);
});
