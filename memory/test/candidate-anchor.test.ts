import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateObjectIdentity, type CandidateObjectSighting, type ObjectEvidence } from '../src/object-identity.js';
import { Store } from '../src/store.js';
import type { CaptureRecord, MemoryBatch, MemoryDelta, Packet } from '../src/contracts.js';

const vision = { scene: 'Keys near a table', observations: ['Metal keys with a distinctive red tag.'],
  readableText: [], uncertainties: [] };
function evidence(priorPacketId?: string): ObjectEvidence {
  return { ref: 'keys', sourceIndex: 1, quote: vision.observations[0],
    anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'distinctive red tag' }],
    match: priorPacketId ? { assessment: 'same_instance', conflictingDetails: [], competingEntityIds: [],
      anchors: [{ anchor: { packetId: priorPacketId, ref: 'keys', index: 0 }, sourceIndex: 1, quote: 'distinctive red tag' }] } : null };
}
function candidateSource(): CandidateObjectSighting {
  return { packet: { id: 'possible', capturedAt: 2000, vision }, packetVersion: 1, ref: 'keys',
    candidateEntityIds: ['known-keys'], evidence: { ...evidence(),
      match: { assessment: 'possible', anchors: [], conflictingDetails: [], competingEntityIds: [] } } };
}
function evaluate(sources = [candidateSource()], current = evidence('possible')) {
  return evaluateObjectIdentity({ packet: { id: 'current', capturedAt: 3000, vision },
    candidateId: 'known-keys', evidence: current, anchors: [], candidateSightings: sources });
}

test('candidate source citations retain exact provenance without becoming matched canonical anchors', () => {
  const current = evidence('possible'), before = structuredClone(current);
  const result = evaluate([candidateSource()], current);
  assert.equal(result.status, 'candidate'); assert.equal(result.reason, 'earlier_candidate_anchor');
  assert.deepEqual(result.matchedAnchorIds, []);
  assert.deepEqual(result.resolvedEvidence, current); assert.deepEqual(current, before);
});

test('candidate citations reject missing, wrong-owner, future, same-frame and mismatched source evidence', () => {
  const cases: [string, (source: CandidateObjectSighting, current: ObjectEvidence) => void, RegExp][] = [
    ['unknown packet', (_, current) => { current.match!.anchors[0].anchor = { packetId: 'missing', ref: 'keys', index: 0 }; }, /unknown_anchor/],
    ['unknown ref', (_, current) => { current.match!.anchors[0].anchor = { packetId: 'possible', ref: 'other', index: 0 }; }, /unknown_anchor/],
    ['unknown index', (_, current) => { current.match!.anchors[0].anchor = { packetId: 'possible', ref: 'keys', index: 1 }; }, /unknown_anchor/],
    ['wrong candidate', source => { source.candidateEntityIds = ['other-keys']; }, /anchor_owner_mismatch/],
    ['wrong evidence owner', source => { source.evidence.ref = 'other'; }, /anchor_owner_mismatch/],
    ['future', source => { source.packet.capturedAt = 4000; }, /non_earlier_anchor/],
    ['equal time', source => { source.packet.capturedAt = 3000; }, /non_earlier_anchor/],
    ['same frame', (source, current) => { source.packet.id = 'current'; current.match!.anchors[0].anchor = { packetId: 'current', ref: 'keys', index: 0 }; }, /non_earlier_anchor/],
    ['unknown source', source => { source.evidence.anchors[0].sourceIndex = 2; }, /unknown_prior_source/],
    ['wrong anchor quote', source => { source.evidence.anchors[0].quote = 'blue ribbon'; }, /prior_quote_mismatch/],
    ['wrong whole source', source => { source.evidence.quote = 'A different object'; }, /prior_quote_mismatch/],
    ['bad current quote', (_, current) => { current.match!.anchors[0].quote = 'blue ribbon'; }, /current_quote_mismatch/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const source = candidateSource(), current = evidence('possible'); mutate(source, current);
    assert.throws(() => evaluate([source], current), pattern, name);
  }
  assert.throws(() => evaluate([candidateSource(), candidateSource()]), /ambiguous_anchor_reference/);
  const current = evidence('possible');
  current.match!.anchors.push({ anchor: { id: 'unknown-canonical-anchor' }, sourceIndex: 1, quote: 'red tag' });
  assert.throws(() => evaluate([candidateSource()], current), /unknown_anchor/,
    'A candidate citation must not bypass validation of a later canonical citation');
});

function packet(store: Store, id: string, at: number): Packet {
  const faces: Packet['faces'] = { frameId: id, streamId: 'faces', capturedAt: at, status: 'unavailable',
    width: 640, height: 480, faces: [] };
  const capture: CaptureRecord = { id, sessionId: 's', sequence: at, capturedAt: at, width: 640, height: 480,
    faces, audioStatus: 'unavailable', imagePath: `/frames/${id}.jpg`, sha256: 'a'.repeat(64), receivedAt: at,
    status: 'ready', error: null, vision };
  store.insertCapture(capture);
  return { id, version: 1, sessionId: 's', sequence: at, capturedAt: at, imagePath: capture.imagePath,
    sha256: capture.sha256, faces, audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: at },
    vision, createdAt: at, correction: false };
}
function delta(existingId: string | null, location: string, prior?: string): MemoryDelta {
  return { state: { location: 'Room', activity: null, summary: vision.scene, uncertainties: [] },
    entities: [{ ref: 'keys', existingId, kind: 'object', label: 'Keys', description: 'Keys with a red tag', personId: null }],
    facts: [{ entityRefs: ['keys'], text: `The keys are ${location}.`, attribute: 'location', value: location,
      visual: true, transcriptKeys: [], confidence: 'observed' }], events: [], objectEvidence: [evidence(prior)] };
}
function row(packet: Packet, delta: MemoryDelta, reuse: MemoryBatch['updates'][number]['reuse'] = []) {
  return { packetId: packet.id, packetVersion: packet.version, delta, reuse };
}

test('V5 candidate bench reference pattern commits all sources without changing canonical projection or anchors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kawk-candidate-anchor-')), db = join(directory, 'memory.sqlite');
  let store = new Store(db, 3, 'test');
  try {
    store.createSession('s', 0);
    store.commit(packet(store, 'baseline', 1000), delta(null, 'on the desk'));
    const id = store.entities()[0].id, original = store.entity(id)!;
    const canonicalAnchors = structuredClone(store.context().entities[0].identityAnchors);
    const possible = packet(store, 'possible', 2000), next = packet(store, 'next', 3000);
    const uncertain = delta(id, 'near the cupboard');
    uncertain.objectEvidence![0].match = { assessment: 'possible', anchors: [], conflictingDetails: [], competingEntityIds: [] };
    const later = delta(id, 'near the window', 'possible');
    // Like V5, binding to an earlier alias has already collapsed to the old ID;
    // there is no row.reuse metadata for the Store to inherit.
    store.commitBatch([possible, next], { updates: [row(possible, uncertain), row(next, later)] });
    assert.equal(store.getCapture('possible')!.status, 'committed');
    assert.equal(store.getCapture('next')!.status, 'committed');
    assert.deepEqual(store.entity(id), original);
    assert.deepEqual(store.context().entities[0].identityAnchors, canonicalAnchors);
    const sightings = store.objectSightings('next');
    assert.equal(sightings[0].status, 'candidate'); assert.equal(sightings[0].entityId, null);
    assert.equal(sightings[0].reason, 'earlier_candidate_anchor');
    assert.deepEqual(sightings[0].candidateEntityIds, [id]);
    assert.deepEqual(sightings[0].evidence!.match!.anchors, later.objectEvidence![0].match!.anchors);
    const notes = store.observations({ entityId: id }).filter(note => note.packetId === 'next');
    assert.ok(notes.some(note => note.text.includes('near the window') && note.confidence === 'uncertain' &&
      note.entityIds.length === 0 && note.candidateEntityIds!.includes(id)));
    assert.ok(store.observations().some(note => note.packetId === 'next' && note.text === vision.observations[0]));
    const before = { sightings: store.objectSightings(), observations: store.observations(), history: store.history() };
    store.close(); store = new Store(db, 3, 'test');
    assert.deepEqual({ sightings: store.objectSightings(), observations: store.observations(), history: store.history() }, before);
    assert.deepEqual(store.entity(id), original);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('candidate inheritance through explicit batch reuse stays unresolved', () => {
  const store = new Store(':memory:', 3, 'test');
  try {
    store.createSession('s', 0); store.commit(packet(store, 'baseline', 1000), delta(null, 'on the desk'));
    const id = store.entities()[0].id;
    const first = packet(store, 'possible', 2000), next = packet(store, 'next', 3000);
    const possible = delta(id, 'near a drawer');
    possible.objectEvidence![0].match = { assessment: 'possible', anchors: [], conflictingDetails: [], competingEntityIds: [] };
    store.commitBatch([first, next], { updates: [row(first, possible),
      row(next, delta(null, 'near a chair', 'possible'), [{ ref: 'keys', fromPacketId: first.id, fromRef: 'keys' }])] });
    assert.equal(store.objectSightings('next')[0].reason, 'earlier_batch_candidate');
    assert.equal(store.objectSightings('next')[0].entityId, null);
    assert.equal(store.entity(id)!.lastSeenAt, 1000);
  } finally { store.close(); }
});

test('new and supported earlier canonical anchors still establish ordinary object continuity', () => {
  const store = new Store(':memory:', 3, 'test');
  try {
    store.createSession('s', 0);
    const first = packet(store, 'first', 1000), second = packet(store, 'second', 2000), third = packet(store, 'third', 3000);
    store.commitBatch([first, second, third], { updates: [row(first, delta(null, 'on the desk')),
      row(second, delta(null, 'in the backpack', 'first'), [{ ref: 'keys', fromPacketId: first.id, fromRef: 'keys' }]),
      row(third, delta(null, 'on the shelf', 'second'), [{ ref: 'keys', fromPacketId: second.id, fromRef: 'keys' }])] });
    assert.equal(store.entities().length, 1);
    assert.equal(store.objectSightings('second')[0].status, 'supported');
    assert.equal(store.objectSightings('third')[0].status, 'supported');
    assert.equal(store.entities()[0].attributes.location.value, 'on the shelf');
    assert.equal(store.entities()[0].lastSeenAt, 3000);
  } finally { store.close(); }
});
