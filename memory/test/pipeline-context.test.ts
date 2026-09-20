import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { createInterpreter, InterpreterError, type ModelTiming } from '../src/interpreter.js';
import { transcriptKey, type CaptureInput, type Embedder, type Interpreter, type MemoryContext,
  type MemoryDelta, type Packet, type Transcript, type Vision } from '../src/contracts.js';

const jpeg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64');
const vision: Vision = { scene: 'An empty desk', observations: [], readableText: [], uncertainties: [] };
const vectors: Embedder = { model: 'test-vector', dimensions: 3, embed: async texts => texts.map(() => [1, 0, 0]) };
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function capture(id: string, at: number, sequence: number): CaptureInput {
  return { id, sessionId: 's', sequence, capturedAt: at, width: 1, height: 1, jpegBase64: jpeg,
    audioStatus: 'live', faces: { frameId: id, streamId: 'faces', capturedAt: at, status: 'ready',
      width: 1, height: 1, faces: [] } };
}
function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return { sessionId: 's', streamId: 'audio', segmentId: 'old', revision: 1, text: 'The exam is Monday',
    isFinal: true, startAt: 1000, endAt: 2000, receivedAt: 2100, words: [], speakerId: null,
    timing: 'approximate', ...overrides };
}
function delta(summary: string): MemoryDelta {
  return { state: { location: 'Room', activity: null, summary, uncertainties: [] }, entities: [], facts: [], events: [] };
}
async function setup(model: Interpreter, embedder = vectors) {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-context-'));
  const store = new Store(join(dir, 'memory.db'), 3, 'test-vector'); store.createSession('s', 0);
  const pipeline = new MemoryPipeline(store, model, embedder, { dataDir: dir, autoStart: false, transcriptWords: 3, contextRetrieval: 'semantic' });
  return { dir, store, pipeline, async cleanup() { await pipeline.stop(); store.close(); await rm(dir, { recursive: true }); } };
}
async function seed(s: Awaited<ReturnType<typeof setup>>, revision = 1) {
  const old = transcript({ revision }); s.pipeline.transcript(old);
  await s.pipeline.capture(capture('old-source', 3000, 1)); s.store.saveVision('old-source', vision);
  const c = s.store.getCapture('old-source')!;
  const packet: Packet = { ...c, version: 1, vision, createdAt: 3010, correction: false,
    audio: { text: old.text, wordCount: 4, segments: [old], status: 'live', throughAt: 3000 } };
  const value = delta(old.text);
  value.facts.push({ entityRefs: [], text: old.text, visual: false, transcriptKeys: [transcriptKey(old)],
    confidence: 'reported', attribute: null, value: null });
  s.store.commit(packet, value);
  for (const note of s.store.pendingEmbeddings()) s.store.putEmbedding(note.id, [1, 0, 0]);
  s.pipeline.transcript(transcript({ segmentId: 'recent', text: 'Unrelated recent words', startAt: 8000, endAt: 9000 }));
}
async function ready(s: Awaited<ReturnType<typeof setup>>, id = 'live', at = 10000, sequence = 2) {
  await s.pipeline.capture(capture(id, at, sequence)); s.store.saveVision(id, vision);
}

test('a final revision during a provider recovery cannot commit the retried stale evidence', async () => {
  const blocked = gate(); const timings: ModelTiming[] = []; let calls = 0;
  const adapter = createInterpreter({ env: {}, maxAttempts: 2, retryDelayMs: 0,
    onTiming: t => timings.push(t), runner: async request => {
      calls++;
      if (calls === 1) throw new InterpreterError('timeout');
      if (calls === 2) await blocked.promise;
      const value = { ...delta(request.stdin.includes('Tuesday') ? 'The exam is Tuesday' : 'The exam is Monday'), objectEvidence: [] };
      return { durationMs: 1, stdout: [
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
        { type: 'turn.completed', usage: {} },
      ].map(event => JSON.stringify(event)).join('\n') };
    } });
  const s = await setup({ observe: async () => vision, update: adapter.update });
  try {
    s.pipeline.transcript(transcript()); await ready(s, 'live', 3000, 1);
    s.pipeline.start(); await until(() => calls === 2);
    assert.equal(s.store.hasCommittedPacket('live'), false);
    s.pipeline.transcript(transcript({ revision: 2, text: 'The exam is Tuesday' }));
    blocked.release(); await until(() => s.store.getCapture('live')?.status === 'committed');
    assert.equal(calls, 3); assert.equal(s.store.currentState().summary, 'The exam is Tuesday');
    assert.ok(s.store.history().every(row => !row.summary.includes('Monday')));
    assert.equal(s.store.getPacket('live')?.audio.segments[0].revision, 2);
    assert.deepEqual(timings.map(t => [t.attempt, t.success]), [[1, false], [2, true], [1, true]]);
  } finally { blocked.release(); await s.cleanup(); }
});

test('an out-of-window final correction cannot reintroduce stale retrieved/state context through an active update', async () => {
  const blocked = gate(); let liveCalls = 0; const contexts: MemoryContext[] = []; const packets: Packet[] = [];
  const s = await setup({ observe: async () => vision, update: async (packet, context) => {
    if (packet.id === 'old-source') return delta(packet.audio.text);
    liveCalls++; contexts.push(context); packets.push(packet);
    if (liveCalls === 1) await blocked.promise;
    return delta(context.state.summary);
  } });
  try {
    await seed(s); await ready(s); s.pipeline.start(); await until(() => liveCalls === 1);
    assert.equal(contexts[0].state.summary, 'The exam is Monday');
    assert.ok(contexts[0].related.some(note => note.text.includes('Monday')));
    assert.equal(packets[0].audio.text, 'Unrelated recent words');
    assert.ok(packets[0].audio.segments.every(t => t.segmentId !== 'old'));
    s.pipeline.transcript(transcript({ revision: 2, text: 'The exam is Tuesday' }));
    assert.equal(s.store.currentState().summary, ''); blocked.release();
    await until(() => s.store.getCapture('live')?.status === 'committed');
    assert.equal(liveCalls, 2); assert.match(s.store.currentState().summary, /Tuesday/);
    assert.deepEqual(packets[1].audio, packets[0].audio);
    assert.equal(s.store.packetVersions('live').length, 1); // Context retry does not invent another evidence version.
    assert.ok(s.store.history().filter(row => row.packetId === 'live').every(row => !row.summary.includes('Monday')));
    assert.equal(s.store.isPacketCommitted('old-source', 2), true);
  } finally { blocked.release(); await s.cleanup(); }
});

test('a context correction requeues the entire active batch before either stale row commits', async () => {
  const blocked = gate(); let batchCalls = 0;
  const s = await setup({ observe: async () => vision,
    update: async packet => delta(packet.audio.text),
    updateBatch: async (packets, context) => {
      if (++batchCalls === 1) await blocked.promise;
      return { updates: packets.map(packet => ({ packetId: packet.id, packetVersion: packet.version,
        delta: delta(context.state.summary), reuse: [] })) };
    } });
  try {
    await seed(s); await ready(s, 'one'); await ready(s, 'two', 15000, 3);
    s.pipeline.start(); await until(() => batchCalls === 1);
    s.pipeline.transcript(transcript({ revision: 2, text: 'The exam is Tuesday' }));
    assert.equal(s.store.hasCommittedPacket('one'), false); assert.equal(s.store.hasCommittedPacket('two'), false);
    blocked.release(); await until(() => s.store.getCapture('two')?.status === 'committed');
    assert.equal(batchCalls, 2);
    const histories = s.store.history().filter(row => row.packetId !== 'old-source');
    assert.equal(histories.length, 2); assert.ok(histories.every(row => row.summary.includes('Tuesday')));
    for (const id of ['one', 'two']) assert.equal(s.store.packetVersions(id).length, 1);
  } finally { blocked.release(); await s.cleanup(); }
});

test('a correction during asynchronous context retrieval is checked before spending a model call', async () => {
  const blocked = gate(); let retrieving = false, shouldBlock = true, liveCalls = 0;
  const embedder: Embedder = { ...vectors, embed: async texts => {
    if (shouldBlock) { shouldBlock = false; retrieving = true; await blocked.promise; }
    return texts.map(() => [1, 0, 0]);
  } };
  const s = await setup({ observe: async () => vision, update: async (packet, context) => {
    if (packet.id === 'old-source') return delta(packet.audio.text);
    liveCalls++; return delta(context.state.summary);
  } }, embedder);
  try {
    await seed(s); await ready(s); s.pipeline.start(); await until(() => retrieving);
    assert.equal(liveCalls, 0);
    s.pipeline.transcript(transcript({ revision: 2, text: 'The exam is Tuesday' }));
    blocked.release(); await until(() => s.store.getCapture('live')?.status === 'committed');
    assert.equal(liveCalls, 1); assert.match(s.store.currentState().summary, /Tuesday/);
  } finally { blocked.release(); await s.cleanup(); }
});

test('routine first finals, partials, duplicate and delayed revisions do not restart an unchanged active window', async () => {
  const blocked = gate(); let liveCalls = 0;
  const s = await setup({ observe: async () => vision, update: async (packet, context) => {
    if (packet.id === 'old-source') return delta(packet.audio.text);
    if (++liveCalls === 1) await blocked.promise;
    return delta(context.state.summary);
  } });
  try {
    await seed(s, 3); await ready(s); s.pipeline.start(); await until(() => liveCalls === 1);
    for (let i = 0; i < 4; i++) assert.equal(s.pipeline.transcript(transcript({ segmentId: `future-${i}`,
      text: 'An ordinary new final', startAt: 12000 + i * 1000, endAt: 12500 + i * 1000 })), true);
    const future = transcript({ segmentId: 'streaming', isFinal: false, text: 'Partial words', startAt: 17000, endAt: 18000 });
    assert.equal(s.pipeline.transcript(future), true);
    assert.equal(s.pipeline.transcript({ ...future, revision: 2, isFinal: true }), true);
    assert.equal(s.pipeline.transcript(transcript({ revision: 3 })), false); // Duplicate final.
    assert.equal(s.pipeline.transcript(transcript({ revision: 2, text: 'Delayed older final' })), true);
    assert.equal(s.pipeline.transcript(transcript({ revision: 4, isFinal: false })), false); // Cannot demote final.
    blocked.release(); await until(() => s.store.getCapture('live')?.status === 'committed');
    assert.equal(liveCalls, 1); assert.equal(s.store.currentState().summary, 'The exam is Monday');
    assert.equal(s.store.packetVersions('live').length, 1);
  } finally { blocked.release(); await s.cleanup(); }
});
