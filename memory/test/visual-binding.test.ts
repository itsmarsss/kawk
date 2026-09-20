import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { BindingError, BindingModelBatchSchema, bindingModelSchema, bindingUpdatePrompt, decodeBindingBatch } from '../src/visual-binding.js';
import { Store } from '../src/store.js';
import { faceEntityId } from '../src/face-identity.js';
import { evaluateObjectIdentity, type ObjectAnchor } from '../src/object-identity.js';
import { bindingDraftContext } from '../src/binding-context.js';
import { MemoryDeltaSchema, MemoryModelStateSchema, transcriptKey, type CaptureRecord, type Entity, type MemoryContext, type Packet, type Transcript } from '../src/contracts.js';

type Wire = z.infer<typeof BindingModelBatchSchema>;
const state = { location: null, activity: null, summary: 'Keys on a desk.', uncertainties: [] };
function context(entities: Entity[] = []): MemoryContext {
  return { state: { ...state, version: 0, observedAt: 0, packetId: null }, entities, related: [] };
}
function entity(id = 'keys', kind: Entity['kind'] = 'object'): Entity {
  return { id, kind, label: kind === 'person' ? 'Bob' : 'Known keys', description: 'Existing metadata remains intact.',
    personId: kind === 'person' ? id : null, createdAt: 1, lastSeenAt: 1, attributes: {} };
}
function packet(index = 0): Packet {
  const id = `packet-${index}`, capturedAt = (index + 1) * 5000;
  return { id, capturedAt, sequence: index, version: 1, sessionId: 'session', createdAt: capturedAt + 1,
    correction: false, imagePath: '/not-read.jpg', sha256: 'a'.repeat(64),
    faces: { frameId: id, capturedAt, streamId: 'faces', status: 'ready', width: 640, height: 480, faces: [] },
    audio: { text: '', wordCount: 0, segments: [], throughAt: capturedAt, status: 'unavailable' },
    vision: { scene: 'A desk in a room.', observations: ['Brass keys with a distinctive red tag are on the desk.'], readableText: [], uncertainties: [],
      visualDraft: { entities: [{ kind: 'object', label: 'Brass keys', descriptionSourceIndex: 1, faceIndex: null }],
        facts: [{ entityIndexes: [0], sourceIndex: 1, text: null, attribute: 'location', value: 'on the desk', confidence: 'observed' }],
        objects: [{ entityIndex: 0, sourceIndex: 1, anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'distinctive red tag' }] }] } } };
}
function wire(count = 1): Wire { return { rows: Array.from({ length: count }, (_, i) => ({ i,
  s: structuredClone(state), b: [{ r: 0, to: null, match: null }], n: [], f: [], e: [] })) }; }
function generationWire(count = 1): Wire {
  const value = wire(count);
  for (const row of value.rows) row.s = { location: null, activity: null, summary: null, extraUncertainties: [] };
  return value;
}
function anchor(owner = 'keys'): ObjectAnchor {
  return { id: 'persisted-anchor', entityId: owner, packetId: 'old-frame', packetVersion: 1,
    ref: 'old-keys', index: 0, sourceIndex: 1, kind: 'attached_item', quote: 'distinctive red tag', observedAt: 1, active: true };
}
function matching(): NonNullable<Wire['rows'][number]['b'][number]['match']> {
  return { assessment: 'same_instance', anchors: [{ prior: 'a0', current: 0 }], conflicts: [], competitors: [] };
}
function relativeMatching(prior = 0, current = 0): NonNullable<Wire['rows'][number]['b'][number]['match']> {
  return { ...matching(), anchors: [{ prior, current }] };
}
function speech(text: string, isFinal = true): Transcript {
  return { sessionId: 'session', streamId: 'speech', segmentId: isFinal ? 'final' : 'partial', revision: 1,
    text, isFinal, startAt: 2000, endAt: 4000, receivedAt: 4001, words: [], timing: 'exact', speakerId: null };
}
function rejects(input: unknown, packets: Packet[], ctx: MemoryContext, code: string) {
  assert.throws(() => decodeBindingBatch(input, packets, ctx), (error: unknown) => error instanceof BindingError && error.code === code);
}

test('possible shorthand expands to identical evidence and cannot become a supported identity', () => {
  const p = packet(), old = entity(), value = generationWire(); old.identityAnchors = [anchor()];
  const ctx = context([old]); value.rows[0].b = [{ r: 0, to: 'e0', match: {
    assessment: 'possible', anchors: [], conflicts: [], competitors: [],
  } }];
  const compact = { rows: [{ ...value.rows[0], b: [{ r: 0, to: 'e0', match: 'possible' }] }] };
  assert.equal(bindingModelSchema([p], ctx).safeParse(compact).success, true);
  const decoded = decodeBindingBatch(compact, [p], ctx);
  assert.deepEqual(decoded, decodeBindingBatch(value, [p], ctx));
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: old.id, anchors: old.identityAnchors,
    evidence: decoded.updates[0].delta.objectEvidence![0] }).status, 'candidate');
  const detailed = structuredClone(value); detailed.rows[0].b[0].match!.conflicts = ['The tag has a different pattern.'];
  detailed.rows[0].b[0].match!.competitors = ['e1'];
  const full = decodeBindingBatch(detailed, [p], context([old, entity('competitor')]));
  assert.deepEqual(full.updates[0].delta.objectEvidence![0].match!.conflictingDetails, ['The tag has a different pattern.']);
  assert.deepEqual(full.updates[0].delta.objectEvidence![0].match!.competingEntityIds, ['competitor']);
});

test('shorthand is invalid for new objects, place identity, wrong targets and duplicate identities', () => {
  const p = packet(), ctx = context([entity()]), row = generationWire().rows[0];
  const value = { rows: [{ ...row, b: [{ r: 0, to: null, match: 'possible' }] }] };
  assert.equal(bindingModelSchema([p], ctx).safeParse(value).success, false);
  rejects(value, [p], ctx, 'invalid_match');
  const wrong = { rows: [{ ...row, b: [{ r: 0, to: 'e99', match: 'possible' }] }] };
  assert.equal(bindingModelSchema([p], ctx).safeParse(wrong).success, false);
  rejects(wrong, [p], ctx, 'unknown_reference');
  const place = packet(); place.vision.visualDraft!.entities[0].kind = 'place'; place.vision.visualDraft!.objects = [];
  const placeContext = context([entity('room', 'place')]);
  const known = { rows: [{ ...row, b: [{ r: 0, to: 'e0', match: 'possible' }] }] };
  assert.equal(bindingModelSchema([place], placeContext).safeParse(known).success, false);
  rejects(known, [place], placeContext, 'invalid_match');
  p.vision.visualDraft!.entities.push({ ...p.vision.visualDraft!.entities[0] });
  p.vision.visualDraft!.objects.push({ ...p.vision.visualDraft!.objects[0], entityIndex: 1 });
  const duplicate = { rows: [{ ...row, b: [{ r: 0, to: 'e0', match: 'possible' }, { r: 1, to: 'e0', match: 'possible' }] }] };
  rejects(duplicate, [p], ctx, 'duplicate_visual_identity');
});

test('explicit and compact candidates preserve identical Store histories without moving canonical keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kawk-compact-candidate-'));
  const packets = [packet(), packet(1)], explicit = generationWire(2);
  packets[1].vision.observations[0] = 'Brass keys with a distinctive red tag are on a backpack.';
  packets[1].vision.visualDraft!.facts[0].value = 'on a backpack';
  explicit.rows[1].b = [{ r: 0, to: 'p0d0', match: { assessment: 'possible', anchors: [], conflicts: [], competitors: [] } }];
  const compact = { rows: explicit.rows.map((row, i) => i === 1 ? { ...row,
    b: [{ r: 0, to: 'p0d0', match: 'possible' }] } : row) };
  const snapshots = [];
  try {
    for (const [i, value] of [explicit, compact].entries()) {
      const store = new Store(join(dir, `${i}.sqlite`), 3, 'fixture');
      try {
        store.createSession('session', 0);
        for (const p of packets) store.insertCapture({ ...p, width: 640, height: 480,
          receivedAt: p.capturedAt, status: 'ready', error: null, audioStatus: 'unavailable' });
        store.commitBatch(packets, decodeBindingBatch(value, packets, context()));
        const object = store.entities().find(e => e.kind === 'object')!;
        assert.equal(object.attributes.location.value, 'on the desk');
        assert.equal(store.objectSightings(packets[1].id)[0].status, 'candidate');
        assert.equal(store.objectSightings(packets[1].id)[0].entityId, null);
        snapshots.push({ entities: store.entities(), sightings: store.objectSightings(), observations: store.observations({ limit: 100 }) });
      } finally { store.close(); }
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generation schema permits only empty bindings for person-only and empty drafts', () => {
  for (const withPerson of [true, false]) {
    const p = packet(), value = generationWire();
    p.vision.visualDraft = { entities: withPerson ? [{ kind: 'person', label: 'Unidentified person', descriptionSourceIndex: 0, faceIndex: null }] : [],
      facts: [], objects: [] };
    const schema = bindingModelSchema([p], context()); value.rows[0].b = [];
    assert.equal(schema.safeParse(value).success, true);
    assert.equal(decodeBindingBatch(value, [p], context()).updates[0].delta.entities.length, withPerson ? 1 : 0);
    value.rows[0].b = [{ r: 0, to: null, match: null }];
    assert.equal(schema.safeParse(value).success, false);
    const json = z.toJSONSchema(schema) as any;
    assert.equal(json.type, 'object'); assert.equal(json.additionalProperties, false);
    const generatedRow = json.properties.rows.items.anyOf[0];
    assert.equal(generatedRow.properties.b.maxItems, 0);
    assert.equal(generatedRow.properties.b.items.type, 'object');
  }
});

test('generation restricts each row to its own object and place slots without relaxing the decoder', () => {
  const packets = [packet(), packet(1)], value = generationWire(2);
  packets[0].vision.visualDraft!.entities.push({ kind: 'place', label: 'Room', descriptionSourceIndex: 0, faceIndex: null });
  packets[1].vision.visualDraft!.entities.unshift({ kind: 'place', label: 'Room', descriptionSourceIndex: 0, faceIndex: null });
  packets[1].vision.visualDraft!.facts[0].entityIndexes = [1]; packets[1].vision.visualDraft!.objects[0].entityIndex = 1;
  const schema = bindingModelSchema(packets, context([entity('room', 'place')]));
  value.rows[0].b = [{ r: 1, to: 'e0', match: null }];
  value.rows[1].b = [{ r: 0, to: 'e0', match: null }, { r: 1, to: 'p0d0', match: relativeMatching() }];
  assert.equal(schema.safeParse(value).success, true);
  value.rows[0].b[0].match = { assessment: 'possible', anchors: [], conflicts: [], competitors: [] };
  assert.equal(schema.safeParse(value).success, false);
  // Recorded malformed place matches remain invalid; no uncertainty is erased to rescue them.
  const first = { rows: [value.rows[0]] };
  assert.equal(BindingModelBatchSchema.safeParse(first).success, true);
  rejects(first, [packets[0]], context([entity('room', 'place')]), 'invalid_match');
  value.rows[0].b[0].match = null;
  value.rows[1].b[1].r = 0; // Row 1's place cannot use Row 0's object slot and match.
  assert.equal(schema.safeParse(value).success, false);
  value.rows[1].b[1].r = 1; value.rows[1].b[1].to = null;
  assert.equal(schema.safeParse(value).success, false);
  value.rows[1].b[1].match = null;
  assert.equal(schema.safeParse(value).success, true);
  value.rows[1].b[1].r = 2;
  assert.equal(schema.safeParse(value).success, false);
  value.rows[1].b = []; value.rows[1].i = 2;
  assert.equal(schema.safeParse(value).success, false);
  assert.equal(schema.safeParse({ rows: [value.rows[0]] }).success, false);
});

test('generation distinguishes relation facts from exactly one-owner attributes', () => {
  const schema = bindingModelSchema([packet()], context()), value = generationWire();
  const relation: Wire['rows'][number]['f'][number] = { r: ['d0', 'e0'], src: 'v1', t: null, a: null, value: null, c: 'observed' };
  value.rows[0].f = [relation]; assert.equal(schema.safeParse(value).success, true);
  for (const r of [[], ['d0', 'e0']]) {
    value.rows[0].f = [{ ...relation, r, a: 'location', value: 'desk' }];
    assert.equal(schema.safeParse(value).success, false);
  }
  value.rows[0].f = [{ ...relation, r: ['d0'], a: 'location', value: 'desk' }];
  assert.equal(schema.safeParse(value).success, true);
  value.rows[0].f[0].value = null; assert.equal(schema.safeParse(value).success, false);
  value.rows[0].f[0].a = null; value.rows[0].f[0].value = 'desk';
  assert.equal(schema.safeParse(value).success, false);
});

test('generation rejects the V2 door, bench and exit-sign citations when current anchors are empty', () => {
  for (const label of ['dark double doors', 'light wood benches', 'illuminated exit-direction sign']) {
    const p = packet(), old = entity(), value = generationWire(); old.identityAnchors = [anchor()];
    p.vision.visualDraft!.entities[0].label = label; p.vision.visualDraft!.objects[0].anchors = [];
    const schema = bindingModelSchema([p], context([old]));
    value.rows[0].b[0] = { r: 0, to: 'e0', match: relativeMatching() };
    assert.equal(schema.safeParse(value).success, false, label);
    assert.equal(BindingModelBatchSchema.safeParse(value).success, true);
    rejects(value, [p], context([old]), 'unknown_current_anchor');
    value.rows[0].b[0].match!.anchors = [];
    assert.equal(schema.safeParse(value).success, true);
    const evidence = decodeBindingBatch(value, [p], context([old])).updates[0].delta.objectEvidence![0];
    assert.equal(evaluateObjectIdentity({ packet: p, candidateId: old.id, evidence, anchors: old.identityAnchors }).status, 'candidate');
  }
});

test('generation uses the actual current anchor range while retaining strict prior ownership checks', () => {
  const p = packet(), old = entity(), value = generationWire(); old.identityAnchors = [anchor()];
  p.vision.visualDraft!.entities.push({ ...p.vision.visualDraft!.entities[0], label: 'Second key set' });
  p.vision.visualDraft!.objects.push({ entityIndex: 1, sourceIndex: 1, anchors: [
    { kind: 'generic', sourceIndex: 1, quote: 'Brass keys' },
    { kind: 'attached_item', sourceIndex: 1, quote: 'distinctive red tag' },
  ] });
  const ctx = context([old]), schema = bindingModelSchema([p], ctx);
  value.rows[0].b = [{ r: 1, to: 'e0', match: relativeMatching(0, 1) }];
  assert.equal(schema.safeParse(value).success, true);
  value.rows[0].b[0].r = 0; assert.equal(schema.safeParse(value).success, false);
  value.rows[0].b[0].r = 1; value.rows[0].b[0].match!.anchors[0].current = 2;
  assert.equal(schema.safeParse(value).success, false);
  value.rows[0].b[0].match!.anchors[0] = { prior: 'a99', current: 1 };
  assert.equal(schema.safeParse(value).success, false);
  rejects(value, [p], ctx, 'unknown_prior_anchor');
});

test('target-relative anchors prevent the V3 double-door match from borrowing another door anchor', () => {
  const p = packet(), targetDoor = entity('double-doors'), otherDoor = entity('plain-door'), value = generationWire();
  targetDoor.label = 'Black double doors'; otherDoor.label = 'Plain gray door';
  otherDoor.identityAnchors = [anchor(otherDoor.id)];
  const ctx = context([targetDoor, otherDoor]);
  value.rows[0].b = [{ r: 0, to: 'e0', match: matching() }];
  rejects(value, [p], ctx, 'anchor_owner_mismatch'); // Original legacy mistake remains invalid.
  const schema = bindingModelSchema([p], ctx);
  assert.equal(schema.safeParse(value).success, false);
  value.rows[0].b[0].match = relativeMatching();
  assert.equal(schema.safeParse(value).success, false);
  rejects(value, [p], ctx, 'unknown_prior_anchor');
  value.rows[0].b[0].match!.anchors = [];
  const evidence = decodeBindingBatch(value, [p], ctx).updates[0].delta.objectEvidence![0];
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: targetDoor.id, evidence, anchors: otherDoor.identityAnchors }).status, 'candidate');
  value.rows[0].b[0] = { r: 0, to: 'e1', match: relativeMatching() };
  assert.equal(schema.safeParse(value).success, true);
  assert.deepEqual(decodeBindingBatch(value, [p], ctx).updates[0].delta.objectEvidence![0].match!.anchors[0].anchor,
    { id: otherDoor.identityAnchors[0].id });
});

test('the V3 future-row exit-sign citation remains rejected and is absent from target-relative generation', () => {
  const packets = [packet(), packet(1)], old = entity(), value = generationWire(2), ctx = context([old]);
  value.rows[0].b = [{ r: 0, to: 'e0', match: { ...matching(), anchors: [{ prior: { i: 1, r: 'd0', n: 0 }, current: 0 }] } }];
  rejects(value, packets, ctx, 'non_earlier_anchor');
  const schema = bindingModelSchema(packets, ctx);
  assert.equal(schema.safeParse(value).success, false);
  value.rows[0].b[0].match = relativeMatching();
  assert.equal(schema.safeParse(value).success, false);
  rejects(value, packets, ctx, 'unknown_prior_anchor');
  const input = JSON.parse(bindingUpdatePrompt(packets, ctx).split('Evidence JSON:\n')[1]);
  assert.deepEqual(input.packets[0].priorAnchors, { e0: [] });
  assert.ok(input.packets[1].priorAnchors.p0d0);
  assert.ok(!input.packets[0].priorAnchors.p1d0); assert.ok(!input.priorAnchors);
});

test('relative existing lists exclude inactive, same-photo, equal-time and future anchors while preserving exact stored IDs', () => {
  const p = packet(), old = entity(), value = generationWire();
  old.identityAnchors = [
    { ...anchor(), id: 'inactive', active: false },
    { ...anchor(), id: 'same-photo', packetId: p.id },
    { ...anchor(), id: 'equal-time', observedAt: p.capturedAt },
    { ...anchor(), id: 'future', observedAt: p.capturedAt + 1 },
    { ...anchor(), id: 'eligible-first', quote: 'first valid quote', index: 4 },
    { ...anchor(), id: 'eligible-second', quote: 'second valid quote', index: 5 },
  ];
  const ctx = context([old]), before = JSON.stringify(ctx), schema = bindingModelSchema([p], ctx);
  const input = JSON.parse(bindingUpdatePrompt([p], ctx).split('Evidence JSON:\n')[1]);
  assert.deepEqual(input.packets[0].priorAnchors.e0, [
    { kind: 'attached_item', quote: 'first valid quote', observedAt: 1 },
    { kind: 'attached_item', quote: 'second valid quote', observedAt: 1 },
  ]);
  for (const index of [0, 1]) {
    value.rows[0].b = [{ r: 0, to: 'e0', match: relativeMatching(index) }];
    assert.equal(schema.safeParse(value).success, true);
    assert.deepEqual(decodeBindingBatch(value, [p], ctx).updates[0].delta.objectEvidence![0].match!.anchors[0].anchor,
      { id: index === 0 ? 'eligible-first' : 'eligible-second' });
  }
  value.rows[0].b[0].match = relativeMatching(2);
  assert.equal(schema.safeParse(value).success, false); rejects(value, [p], ctx, 'unknown_prior_anchor');
  assert.equal(JSON.stringify(ctx), before);
  old.identityAnchors[0].entityId = 'another-owner';
  assert.throws(() => bindingModelSchema([p], ctx), (error: unknown) => error instanceof BindingError && error.code === 'anchor_owner_mismatch');
});

test('relative prior draft anchors preserve their original packet/ref/index and support real Store binding', () => {
  const packets = [packet(), packet(1)], value = generationWire(2);
  packets[0].vision.visualDraft!.objects[0].anchors.unshift({ kind: 'generic', sourceIndex: 1, quote: 'Brass keys' });
  value.rows[1].b = [{ r: 0, to: 'p0d0', match: relativeMatching(1) }];
  assert.equal(bindingModelSchema(packets, context()).safeParse(value).success, true);
  const batch = decodeBindingBatch(value, packets, context());
  assert.deepEqual(batch.updates[1].delta.objectEvidence![0].match!.anchors[0].anchor,
    { packetId: packets[0].id, ref: 'd0', index: 1 });
  const store = new Store(':memory:', 3, 'test-embedding');
  try {
    store.createSession(packets[0].sessionId, 0);
    for (const p of packets) {
      store.insertCapture({ id: p.id, sessionId: p.sessionId, sequence: p.sequence, capturedAt: p.capturedAt,
        width: p.faces.width, height: p.faces.height, faces: p.faces, audioStatus: p.audio.status,
        imagePath: p.imagePath, sha256: p.sha256, receivedAt: p.createdAt, status: 'ready', error: null, vision: p.vision });
      store.savePacket(p);
    }
    store.commitBatch(packets, batch);
    const sightings = store.objectSightings();
    const first = sightings.find(sighting => sighting.packetId === packets[0].id)!;
    const second = sightings.find(sighting => sighting.packetId === packets[1].id)!;
    assert.equal(second.status, 'supported'); assert.equal(second.entityId, first.entityId);
  } finally { store.close(); }
});

test('relative anchors on prior supplemental targets are unavailable and empty matches remain candidates', () => {
  const packets = [packet(), packet(1)], value = generationWire(2);
  value.rows[0].n = [{ r: 's9', k: 'object', l: 'Spoken keys', d: 'Keys mentioned without visual evidence.' }];
  value.rows[1].b = [{ r: 0, to: 'p0s9', match: relativeMatching() }];
  const schema = bindingModelSchema(packets, context());
  assert.equal(schema.safeParse(value).success, false);
  rejects(value, packets, context(), 'unknown_prior_anchor');
  value.rows[1].b[0].match!.anchors = [];
  assert.equal(schema.safeParse(value).success, true);
  const evidence = decodeBindingBatch(value, packets, context()).updates[1].delta.objectEvidence![0];
  assert.equal(evaluateObjectIdentity({ packet: packets[1], candidateId: 'spoken-keys', evidence, anchors: [] }).status, 'candidate');
  for (const to of ['p1s9', 'p2s9', 'p1d0', 'p2d0']) {
    value.rows[1].b[0].to = to; assert.equal(schema.safeParse(value).success, false, to);
    rejects(value, packets, context(), 'non_earlier_reference');
  }
});

test('relative integer bounds, legacy typed references and oversized external legacy contexts remain explicit', () => {
  const p = packet(), old = entity(), value = generationWire();
  old.identityAnchors = Array.from({ length: 12 }, (_, i) => ({ ...anchor(), id: `anchor-${i}` }));
  const ctx = context([old]), schema = bindingModelSchema([p], ctx);
  value.rows[0].b = [{ r: 0, to: 'e0', match: relativeMatching(11) }];
  assert.equal(schema.safeParse(value).success, true);
  assert.deepEqual(decodeBindingBatch(value, [p], ctx).updates[0].delta.objectEvidence![0].match!.anchors[0].anchor, { id: 'anchor-11' });
  for (const prior of [-1, .5, 12]) {
    value.rows[0].b[0].match = relativeMatching(prior);
    assert.equal(schema.safeParse(value).success, false); rejects(value, [p], ctx, 'schema_validation');
  }
  value.rows[0].b[0].match = matching();
  assert.equal(schema.safeParse(value).success, false); // New generation uses only relative integers.
  assert.deepEqual(decodeBindingBatch(value, [p], ctx).updates[0].delta.objectEvidence![0].match!.anchors[0].anchor, { id: 'anchor-0' });
  old.identityAnchors.push({ ...anchor(), id: 'anchor-12' });
  assert.throws(() => bindingModelSchema([p], ctx), (error: unknown) => error instanceof BindingError && error.code === 'prior_anchor_limit');
  assert.doesNotThrow(() => decodeBindingBatch(value, [p], ctx)); // Existing legacy behavior is not capped retroactively.
  value.rows[0].b[0].match = relativeMatching(); rejects(value, [p], ctx, 'prior_anchor_limit');
});

test('relative citations never upgrade generic or configuration-only object matches', () => {
  for (const kind of ['generic', 'distinctive_configuration'] as const) {
    const p = packet(), old = entity(), value = generationWire();
    old.identityAnchors = [{ ...anchor(), kind }]; p.vision.visualDraft!.objects[0].anchors[0].kind = kind;
    value.rows[0].b = [{ r: 0, to: 'e0', match: relativeMatching() }];
    assert.equal(bindingModelSchema([p], context([old])).safeParse(value).success, true);
    const evidence = decodeBindingBatch(value, [p], context([old])).updates[0].delta.objectEvidence![0];
    assert.equal(evaluateObjectIdentity({ packet: p, candidateId: old.id, evidence, anchors: old.identityAnchors }).status, 'candidate');
  }
});

test('maximum relative-anchor generation groups stay below 5000 JSON object properties', () => {
  const packets = Array.from({ length: 4 }, (_, index) => {
    const p = packet(index);
    p.vision.visualDraft = { entities: Array.from({ length: 30 }, (_, i) => ({ kind: 'object', label: `Object ${i}`, descriptionSourceIndex: 1, faceIndex: null })),
      facts: [], objects: Array.from({ length: 30 }, (_, i) => ({ entityIndex: i, sourceIndex: 1,
        anchors: Array.from({ length: i % 7 }, () => ({ kind: 'attached_item', sourceIndex: 1, quote: 'distinctive red tag' })) })) };
    return p;
  });
  const ctx = context(Array.from({ length: 13 }, (_, count) => {
    const old = entity(`old-${count}`);
    old.identityAnchors = Array.from({ length: count }, (_, i) => ({ ...anchor(old.id), id: `old-${count}-anchor-${i}` }));
    return old;
  }));
  const json = z.toJSONSchema(bindingModelSchema(packets, ctx)) as any;
  function objectProperties(value: unknown): number {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + objectProperties(item), 0);
    if (!value || typeof value !== 'object') return 0;
    const record = value as Record<string, unknown>;
    const count = record.properties && typeof record.properties === 'object' ? Object.keys(record.properties).length : 0;
    return count + Object.values(record).reduce<number>((sum, item) => sum + objectProperties(item), 0);
  }
  const count = objectProperties(json);
  assert.ok(count > 1000); assert.ok(count < 5000, `Generated ${count} object properties`);
  for (const row of json.properties.rows.items.anyOf) assert.ok(row.properties.b.items.anyOf.length <= 92);
});

test('generation filters existing and prior draft targets by kind, including the V2 phone-to-person error', () => {
  const packets = [packet(), packet(1)], value = generationWire(2);
  packets[0].vision.visualDraft!.entities.push(
    { kind: 'person', label: 'Person in dark clothing', descriptionSourceIndex: 0, faceIndex: null },
    { kind: 'place', label: 'Corridor', descriptionSourceIndex: 0, faceIndex: null },
  );
  packets[1].vision.visualDraft!.entities[0].label = 'Handheld phone';
  packets[1].vision.visualDraft!.entities.push({ kind: 'place', label: 'Corridor', descriptionSourceIndex: 0, faceIndex: null });
  const ctx = context([entity(), entity('corridor', 'place'), entity('bob', 'person')]);
  const schema = bindingModelSchema(packets, ctx);
  value.rows[1].b = [{ r: 0, to: 'p0d1', match: null }];
  assert.equal(schema.safeParse(value).success, false);
  rejects(value, packets, ctx, 'entity_kind_mismatch');
  for (const to of ['e1', 'e2', 'e99', 'p0d2', 'p0d99', 'p1d0', 'p2d0']) {
    value.rows[1].b[0].to = to; assert.equal(schema.safeParse(value).success, false, to);
  }
  for (const to of ['e0', 'p0d0']) {
    value.rows[1].b[0].to = to; assert.equal(schema.safeParse(value).success, true, to);
  }
  value.rows[1].b = [{ r: 1, to: 'p0d2', match: null }];
  assert.equal(schema.safeParse(value).success, true);
  value.rows[1].b[0].to = 'e1'; assert.equal(schema.safeParse(value).success, true);
  value.rows[1].b[0].to = 'e0'; assert.equal(schema.safeParse(value).success, false);
});

test('generation preserves earlier supplemental aliases with decoder kind and existence checks', () => {
  const packets = [packet(), packet(1)], value = generationWire(2), ctx = context();
  const schema = bindingModelSchema(packets, ctx);
  value.rows[0].n = [{ r: 's0', k: 'place', l: 'Spoken room', d: 'A room mentioned in conversation.' }];
  value.rows[1].b = [{ r: 0, to: 'p0s0', match: null }];
  assert.equal(schema.safeParse(value).success, true);
  rejects(value, packets, ctx, 'entity_kind_mismatch');
  value.rows[0].n[0].k = 'object';
  assert.equal(decodeBindingBatch(value, packets, ctx).updates[1].reuse[0].fromRef, 's0');
  value.rows[1].b[0].to = 'p0s9'; assert.equal(schema.safeParse(value).success, true);
  rejects(value, packets, ctx, 'unknown_reference');
  for (const to of ['p1s0', 'p2s0']) {
    value.rows[1].b[0].to = to; assert.equal(schema.safeParse(value).success, false);
  }
  value.rows[0].b[0].to = 'p0s0'; value.rows[1].b = [];
  assert.equal(schema.safeParse(value).success, false);
  value.rows[0].b[0].to = null; value.rows[1].b = [{ r: 0, to: 'p0s0', match: null }];
  packets[1].capturedAt = packets[0].capturedAt; packets[1].faces.capturedAt = packets[0].capturedAt;
  assert.equal(bindingModelSchema(packets, ctx).safeParse(value).success, false);
});

test('the V2 split of a prior combined object remains an explicit duplicate-target rejection', () => {
  const packets = [packet(), packet(1)], value = generationWire(2);
  packets[0].vision.visualDraft!.entities[0].label = 'Tables and chairs';
  packets[1].vision.visualDraft!.entities[0].label = 'Chairs';
  packets[1].vision.visualDraft!.entities.push({ ...packets[1].vision.visualDraft!.entities[0], label: 'Tables' });
  packets[1].vision.visualDraft!.objects.push({ entityIndex: 1, sourceIndex: 1, anchors: [] });
  value.rows[1].b = [0, 1].map(r => ({ r, to: 'p0d0', match: null }));
  assert.equal(bindingModelSchema(packets, context()).safeParse(value).success, true);
  rejects(value, packets, context(), 'duplicate_visual_identity');
});

test('generated JSON groups equal-anchor slots rather than making a branch per entity', () => {
  const packets = Array.from({ length: 4 }, (_, index) => {
    const p = packet(index), kinds = ['object', 'person', 'place'] as const;
    p.vision.visualDraft = {
      entities: Array.from({ length: 30 }, (_, i) => ({ kind: kinds[i % 3], label: `Visible ${i}`, descriptionSourceIndex: 1, faceIndex: null })),
      facts: [], objects: Array.from({ length: 10 }, (_, i) => ({ entityIndex: i * 3, sourceIndex: 1, anchors: [] })),
    }; return p;
  });
  const json = z.toJSONSchema(bindingModelSchema(packets, context([entity(), entity('room', 'place')]))) as any;
  assert.equal(json.properties.rows.minItems, 4); assert.equal(json.properties.rows.maxItems, 4);
  const variants = json.properties.rows.items.anyOf;
  assert.equal(variants.length, 4);
  for (const [i, row] of variants.entries()) {
    assert.equal(row.properties.i.const, i); assert.equal(row.additionalProperties, false);
    assert.equal(row.properties.b.items.anyOf.length, 3);
    const [place, newObject, existingObject] = row.properties.b.items.anyOf;
    assert.deepEqual(place.properties.r.enum, Array.from({ length: 10 }, (_, n) => n * 3 + 2));
    assert.deepEqual(newObject.properties.r.enum, Array.from({ length: 10 }, (_, n) => n * 3));
    assert.deepEqual(existingObject.properties.r.enum, newObject.properties.r.enum);
    assert.equal(place.properties.match.type, 'null'); assert.equal(newObject.properties.match.type, 'null');
    assert.equal(newObject.properties.to.type, 'null');
    const [fullMatch, possibleMatch] = existingObject.properties.match.anyOf[0].anyOf;
    assert.equal(fullMatch.properties.anchors.maxItems, 0);
    assert.equal(possibleMatch.const, 'possible');
    const [relation, attribute] = row.properties.f.items.anyOf;
    assert.equal(relation.properties.a.type, 'null'); assert.equal(relation.properties.value.type, 'null');
    assert.equal(attribute.properties.r.minItems, 1); assert.equal(attribute.properties.r.maxItems, 1);
  }
  assert.match(bindingUpdatePrompt(packets, context()), /ambiguous\s+place omit its binding/);
});

test('binding generation requires source-copy state while the decoder keeps legacy state compatible', () => {
  const p = packet(), value = generationWire(), schema = bindingModelSchema([p], context());
  assert.equal(schema.safeParse(value).success, true);
  assert.equal(schema.safeParse(wire()).success, false);
  assert.equal(BindingModelBatchSchema.safeParse(wire()).success, true);
  const json = z.toJSONSchema(schema) as any;
  const generatedState = json.properties.rows.items.anyOf[0].properties.s;
  assert.ok(generatedState.required.includes('extraUncertainties'));
  assert.ok(!generatedState.properties.uncertainties);
  assert.equal(generatedState.properties.extraUncertainties.maxItems, 10);
  assert.equal(generatedState.properties.extraUncertainties.items.maxLength, 500);
  assert.equal(generatedState.additionalProperties, false);
  const prompt = bindingUpdatePrompt([p], context());
  assert.match(prompt, /summary:null to copy this packet's exact scene/);
  assert.match(prompt, /do not repeat or paraphrase supplied uncertainties/);
});

test('source-copy state uses each current packet including corrections and never carries prior state', () => {
  const packets = [packet(), packet(1)], value = generationWire(2), ctx = context();
  packets[0].vision.scene = 'The original room at the original source time.';
  packets[0].vision.uncertainties = ['Original image is partly obscured.'];
  packets[0].version = 2; packets[0].correction = true;
  packets[1].vision.scene = 'A different later room.';
  packets[1].vision.uncertainties = ['Later image has glare.'];
  ctx.state = { ...ctx.state, location: 'Unrelated newer room', activity: 'An old activity',
    summary: 'A newer person is present.', uncertainties: ['Old uncertainty.'] };
  const before = JSON.stringify({ packets, value, ctx });
  const rows = decodeBindingBatch(value, packets, ctx).updates;
  for (const [i, row] of rows.entries()) {
    assert.equal(row.delta.state.summary, packets[i].vision.scene);
    assert.deepEqual(row.delta.state.uncertainties, packets[i].vision.uncertainties);
    assert.equal(row.delta.state.location, null); assert.equal(row.delta.state.activity, null);
    assert.equal(row.packetVersion, packets[i].version); assert.equal(row.packetId, packets[i].id);
  }
  assert.equal(JSON.stringify({ packets, value, ctx }), before);
  packets[0].vision.scene = '';
  assert.equal(decodeBindingBatch(value, packets, ctx).updates[0].delta.state.summary, '');
});

test('written source-copy summaries retain exact visual and additional uncertainties with stable exact deduplication', () => {
  const p = packet(), value = generationWire();
  p.vision.uncertainties = ['First visual caveat.', 'Repeated caveat.', 'Spaced caveat. '];
  value.rows[0].s = { location: 'Lecture room', activity: null, summary: 'The class ended according to finalized conversation.',
    extraUncertainties: ['Repeated caveat.', 'Additional speaker uncertainty.', 'Additional speaker uncertainty.', 'Spaced caveat.'] };
  const actual = decodeBindingBatch(value, [p], context()).updates[0].delta.state;
  assert.equal(actual.summary, value.rows[0].s.summary);
  assert.deepEqual(actual.uncertainties, ['First visual caveat.', 'Repeated caveat.', 'Spaced caveat. ',
    'Additional speaker uncertainty.', 'Spaced caveat.']);
  assert.equal(actual.location, 'Lecture room'); assert.equal(actual.activity, null);
});

test('state expansion preserves ten full visual caveats plus ten full writer caveats without widening provider bounds', () => {
  const p = packet(), value = generationWire();
  p.vision.uncertainties = Array.from({ length: 10 }, (_, i) => `Visual ${i} `.padEnd(1000, 'v'));
  const extraUncertainties = Array.from({ length: 10 }, (_, i) => `Writer ${i} `.padEnd(500, 'w'));
  value.rows[0].s = { location: null, activity: null, summary: null, extraUncertainties };
  assert.equal(bindingModelSchema([p], context()).safeParse(value).success, true);
  const actual = decodeBindingBatch(value, [p], context()).updates[0].delta.state;
  assert.deepEqual(actual.uncertainties, [...p.vision.uncertainties, ...extraUncertainties]);
  assert.equal(actual.uncertainties.length, 20);
  assert.equal(MemoryDeltaSchema.shape.state.safeParse(actual).success, true);
  assert.equal(MemoryModelStateSchema.safeParse(actual).success, false);
  assert.equal(MemoryModelStateSchema.safeParse({ ...state, uncertainties: ['v'.repeat(501)] }).success, false);
  assert.equal(MemoryModelStateSchema.safeParse({ ...state, uncertainties: Array(11).fill('Short.') }).success, false);
});

test('state-copy decoder rejects mixed shapes and over-bound additions without truncation', () => {
  const p = packet(), value = generationWire();
  const bothKeys = structuredClone(value) as unknown as { rows: { s: Record<string, unknown> }[] };
  bothKeys.rows[0].s.uncertainties = [];
  rejects(bothKeys, [p], context(), 'schema_validation');
  const nullLegacy = wire() as unknown as { rows: { s: Record<string, unknown> }[] };
  nullLegacy.rows[0].s.summary = null;
  rejects(nullLegacy, [p], context(), 'schema_validation');
  for (const extraUncertainties of [Array(11).fill('Caveat.'), ['x'.repeat(501)]]) {
    value.rows[0].s = { location: null, activity: null, summary: null, extraUncertainties };
    rejects(value, [p], context(), 'schema_validation');
  }
  value.rows[0].s = { location: null, activity: null, summary: null, extraUncertainties: [] };
  p.vision.uncertainties = ['x'.repeat(1001)];
  rejects(value, [p], context(), 'expanded_schema');
});

test('legacy explicit state remains exact even when current visual uncertainty differs', () => {
  const p = packet(), value = wire();
  p.vision.uncertainties = ['New visual uncertainty that was not part of the recorded legacy state.'];
  value.rows[0].s = { location: null, activity: null, summary: 'Original recorded summary.', uncertainties: ['Original writer caveat.'] };
  assert.deepEqual(decodeBindingBatch(value, [p], context()).updates[0].delta.state, value.rows[0].s);
  value.rows[0].s = { ...state, uncertainties: Array(11).fill('Legacy caveat.') };
  rejects(value, [p], context(), 'schema_validation');
  value.rows[0].s = { ...state, uncertainties: ['x'.repeat(501)] };
  rejects(value, [p], context(), 'schema_validation');
});

test('source-copy state retains final speech and event meaning through explicit summary and supplemental evidence', () => {
  const p = packet(), value = generationWire(), final = speech('The calculus class has started.');
  p.audio.segments = [speech('SECRET PARTIAL', false), final];
  p.vision.uncertainties = ['Room name cannot be read.'];
  value.rows[0].s = { location: null, activity: 'calculus class', summary: 'Finalized conversation says the calculus class has started.',
    extraUncertainties: ['The speaker is not verified.'] };
  value.rows[0].n = [{ r: 's0', k: 'event', l: 'Calculus class', d: 'The class described in finalized speech.' }];
  value.rows[0].f = [{ r: ['s0'], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  value.rows[0].e = [{ r: 's0', status: 'ongoing', summary: 'The class has started.' }];
  const row = decodeBindingBatch(value, [p], context()).updates[0];
  assert.equal(row.delta.state.summary, value.rows[0].s.summary);
  assert.deepEqual(row.delta.state.uncertainties, ['Room name cannot be read.', 'The speaker is not verified.']);
  assert.deepEqual(row.delta.facts.at(-1)!.transcriptKeys, [transcriptKey(final)]);
  assert.equal(row.delta.events[0].status, 'ongoing');
  assert.ok(!bindingUpdatePrompt([p], context()).includes('SECRET PARTIAL'));
});

test('complete expanded state and history survive Store close and reopen unchanged', () => {
  const p = packet(), value = generationWire();
  p.vision.uncertainties = Array.from({ length: 10 }, (_, i) => `Visual ${i} `.padEnd(1000, 'v'));
  value.rows[0].s = { location: null, activity: null, summary: null,
    extraUncertainties: Array.from({ length: 10 }, (_, i) => `Writer ${i} `.padEnd(500, 'w')) };
  const batch = decodeBindingBatch(value, [p], context());
  const dir = mkdtempSync(join(tmpdir(), 'binding-state-copy-')), path = join(dir, 'memory.sqlite');
  let store = new Store(path, 3, 'test-embedding');
  try {
    store.createSession(p.sessionId, 0);
    store.insertCapture({ id: p.id, sessionId: p.sessionId, sequence: p.sequence, capturedAt: p.capturedAt,
      width: p.faces.width, height: p.faces.height, faces: p.faces, audioStatus: p.audio.status,
      imagePath: p.imagePath, sha256: p.sha256, receivedAt: p.createdAt, status: 'ready', error: null, vision: p.vision });
    store.savePacket(p); store.commitBatch([p], batch);
    const saved = store.currentState(), history = store.history();
    assert.equal(saved.summary, p.vision.scene); assert.equal(saved.observedAt, p.capturedAt);
    assert.deepEqual(saved.uncertainties, batch.updates[0].delta.state.uncertainties);
    assert.equal(saved.uncertainties.length, 20);
    store.close(); store = new Store(path, 3, 'test-embedding');
    assert.deepEqual(store.currentState(), saved); assert.deepEqual(store.history(), history);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('binding expands every draft fact and anchor without mutating inputs', () => {
  const p = packet(), value = wire(), before = JSON.stringify({ p, value });
  const result = decodeBindingBatch(value, [p], context()).updates[0];
  assert.deepEqual(result.delta.entities, [{ ref: 'd0', existingId: null, kind: 'object', label: 'Brass keys',
    description: p.vision.observations[0], personId: null }]);
  assert.equal(result.delta.facts.length, p.vision.visualDraft!.facts.length);
  assert.equal(result.delta.facts[0].text, p.vision.observations[0]);
  assert.equal(result.delta.facts[0].value, 'on the desk');
  assert.deepEqual(result.delta.objectEvidence![0].anchors, p.vision.visualDraft!.objects[0].anchors);
  assert.equal(result.delta.objectEvidence![0].quote, p.vision.observations[0]);
  assert.deepEqual(result.reuse, []); assert.equal(JSON.stringify({ p, value }), before);
});

test('known binding retains metadata and interns supplemental context aliases', () => {
  const p = packet(), old = entity(), value = wire(); old.identityAnchors = [anchor()];
  value.rows[0].b[0] = { r: 0, to: 'e0', match: matching() };
  value.rows[0].f = [{ r: ['e0'], src: 'v1', t: null, a: null, value: null, c: 'observed' }];
  const row = decodeBindingBatch(value, [p], context([old])).updates[0];
  assert.equal(row.delta.entities.length, 1); assert.equal(row.delta.entities[0].label, old.label);
  assert.equal(row.delta.entities[0].description, old.description); assert.deepEqual(row.delta.facts[1].entityRefs, ['d0']);
  assert.deepEqual(row.delta.objectEvidence![0].match!.anchors[0], { anchor: { id: anchor().id }, sourceIndex: 1, quote: 'distinctive red tag' });
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: old.id, evidence: row.delta.objectEvidence![0], anchors: old.identityAnchors }).status, 'supported');
});

test('backward visual reuse preserves canonical declarations, facts and anchor indices', () => {
  const packets = [packet(), packet(1)], value = wire(2);
  packets[0].vision.visualDraft!.objects[0].anchors.unshift({ kind: 'generic', sourceIndex: 1, quote: 'Brass keys' });
  value.rows[1].b[0] = { r: 0, to: 'p0d0', match: { ...matching(), anchors: [{ prior: { i: 0, r: 'd0', n: 1 }, current: 0 }] } };
  const rows = decodeBindingBatch(value, packets, context()).updates;
  assert.deepEqual(rows[1].reuse, [{ ref: 'd0', fromPacketId: packets[0].id, fromRef: 'd0' }]);
  assert.deepEqual(rows[1].delta.objectEvidence![0].match!.anchors[0].anchor, { packetId: packets[0].id, ref: 'd0', index: 1 });
  assert.equal(rows[0].delta.objectEvidence![0].anchors[0].kind, 'generic'); assert.equal(rows[1].delta.facts.length, 1);
});

test('supplemental events and final speech retain explicit causal reuse and source keys', () => {
  const packets = [packet(), packet(1)], value = wire(2), lecture = speech('The calculus class is starting.'), ending = speech('The calculus class has ended.');
  ending.segmentId = 'ending'; ending.startAt = 7000; ending.endAt = 9000;
  packets[0].audio.segments = [lecture]; packets[1].audio.segments = [ending];
  value.rows[0].n = [{ r: 's0', k: 'event', l: 'Calculus class', d: 'Class occurrence.' }];
  value.rows[0].f = [{ r: ['s0'], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  value.rows[0].e = [{ r: 's0', status: 'ongoing', summary: 'Class starting.' }];
  value.rows[1].f = [{ r: ['p0s0'], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  value.rows[1].e = [{ r: 'p0s0', status: 'ended', summary: 'Class ended.' }];
  const rows = decodeBindingBatch(value, packets, context()).updates;
  assert.deepEqual(rows[1].reuse, [{ ref: 'p0s0', fromPacketId: packets[0].id, fromRef: 's0' }]);
  assert.deepEqual(rows[1].delta.facts[1].transcriptKeys, [transcriptKey(ending)]);
  assert.equal(rows[1].delta.facts[1].text, ending.text); assert.equal(rows[1].delta.events[0].status, 'ended');
  assert.equal(rows[1].delta.state.activity, null);
});

test('known and provisional face slots force the exact context alias', () => {
  for (const confirmed of [true, false]) {
    const p = packet(); p.vision.visualDraft = { entities: [{ kind: 'person', label: 'Visible person', descriptionSourceIndex: 0, faceIndex: 0 }],
      facts: [{ entityIndexes: [0], sourceIndex: 0, text: null, attribute: null, value: null, confidence: 'observed' }], objects: [] };
    p.faces.faces = [{ trackId: 'track', personId: confirmed ? 'bob' : null, name: confirmed ? 'Bob' : null,
      identityStatus: confirmed ? 'confirmed' : 'unknown', similarity: .8, box: [1, 1, 100, 100] }];
    const actual = entity(faceEntityId(p, p.faces.faces[0]), 'person'); actual.personId = confirmed ? 'bob' : null;
    const ctx = context([actual, entity('alice', 'person')]), value = wire(); value.rows[0].b[0].to = 'e0';
    const row = decodeBindingBatch(value, [p], ctx).updates[0]; assert.equal(row.delta.entities[0].existingId, actual.id);
    const automatic = wire(); automatic.rows[0].b = [];
    assert.equal(decodeBindingBatch(automatic, [p], ctx).updates[0].delta.entities[0].existingId, actual.id);
    rejects(automatic, [p], context(), 'missing_face_context');
    value.rows[0].b[0].to = 'e1'; rejects(value, [p], ctx, 'face_binding_mismatch');
    value.rows[0].b[0].to = null; rejects(value, [p], ctx, 'face_binding_mismatch');
  }
});

test('mandatory draft, exact row order and valid sparse binding indexes are enforced', () => {
  const p = packet(), value = wire(); delete p.vision.visualDraft; rejects(value, [p], context(), 'missing_visual_draft');
  const missing = wire(); missing.rows[0].b = []; assert.equal(decodeBindingBatch(missing, [packet()], context()).updates[0].delta.entities[0].existingId, null);
  const unknown = wire(); unknown.rows[0].b[0].r = 1; rejects(unknown, [packet()], context(), 'duplicate_or_unknown_binding');
  const two = wire(2); two.rows.reverse(); rejects(two, [packet(), packet(1)], context(), 'row_order');
  rejects(wire(), [packet(), packet(1)], context(), 'row_count');
  const wrongFrame = packet(); wrongFrame.faces.frameId = 'other'; rejects(wire(), [wrongFrame], context(), 'face_packet_mismatch');
});

test('forward, missing, equal-time and kind-conflicting targets are rejected', () => {
  for (const [to, code] of [['p0d0', 'non_earlier_reference'], ['p1d0', 'non_earlier_reference'], ['e9', 'unknown_reference']] as const) {
    const value = wire(); value.rows[0].b[0].to = to; rejects(value, [packet()], context(), code);
  }
  const value = wire(2); value.rows[1].b[0].to = 'p0d9'; rejects(value, [packet(), packet(1)], context(), 'unknown_reference');
  value.rows[1].b[0].to = 'p0d0'; const equal = packet(1); equal.capturedAt = packet().capturedAt; equal.faces.capturedAt = equal.capturedAt;
  rejects(value, [packet(), equal], context(), 'non_earlier_reference');
  const kind = wire(); kind.rows[0].b[0].to = 'e0'; rejects(kind, [packet()], context([entity('bob', 'person')]), 'entity_kind_mismatch');
});

test('duplicate visual identity and duplicate supplemental aliases are rejected', () => {
  const p = packet(), value = wire(); p.vision.visualDraft!.entities.push({ ...p.vision.visualDraft!.entities[0] });
  p.vision.visualDraft!.objects.push({ ...p.vision.visualDraft!.objects[0], entityIndex: 1 });
  value.rows[0].b = [{ r: 0, to: 'e0', match: null }, { r: 1, to: 'e0', match: null }];
  rejects(value, [p], context([entity()]), 'duplicate_visual_identity');
  const duplicate = wire(); duplicate.rows[0].n = [0, 1].map(() => ({ r: 's0', k: 'event', l: 'Class', d: '' }));
  rejects(duplicate, [packet()], context(), 'duplicate_declaration');
});

test('anchor citations reject unknown, wrong-owner, inactive, future and nonexistent current anchors', () => {
  const run = (change: (value: Wire, entities: Entity[]) => void, code: string) => {
    const old = entity(), other = entity('other'), entities = [old, other]; old.identityAnchors = [anchor()];
    const value = wire(); value.rows[0].b[0] = { r: 0, to: 'e0', match: matching() }; change(value, entities);
    rejects(value, [packet()], context(entities), code);
  };
  run(value => { value.rows[0].b[0].match!.anchors[0].prior = 'a99'; }, 'unknown_prior_anchor');
  run((_value, entities) => { entities[0].identityAnchors = []; entities[1].identityAnchors = [anchor('other')]; }, 'anchor_owner_mismatch');
  run((_value, entities) => { entities[0].identityAnchors![0].active = false; }, 'inactive_anchor');
  run((_value, entities) => { entities[0].identityAnchors![0].observedAt = 5000; }, 'non_earlier_anchor');
  run(value => { value.rows[0].b[0].match!.anchors[0].current = 5; }, 'unknown_current_anchor');
  run(value => { value.rows[0].b[0].match!.competitors = ['e99']; }, 'unknown_competitor');
});

test('generic and explicitly ambiguous object evidence remains available to Store gates', () => {
  const p = packet(), old = entity(), value = wire(); old.identityAnchors = [anchor()];
  value.rows[0].b[0] = { r: 0, to: 'e0', match: { ...matching(), assessment: 'possible', conflicts: ['Marker partly obscured.'], competitors: [] } };
  const evidence = decodeBindingBatch(value, [p], context([old])).updates[0].delta.objectEvidence![0];
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: old.id, evidence, anchors: old.identityAnchors }).status, 'candidate');
  old.identityAnchors[0].kind = 'generic'; value.rows[0].b[0].match = matching();
  const generic = decodeBindingBatch(value, [p], context([old])).updates[0].delta.objectEvidence![0];
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: old.id, evidence: generic, anchors: old.identityAnchors }).status, 'candidate');
});

test('supplements enforce finality, OCR uncertainty, single-owner attributes and unique identities', () => {
  const p = packet(), value = wire(); p.audio.segments = [speech('Do not save partial text.', false), speech('Final useful statement.')];
  p.vision.readableText = ['Room 42'];
  value.rows[0].f = [{ r: [], src: 'o0', t: null, a: null, value: null, c: 'observed' },
    { r: ['d0'], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  const row = decodeBindingBatch(value, [p], context()).updates[0];
  assert.equal(row.delta.facts[1].confidence, 'uncertain'); assert.equal(row.delta.facts[2].text, 'Final useful statement.');
  value.rows[0].f[1].src = 't1'; rejects(value, [p], context(), 'unknown_source');
  value.rows[0].f[1].src = 't0'; value.rows[0].f[1].c = 'observed'; rejects(value, [p], context(), 'speech_as_observed');
  value.rows[0].f = [{ r: [], src: 'v1', t: null, a: 'location', value: 'desk', c: 'observed' }]; rejects(value, [p], context(), 'attribute_owner');
  value.rows[0].f[0].r = ['d0']; value.rows[0].f[0].value = null; rejects(value, [p], context(), 'attribute_pair');
  value.rows[0].f = [{ r: ['d0', 'e0'], src: 'v1', t: null, a: null, value: null, c: 'observed' }]; value.rows[0].b[0].to = 'e0';
  rejects(value, [p], context([entity()]), 'duplicate_fact_identity');
});

test('combined limits reject without discarding draft facts or truncating copied speech', () => {
  const p = packet(), value = wire(); value.rows[0].f = Array.from({ length: 40 }, () => ({ r: [], src: 'v0', t: null, a: null, value: null, c: 'observed' }));
  assert.equal(decodeBindingBatch(value, [p], context()).updates[0].delta.facts.length, 41);
  p.audio.segments = [speech('x'.repeat(2001))]; value.rows[0].f = [{ r: [], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  rejects(value, [p], context(), 'expanded_schema');
});

test('prompt exposes complete drafts and exact face targets but withholds partial speech and file paths', () => {
  const p = packet(); p.audio.segments = [speech('SECRET PARTIAL', false), speech('Final conversation.')]; p.audio.text = 'SECRET PARTIAL Final conversation.';
  const prompt = bindingUpdatePrompt([p], context());
  assert.ok(prompt.includes('distinctive red tag')); assert.ok(prompt.includes('Final conversation.'));
  assert.ok(!prompt.includes('SECRET PARTIAL')); assert.ok(!prompt.includes('/not-read.jpg')); assert.ok(!prompt.includes(p.sha256));
  const input = JSON.parse(prompt.split('Evidence JSON:\n')[1]); assert.deepEqual(input.packets[0].draft, bindingDraftContext(p.vision.visualDraft!));
  assert.deepEqual(input.packets[0].pendingSpeech, [{ startAt: 2000, endAt: 4000 }]);
});


test('a body without a matched face cannot inherit another visible person identity', () => {
  const p = packet(), bob = entity('bob', 'person');
  p.vision.scene = 'Two people are visible.';
  p.vision.observations = ['Bob is at the left wearing a red shirt.', 'A back-facing person in a blue jacket is at the right.'];
  p.faces.faces = [{ trackId: 'bob-track', personId: 'bob', name: 'Bob', identityStatus: 'confirmed', similarity: .9, box: [1, 1, 100, 100] }];
  p.vision.visualDraft = {
    entities: [
      { kind: 'person', label: 'Person at left', descriptionSourceIndex: 1, faceIndex: 0 },
      { kind: 'person', label: 'Back-facing person', descriptionSourceIndex: 2, faceIndex: null },
    ],
    facts: [
      { entityIndexes: [0], sourceIndex: 1, text: null, attribute: null, value: null, confidence: 'observed' },
      { entityIndexes: [1], sourceIndex: 2, text: null, attribute: 'clothing', value: 'blue jacket', confidence: 'observed' },
    ], objects: [],
  };
  const ctx = context([bob]), unsafe = wire();
  unsafe.rows[0].b = [{ r: 0, to: 'e0', match: null }, { r: 1, to: 'e0', match: null }];
  rejects(unsafe, [p], ctx, 'unbound_person_identity');
  const prior = packet(1); prior.vision = structuredClone(p.vision); prior.faces.faces = structuredClone(p.faces.faces);
  const backward = wire(2); backward.rows[0] = structuredClone(unsafe.rows[0]); backward.rows[0].b[1].to = null;
  backward.rows[1].b = [{ r: 0, to: 'e0', match: null }, { r: 1, to: 'p0d1', match: null }];
  rejects(backward, [p, prior], ctx, 'unbound_person_identity');

  const safe = structuredClone(unsafe); safe.rows[0].b[1].to = null;
  const batch = decodeBindingBatch(safe, [p], ctx), row = batch.updates[0];
  assert.equal(row.delta.entities.find(e => e.ref === 'd1')!.existingId, null);
  assert.equal(row.delta.entities.find(e => e.ref === 'd1')!.personId, null);
  const store = new Store(':memory:', 3, 'test-embedding');
  try {
    store.createSession(p.sessionId, 0);
    const capture: CaptureRecord = { id: p.id, sessionId: p.sessionId, sequence: p.sequence, capturedAt: p.capturedAt,
      width: p.faces.width, height: p.faces.height, faces: p.faces, audioStatus: p.audio.status,
      imagePath: p.imagePath, sha256: p.sha256, receivedAt: p.createdAt, status: 'ready', error: null, vision: p.vision };
    store.insertCapture(capture); store.savePacket(p); store.commitBatch([p], batch);
    const people = store.entities().filter(e => e.kind === 'person');
    const known = people.find(e => e.personId === 'bob')!, anonymous = people.find(e => e.personId === null)!;
    assert.equal(people.length, 2); assert.equal(known.label, bob.label); assert.equal(known.description, bob.description);
    assert.deepEqual(known.attributes, bob.attributes);
    assert.equal(known.attributes.clothing, undefined); assert.equal(anonymous.attributes.clothing.value, 'blue jacket');
    assert.ok(store.observations().some(note => note.entityIds.includes('bob') && note.text === 'Bob is visible in this frame.'));
    assert.ok(store.observations().some(note => note.entityIds.includes(anonymous.id) && note.text.includes('blue jacket')));
    assert.ok(!store.observations().some(note => note.entityIds.includes('bob') && note.text.includes('blue jacket')));
  } finally { store.close(); }
});


test('supplemental body facts require source association to the same matched face', () => {
  const p = packet(), bob = entity('bob', 'person'), klass = entity('class', 'event');
  p.vision.scene = 'Two people stand by the class board.';
  p.vision.observations = ['A back-facing person wears a blue jacket.', 'The person at left wears a red shirt.', 'The person at left stands by the class board.'];
  p.vision.readableText = ['Bob'];
  p.faces.faces = [{ trackId: 'bob-track', personId: 'bob', name: 'Bob', identityStatus: 'confirmed', similarity: .9, box: [1, 1, 100, 100] }];
  p.vision.visualDraft = {
    entities: [{ kind: 'person', label: 'Person at left', descriptionSourceIndex: 2, faceIndex: 0 },
      { kind: 'person', label: 'Back-facing person', descriptionSourceIndex: 1, faceIndex: null }],
    facts: [{ entityIndexes: [0], sourceIndex: 3, text: null, attribute: null, value: null, confidence: 'observed' },
      { entityIndexes: [1], sourceIndex: 1, text: null, attribute: 'clothing', value: 'blue jacket', confidence: 'observed' }],
    objects: [],
  };
  const ctx = context([bob, klass]), value = wire();
  value.rows[0].b = [{ r: 0, to: 'e0', match: null }, { r: 1, to: null, match: null }];
  for (const r of [['e0'], ['d0'], ['e0', 'e1'], ['d0', 'e1']]) {
    value.rows[0].f = [{ r, src: 'v1', t: null, a: null, value: null, c: 'observed' }];
    rejects(value, [p], ctx, 'person_visual_source_mismatch');
  }
  for (const src of ['v2', 'v3']) {
    value.rows[0].f = [{ r: ['e0', 'e1'], src, t: null, a: null, value: null, c: 'observed' }];
    const row = decodeBindingBatch(value, [p], ctx).updates[0];
    assert.deepEqual(row.delta.facts.at(-1)!.entityRefs, ['d0', 'e1']);
    assert.equal(row.delta.facts.at(-1)!.text, p.vision.observations[Number(src.slice(1)) - 1]);
  }
  value.rows[0].f = [{ r: ['e0'], src: 'o0', t: null, a: null, value: null, c: 'uncertain' }];
  rejects(value, [p], ctx, 'person_visual_source_mismatch');
  value.rows[0].f[0].r = [];
  assert.equal(decodeBindingBatch(value, [p], ctx).updates[0].delta.facts.at(-1)!.confidence, 'uncertain');
  p.audio.segments = [speech('Bob enjoys hiking.')];
  value.rows[0].f = [{ r: ['e0'], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  assert.deepEqual(decodeBindingBatch(value, [p], ctx).updates[0].delta.facts.at(-1)!.transcriptKeys, [transcriptKey(p.audio.segments[0])]);
  // A face elsewhere in the frame is insufficient if no visual draft entity binds it.
  p.vision.visualDraft.entities[0].faceIndex = null; value.rows[0].b[0].to = null;
  value.rows[0].f = [{ r: ['e0'], src: 'v2', t: null, a: null, value: null, c: 'observed' }];
  rejects(value, [p], ctx, 'person_visual_source_mismatch');
});


test('sparse new defaults preserve every visual declaration and backward reuse stays checked', () => {
  const packets = [packet(), packet(1)], value = wire(2);
  value.rows[0].b = [];
  value.rows[1].b = [{ r: 0, to: 'p0d0', match: { ...matching(), anchors: [{ prior: { i: 0, r: 'd0', n: 0 }, current: 0 }] } }];
  const rows = decodeBindingBatch(value, packets, context()).updates;
  assert.equal(rows[0].delta.entities[0].existingId, null); assert.equal(rows[0].delta.facts.length, 1);
  assert.deepEqual(rows[1].reuse, [{ ref: 'd0', fromPacketId: packets[0].id, fromRef: 'd0' }]);
  value.rows[1].b[0].match!.anchors[0].current = 1; rejects(value, packets, context(), 'unknown_current_anchor');
  value.rows[1].b = [{ r: 0, to: null, match: null }, { r: 0, to: null, match: null }];
  rejects(value, packets, context(), 'duplicate_or_unknown_binding');
});

test('every declared visual entity gets a full descriptor note unless exact source text is already linked', () => {
  const p = packet(); p.vision.visualDraft!.facts[0].text = 'Keys are visible.';
  const row = decodeBindingBatch(wire(), [p], context()).updates[0];
  assert.equal(row.delta.facts.length, 2); assert.equal(row.delta.facts[0].confidence, 'observed');
  assert.deepEqual(row.delta.facts[1], { entityRefs: ['d0'], text: p.vision.observations[0], attribute: null, value: null,
    visual: true, transcriptKeys: [], confidence: 'uncertain' });
  p.vision.visualDraft!.facts[0].text = p.vision.observations[0];
  assert.equal(decodeBindingBatch(wire(), [p], context()).updates[0].delta.facts.length, 1);
});

test('two factless anonymous people retain searchable descriptors and source-time last seen', () => {
  const p = packet(); p.vision.scene = 'Two visible people.';
  p.vision.observations = ['A back-facing person wears a blue jacket.', 'A person in a green sweater stands nearby.'];
  p.vision.visualDraft = { entities: [
    { kind: 'person', label: 'Back-facing person', descriptionSourceIndex: 1, faceIndex: null },
    { kind: 'person', label: 'Person in green sweater', descriptionSourceIndex: 2, faceIndex: null },
  ], facts: [], objects: [] };
  const value = wire(); value.rows[0].b = [];
  const batch = decodeBindingBatch(value, [p], context()); assert.equal(batch.updates[0].delta.facts.length, 2);
  const store = new Store(':memory:', 3, 'test-embedding');
  try {
    store.createSession(p.sessionId, 0);
    const capture: CaptureRecord = { id: p.id, sessionId: p.sessionId, sequence: p.sequence, capturedAt: p.capturedAt,
      width: p.faces.width, height: p.faces.height, faces: p.faces, audioStatus: p.audio.status,
      imagePath: p.imagePath, sha256: p.sha256, receivedAt: p.createdAt, status: 'ready', error: null, vision: p.vision };
    store.insertCapture(capture); store.savePacket(p); store.commitBatch([p], batch);
    const people = store.entities().filter(e => e.kind === 'person'); assert.equal(people.length, 2);
    for (const person of people) {
      assert.equal(person.lastSeenAt, p.capturedAt); assert.equal(person.personId, null);
      const notes = store.observations().filter(note => note.entityIds.includes(person.id));
      assert.equal(notes.length, 1); assert.equal(notes[0].text, person.description); assert.equal(notes[0].confidence, 'uncertain');
      store.putEmbedding(notes[0].id, [1, 0, 0]);
      const hits = store.search([1, 0, 0], { entityId: person.id, limit: 5 });
      assert.equal(hits.length, 1); assert.equal(hits[0].text, person.description);
    }
  } finally { store.close(); }
});

test('40 visual facts, 30 full descriptors and 40 supplements are preserved together', () => {
  const p = packet(); p.vision.observations = Array.from({ length: 30 }, (_, i) => `Place feature ${i}.`);
  p.vision.visualDraft = { entities: Array.from({ length: 30 }, (_, i) => ({ kind: 'place', label: `Place ${i}`, descriptionSourceIndex: i + 1, faceIndex: null })),
    facts: Array.from({ length: 40 }, () => ({ entityIndexes: [], sourceIndex: 0, text: null, attribute: null, value: null, confidence: 'observed' })), objects: [] };
  const value = wire(); value.rows[0].b = []; value.rows[0].f = Array.from({ length: 40 }, () => ({ r: [], src: 'v0', t: null, a: null, value: null, c: 'observed' }));
  const row = decodeBindingBatch(value, [p], context()).updates[0]; assert.equal(row.delta.facts.length, 110);
  assert.equal(row.delta.entities.length, 30); assert.equal(row.delta.facts.filter(fact => fact.confidence === 'uncertain').length, 30);
});

test('60 visual facts, 30 additional legacy descriptors and 40 supplements retain the full 130-fact expansion', () => {
  const p = packet(); p.vision.observations = Array.from({ length: 30 }, (_, i) => `Distinct place descriptor ${i}.`);
  p.vision.visualDraft = { entities: Array.from({ length: 30 }, (_, i) => ({ kind: 'place', label: `Place ${i}`, descriptionSourceIndex: i + 1, faceIndex: null })),
    facts: Array.from({ length: 60 }, (_, i) => ({ entityIndexes: [i % 30], sourceIndex: 0, text: `Visual fact ${i}.`, attribute: null, value: null, confidence: 'observed' })), objects: [] };
  const value = wire(); value.rows[0].b = [];
  value.rows[0].f = Array.from({ length: 40 }, (_, i) => ({ r: [], src: 'v0', t: `Supplement ${i}.`, a: null, value: null, c: 'observed' }));
  const row = decodeBindingBatch(value, [p], context()).updates[0];
  assert.equal(row.delta.facts.length, 130); assert.equal(row.delta.entities.length, 30);
  assert.deepEqual(row.delta.facts.slice(0, 60).map(fact => fact.text), p.vision.visualDraft.facts.map(fact => fact.text));
  assert.deepEqual(row.delta.facts.slice(60, 90).map(fact => fact.text), p.vision.observations);
  assert.deepEqual(row.delta.facts.slice(90).map(fact => fact.text), value.rows[0].f.map(fact => fact.t));
});

test('30 visual entities plus a final-speech class survive mechanical expansion without dropping linkage', () => {
  const p = packet(); p.vision.observations = Array.from({ length: 30 }, (_, i) => `Distinct visual area ${i}.`);
  p.vision.visualDraft = { entities: p.vision.observations.map((_text, i) => ({ kind: 'place', label: `Visual area ${i}`, descriptionSourceIndex: i + 1, faceIndex: null })), facts: [], objects: [] };
  const final = speech('The calculus class begins now.'); p.audio.segments = [final];
  const value = wire(); value.rows[0].b = [];
  value.rows[0].n = [{ r: 's0', k: 'event', l: 'Calculus class', d: 'A class introduced by finalized speech.' }];
  value.rows[0].f = [{ r: ['s0'], src: 't0', t: null, a: null, value: null, c: 'reported' }];
  value.rows[0].e = [{ r: 's0', status: 'ongoing', summary: 'The calculus class begins.' }];
  const row = decodeBindingBatch(value, [p], context()).updates[0];
  assert.equal(row.delta.entities.length, 31); assert.equal(row.delta.facts.length, 31);
  assert.equal(row.delta.events[0].entityRef, 's0');
  assert.deepEqual(row.delta.facts.at(-1)!.entityRefs, ['s0']);
  assert.deepEqual(row.delta.facts.at(-1)!.transcriptKeys, [transcriptKey(final)]);
  assert.equal(row.delta.facts.at(-1)!.text, final.text);
  const tooManyDeclarations = structuredClone(value);
  tooManyDeclarations.rows[0].n = Array.from({ length: 31 }, (_, i) => ({ r: `s${i}`, k: 'event', l: 'Class', d: '' }));
  rejects(tooManyDeclarations, [p], context(), 'schema_validation');
  const tooManySupplementalFacts = structuredClone(value);
  tooManySupplementalFacts.rows[0].f = Array.from({ length: 41 }, () => structuredClone(value.rows[0].f[0]));
  rejects(tooManySupplementalFacts, [p], context(), 'schema_validation');
});

test('all 180 earlier local aliases can be retained as explicit backward reuse', () => {
  const packets = Array.from({ length: 4 }, (_, index) => {
    const p = packet(index); p.vision.observations = Array.from({ length: 30 }, (_, i) => `Visible area ${index}-${i}.`);
    p.vision.visualDraft = { entities: p.vision.observations.map((_text, i) => ({ kind: 'place', label: `Area ${index}-${i}`, descriptionSourceIndex: i + 1, faceIndex: null })), facts: [], objects: [] };
    return p;
  });
  const value = wire(4);
  for (const row of value.rows) {
    row.b = []; row.n = Array.from({ length: 30 }, (_, i) => ({ r: `s${i}`, k: 'event', l: `Supplement ${row.i}-${i}`, d: '' }));
  }
  const references = Array.from({ length: 3 }, (_, i) => [
    ...Array.from({ length: 30 }, (_, n) => `p${i}d${n}`), ...Array.from({ length: 30 }, (_, n) => `p${i}s${n}`),
  ]).flat();
  value.rows[3].f = Array.from({ length: 18 }, (_, i) => ({ r: references.slice(i * 10, (i + 1) * 10), src: 'v0', t: null, a: null, value: null, c: 'observed' }));
  const row = decodeBindingBatch(value, packets, context()).updates[3];
  assert.equal(row.delta.entities.length, 240); assert.equal(row.reuse.length, 180);
  assert.deepEqual(row.reuse[0], { ref: 'p0d0', fromPacketId: packets[0].id, fromRef: 'd0' });
  assert.deepEqual(row.reuse.at(-1), { ref: 'p2s29', fromPacketId: packets[2].id, fromRef: 's29' });
  assert.equal(row.delta.facts.length, 48);
});
