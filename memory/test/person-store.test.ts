import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { transcriptKey, type CaptureRecord, type MemoryDelta, type Packet, type Transcript } from '../src/contracts.js';

let sequence = 0;
function open(path = ':memory:') { const store = new Store(path, 3, 'test-vector'); store.createSession('s', 0); return store; }
function frame(store: Store, id: string, at: number,
  people: { id: string | null; name?: string; track?: string }[] = [], status: 'ready' | 'unavailable' = 'ready', streamId = 'faces'): Packet {
  const vision = { scene: 'An indoor scene', observations: ['A person wears a blue jacket'], readableText: [], uncertainties: [] };
  const capture: CaptureRecord = { id, sequence: sequence++, sessionId: 's', capturedAt: at, width: 640, height: 480,
    faces: { frameId: id, streamId, capturedAt: at, status, width: 640, height: 480,
      faces: people.map((person, index) => ({ trackId: person.track ?? `track-${index}`, personId: person.id,
        name: person.name ?? null, similarity: person.id ? .8 : null, box: [10, 10, 100, 100],
        identityStatus: person.id ? 'confirmed' : 'unknown' })) },
    audioStatus: 'live', imagePath: `/frames/${id}.jpg`, sha256: 'a'.repeat(64), receivedAt: at + 1,
    status: 'ready', error: null, vision };
  store.insertCapture(capture);
  return { ...capture, version: 1, audio: { text: '', wordCount: 0, segments: [], status: 'live', throughAt: at },
    createdAt: at + 2, correction: false, vision };
}
function empty(): MemoryDelta {
  return { state: { location: 'Room', activity: null, summary: 'An indoor scene', uncertainties: [] }, entities: [], facts: [], events: [] };
}
function person(existingId: string | null, personId: string | null = null, location = 'at the desk'): MemoryDelta {
  const value = empty();
  value.entities.push({ ref: 'person', existingId, kind: 'person', personId, label: 'Person in blue', description: 'Wears a blue jacket' });
  value.facts.push({ entityRefs: ['person'], text: `The person is ${location}.`, attribute: 'location', value: location,
    visual: true, transcriptKeys: [], confidence: 'observed' });
  return value;
}
function seed(store: Store): void {
  store.commit(frame(store, 'first', 1000, [{ id: 'bob', name: 'Bob' }]), person('bob', 'bob'));
}
function speech(store: Store, revision = 1, text = 'Bob likes hiking'): Transcript {
  const value: Transcript = { sessionId: 's', streamId: 'audio', segmentId: 'segment', revision,
    text, isFinal: true, startAt: 1200, endAt: 1500, receivedAt: 2100 + revision,
    speakerId: null, timing: 'approximate', words: [] };
  store.saveTranscript(value); return value;
}
function withSpeech(packet: Packet, transcript: Transcript): Packet {
  return { ...packet, audio: { ...packet.audio, text: transcript.text, wordCount: transcript.text.split(' ').length, segments: [transcript] } };
}

test('absent or unavailable gallery identity becomes a searchable candidate without canonical mutation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kawk-person-')); const path = join(directory, 'memory.sqlite');
  let store = open(path);
  try {
    seed(store); const before = store.entity('bob');
    for (const [i, status] of (['unavailable', 'ready'] as const).entries()) {
      const value = person('bob', 'bob', `in guessed room ${i}`);
      value.entities[0].description = 'An unverified replacement description';
      store.commit(frame(store, `guess-${i}`, 2000 + i * 1000, [], status), value);
    }
    assert.deepEqual(store.entity('bob'), before);
    const candidates = store.entityHistory('bob').filter(note => note.candidateEntityIds?.includes('bob'));
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(note => note.entityIds.length === 0 && note.confidence === 'uncertain'));
    for (const note of candidates) store.putEmbedding(note.id, [1, 0, 0]);
    assert.equal(store.search([1, 0, 0], { entityId: 'bob', from: 2000, to: 3000 }).length, 2);
    assert.equal(store.objectSightings().length, 0);
    assert.deepEqual(store.encounters().map(row => [row.startAt, row.endAt]), [[1000, 3000]]);
    store.close(); store = open(path);
    assert.deepEqual(store.entity('bob'), before);
    assert.ok(store.search([1, 0, 0], { entityId: 'bob', from: 2000 }).every(note => note.candidateEntityIds?.includes('bob')));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a different confirmed face cannot validate a gallery guess; actual return keeps the original UUID', () => {
  const store = open();
  try {
    seed(store); const before = store.entity('bob');
    store.commit(frame(store, 'alice', 2000, [{ id: 'alice', name: 'Alice' }]), person('bob', 'bob', 'by the window'));
    assert.deepEqual(store.entity('bob'), before);
    assert.equal(store.entity('alice')!.lastSeenAt, 2000);
    assert.ok(store.entityHistory('bob').find(note => note.packetId === 'alice')!.candidateEntityIds?.includes('bob'));
    store.commit(frame(store, 'return', 3000, [{ id: 'bob', name: 'Robert' }]), person('bob', 'bob', 'on the sofa'));
    assert.equal(store.entity('bob')!.lastSeenAt, 3000);
    assert.equal(store.entity('bob')!.label, 'Robert');
    assert.equal(store.entity('bob')!.attributes.location.value, 'on the sofa');
    assert.equal(store.encounters().filter(row => row.personId === 'bob').length, 2);
  } finally { store.close(); }
});

test('anonymous identities require the same actual stream and track, never just matching appearance', () => {
  const store = open();
  try {
    const first = frame(store, 'anonymous', 1000, [{ id: null, track: 't1' }]);
    const id = store.faceEntities(first)[0].id;
    store.commit(first, person(id));
    store.commit(frame(store, 'same-track', 2000, [{ id: null, track: 't1' }]), person(id, null, 'by the window'));
    const before = store.entity(id)!;
    assert.equal(before.lastSeenAt, 2000); assert.equal(before.attributes.location.value, 'by the window');
    store.commit(frame(store, 'new-stream', 3000, [{ id: null, track: 't1' }], 'ready', 'replacement-stream'), person(id, null, 'in the hall'));
    store.commit(frame(store, 'different-track', 4000, [{ id: null, track: 't2' }]), person(id, null, 'at a second desk'));
    assert.deepEqual(store.entity(id), before);
    assert.equal(store.entityHistory(id).filter(note => note.candidateEntityIds?.includes(id)).length, 2);
    assert.equal(store.entities().length, 3);
  } finally { store.close(); }
});

test('caption-created person aliases remain candidates through backward batch reuse', () => {
  const store = open();
  try {
    const packets = [1, 2, 3].map(i => frame(store, `caption-${i}`, i * 1000, [], 'unavailable'));
    store.commitBatch(packets, { updates: packets.map((packet, i) => ({
      packetId: packet.id, packetVersion: 1, delta: person(null, null, `at desk ${i}`),
      reuse: i ? [{ ref: 'person', fromPacketId: packets[i - 1].id, fromRef: 'person' }] : [],
    })) });
    const entity = store.entities()[0];
    assert.equal(store.entities().length, 1); assert.equal(entity.lastSeenAt, 1000);
    assert.equal(entity.attributes.location.value, 'at desk 0');
    assert.equal(store.entityHistory(entity.id).filter(note => note.candidateEntityIds?.includes(entity.id)).length, 2);
    assert.equal(store.encounters().length, 0); assert.equal(store.objectSightings().length, 0);
  } finally { store.close(); }
});

test('header-only guesses cannot rewrite person metadata, and conflicting IDs still reject atomically', () => {
  const store = open();
  try {
    seed(store); store.commit(frame(store, 'other', 1500, [{ id: 'alice', name: 'Alice' }]), empty());
    const before = store.entity('bob');
    const header = person('bob'); header.facts = []; header.entities[0].description = 'Unsupported new description';
    store.commit(frame(store, 'header', 2000, [], 'unavailable'), header);
    assert.deepEqual(store.entity('bob'), before);
    const bad = frame(store, 'conflict', 3000, [], 'unavailable');
    assert.throws(() => store.commit(bad, person('bob', 'alice')), /Conflicting person identity/);
    assert.equal(store.isPacketCommitted(bad.id, 1), false);
    assert.deepEqual(store.entity('bob'), before);
  } finally { store.close(); }
});

test('reported named-person speech keeps source times and never advances physical lastSeen', () => {
  const store = open();
  try {
    seed(store); const t = speech(store);
    const value = person('bob', 'bob'); value.entities[0].description = 'Reported to enjoy hiking';
    value.facts[0] = { entityRefs: ['person'], text: 'Bob likes hiking', attribute: 'interest', value: 'hiking',
      visual: false, transcriptKeys: [transcriptKey(t)], confidence: 'observed' };
    store.commit(withSpeech(frame(store, 'reported', 5000, [], 'unavailable'), t), value);
    const note = store.entityHistory('bob').find(row => row.packetId === 'reported' && row.text === 'Bob likes hiking')!;
    assert.deepEqual(note.entityIds, ['bob']); assert.deepEqual(note.candidateEntityIds, []);
    assert.equal(note.confidence, 'reported'); assert.equal(note.observedAt, 1200); assert.equal(note.endAt, 1500);
    assert.equal(store.entity('bob')!.lastSeenAt, 1000); assert.equal(store.entity('bob')!.attributes.interest.value, 'hiking');
    assert.equal(store.entity('bob')!.description, 'Reported to enjoy hiking');
    assert.equal(store.encounters().length, 1);
  } finally { store.close(); }
});

test('mixed speech and visual guesses cannot rewrite metadata but separate reported facts remain canonical', () => {
  const store = open();
  try {
    seed(store); const before = store.entity('bob')!; const t = speech(store);
    const value = person('bob', 'bob', 'at the café'); value.entities[0].description = 'Unverified café visitor';
    value.facts[0].transcriptKeys = [transcriptKey(t)];
    value.facts.push({ entityRefs: ['person'], text: 'Bob likes hiking', attribute: 'interest', value: 'hiking',
      visual: false, transcriptKeys: [transcriptKey(t)], confidence: 'reported' });
    store.commit(withSpeech(frame(store, 'mixed', 3000, [], 'unavailable'), t), value);
    const notes = store.entityHistory('bob').filter(row => row.packetId === 'mixed');
    const visual = notes.find(row => row.visual)!; const reported = notes.find(row => !row.visual)!;
    assert.deepEqual(visual.entityIds, []); assert.deepEqual(visual.candidateEntityIds, ['bob']);
    assert.equal(visual.confidence, 'uncertain'); assert.deepEqual(visual.transcriptKeys, [transcriptKey(t)]);
    assert.deepEqual(reported.entityIds, ['bob']); assert.equal(reported.confidence, 'reported');
    assert.equal(store.entity('bob')!.description, before.description); assert.equal(store.entity('bob')!.lastSeenAt, 1000);
    assert.equal(store.entity('bob')!.attributes.location.value, before.attributes.location.value);
    assert.equal(store.entity('bob')!.attributes.interest.value, 'hiking');
  } finally { store.close(); }
});

test('an earlier reported name can use a later registered face without inventing an earlier sighting', () => {
  const store = open();
  try {
    const t = speech(store); const earlier = withSpeech(frame(store, 'reported', 2000, [], 'unavailable'), t);
    const later = frame(store, 'confirmed', 3000, [{ id: 'bob', name: 'Bob' }]);
    const value = person('bob', 'bob'); value.facts[0] = { entityRefs: ['person'], text: t.text, attribute: null, value: null,
      visual: false, transcriptKeys: [transcriptKey(t)], confidence: 'reported' };
    store.commitBatch([earlier, later], { updates: [
      { packetId: earlier.id, packetVersion: 1, delta: value, reuse: [] },
      { packetId: later.id, packetVersion: 1, delta: empty(), reuse: [] },
    ] });
    assert.equal(store.entity('bob')!.lastSeenAt, 3000);
    assert.deepEqual(store.encounters().map(row => row.startAt), [3000]);
    assert.ok(store.entityHistory('bob').filter(row => row.packetId === earlier.id).every(row => !row.visual));
  } finally { store.close(); }
});

test('late final correction preserves the frozen face gate and removes obsolete candidate claims', () => {
  const store = open();
  try {
    seed(store); const before = store.entity('bob')!; const first = speech(store);
    const packet = withSpeech(frame(store, 'mixed', 3000, [], 'unavailable'), first);
    const value = person('bob', 'bob', 'at the café'); value.facts[0].transcriptKeys = [transcriptKey(first)];
    store.commit(packet, value);
    const old = store.entityHistory('bob').find(row => row.packetId === 'mixed' && row.visual)!; store.putEmbedding(old.id, [1, 0, 0]);
    const revised = speech(store, 2, 'Bob likes swimming');
    const correction = withSpeech({ ...packet, version: 2, correction: true }, revised);
    const corrected = person('bob', 'bob', 'near the pool'); corrected.facts[0].transcriptKeys = [transcriptKey(revised)];
    store.commit(correction, corrected);
    assert.deepEqual(store.entity('bob'), before);
    const notes = store.entityHistory('bob', { includeSuperseded: false }).filter(row => row.packetId === 'mixed' && row.visual);
    assert.equal(notes.length, 1); assert.deepEqual(notes[0].candidateEntityIds, ['bob']);
    assert.deepEqual(notes[0].transcriptKeys, [transcriptKey(revised)]);
    assert.equal(store.search([1, 0, 0], { entityId: 'bob', from: 2000 }).length, 0);
    assert.equal(store.entityHistory('bob', { includeSuperseded: true }).filter(row => row.packetId === 'mixed' && row.visual).length, 2);
  } finally { store.close(); }
});
