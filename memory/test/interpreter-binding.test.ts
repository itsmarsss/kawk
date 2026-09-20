import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInterpreter, type ModelTiming } from '../src/interpreter.js';
import { Store } from '../src/store.js';
import { checkedVision, type CaptureRecord, type Packet } from '../src/contracts.js';

const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
const response = {
  scene: 'An office desk and one person.',
  entities: [
    { kind: 'object', label: 'Brass keys', description: 'Brass keys with a distinctive red tag rest on the desk.',
      confidence: 'observed', faceIndex: null, location: { value: 'on the desk', confidence: 'observed' },
      anchors: [{ kind: 'attached_item', quote: 'distinctive red tag' }] },
    { kind: 'person', label: 'Person in blue', description: 'A person in a blue jacket is beside the desk.',
      confidence: 'observed', faceIndex: 0, location: null, anchors: [] },
  ],
  readableText: [], uncertainties: [],
};
function binding() {
  return { rows: [{ i: 0, s: { location: 'Office', activity: null,
    summary: 'Bob and brass keys are visible near the desk.', extraUncertainties: [] },
  b: [], n: [], f: [], e: [] }] };
}
function events(value: unknown) {
  return [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }].map(e => JSON.stringify(e)).join('\n');
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-binding-adapter-'));
  const path = join(dir, 'capture.jpg'); await writeFile(path, image);
  const capture: CaptureRecord = { id: 'photo', sessionId: 'session', sequence: 0, capturedAt: 5000,
    width: 640, height: 480, imagePath: path, sha256: createHash('sha256').update(image).digest('hex'),
    receivedAt: 5010, status: 'queued', error: null, vision: null, audioStatus: 'live',
    faces: { frameId: 'photo', streamId: 'face-stream', capturedAt: 5000, status: 'ready', width: 640, height: 480,
      faces: [{ trackId: 'face-track', personId: 'gallery-bob', name: 'Bob', similarity: .8,
        box: [10, 20, 100, 180], identityStatus: 'confirmed' }] } };
  return { dir, capture, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('binding mode structures the exact image, then preserves every visual fact through real Store/reopen', async () => {
  const f = await fixture(); let calls = 0; const timings: ModelTiming[] = [];
  let store = new Store(join(f.dir, 'memory.sqlite'), 3, 'test-vectors');
  try {
    store.createSession(f.capture.sessionId, 0); store.insertCapture(f.capture);
    const model = createInterpreter({ env: {}, updateFormat: 'binding', onTiming: t => timings.push(t), runner: async request => {
      const schema = JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema') + 1], 'utf8'));
      if (calls++ === 0) {
        assert.ok(schema.required.includes('entities')); assert.ok(!schema.properties.d);
        assert.ok(request.args.includes('-i'));
        assert.deepEqual(await readFile(request.args[request.args.indexOf('-i') + 1]), image);
        assert.match(request.stdin, /Same-image face slots/); assert.match(request.stdin, /\[10,20,100,180\]/);
        assert.ok(!request.stdin.includes('SECRET_PARTIAL'));
        return { stdout: events(response), durationMs: 1 };
      }
      assert.ok(schema.required.includes('rows')); assert.ok(!request.args.includes('-i'));
      assert.ok(!request.stdin.includes('SECRET_PARTIAL'));
      return { stdout: events(binding()), durationMs: 1 };
    } });
    const vision = await model.observe(f.capture);
    assert.equal(vision.visualDraft?.entities.length, 2); assert.ok(!('d' in vision));
    store.saveVision(f.capture.id, vision);
    const packet: Packet = { ...f.capture, version: 1, vision, createdAt: 5500, correction: false,
      audio: { text: 'SECRET_PARTIAL', wordCount: 1, status: 'live', throughAt: 5000,
        segments: [{ sessionId: 'session', streamId: 'speech', segmentId: 'partial', revision: 1,
          text: 'SECRET_PARTIAL', isFinal: false, startAt: 4000, endAt: 4900, receivedAt: 5000,
          words: [], speakerId: null, timing: 'approximate' }] } };
    const context = store.context(); context.entities = store.faceEntities(f.capture);
    const delta = await model.update(packet, context);
    assert.equal(delta.facts.length, 3);
    assert.ok(delta.facts.some(fact => fact.text === response.entities[0].description));
    assert.ok(delta.facts.some(fact => fact.text === response.entities[1].description));
    store.commit(packet, delta);
    const key = store.entities().find(e => e.kind === 'object')!;
    assert.equal(key.attributes.location.value, 'on the desk');
    assert.equal(key.identityAnchors?.[0].quote, 'distinctive red tag');
    assert.equal(store.entity('gallery-bob')?.label, 'Bob');
    assert.ok(store.entityHistory('gallery-bob').some(n => n.text === response.entities[1].description));
    const persisted = store.getPacket(packet.id); store.close();
    store = new Store(join(f.dir, 'memory.sqlite'), 3, 'test-vectors');
    assert.deepEqual(store.getPacket(packet.id), persisted);
    assert.deepEqual(store.getCapture(packet.id)?.vision, vision);
    assert.equal(store.entities().length, 2);
    assert.deepEqual(timings.map(t => [t.operation, t.updateFormat, t.success]),
      [['observe', 'binding', true], ['update', 'binding', true]]);
  } finally { store.close(); await f.cleanup(); }
});

test('binding mode fails explicitly for legacy vision before spending an update call', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const vision = { scene: response.scene, observations: response.entities.map(entity => entity.description),
      readableText: response.readableText, uncertainties: response.uncertainties };
    const model = createInterpreter({ env: {}, updateFormat: 'binding', runner: async () => { calls++; throw new Error('Unexpected provider'); } });
    const packet: Packet = { ...f.capture, version: 1, vision, createdAt: 5500, correction: false,
      audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: 5000 } };
    await assert.rejects(model.update(packet, { state: { version: 0, observedAt: 0, location: null, activity: null,
      summary: '', uncertainties: [], packetId: null }, entities: [], related: [] }), /missing_visual_draft/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('bad image structure is recorded as failed validation, never a successful observation', async () => {
  const f = await fixture(); const timings: ModelTiming[] = [];
  try {
    const bad = structuredClone(response); bad.entities[0].anchors[0].quote = 'imaginary purple tag';
    const model = createInterpreter({ env: {}, updateFormat: 'binding', onTiming: t => timings.push(t),
      runner: async () => ({ stdout: events(bad), durationMs: 1 }) });
    await assert.rejects(model.observe(f.capture), /anchor_quote_mismatch/);
    assert.equal(timings[0].success, false); assert.equal(timings[0].errorCode, 'anchor_quote_mismatch');
  } finally { await f.cleanup(); }
});

test('persisted image structure requires the matching face evidence even before the writer', async () => {
  const f = await fixture();
  try {
    const model = createInterpreter({ env: {}, updateFormat: 'binding', runner: async () => ({ stdout: events(response), durationMs: 1 }) });
    const vision = await model.observe(f.capture);
    assert.throws(() => checkedVision(vision, { id: f.capture.id, capturedAt: 5000, sha256: f.capture.sha256 }), /matching capture/);
    assert.throws(() => checkedVision(vision, { ...f.capture, faces: { ...f.capture.faces, frameId: 'different' } }), /matching capture/);
    assert.deepEqual(checkedVision(vision, f.capture), vision);
  } finally { await f.cleanup(); }
});
