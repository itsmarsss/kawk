import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { type CaptureInput, type Embedder, type Interpreter, type MemoryDelta,
  type Packet, type Transcript, type Vision } from '../src/contracts.js';

// Header-only JPEG is sufficient for parser/queue unit tests; live smoke uses real camera JPEGs.
const jpeg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64');
const vision: Vision = { scene: 'A desk', observations: ['Keys are on the desk.'], readableText: [], uncertainties: [] };
const embedder: Embedder = { model: 'test-vector', dimensions: 3, embed: async texts => texts.map(() => [1,0,0]) };
const delta = (packet: Packet): MemoryDelta => ({ state: { location: 'office', activity: null,
  summary: `Scene at ${packet.capturedAt}`, uncertainties: [] }, entities: [], facts: [], events: [] });
const capture = (id: string, capturedAt: number, sequence = 1): CaptureInput => ({ id,
  sessionId: 'session', sequence, capturedAt, width: 1, height: 1, jpegBase64: jpeg,
  audioStatus: 'live', faces: { frameId: id, streamId: 'f', capturedAt,
    status: 'ready', width: 1, height: 1, faces: [] } });
const transcript = (overrides: Partial<Transcript> = {}): Transcript => ({ sessionId: 'session',
  streamId: 'audio', segmentId: '1', revision: 1, text: 'I brought my keys', isFinal: false,
  startAt: 1000, endAt: 2000, receivedAt: 2100, words: [], speakerId: null,
  timing: 'approximate', ...overrides });
async function until(predicate: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
async function setup(model: Interpreter, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-pipeline-'));
  const store = new Store(join(dir, 'memory.db'), 3, 'test-vector');
  store.createSession('session', 0);
  const pipeline = new MemoryPipeline(store, model, embedder, { dataDir: dir, ...extra });
  return { dir, store, pipeline, async cleanup() { await pipeline.stop(); store.close(); await rm(dir, { recursive: true }); } };
}

test('invalid batch references retry saved packets individually without repeating image inference', async () => {
  let observations = 0, batches = 0;
  const singles: string[] = [];
  const s = await setup({ observe: async () => { observations++; return vision; },
    update: async p => { singles.push(p.id); return delta(p); },
    updateBatch: async () => { batches++; throw Error('Memory interpretation failed: invalid_batch_reuse'); },
  }, { autoStart: false });
  try {
    await s.pipeline.capture(capture('one', 5000));
    await s.pipeline.capture(capture('two', 10000, 2));
    s.pipeline.start();
    await until(() => s.store.getCapture('two')?.status === 'committed');
    assert.equal(batches, 1); assert.equal(observations, 2); assert.deepEqual(singles, ['one', 'two']);
    assert.equal(s.store.currentState().observedAt, 10000);
  } finally { await s.cleanup(); }
});

test('captures remain independent of inference; out-of-order vision commits in capture order', async () => {
  let release!: () => void;
  const slow = new Promise<void>(r => { release = r; });
  const commits: string[] = [];
  const s = await setup({ observe: async c => { if (c.id === 'one') await slow; return vision; },
    update: async p => { commits.push(p.id); return delta(p); } });
  try {
    await s.pipeline.capture(capture('one', 5000));
    await s.pipeline.capture(capture('two', 10000, 2));
    await until(() => s.store.getCapture('two')?.status === 'ready');
    assert.equal(s.store.getCapture('one')?.status, 'observing'); assert.deepEqual(commits, []);
    release(); await until(() => s.store.getCapture('two')?.status === 'committed');
    assert.deepEqual(commits, ['one', 'two']); assert.equal(s.store.currentState().observedAt, 10000);
  } finally { release(); await s.cleanup(); }
});

test('late final generates an original-time packet revision without changing the frame', async () => {
  const packets: Packet[] = [];
  const s = await setup({ observe: async () => vision, update: async p => { packets.push(p); return delta(p); } });
  try {
    s.pipeline.transcript(transcript()); await s.pipeline.capture(capture('one', 5000));
    await until(() => s.store.getCapture('one')?.status === 'committed');
    s.pipeline.transcript(transcript({ revision: 2, text: 'I forgot my keys', isFinal: true, receivedAt: 9000 }));
    await until(() => s.store.isPacketCommitted('one', 2));
    assert.equal(packets[1].capturedAt, 5000); assert.equal(packets[1].audio.text, 'I forgot my keys');
    assert.equal(packets[1].correction, true); assert.equal(packets[0].sha256, packets[1].sha256);
    assert.equal(packets[1].audio.segments[0].speakerId, null);
  } finally { await s.cleanup(); }
});

test('duplicate capture is idempotent and conflicting evidence is rejected', async () => {
  const s = await setup({ observe: async () => vision, update: async p => delta(p) }, { autoStart: false });
  try {
    await s.pipeline.capture(capture('one', 5000)); await s.pipeline.capture(capture('one', 5000));
    assert.equal(s.store.listCaptures().length, 1);
    await assert.rejects(s.pipeline.capture(capture('one', 6000)), /different evidence/);
  } finally { await s.cleanup(); }
});

test('bounded queue rejects visibly and retains accepted captures', async () => {
  const s = await setup({ observe: async () => vision, update: async p => delta(p) }, { autoStart: false, maxPending: 1 });
  try {
    await s.pipeline.capture(capture('one', 5000));
    await assert.rejects(s.pipeline.capture(capture('two', 10000, 2)), /queue is full/);
    assert.equal(s.store.listCaptures().length, 1);
  } finally { await s.cleanup(); }
});

test('model failure keeps source durable and explicit retry recovers', async () => {
  let fail = true;
  const s = await setup({ observe: async () => { if (fail) throw new Error('model_timeout'); return vision; },
    update: async p => delta(p) });
  try {
    await s.pipeline.capture(capture('one', 5000)); await until(() => s.store.getCapture('one')?.status === 'failed');
    assert.equal(s.store.getCapture('one')?.error, 'model_timeout'); assert.equal(s.store.getPacket('one'), null);
    fail = false; s.pipeline.retry('one'); await until(() => s.store.getCapture('one')?.status === 'committed');
    assert.equal(s.store.packetVersions('one').length, 1);
  } finally { await s.cleanup(); }
});

test('speech from Bob context cannot acquire Alice context just because a later frame sees Alice', async () => {
  const packets: Packet[] = [];
  const s = await setup({ observe: async () => vision, update: async p => { packets.push(p); return delta(p); } });
  const withPerson = (id: string, at: number, sequence: number, personId: string): CaptureInput => {
    const c = capture(id, at, sequence);
    c.faces.faces = [{ trackId: personId, personId, name: personId, similarity: .8,
      box: [.1,.1,.9,.9], identityStatus: 'confirmed' }];
    return c;
  };
  try {
    await s.pipeline.capture(withPerson('bob-frame', 5000, 1, 'bob'));
    await until(() => s.store.getCapture('bob-frame')?.status === 'committed');
    s.pipeline.transcript(transcript({ text: 'I am going to the park', startAt: 6000, endAt: 8000,
      receivedAt: 12000, isFinal: true }));
    await s.pipeline.capture(withPerson('alice-frame', 10000, 2, 'alice'));
    await until(() => s.store.getCapture('alice-frame')?.status === 'committed');
    const p = packets.find(p => p.id === 'alice-frame')!;
    assert.equal(p.faces.faces[0].personId, 'alice');
    assert.deepEqual(p.audio.contexts?.[0].personIds, ['bob']);
    assert.deepEqual(p.audio.contexts?.[0].captureIds, ['bob-frame']);
    assert.equal(p.audio.contexts?.[0].ambiguous, false);
    assert.equal(p.audio.segments[0].speakerId, null);
  } finally { await s.cleanup(); }
});

test('a final arriving during model update retries before committing stale state', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let updates = 0;
  const s = await setup({ observe: async () => vision, update: async p => {
    updates++; if (updates === 1) await gate; return { ...delta(p), state: { ...delta(p).state, summary: p.audio.text } };
  } });
  try {
    s.pipeline.transcript(transcript()); await s.pipeline.capture(capture('one', 5000));
    await until(() => updates === 1);
    s.pipeline.transcript(transcript({ revision: 2, text: 'corrected final', isFinal: true })); release();
    await until(() => s.store.getCapture('one')?.status === 'committed');
    assert.equal(updates, 2); assert.equal(s.store.currentState().summary, 'corrected final');
    assert.equal(s.store.packetVersions('one').length, 2);
    assert.equal(s.store.isPacketCommitted('one', 1), false);
    assert.equal(s.store.isPacketCommitted('one', 2), true);
  } finally { release(); await s.cleanup(); }
});

test('ready packets share one bounded update call and retain separate ordered state histories', async () => {
  const batches: string[][] = [];
  const s = await setup({ observe: async () => vision,
    update: async p => delta(p), updateBatch: async packets => {
      batches.push(packets.map(p => p.id));
      return { updates: packets.map(p => ({ packetId: p.id, packetVersion: p.version, delta: delta(p), reuse: [] })) };
    } }, { autoStart: false, updateBatchSize: 2 });
  try {
    for (let i = 1; i <= 3; i++) {
      await s.pipeline.capture(capture(`frame-${i}`, i * 5000, i)); s.store.saveVision(`frame-${i}`, vision);
    }
    s.pipeline.start(); await until(() => s.store.getCapture('frame-3')?.status === 'committed');
    assert.deepEqual(batches, [['frame-1', 'frame-2']]);
    assert.equal(s.store.currentState().observedAt, 15000);
    assert.equal(s.store.history().length, 3);
    for (let i = 1; i <= 3; i++) assert.equal(s.store.getPacket(`frame-${i}`)?.capturedAt, i * 5000);
  } finally { await s.cleanup(); }
});

test('a final changing one batch row requeues the whole batch before any state is committed', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
  const s = await setup({ observe: async () => vision, update: async p => delta(p),
    updateBatch: async packets => {
      calls++; if (calls === 1) await gate;
      return { updates: packets.map(p => ({ packetId: p.id, packetVersion: p.version,
        delta: { ...delta(p), state: { ...delta(p).state, summary: p.audio.text } }, reuse: [] })) };
    } }, { autoStart: false });
  try {
    for (let i = 1; i <= 2; i++) {
      await s.pipeline.capture(capture(`frame-${i}`, i * 5000, i)); s.store.saveVision(`frame-${i}`, vision);
    }
    s.pipeline.start(); await until(() => calls === 1);
    s.pipeline.transcript(transcript({ isFinal: true, text: 'Later final', startAt: 6000, endAt: 7000 }));
    assert.equal(s.store.history().length, 0); release();
    await until(() => s.store.getCapture('frame-2')?.status === 'committed');
    assert.equal(calls, 2); assert.equal(s.store.currentState().summary, 'Later final');
    assert.equal(s.store.packetVersions('frame-1').length, 1); assert.equal(s.store.packetVersions('frame-2').length, 2);
    assert.equal(s.store.isPacketCommitted('frame-2', 1), false);
    assert.equal(s.store.isPacketCommitted('frame-2', 2), true);
  } finally { release(); await s.cleanup(); }
});

test('joined evidence persists before a slow update, survives failure and is reused on retry', async () => {
  let rejectUpdate!: (error: Error) => void;
  const stalled = new Promise<MemoryDelta>((_, reject) => { rejectUpdate = reject; });
  let calls = 0;
  const s = await setup({ observe: async () => vision, update: async p => {
    calls++; return calls === 1 ? stalled : delta(p);
  } });
  try {
    s.pipeline.transcript(transcript({ isFinal: true }));
    await s.pipeline.capture(capture('joined', 5000));
    await until(() => calls === 1);
    const prepared = s.store.getPacket('joined')!;
    assert.equal(prepared.vision.scene, vision.scene); assert.equal(prepared.audio.text, 'I brought my keys');
    assert.equal(prepared.faces.frameId, 'joined'); assert.equal(s.store.isPacketCommitted('joined', 1), false);
    assert.equal(s.store.currentState().version, 0); assert.equal(s.store.observations().length, 0);
    rejectUpdate(new Error('model unavailable')); await until(() => s.store.getCapture('joined')?.status === 'failed');
    assert.deepEqual(s.store.getPacket('joined'), prepared);
    // A separate connection proves the packet itself is durable, not an in-memory join.
    const reopened = new Store(join(s.dir, 'memory.db'), 3, 'test-vector');
    assert.deepEqual(reopened.getPacket('joined'), prepared); reopened.close();
    s.pipeline.retry('joined'); await until(() => s.store.getCapture('joined')?.status === 'committed');
    assert.deepEqual(s.store.getPacket('joined'), prepared); assert.equal(s.store.packetVersions('joined').length, 1);
    assert.equal(s.store.isPacketCommitted('joined', 1), true);
  } finally { rejectUpdate(new Error('cleanup')); await s.cleanup(); }
});

test('first successful commit may use refreshed draft v2 without losing its face encounter', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
  const s = await setup({ observe: async () => vision, update: async p => {
    if (++calls === 1) await gate; return delta(p);
  } });
  try {
    const input = capture('face-draft', 5000);
    input.faces.faces = [{ trackId: 'track', personId: 'bob', name: 'Bob', similarity: .9,
      box: [.1,.1,.9,.9], identityStatus: 'confirmed' }];
    await s.pipeline.capture(input); await until(() => calls === 1);
    s.pipeline.transcript(transcript({ isFinal: true })); release();
    await until(() => s.store.getCapture('face-draft')?.status === 'committed');
    assert.equal(s.store.isPacketCommitted('face-draft', 1), false);
    assert.equal(s.store.isPacketCommitted('face-draft', 2), true);
    assert.equal(s.store.encounters().length, 1); assert.equal(s.store.encounters()[0].startAt, 5000);
  } finally { release(); await s.cleanup(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function batchModel(observe: Interpreter['observe'], calls: string[][]): Interpreter {
  return { observe, update: async p => { calls.push([p.id]); return delta(p); },
    updateBatch: async packets => {
      calls.push(packets.map(p => p.id));
      return { updates: packets.map(p => ({ packetId: p.id, packetVersion: p.version, delta: delta(p), reuse: [] })) };
    } };
}

test('optional coalescing combines an already-observing neighbor and keeps capture order', async () => {
  const second = gate(), first = gate(); const calls: string[][] = [];
  const s = await setup(batchModel(async c => { await (c.id === 'one' ? first.promise : second.promise); return vision; }, calls),
    { batchWaitMs: 5000 });
  try {
    await s.pipeline.capture(capture('one', 5000)); await s.pipeline.capture(capture('two', 10000, 2));
    first.release(); await until(() => s.store.getCapture('one')?.status === 'ready');
    assert.deepEqual(calls, []);
    second.release(); await until(() => s.store.getCapture('two')?.status === 'committed');
    assert.deepEqual(calls, [['one', 'two']]);
    assert.deepEqual(s.store.history().map(row => row.observedAt), [5000, 10000]);
  } finally { first.release(); second.release(); await s.cleanup(); }
});

test('coalescing deadline is first-ready time and does not reset on later uploads or out-of-order vision', async () => {
  let now = 100000;
  const first = gate(), second = gate(); const calls: string[][] = [];
  const s = await setup(batchModel(async c => {
    if (c.id === 'one') await first.promise;
    if (c.id === 'two') await second.promise;
    return vision;
  }, calls), { batchWaitMs: 1000, now: () => now });
  try {
    await s.pipeline.capture(capture('one', 5000)); await s.pipeline.capture(capture('two', 10000, 2));
    first.release(); await until(() => s.store.getCapture('one')?.status === 'ready');
    now += 999;
    await s.pipeline.capture(capture('three', 15000, 3));
    await until(() => s.store.getCapture('three')?.status === 'ready');
    assert.deepEqual(calls, []);
    now++;
    await until(() => s.store.getCapture('one')?.status === 'committed');
    assert.deepEqual(calls, [['one']]); // Third cannot skip the observing second.
    second.release(); await until(() => s.store.getCapture('three')?.status === 'committed');
    assert.deepEqual(calls, [['one'], ['two', 'three']]);
  } finally { first.release(); second.release(); await s.cleanup(); }
});

test('coalescing does not wait for nonexistent work, another session, or a full batch', async () => {
  const calls: string[][] = []; const other = gate();
  const s = await setup(batchModel(async c => { if (c.id === 'other') await other.promise; return vision; }, calls),
    { batchWaitMs: 5000, updateBatchSize: 2 });
  try {
    await s.pipeline.capture(capture('alone', 5000));
    await until(() => s.store.getCapture('alone')?.status === 'committed', 1000);
    s.store.createSession('other-session', 0);
    await s.pipeline.capture({ ...capture('other', 20000, 1), sessionId: 'other-session' });
    await s.pipeline.capture(capture('before-other', 15000, 2));
    await until(() => s.store.getCapture('before-other')?.status === 'committed', 1000);
    assert.deepEqual(calls, [['alone'], ['before-other']]);
  } finally { other.release(); await s.cleanup(); }

  const first = gate(), second = gate(), third = gate(); const batches: string[][] = [];
  const full = await setup(batchModel(async c => {
    await ({ one: first, two: second, three: third }[c.id]!).promise; return vision;
  }, batches), { batchWaitMs: 5000, updateBatchSize: 2 });
  try {
    for (const [index, id] of ['one', 'two', 'three'].entries()) await full.pipeline.capture(capture(id, (index + 1) * 5000, index + 1));
    second.release(); await until(() => full.store.getCapture('two')?.status === 'ready');
    first.release(); await until(() => full.store.getCapture('two')?.status === 'committed', 1000);
    assert.deepEqual(batches, [['one', 'two']]);
    assert.equal(full.store.getCapture('three')?.status, 'observing');
  } finally { first.release(); second.release(); third.release(); await full.cleanup(); }
});

test('time spent ready behind an active reducer consumes the coalescing budget', async () => {
  let now = 100000; const update = gate(), third = gate(); const calls: string[][] = [];
  const model = batchModel(async c => { if (c.id === 'three') await third.promise; return vision; }, calls);
  model.update = async p => { calls.push([p.id]); if (p.id === 'one') await update.promise; return delta(p); };
  const s = await setup(model, { batchWaitMs: 5000, now: () => now });
  try {
    await s.pipeline.capture(capture('one', 5000)); await until(() => calls.length === 1);
    await s.pipeline.capture(capture('two', 10000, 2)); await until(() => s.store.getCapture('two')?.status === 'ready');
    await s.pipeline.capture(capture('three', 15000, 3));
    now += 5000; update.release();
    await until(() => s.store.getCapture('two')?.status === 'committed', 1000);
    assert.deepEqual(calls, [['one'], ['two']]);
    assert.equal(s.store.getCapture('three')?.status, 'observing');
  } finally { update.release(); third.release(); await s.cleanup(); }
});

test('default zero wait and historical corrections dispatch immediately', async () => {
  const first = gate(), second = gate(); const calls: string[][] = [];
  const s = await setup(batchModel(async c => { await (c.id === 'one' ? first.promise : second.promise); return vision; }, calls));
  try {
    await s.pipeline.capture(capture('one', 5000)); await s.pipeline.capture(capture('two', 10000, 2));
    first.release(); await until(() => s.store.getCapture('one')?.status === 'committed', 1000);
    assert.deepEqual(calls, [['one']]);
  } finally { first.release(); second.release(); await s.cleanup(); }

  const neighbor = gate(); const corrections: string[][] = [];
  const correcting = await setup(batchModel(async c => { if (c.id === 'neighbor') await neighbor.promise; return vision; }, corrections),
    { batchWaitMs: 5000 });
  try {
    await correcting.pipeline.capture(capture('old', 5000)); await until(() => correcting.store.hasCommittedPacket('old'));
    await correcting.pipeline.capture(capture('neighbor', 10000, 2));
    correcting.pipeline.transcript(transcript({ isFinal: true }));
    await until(() => correcting.store.isPacketCommitted('old', 2), 1000);
    assert.deepEqual(corrections, [['old'], ['old']]);
    assert.equal(correcting.store.getCapture('neighbor')?.status, 'observing');
  } finally { neighbor.release(); await correcting.cleanup(); }
});

test('restart flushes recovered ready captures without starting a fresh wait budget', async () => {
  const first = gate(), second = gate(); const calls: string[][] = [];
  const model = batchModel(async c => { await (c.id === 'one' ? first.promise : second.promise); return vision; }, calls);
  const s = await setup(model, { batchWaitMs: 5000 });
  let recovered: MemoryPipeline | undefined;
  try {
    await s.pipeline.capture(capture('one', 5000)); await s.pipeline.capture(capture('two', 10000, 2));
    first.release(); await until(() => s.store.getCapture('one')?.status === 'ready');
    const stopping = s.pipeline.stop(); second.release(); await stopping;
    assert.deepEqual(calls, []);
    // Simulate a second durable job interrupted before its vision finished.
    await s.pipeline.capture(capture('three', 15000, 3));
    const observing = gate();
    recovered = new MemoryPipeline(s.store, batchModel(async () => { await observing.promise; return vision; }, calls), embedder,
      { dataDir: s.dir, batchWaitMs: 5000 });
    try {
      await until(() => s.store.getCapture('two')?.status === 'committed', 1000);
      assert.deepEqual(calls, [['one', 'two']]);
      assert.equal(s.store.getCapture('three')?.status, 'observing');
    } finally { observing.release(); await recovered.stop(); }
  } finally { first.release(); second.release(); await recovered?.stop(); await s.cleanup(); }
});

test('batch wait configuration is explicitly bounded to five seconds', async () => {
  const s = await setup({ observe: async () => vision, update: async p => delta(p) }, { autoStart: false });
  try {
    for (const batchWaitMs of [-1, 5001, 1.5, NaN]) assert.throws(() => new MemoryPipeline(s.store,
      { observe: async () => vision, update: async p => delta(p) }, embedder,
      { dataDir: s.dir, autoStart: false, batchWaitMs }), /Invalid batchWaitMs/);
  } finally { await s.cleanup(); }
});
