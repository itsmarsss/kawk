// Run-level test of the agent interrupt path: `captureNow` takes a photo through the SAME draw → face
// derivative → face slot → once-only submission path as the 5 s ticks, tags the POST body with the
// requestId, shares the strictly increasing sequence with regular ticks, and rejects when nothing can be
// captured. Browser globals are faked; the face server is the in-memory FakeWebSocket; time is the FakeClock
// (so every Run-side wait is driven explicitly by `pump`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, FakeWebSocket, installFakeWebSocket } from './fakes.ts';
import type { MediaDeps, StreamLike } from '../src/media.ts';
import type { CaptureInput } from '../src/types.ts';

installFakeWebSocket();
(globalThis as unknown as { requestAnimationFrame: (fn: () => void) => number }).requestAnimationFrame = (fn) => { queueMicrotask(fn); return 1; };
const { Run } = await import('../src/session.ts');

const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise<void>((r) => setTimeout(r, 0)); };

function fakeCanvas(): HTMLCanvasElement {
  const c = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
    toBlob(cb: (b: { arrayBuffer(): Promise<ArrayBuffer> } | null) => void) { const bytes = new Uint8Array([0xff, 0xd8, c.width & 0xff, c.height & 0xff]); cb({ arrayBuffer: async () => bytes.buffer }); } };
  return c as unknown as HTMLCanvasElement;
}
function fakeVideo(): HTMLVideoElement {
  return { srcObject: null, muted: false, playsInline: false, readyState: 2, videoWidth: 1280, videoHeight: 720,
    async play() {}, addEventListener() {}, removeEventListener() {} } as unknown as HTMLVideoElement;
}
function harness() {
  FakeWebSocket.instances = [];
  const clock = new FakeClock();
  const captures: CaptureInput[] = [];
  let captureStatus = 202;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/sessions')) return new Response(JSON.stringify({ id: 'sess_run', startedAt: clock.now() }), { status: 201, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/captures')) {
      const body = JSON.parse(String(init?.body)) as CaptureInput;
      captures.push(body);
      return new Response(captureStatus === 202 ? JSON.stringify({ id: body.id, status: 'queued' }) : JSON.stringify({ error: 'rejected' }), { status: captureStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const stream: StreamLike = { getTracks: () => [{ stop() {} }], getVideoTracks: () => [{ stop() {} }], getAudioTracks: () => [] };
  const mediaDeps: MediaDeps = {
    getUserMedia: async (c) => { if (c.audio) throw new Error('NotFoundError: no microphone in this test'); return stream; },
    createContext: () => { throw new Error('no audio in this test'); },
    createWorkletNode: () => { throw new Error('no audio in this test'); },
    createCanvas: fakeCanvas,
  };
  const run = new Run({ videoEl: fakeVideo(), config: { captureIntervalMs: 5000, transcriptWords: 200 }, clock, mediaDeps, commands: null,
    onUpdate: () => {}, onLiveFaces: () => {}, onTranscript: () => {} });
  const faceReply = (ws: FakeWebSocket, faces: unknown[] = []) => ws.serverSend({ type: 'frame', frame_id: 1, faces, input_wh: [640, 360] });
  /** Drive fake-clock waits (50 ms steps + microtask/IO flushes) until `p` settles. Bounded. */
  const pump = async <T,>(p: Promise<T>, maxSteps = 400): Promise<T> => {
    let done = false; let value: T | undefined; let error: unknown; let failed = false;
    p.then((v) => { done = true; value = v; }, (e) => { done = true; failed = true; error = e; });
    for (let i = 0; i < maxSteps && !done; i += 1) { await flush(3); if (!done) clock.advance(50); }
    await flush(2);
    if (!done) throw new Error(`pump: promise did not settle within ${maxSteps} steps`);
    if (failed) throw error;
    return value as T;
  };
  return { clock, run, captures, faceReply, pump, setCaptureStatus: (s: number) => { captureStatus = s; }, faceSocket: () => FakeWebSocket.instances.at(-1)! };
}

test('captureNow between ticks: same capture path, requestId in the body, unique increasing sequence, cadence untouched', async () => {
  const h = harness();
  try {
    await h.run.start({ cameraId: null, micId: null, speechBackend: 'local' });
    const anchor = h.clock.now();
    assert.equal(h.run.snapshot().phase, 'running');
    const ws = h.faceSocket();
    ws.serverOpen(); ws.serverSend({ type: 'ready', model: 'buffalo_l', backend: 'local' });
    h.clock.advance(0); // tick 0 is due at the anchor itself
    await flush();
    assert.equal(ws.binarySent.length, 1, 'tick 0 derivative sent');
    h.faceReply(ws, [{ track_id: 1, box: [10, 10, 100, 120], stable_id: 'uuid-sam', stable_name: 'Sam', match: { id: 'uuid-sam', similarity: 0.7 } }]);
    await flush();
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0]!.sequence, 0);
    assert.equal(h.captures[0]!.requestId, undefined, 'regular ticks carry no requestId');

    h.clock.advance(2300); // between tick 0 and tick 1
    const p = h.run.captureNow('cmd_1');
    assert.equal(h.run.captureNow('cmd_1'), p, 'a repeated requestId returns the same promise; no second photo');
    await flush();
    assert.equal(ws.binarySent.length, 2, 'the interrupt derivative went through the face slot');
    h.faceReply(ws, [{ track_id: 1, box: [12, 10, 100, 120], stable_id: 'uuid-sam', stable_name: 'Sam', match: { id: 'uuid-sam', similarity: 0.71 } }]);
    const id = await h.pump(p);
    assert.match(id, /^capnow_/);
    assert.equal(h.captures.length, 2);
    const body = h.captures[1]!;
    assert.equal(body.id, id);
    assert.equal(body.requestId, 'cmd_1');
    assert.equal(body.sequence, 1);
    assert.equal(body.capturedAt, anchor + 2300, 'source time is the moment the photo was drawn');
    assert.equal(body.faces.frameId, id, 'face evidence belongs to this very photo');
    assert.equal(body.faces.capturedAt, body.capturedAt);
    assert.equal(body.faces.faces[0]!.name, 'Sam');
    assert.equal(body.faces.faces[0]!.identityStatus, 'confirmed');
    assert.ok(h.clock.now() < anchor + 5000, 'still before tick 1');

    h.clock.advance(anchor + 5000 - h.clock.now()); // t = 5000: tick 1 fires exactly on the anchored schedule
    await flush();
    assert.equal(ws.binarySent.length, 3);
    h.faceReply(ws);
    await flush();
    assert.equal(h.captures.length, 3);
    assert.equal(h.captures[2]!.sequence, 2);
    assert.equal(h.captures[2]!.capturedAt, anchor + 5000, 'the regular tick was not shifted by the interrupt');
    assert.deepEqual(h.captures.map((c) => c.sequence), [0, 1, 2]);
    const snap = h.run.snapshot();
    assert.equal(snap.photos.interrupts, 1);
    assert.equal(snap.photos.nextSequence, 3);
    assert.equal(snap.submissions.accepted, 3);

    const stopping = h.run.stop('test done');
    await flush();
    assert.equal(ws.binarySent.length, 4, 'the Stop snapshot also goes through the face slot');
    h.faceReply(ws);
    await h.pump(stopping);
    const final = h.captures.at(-1)!;
    assert.match(final.id, /^capfinal_/);
    assert.equal(final.sequence, 3, 'the Stop snapshot continues the same sequence');
    assert.equal(final.requestId, undefined);
    assert.equal(h.run.snapshot().finalCapture.stage, 'accepted');
  } finally { await h.pump(h.run.stop('cleanup')); }
});

test('captureNow rejects when the run is not running and when the server rejects the photo', async () => {
  const h = harness();
  try {
    await assert.rejects(h.run.captureNow('early'), /run is idle/);
    await h.run.start({ cameraId: null, micId: null, speechBackend: 'local' });
    const ws = h.faceSocket();
    ws.serverOpen(); ws.serverSend({ type: 'ready', model: 'buffalo_l', backend: 'local' });
    h.clock.advance(0); await flush(); h.faceReply(ws); await flush();
    assert.equal(h.captures.length, 1);
    h.setCaptureStatus(400);
    const p = h.run.captureNow('rejected');
    await flush(); h.faceReply(ws); // face reply arrives; the POST then gets HTTP 400 (not retried)
    await assert.rejects(h.pump(p), /not accepted: HTTP 400/);
    assert.equal(h.captures.length, 2, 'the rejected body was sent once');
    await assert.rejects(h.run.captureNow(''), /requires a requestId/);
    const stopping = h.run.stop('test');
    await assert.rejects(h.run.captureNow('late'), /run is stopping/);
    await h.pump(stopping);
    await assert.rejects(h.run.captureNow('after'), /run is stopped/);
  } finally { await h.pump(h.run.stop('cleanup')); }
});
