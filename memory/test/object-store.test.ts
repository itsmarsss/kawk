import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { transcriptKey, type CaptureRecord, type MemoryDelta, type Packet, type Transcript } from '../src/contracts.js';
import type { ObjectEvidence } from '../src/object-identity.js';

const keyDescription = 'Two brass keys on a ring with a red tag';
let sequence = 0;
function open(path = ':memory:') { const store = new Store(path, 3, 'test-vector'); store.createSession('s', 0); return store; }
function frame(store: Store, id: string, at: number, description = keyDescription): Packet {
  const vision = { scene: 'An indoor scene', observations: [description], readableText: [], uncertainties: [] };
  const capture: CaptureRecord = { id, sequence: sequence++, sessionId: 's', capturedAt: at, width: 640, height: 480,
    faces: { frameId: id, streamId: 'faces', capturedAt: at, status: 'unavailable', width: 640, height: 480, faces: [] },
    audioStatus: 'live', imagePath: `/frames/${id}.jpg`, sha256: 'a'.repeat(64), receivedAt: at + 1,
    status: 'ready', error: null, vision };
  store.insertCapture(capture);
  return { ...capture, version: 1, audio: { text: '', wordCount: 0, segments: [], status: 'live', throughAt: at },
    createdAt: at + 2, correction: false, vision };
}
function delta(existingId: string | null, location: string, description = keyDescription, ref = 'item'): MemoryDelta {
  return { state: { location: 'Room', activity: null, summary: description, uncertainties: [] },
    entities: [{ ref, existingId, kind: 'object', label: 'Item', description, personId: null }],
    facts: [{ entityRefs: [ref], text: `${description} is ${location}.`, attribute: 'location', value: location,
      visual: true, transcriptKeys: [], confidence: 'observed' }], events: [], objectEvidence: [] };
}
function proof(ref = 'item', prior?: string, kind: ObjectEvidence['anchors'][number]['kind'] = 'attached_item',
  quote = 'red tag'): ObjectEvidence {
  return { ref, sourceIndex: 1, quote, anchors: [{ kind, sourceIndex: 1, quote }],
    match: prior ? { assessment: 'same_instance', conflictingDetails: [], competingEntityIds: [],
      anchors: [{ anchor: { packetId: prior, ref, index: 0 }, sourceIndex: 1, quote }] } : null };
}
function witnessed(existingId: string | null, location: string, prior?: string): MemoryDelta {
  const value = delta(existingId, location); value.objectEvidence = [proof('item', prior)]; return value;
}
function seed(store: Store, id = 'first', at = 1000) {
  store.commit(frame(store, id, at), witnessed(null, 'on desk'));
  return store.entities().find(entity => entity.kind === 'object')!.id;
}
function finalSpeech(): Transcript {
  return { sessionId: 's', streamId: 'audio', segmentId: 'segment', revision: 1,
    text: 'The keys are in the drawer', isFinal: true, startAt: 1200, endAt: 1500,
    receivedAt: 2100, speakerId: null, timing: 'approximate', words: [] };
}

test('three generic doors stay candidate sightings without entity proliferation or canonical mutations', () => {
  const store = open();
  try {
    const descriptions = ['An opaque dark door with a silver handle', 'Glass double doors with silver handles', 'Poster-covered glass double doors'];
    const initial = delta(null, 'near camera', descriptions[0]);
    initial.objectEvidence = [proof('item', undefined, 'generic', 'door')];
    store.commit(frame(store, 'door1', 1000, descriptions[0]), initial);
    const id = store.entities()[0].id, before = store.entity(id)!;
    for (let i = 1; i < descriptions.length; i++) {
      const next = delta(id, `doorway ${i}`, descriptions[i]);
      next.entities[0].label = 'Wrong renamed canonical door';
      // Even a cited generic anchor cannot prove the same physical door.
      next.objectEvidence = [proof('item', 'door1', 'generic', 'door')];
      store.commit(frame(store, `door${i + 1}`, (i + 1) * 1000, descriptions[i]), next);
    }
    assert.equal(store.entities().length, 1);
    assert.deepEqual(store.entity(id), before);
    assert.deepEqual(store.objectSightings().map(row => row.status), ['new', 'candidate', 'candidate']);
    const candidates = store.entityHistory(id).filter(note => note.candidateEntityIds?.includes(id));
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(note => note.entityIds.length === 0 && note.confidence === 'uncertain'));
    for (const note of candidates) store.putEmbedding(note.id, [1, 0, 0]);
    const result = store.search([1, 0, 0], { entityId: id, from: 2000, to: 3000 });
    assert.equal(result.length, 2); assert.ok(result.every(note => note.candidateEntityIds?.[0] === id));
  } finally { store.close(); }
});

test('unique exact citation repair persists actual source indexes without mutating model evidence', () => {
  const store = open();
  try {
    const id = seed(store);
    const value = witnessed(id, 'in backpack', 'first');
    const original = JSON.stringify(value);
    const packet = frame(store, 'changed-order', 6000);
    packet.vision.observations.unshift('An empty bench beside a window');
    // All three current-side citations point to index 1; the exact quote is now at 2.
    store.commit(packet, value);
    const sighting = store.objectSightings(packet.id)[0];
    assert.equal(sighting.status, 'supported');
    assert.equal(sighting.evidence!.sourceIndex, 2);
    assert.equal(sighting.evidence!.anchors[0].sourceIndex, 2);
    assert.equal(sighting.evidence!.match!.anchors[0].sourceIndex, 2);
    assert.equal(JSON.stringify(value), original);
    assert.equal(store.entity(id)!.attributes.location.value, 'in backpack');
  } finally { store.close(); }
});

test('distinctive keys retain their ID across relocation, return and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kawk-object-')); const path = join(directory, 'memory.sqlite');
  let store = open(path);
  try {
    const id = seed(store);
    store.commit(frame(store, 'bag', 6000), witnessed(id, 'inside blue backpack', 'first'));
    store.commit(frame(store, 'return', 600_000), witnessed(id, 'on desk again', 'bag'));
    assert.equal(store.entities().length, 1); assert.equal(store.entity(id)!.lastSeenAt, 600_000);
    assert.equal(store.entity(id)!.attributes.location.value, 'on desk again');
    assert.equal(store.entityHistory(id).length, 3); assert.equal(store.entity(id)!.identityAnchors?.length, 1);
    const entity = store.entity(id), sightings = store.objectSightings();
    store.close(); store = open(path);
    assert.deepEqual(store.entity(id), entity); assert.deepEqual(store.objectSightings(), sightings);
    assert.equal(store.context().entities[0].identityAnchors?.length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a generic current view cannot move red-tag keys; candidate history and vectors survive restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kawk-current-marker-')); const path = join(directory, 'memory.sqlite');
  let store = open(path);
  try {
    const id = seed(store), before = store.entity(id)!;
    const text = 'Two brass keys are inside a blue backpack; their attached marker is not visible.';
    const value = delta(id, 'inside blue backpack', text);
    value.entities[0].label = 'Unproven renamed keys';
    value.objectEvidence = [proof('item', 'first', 'generic', 'brass keys')];
    store.commit(frame(store, 'generic-view', 6000, text), value);
    assert.deepEqual(store.entity(id), before); assert.equal(store.entities().length, 1);
    const sighting = store.objectSightings('generic-view')[0];
    assert.equal(sighting.status, 'candidate'); assert.equal(sighting.reason, 'unpaired_current_anchor');
    const note = store.entityHistory(id).find(row => row.packetId === 'generic-view')!;
    assert.deepEqual(note.entityIds, []); assert.deepEqual(note.candidateEntityIds, [id]);
    assert.equal(note.confidence, 'uncertain'); assert.match(note.text, /blue backpack/);
    store.putEmbedding(note.id, [1, 0, 0]); store.close(); store = open(path);
    assert.deepEqual(store.entity(id), before);
    assert.deepEqual(store.objectSightings('generic-view')[0], sighting);
    assert.equal(store.search([1, 0, 0], { entityId: id, from: 6000, to: 6000 })[0].id, note.id);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('identical known keysets and same-frame new competitors prevent a forced match in either declaration order', () => {
  const known = open();
  try {
    const id = seed(known); known.commit(frame(known, 'second', 2000), witnessed(null, 'on another table'));
    const before = known.entity(id)!;
    known.commit(frame(known, 'ambiguous', 3000), witnessed(id, 'in bag', 'first'));
    assert.deepEqual(known.entity(id), before);
    assert.equal(known.objectSightings('ambiguous')[0].reason, 'indistinguishable_anchors');
  } finally { known.close(); }
  for (const reversed of [false, true]) {
    const store = open();
    try {
      const id = seed(store), before = store.entity(id)!;
      const value = witnessed(id, 'in bag', 'first');
      value.entities.push({ ...value.entities[0], ref: 'other', existingId: null });
      value.facts.push({ ...value.facts[0], entityRefs: ['other'], value: 'on shelf' });
      value.objectEvidence!.push(proof('other'));
      if (reversed) { value.entities.reverse(); value.objectEvidence!.reverse(); }
      store.commit(frame(store, 'together', 2000), value);
      assert.deepEqual(store.entity(id), before);
      assert.equal(store.objectSightings('together').find(row => row.ref === 'item')!.status, 'candidate');
    } finally { store.close(); }
  }
});

test('missing evidence and explicit conflicts protect metadata, while final object mentions remain reported', () => {
  const store = open();
  try {
    const id = seed(store), before = store.entity(id)!;
    const header = delta(id, 'in drawer'); header.facts = []; header.entities[0].description = 'Unproven replacement';
    store.commit(frame(store, 'header-only', 2000), header);
    assert.deepEqual(store.entity(id), before);
    const conflict = witnessed(id, 'in drawer', 'first'); conflict.objectEvidence![0].match!.conflictingDetails = ['Different attached tag'];
    store.commit(frame(store, 'conflict', 3000), conflict); assert.deepEqual(store.entity(id), before);
    const t = finalSpeech(); store.saveTranscript(t);
    const p = frame(store, 'reported', 4000, 'An empty tabletop');
    p.audio = { ...p.audio, text: t.text, wordCount: 7, segments: [t] };
    const speech = delta(id, 'in drawer'); speech.facts[0].visual = false;
    speech.facts[0].transcriptKeys = [transcriptKey(t)]; speech.facts[0].confidence = 'observed';
    store.commit(p, speech);
    assert.equal(store.entity(id)!.attributes.location.value, 'in drawer');
    assert.equal(store.entity(id)!.lastSeenAt, 1000); assert.equal(store.objectSightings('reported').length, 0);
    assert.equal(store.observations({ entityId: id }).find(note => note.packetId === 'reported')!.confidence, 'reported');
  } finally { store.close(); }
});

test('backward batch reuse cannot bypass the identity gate or turn an earlier candidate into a canonical entity', () => {
  const store = open();
  try {
    const id = seed(store), before = store.entity(id)!;
    const packets = [frame(store, 'a', 2000), frame(store, 'b', 3000)];
    store.commitBatch(packets, { updates: [
      { packetId: 'a', packetVersion: 1, delta: delta(id, 'in drawer'), reuse: [] },
      { packetId: 'b', packetVersion: 1, delta: witnessed(null, 'in bag', 'first'),
        reuse: [{ ref: 'item', fromPacketId: 'a', fromRef: 'item' }] },
    ] });
    assert.equal(store.entities().length, 1); assert.deepEqual(store.entity(id), before);
    assert.equal(store.objectSightings('a')[0].status, 'candidate');
    assert.equal(store.objectSightings('b')[0].status, 'candidate');
    assert.equal(store.objectSightings('b')[0].reason, 'earlier_batch_candidate');
    assert.ok(store.entityHistory(id).filter(note => note.packetId !== 'first').every(note =>
      note.entityIds.length === 0 && note.candidateEntityIds?.includes(id)));
    const stats = store.stats(); store.commitBatch(packets, { updates: [
      { packetId: 'a', packetVersion: 1, delta: delta(id, 'in drawer'), reuse: [] },
      { packetId: 'b', packetVersion: 1, delta: delta(null, 'in bag'), reuse: [{ ref: 'item', fromPacketId: 'a', fromRef: 'item' }] },
    ] }); assert.deepEqual(store.stats(), stats);
  } finally { store.close(); }
});

test('audio-only corrections keep frozen supported/candidate sightings and anchors without duplicates', () => {
  const store = open();
  try {
    const id = seed(store); const candidate = frame(store, 'candidate', 2000);
    store.commit(candidate, delta(id, 'in drawer'));
    const before = store.entity(id)!, sightings = store.objectSightings(), notes = store.entityHistory(id);
    const t = finalSpeech(); store.saveTranscript(t);
    const changed = { ...candidate, version: 2, correction: true,
      audio: { ...candidate.audio, text: t.text, wordCount: 7, segments: [t] } };
    // Newly generated continuity proof cannot promote this already-frozen guess.
    store.commit(changed, witnessed(id, 'in drawer', 'first'));
    assert.deepEqual(store.entity(id), before); assert.deepEqual(store.objectSightings(), sightings);
    assert.deepEqual(store.entityHistory(id), notes);
    const original = store.getPacket('first')!;
    store.commit({ ...original, version: 2, correction: true }, witnessed(id, 'on desk', 'first'));
    assert.equal(store.entity(id)!.identityAnchors?.length, 1); assert.equal(store.objectSightings().length, 2);
    assert.equal(store.entity(id)!.lastSeenAt, 1000);
  } finally { store.close(); }
});

test('malformed anchor references roll back the entire batch including new anchors and candidate sightings', () => {
  const store = open();
  try {
    const id = seed(store), before = store.stats(), anchors = store.entity(id)!.identityAnchors;
    const packets = [frame(store, 'candidate', 2000), frame(store, 'invalid', 3000)];
    const bad = witnessed(id, 'in bag', 'first'); bad.objectEvidence![0].match!.anchors[0].anchor = { id: 'not-an-anchor' };
    assert.throws(() => store.commitBatch(packets, { updates: [
      { packetId: 'candidate', packetVersion: 1, delta: delta(id, 'in drawer'), reuse: [] },
      { packetId: 'invalid', packetVersion: 1, delta: bad, reuse: [] },
    ] }), /unknown_anchor/);
    assert.equal(store.objectSightings().length, 1); assert.deepEqual(store.entity(id)!.identityAnchors, anchors);
    assert.equal(store.stats().packets, before.packets); assert.equal(store.stats().observations, before.observations);
    assert.equal(store.getCapture('candidate')!.status, 'ready');
  } finally { store.close(); }
});

test('candidate storage survives restart and additive migration preserves old observations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kawk-candidate-')); const path = join(directory, 'memory.sqlite');
  let store = open(path);
  try {
    const id = seed(store); store.close();
    const raw = new Database(path); raw.exec('ALTER TABLE observations DROP COLUMN candidate_entity_ids'); raw.close();
    store = open(path); assert.ok(store.entityHistory(id).every(note => note.candidateEntityIds?.length === 0));
    store.commit(frame(store, 'candidate', 2000), delta(id, 'in drawer'));
    const note = store.entityHistory(id).find(note => note.candidateEntityIds?.includes(id))!;
    store.putEmbedding(note.id, [1, 0, 0]); const sightings = store.objectSightings();
    store.close(); store = open(path);
    assert.deepEqual(store.objectSightings(), sightings);
    assert.deepEqual(store.search([1, 0, 0], { entityId: id, from: 2000, to: 2000 })[0].candidateEntityIds, [id]);
    assert.equal(store.entity(id)!.lastSeenAt, 1000);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('context anchors retain original distinct proof and bounded old/new details while full history survives', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kawk-anchors-')); const path = join(directory, 'memory.sqlite');
  const store = open(path);
  try {
    const id = seed(store), originalAnchor = store.entity(id)!.identityAnchors![0];
    for (let i = 1; i <= 14; i++) {
      const description = `${keyDescription}, carrying sticker ${i}`;
      const value = witnessed(id, 'on desk', 'first');
      value.objectEvidence![0].anchors = [
        { kind: 'attached_item', sourceIndex: 1, quote: 'red tag' },
        { kind: 'distinctive_marking', sourceIndex: 1, quote: `sticker ${i}` },
        { kind: 'generic', sourceIndex: 1, quote: 'brass keys' },
      ];
      store.commit(frame(store, `later-${i}`, (i + 1) * 1000, description), value);
    }
    const exposed = store.entity(id)!.identityAnchors!;
    assert.equal(exposed.length, 12); assert.deepEqual(exposed[0], originalAnchor);
    assert.deepEqual(exposed.map(anchor => anchor.quote), ['red tag', 'sticker 1', 'sticker 2', 'sticker 3', 'sticker 4', 'sticker 5',
      'sticker 9', 'sticker 10', 'sticker 11', 'sticker 12', 'sticker 13', 'sticker 14']);
    const raw = new Database(path, { readonly: true });
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM object_anchors').get() as { n: number }).n, 43); raw.close();
    // An exact original source remains available for matches despite repeated evidence.
    store.commit(frame(store, 'return', 100_000), witnessed(id, 'in bag', 'first'));
    assert.equal(store.entity(id)!.attributes.location.value, 'in bag');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('correction cannot silently rebind an explicit object ID to another frozen identity', () => {
  const store = open();
  try {
    const firstId = seed(store);
    store.commit(frame(store, 'other', 2000), witnessed(null, 'on another desk'));
    const otherId = store.entities().find(entity => entity.id !== firstId)!.id;
    const before = store.entities(), sightings = store.objectSightings(), history = store.history();
    const original = store.getPacket('first')!;
    assert.throws(() => store.commit({ ...original, version: 2, correction: true }, witnessed(otherId, 'on desk')),
      /conflicts with frozen object identity/);
    assert.deepEqual(store.entities(), before); assert.deepEqual(store.objectSightings(), sightings);
    assert.deepEqual(store.history(), history); assert.equal(store.packetVersions('first').length, 1);
  } finally { store.close(); }
});
