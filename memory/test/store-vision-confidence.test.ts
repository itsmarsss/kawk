import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { decodeNestedVisionModel } from '../src/visual-draft.js';
import { decodeBindingBatch } from '../src/visual-binding.js';
import type { CaptureRecord, MemoryDelta, Packet, Vision } from '../src/contracts.js';

const uncertainText = 'The small plaque appears to read SE 4045, but the letters are blurred.';
const observedText = 'A blue recycling bin stands beside the wall.';

function packet(store: Store, vision?: Vision): Packet {
  const id = 'frame', at = 5000;
  const faces: Packet['faces'] = { frameId: id, streamId: 'faces', capturedAt: at,
    status: 'unavailable', width: 640, height: 480, faces: [] };
  vision ??= decodeNestedVisionModel({
    scene: 'A hallway with a plaque and a bin.',
    entities: [
      { kind: 'object', label: 'Small plaque', description: uncertainText, confidence: 'uncertain',
        location: { value: 'on the wall', confidence: 'observed' }, faceIndex: null, anchors: [] },
      { kind: 'object', label: 'Blue bin', description: observedText, confidence: 'observed',
        location: { value: 'possibly near the classroom entrance', confidence: 'uncertain' }, faceIndex: null, anchors: [] },
    ], readableText: ['SE 4045'], uncertainties: ['The small plaque is blurred.'],
  }, faces);
  const capture: CaptureRecord = { id, sessionId: 'session', sequence: 0, capturedAt: at,
    width: 640, height: 480, faces, audioStatus: 'unavailable', imagePath: '/fixture.jpg', sha256: 'a'.repeat(64),
    receivedAt: at + 1, status: 'ready', error: null, vision };
  store.insertCapture(capture);
  return { id, version: 1, sessionId: 'session', sequence: 0, capturedAt: at,
    imagePath: capture.imagePath, sha256: capture.sha256, faces,
    audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: at },
    vision, createdAt: at + 2, correction: false };
}

function commitDraft(store: Store, p: Packet): void {
  const batch = decodeBindingBatch({ rows: [{ i: 0,
    s: { location: 'hallway', activity: null, summary: null, extraUncertainties: [] },
    b: [], n: [], f: [], e: [],
  }] }, [p], store.context());
  store.commitBatch([p], batch);
}

function indexedCopies(store: Store, text: string) {
  // Exercise the real SQLite vector index without a model download. These fixed
  // vectors test source/confidence retention, not embedding semantic accuracy.
  for (const observation of store.pendingEmbeddings(100)) {
    store.putEmbedding(observation.id, observation.text === text ? [1, 0, 0] : [0, 1, 0]);
  }
  return store.search([1, 0, 0], { from: 5000, to: 5000, limit: 100 }).filter(row => row.text === text);
}

test('uncertain nested descriptor stays uncertain in linked and raw vector-searchable copies', t => {
  const store = new Store(':memory:', 3, 'fixture-vectors'); t.after(() => store.close());
  store.createSession('session', 0); const p = packet(store); commitDraft(store, p);

  const copies = indexedCopies(store, uncertainText);
  assert.equal(copies.length, 2);
  assert.ok(copies.every(row => row.confidence === 'uncertain' && row.packetId === p.id && row.distance === 0));
  assert.equal(copies.filter(row => row.entityIds.length === 0).length, 1);
  const linked = copies.find(row => row.entityIds.length === 1)!;
  assert.equal(store.search([1, 0, 0], { entityId: linked.entityIds[0] })
    .find(row => row.id === linked.id)?.confidence, 'uncertain');

  const observed = store.observations().filter(row => row.text === observedText);
  assert.equal(observed.length, 2);
  assert.ok(observed.every(row => row.confidence === 'observed'),
    'an uncertain location paraphrase must not downgrade an observed full descriptor');
  assert.equal(store.observations().find(row => row.text === p.vision.scene)?.confidence, 'observed');
  assert.ok(store.observations().filter(row => row.text.startsWith('Unverified text reading'))
    .every(row => row.confidence === 'uncertain'));
});

test('text dedup cannot overwrite uncertain descriptor confidence with a second observed source', t => {
  const store = new Store(':memory:', 3, 'fixture-vectors'); t.after(() => store.close());
  store.createSession('session', 0); const p = packet(store);
  p.vision.scene = uncertainText; // The raw source deduplicator sees the same text twice.
  store.saveVision(p.id, p.vision); commitDraft(store, p);
  const copies = indexedCopies(store, uncertainText);
  assert.equal(copies.length, 2);
  assert.ok(copies.every(row => row.confidence === 'uncertain'));
});

test('legacy vision without declared descriptor confidence retains observed raw sources', t => {
  const store = new Store(':memory:', 3, 'fixture-vectors'); t.after(() => store.close());
  store.createSession('session', 0);
  const p = packet(store, { scene: 'A hallway.', observations: [observedText], readableText: [], uncertainties: [] });
  const delta: MemoryDelta = { state: { location: 'hallway', activity: null, summary: p.vision.scene, uncertainties: [] },
    entities: [], facts: [], events: [] };
  store.commit(p, delta);
  const copies = indexedCopies(store, observedText);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].confidence, 'observed');
});

test('identical observed and uncertain descriptors retain conservative raw-copy confidence', t => {
  const store = new Store(':memory:', 3, 'fixture-vectors'); t.after(() => store.close());
  store.createSession('session', 0); const p = packet(store);
  p.vision.observations[1] = uncertainText;
  store.saveVision(p.id, p.vision); commitDraft(store, p);
  const copies = indexedCopies(store, uncertainText);
  assert.equal(copies.length, 3);
  assert.equal(copies.find(row => row.entityIds.length === 0)?.confidence, 'uncertain');
  assert.deepEqual(copies.filter(row => row.entityIds.length === 1).map(row => row.confidence).sort(),
    ['observed', 'uncertain']);
});
