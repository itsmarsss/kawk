import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { createInterpreter } from '../src/interpreter.js';
import { decodeVisualDraft } from '../src/visual-draft.js';
import { decodeBindingBatch } from '../src/visual-binding.js';
import type { CaptureRecord, MemoryContext, MemoryDelta, Packet } from '../src/contracts.js';

const state = { location: 'Room', activity: null, summary: 'A person and keys in a room.', uncertainties: [] };
const visual = { scene: state.summary, observations: ['A person wears a blue jacket.', 'A room has white walls.', 'Keys with a red tag rest on a table.'], readableText: [], uncertainties: [] };
const draftWire = { n: [{ k: 'person', l: 'Person in blue jacket', v: 1, face: null },
  { k: 'place', l: 'White-walled room', v: 2, face: null }, { k: 'object', l: 'Tagged keys', v: 3, face: null }],
f: [{ r: [0], v: 1, t: null, a: null, value: null, c: 'observed' },
  { r: [1], v: 2, t: null, a: null, value: null, c: 'observed' },
  { r: [2], v: 3, t: null, a: null, value: null, c: 'observed' }],
m: [{ r: 2, v: 3, a: [{ k: 'attached_item', v: 3, q: 'red tag' }] }] };
const wire = () => ({ rows: [{ i: 0, s: structuredClone(state), b: [] as { r: number; to: string | null; match: null }[], n: [], f: [], e: [] }] });
const context = (store: Store): MemoryContext => ({ state: store.currentState(), entities: store.entities(), related: [] });
function packet(id = 'photo', capturedAt = 5000, sequence = 0): Packet {
  const faces = { frameId: id, streamId: 'faces', capturedAt, status: 'ready' as const, width: 1, height: 1, faces: [] };
  return { id, sessionId: 's', version: 1, sequence, capturedAt, createdAt: capturedAt + 1, correction: false,
    imagePath: '/fixture-not-read.jpg', sha256: 'a'.repeat(64), faces,
    audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: capturedAt },
    vision: { ...structuredClone(visual), visualDraft: decodeVisualDraft(draftWire, visual, faces) } };
}
function insert(store: Store, p: Packet) {
  const capture: CaptureRecord = { id: p.id, sessionId: p.sessionId, sequence: p.sequence, capturedAt: p.capturedAt,
    width: 1, height: 1, faces: p.faces, audioStatus: p.audio.status, imagePath: p.imagePath, sha256: p.sha256,
    receivedAt: p.createdAt, status: 'ready', error: null, vision: p.vision };
  store.insertCapture(capture);
}
function fixture() {
  const store = new Store(':memory:', 3, 'test-vector'); store.createSession('s', 0);
  const p = packet(); insert(store, p); const decoded = decodeBindingBatch(wire(), [p], context(store));
  store.commitBatch([p], decoded);
  return { store, p, decoded, correction: () => ({ ...structuredClone(p), version: 2, correction: true, createdAt: 6000 }) };
}
const snapshot = (store: Store) => ({ entities: store.entities(), history: store.history(),
  observations: store.observations(), packets: store.packetVersions('photo'), sightings: store.objectSightings('photo') });

test('committed image correction retains anonymous person/place IDs, metadata, source history and object identity', () => {
  const s = fixture();
  try {
    const before = snapshot(s.store), p2 = s.correction();
    s.store.commitBatch([p2], decodeBindingBatch(wire(), [p2], context(s.store)));
    assert.deepEqual(s.store.entities(), before.entities);
    assert.deepEqual(s.store.observations(), before.observations);
    assert.deepEqual(s.store.objectSightings('photo'), before.sightings);
    assert.equal(s.store.history().filter(h => !h.superseded).length, 1);
    assert.equal(s.store.isPacketCommitted('photo', 1), true); assert.equal(s.store.isPacketCommitted('photo', 2), true);
    assert.equal(s.store.history().at(-1)!.observedAt, 5000);
    const p3 = { ...p2, version: 3, createdAt: 7000 };
    s.store.commitBatch([p3], decodeBindingBatch(wire(), [p3], context(s.store)));
    assert.deepEqual(s.store.entities(), before.entities); assert.deepEqual(s.store.observations(), before.observations);
  } finally { s.store.close(); }
});

test('changed source, slot or explicit identity is rejected with no partial correction commit', () => {
  const changes: [string, (p: Packet, delta: MemoryDelta) => void, RegExp][] = [
    ['hash', p => { p.sha256 = 'b'.repeat(64); }, /immutable capture/],
    ['face stream', p => { p.faces.streamId = 'another'; }, /immutable capture/],
    ['draft', p => { p.vision.visualDraft!.entities[0].label = 'Different'; }, /frozen visual draft evidence/],
    ['scene', p => { p.vision.scene = 'Different source'; }, /frozen visual draft evidence/],
    ['missing draft', p => { delete p.vision.visualDraft; }, /frozen visual draft evidence/],
    ['kind', (_p, d) => { d.entities[0].kind = 'place'; }, /frozen draft slot/],
    ['missing slot', (_p, d) => { d.entities[0].ref = 'd29'; d.facts[0].entityRefs = ['d29']; }, /frozen draft slot/],
    ['different person', (_p, d) => { d.entities[0].existingId = 'different-person'; }, /conflicts with frozen draft identity/],
    ['gallery claim', (_p, d) => { d.entities[0].personId = 'invented-gallery-person'; }, /conflicts with frozen draft identity/],
    ['different place', (_p, d) => { d.entities[1].existingId = 'different-place'; }, /conflicts with frozen draft identity/],
  ];
  for (const [name, mutate, message] of changes) {
    const s = fixture();
    try {
      const before = snapshot(s.store), p = s.correction(), d = decodeBindingBatch(wire(), [p], context(s.store)).updates[0].delta;
      mutate(p, d); assert.throws(() => s.store.commit(p, d), message, name);
      assert.deepEqual(snapshot(s.store), before, name);
    } finally { s.store.close(); }
  }
});

test('frozen new draft metadata is source-owned, not replaced by correction prose', () => {
  const s = fixture();
  try {
    const before = s.store.entities(), p = s.correction(), d = decodeBindingBatch(wire(), [p], context(s.store)).updates[0].delta;
    d.entities[0].label = 'Invented correction name'; d.entities[0].description = 'Unsupported corrected description';
    d.entities[1].label = 'Invented room'; d.entities[1].description = 'Unsupported room';
    s.store.commit(p, d); assert.deepEqual(s.store.entities(), before);
  } finally { s.store.close(); }
});

test('an originally reused place keeps its older metadata and receives no empty replacement', () => {
  const store = new Store(':memory:', 3, 'test-vector'); store.createSession('s', 0);
  try {
    const old = packet('earlier', 1000, 0); delete old.vision.visualDraft; insert(store, old);
    store.commit(old, { state, entities: [{ ref: 'room', kind: 'place', existingId: null, personId: null,
      label: 'Earlier room label', description: 'Metadata supported by the earlier packet.' }],
    facts: [{ entityRefs: ['room'], text: old.vision.scene, visual: true, transcriptKeys: [], confidence: 'observed', attribute: null, value: null }], events: [] });
    const known = store.entities()[0]; const p = packet('photo', 5000, 1); insert(store, p);
    const firstWire = wire(); firstWire.rows[0].b = [{ r: 1, to: 'e0', match: null }];
    store.commitBatch([p], decodeBindingBatch(firstWire, [p], context(store)));
    const before = store.entities(), originalHistory = store.entityHistory(known.id);
    const p2 = { ...structuredClone(p), version: 2, correction: true, createdAt: 6000 };
    // Sparse correction omits the prior explicit binding; the unchanged d1 slot is still the same place.
    store.commitBatch([p2], decodeBindingBatch(wire(), [p2], context(store)));
    assert.deepEqual(store.entities(), before); assert.deepEqual(store.entityHistory(known.id), originalHistory);
    assert.equal(store.entity(known.id)!.label, 'Earlier room label');
    assert.equal(store.entity(known.id)!.description, 'Metadata supported by the earlier packet.');
  } finally { store.close(); }
});

test('a different image does not inherit an anonymous person through draft alias or appearance', () => {
  const s = fixture();
  try {
    const oldPerson = s.store.entities().find(e => e.kind === 'person')!;
    const next = packet('another-image', 10000, 1); insert(s.store, next);
    const value = wire(); value.rows[0].b = [{ r: 0, to: `e${context(s.store).entities.findIndex(e => e.id === oldPerson.id)}`, match: null }];
    assert.throws(() => decodeBindingBatch(value, [next], context(s.store)), /unbound_person_identity/);
    const d = decodeBindingBatch(wire(), [next], context(s.store)).updates[0].delta;
    d.entities[0].existingId = oldPerson.id; // Direct Store caller still cannot bypass the biometric gate.
    s.store.commit(next, d);
    const later = s.store.entityHistory(oldPerson.id).filter(o => o.packetId === next.id);
    assert.equal(later.length, 1); assert.ok(later.every(o => !o.entityIds.includes(oldPerson.id) && o.candidateEntityIds?.includes(oldPerson.id)));
    assert.equal(s.store.entity(oldPerson.id)!.lastSeenAt, 5000);
  } finally { s.store.close(); }
});

test('supplemental aliases and legacy no-draft packets do not gain implicit correction identity reuse', () => {
  for (const keepDraft of [false, true]) {
    const store = new Store(':memory:', 3, 'test-vector'); store.createSession('s', 0);
    try {
      const p = packet(); if (!keepDraft) delete p.vision.visualDraft; insert(store, p);
      const ref = keepDraft ? 's0' : 'd0';
      const delta: MemoryDelta = { state, entities: [{ ref, existingId: null, personId: null, kind: 'place', label: 'Spoken place', description: 'Legacy declaration' }],
        facts: [{ entityRefs: [ref], text: 'A place is discussed.', visual: true, transcriptKeys: [], confidence: 'uncertain', attribute: null, value: null }], events: [] };
      store.commit(p, delta); const original = store.entities()[0].id;
      store.commit({ ...p, version: 2, correction: true, createdAt: 6000 }, delta);
      assert.equal(store.entities().length, 2); assert.ok(store.entities().some(e => e.id === original));
    } finally { store.close(); }
  }
});

test('actual interpreter/pipeline correction after v1 commit reuses image structure and survives Store restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'committed-visual-correction-')); const path = join(dir, 'memory.sqlite');
  let store = new Store(path, 3, 'test-vector'); store.createSession('s', 0);
  const response = (v: unknown) => [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(v) } }, { type: 'turn.completed' }].map(e => JSON.stringify(e)).join('\n');
  let images = 0, bindings = 0;
  const model = createInterpreter({ env: {}, updateFormat: 'binding', runner: async request => {
    if (request.args.includes('-i')) {
      images++;
      return { stdout: response({ scene: visual.scene, readableText: [], uncertainties: [], entities: [
        { kind: 'person', label: 'Person in blue jacket', description: visual.observations[0],
          confidence: 'observed', faceIndex: null, location: null, anchors: [] },
        { kind: 'place', label: 'White-walled room', description: visual.observations[1],
          confidence: 'observed', faceIndex: null, location: null, anchors: [] },
        { kind: 'object', label: 'Tagged keys', description: visual.observations[2],
          confidence: 'observed', faceIndex: null, location: null,
          anchors: [{ kind: 'attached_item', quote: 'red tag' }] },
      ] }), durationMs: 1 };
    }
    bindings++; const value: any = wire();
    value.rows[0].s = { location: state.location, activity: state.activity, summary: null, extraUncertainties: [] };
    const input = JSON.parse(request.stdin.split('Evidence JSON:\n')[1]);
    if (input.packets[0].t.t0) value.rows[0].f = [{ r: [], src: 't0', t: null, a: null, value: null, c: 'reported' }];
    return { stdout: response(value), durationMs: 1 };
  } });
  const pipeline = new MemoryPipeline(store, model, { model: 'test-vector', dimensions: 3, embed: async texts => texts.map(() => [1, 0, 0]) }, { dataDir: dir });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.notEqual(store.getCapture('photo')?.status, 'failed', store.getCapture('photo')?.error ?? ''); if (Date.now() > deadline) throw new Error('Fixture timeout'); await new Promise(r => setTimeout(r, 5)); }
  }
  try {
    const photo = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
    await pipeline.capture({ id: 'photo', sessionId: 's', sequence: 0, capturedAt: 5000, width: 1, height: 1,
      jpegBase64: photo.toString('base64'), audioStatus: 'live', faces: packet().faces });
    await until(() => store.isPacketCommitted('photo', 1)); const entities = store.entities(), first = store.getPacket('photo')!;
    const histories = entities.map(e => store.entityHistory(e.id));
    pipeline.transcript({ sessionId: 's', streamId: 'speech', segmentId: 'late', revision: 1, text: 'The meeting is tomorrow.',
      isFinal: true, startAt: 2000, endAt: 4000, receivedAt: 6000, words: [], speakerId: null, timing: 'approximate' });
    await until(() => store.isPacketCommitted('photo', 2)); await until(() => store.pendingEmbeddings(1).length === 0);
    assert.equal(images, 1); assert.equal(bindings, 2); assert.deepEqual(store.entities(), entities);
    assert.deepEqual(entities.map(e => store.entityHistory(e.id)), histories);
    const latest = store.getPacket('photo')!; assert.deepEqual(latest.vision, first.vision); assert.deepEqual(latest.faces, first.faces);
    assert.equal(latest.sha256, first.sha256); assert.equal(latest.capturedAt, 5000);
    assert.ok(store.observations().some(o => o.text.includes('The meeting is tomorrow.')));
    assert.ok(store.search([1, 0, 0], { entityId: entities.find(e => e.kind === 'person')!.id }).length > 0);
    await pipeline.stop(); const saved = snapshot(store); store.close(); store = new Store(path, 3, 'test-vector');
    assert.deepEqual(snapshot(store), saved);
  } finally { await pipeline.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
