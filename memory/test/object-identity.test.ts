import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateObjectIdentity, ObjectEvidenceSchema, ObjectIdentityError,
  type ObjectAnchor, type ObjectEvidence } from '../src/object-identity.js';
import { Store } from '../src/store.js';
import type { CaptureRecord, Packet } from '../src/contracts.js';

const packet = (id = 'later', capturedAt = 10000, observations = ['The brass keys with an attached red tag rest on a blue backpack.']) => ({
  id, capturedAt, vision: { scene: 'A room with a wooden desk.', observations },
});
function anchor(overrides: Partial<ObjectAnchor> = {}): ObjectAnchor {
  return { id: 'anchor-red-tag', entityId: 'keys', packetId: 'earlier', packetVersion: 1,
    ref: 'key-ref', index: 0, sourceIndex: 1, kind: 'attached_item', quote: 'attached red tag', observedAt: 5000,
    active: true, ...overrides };
}
function evidence(overrides: Partial<ObjectEvidence> = {}): ObjectEvidence {
  return { ref: 'current-keys', sourceIndex: 1, quote: 'brass keys with an attached red tag',
    anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'attached red tag' }],
    match: { assessment: 'same_instance', anchors: [{ anchor: { id: 'anchor-red-tag' }, sourceIndex: 1, quote: 'attached red tag' }],
      conflictingDetails: [], competingEntityIds: [] }, ...overrides };
}
function evaluate(e: ObjectEvidence | undefined = evidence(), anchors = [anchor()]) {
  return evaluateObjectIdentity({ packet: packet(), candidateId: 'keys', evidence: e, anchors });
}
function rejects(run: () => unknown, code: string) {
  assert.throws(run, error => error instanceof ObjectIdentityError && error.code === code);
}

test('new objects need no identity anchor; generic entries retain their original indices', () => {
  const empty = evaluateObjectIdentity({ packet: packet(), candidateId: null, anchors: [] });
  assert.equal(empty.status, 'new'); assert.deepEqual(empty.newAnchors, []);
  const e = evidence({ match: null, anchors: [
    { kind: 'generic', sourceIndex: 1, quote: 'brass keys' },
    { kind: 'attached_item', sourceIndex: 1, quote: 'attached red tag' },
  ] });
  const result = evaluateObjectIdentity({ packet: packet(), candidateId: null, evidence: e, anchors: [] });
  assert.equal(result.status, 'new'); assert.deepEqual(result.matchedAnchorIds, []);
  assert.deepEqual(result.newAnchors, e.anchors); assert.equal(result.newAnchors[1].kind, 'attached_item');
  const genericOnly = evaluateObjectIdentity({ packet: packet(), candidateId: null,
    evidence: { ...e, anchors: [e.anchors[0]] }, anchors: [] });
  assert.equal(genericOnly.status, 'new'); assert.equal(genericOnly.newAnchors[0].kind, 'generic');
  rejects(() => evaluateObjectIdentity({ packet: packet(), candidateId: null, evidence: evidence(), anchors: [anchor()] }), 'match_without_candidate');
});

test('three similar doors are candidate matches, not supported instance continuity', () => {
  const prior = anchor({ id: 'generic-door', entityId: 'door-one', kind: 'generic', quote: 'white door with a silver handle' });
  for (const [i, room] of ['first office', 'second office', 'corridor'].entries()) {
    const p = packet(`door-frame-${i}`, 10000 + i * 5000, [`A white door with a silver handle is beside the ${room}.`]);
    const e: ObjectEvidence = { ref: 'door', sourceIndex: 1, quote: 'white door with a silver handle',
      anchors: [{ kind: 'generic', sourceIndex: 1, quote: 'white door with a silver handle' }],
      match: { assessment: 'same_instance', anchors: [{ anchor: { id: prior.id }, sourceIndex: 1, quote: 'white door with a silver handle' }],
        conflictingDetails: [], competingEntityIds: [] } };
    const result = evaluateObjectIdentity({ packet: p, candidateId: 'door-one', evidence: e, anchors: [prior] });
    assert.equal(result.status, 'candidate'); assert.equal(result.reason, 'insufficient_anchors');
    assert.deepEqual(result.matchedAnchorIds, []);
  }
});

test('red-tag keys support inferred relocation and later return using active original anchors', () => {
  const before = [anchor()]; const copy = structuredClone(before);
  const moved = evaluate(); assert.equal(moved.status, 'supported'); assert.deepEqual(moved.matchedAnchorIds, ['anchor-red-tag']);
  const returned = evaluateObjectIdentity({ packet: packet('return', 20000, ['The brass keys with an attached red tag are again on the wooden desk.']),
    candidateId: 'keys', evidence: evidence(), anchors: before });
  assert.equal(returned.status, 'supported'); assert.equal(returned.reason, 'matched_intrinsic_anchors');
  assert.deepEqual(before, copy); // Pure evaluation does not mutate evidence or persistence.
});

test('a past distinctive marker cannot promote a generic, missing or unrelated current marker', () => {
  for (const currentAnchors of [[],
    [{ kind: 'generic' as const, sourceIndex: 1, quote: 'brass keys' }],
    [{ kind: 'attached_item' as const, sourceIndex: 1, quote: 'attached red tag' }],
  ]) {
    const e = evidence({ anchors: currentAnchors });
    e.match!.anchors[0].quote = 'brass keys';
    const before = structuredClone(e), result = evaluate(e);
    assert.equal(result.status, 'candidate');
    assert.equal(result.reason, 'unpaired_current_anchor');
    assert.deepEqual(result.matchedAnchorIds, []);
    assert.deepEqual(result.resolvedEvidence, e); assert.deepEqual(e, before);
  }
});

test('an intrinsic marker must be intrinsic in both views, not a cross-pair of configuration and marking', () => {
  for (const [priorKind, currentKind] of [
    ['attached_item', 'distinctive_configuration'],
    ['distinctive_configuration', 'distinctive_marking'],
  ] as const) {
    const e = evidence({ anchors: [{ kind: currentKind, sourceIndex: 1, quote: 'attached red tag' }] });
    const result = evaluate(e, [anchor({ kind: priorKind })]);
    assert.equal(result.status, 'candidate');
    assert.equal(result.reason, 'configuration_without_intrinsic_marker');
  }
});

test('an unpaired second citation cannot distinguish otherwise identical competing keys', () => {
  const p = packet('two-markers', 10000, ['The brass keys with an attached red tag have a triangle engraving.']);
  const e = evidence({ anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'attached red tag' }] });
  e.match!.anchors.push({ anchor: { id: 'engraving' }, sourceIndex: 1, quote: 'brass keys' });
  const result = evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: e, anchors: [anchor(),
    anchor({ id: 'engraving', index: 1, kind: 'distinctive_marking', quote: 'triangle engraving' }),
    anchor({ id: 'competitor', entityId: 'other-keys' }),
  ] });
  assert.equal(result.status, 'candidate'); assert.equal(result.reason, 'indistinguishable_anchors');
  assert.deepEqual(result.matchedAnchorIds, ['anchor-red-tag']);
});

test('a common device configuration cannot establish physical identity by itself', () => {
  const text = 'a black card reader showing a green illuminated strip';
  const prior = anchor({ id: 'reader-shape', entityId: 'reader', kind: 'distinctive_configuration', quote: text });
  const current: ObjectEvidence = { ref: 'reader', sourceIndex: 1, quote: text,
    anchors: [{ kind: 'distinctive_configuration', sourceIndex: 1, quote: text }],
    match: { assessment: 'same_instance', anchors: [{ anchor: { id: prior.id }, sourceIndex: 1, quote: text }],
      conflictingDetails: [], competingEntityIds: [] } };
  const result = evaluateObjectIdentity({ packet: packet('second-reader', 10000, [`There is ${text}.`]),
    candidateId: 'reader', evidence: current, anchors: [prior] });
  assert.equal(result.status, 'candidate'); assert.equal(result.reason, 'configuration_without_intrinsic_marker');
});

test('all eligible signatures must be unique across other active objects', () => {
  const identical = anchor({ id: 'other-red-tag', entityId: 'other-keys', packetId: 'other-photo', quote: 'attached   red\n tag' });
  const result = evaluate(evidence(), [anchor(), identical]);
  assert.equal(result.status, 'candidate'); assert.equal(result.reason, 'indistinguishable_anchors');
  assert.equal(evaluate(evidence(), [anchor(), { ...identical, quote: 'Attached Red Tag' }]).reason, 'indistinguishable_anchors');
  const engraved = anchor({ id: 'engraving', kind: 'distinctive_marking', quote: 'triangle engraving', index: 1 });
  const p = packet('both', 10000, ['The brass keys with an attached red tag have a triangle engraving.']);
  const e = evidence(); e.match!.anchors.push({ anchor: { id: 'engraving' }, sourceIndex: 1, quote: 'triangle engraving' });
  e.anchors.push({ kind: 'distinctive_marking', sourceIndex: 1, quote: 'triangle engraving' });
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: e, anchors: [anchor(), engraved, identical] }).status, 'supported');
  const otherEngraved = { ...engraved, id: 'other-engraving', entityId: 'other-keys', packetId: 'other-photo' };
  assert.equal(evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: e,
    anchors: [anchor(), engraved, identical, otherEngraved] }).status, 'candidate');
  assert.equal(evaluate(evidence(), [anchor(), { ...identical, active: false }]).status, 'supported');
  assert.equal(evaluate(evidence(), [anchor(), { ...identical, observedAt: 10001 }]).status, 'supported');
});

test('current-frame competing proposals prevent order-dependent matches but cannot support reuse', () => {
  const currentCompetitor = anchor({ id: 'new-keys-red-tag', entityId: 'new-keyset', packetId: 'later', observedAt: 10000 });
  for (const anchors of [[anchor(), currentCompetitor], [currentCompetitor, anchor()]]) {
    const result = evaluate(evidence(), anchors);
    assert.equal(result.status, 'candidate'); assert.equal(result.reason, 'indistinguishable_anchors');
  }
  const sameFrameOwned = { ...currentCompetitor, entityId: 'keys' }, e = evidence();
  e.match!.anchors[0].anchor = { id: sameFrameOwned.id };
  rejects(() => evaluate(e, [sameFrameOwned]), 'non_earlier_anchor');
});

test('missing, occluded, possible, conflicting and declared competing evidence remain candidates', () => {
  const missing = evaluateObjectIdentity({ packet: packet(), candidateId: 'keys', anchors: [anchor()] });
  assert.equal(missing.status, 'candidate'); assert.equal(missing.reason, 'missing_evidence');
  assert.equal(evaluate(evidence({ match: null })).reason, 'missing_match');
  const occluded = evidence(); occluded.match!.anchors = [];
  assert.equal(evaluate(occluded).reason, 'insufficient_anchors');
  const possible = evidence(); possible.match!.assessment = 'possible';
  assert.equal(evaluate(possible).reason, 'possible_match');
  const conflict = evidence(); conflict.match!.conflictingDetails = ['Tag shape differs.'];
  assert.equal(evaluate(conflict).reason, 'conflicting_details');
  const competing = evidence(); competing.match!.competingEntityIds = ['other-keys'];
  assert.equal(evaluate(competing).reason, 'declared_competitors');
});

test('wrong-owner, unknown, inactive, future and same-frame anchor citations throw typed errors', () => {
  rejects(() => evaluate(evidence(), [anchor({ entityId: 'different-keys' })]), 'anchor_owner_mismatch');
  rejects(() => evaluate(evidence(), []), 'unknown_anchor');
  rejects(() => evaluate(evidence(), [anchor({ active: false })]), 'inactive_anchor');
  rejects(() => evaluate(evidence(), [anchor({ observedAt: 10001 })]), 'non_earlier_anchor');
  rejects(() => evaluate(evidence(), [anchor({ observedAt: 10000 })]), 'non_earlier_anchor');
  rejects(() => evaluate(evidence(), [anchor({ packetId: 'later', observedAt: 5000 })]), 'non_earlier_anchor');
  const possible = evidence(); possible.match!.assessment = 'possible';
  rejects(() => evaluate(possible, []), 'unknown_anchor'); // Invalid citations do not bypass validation.
});

test('batch packet/ref/index citations resolve exactly and preserve index holes', () => {
  const stored = anchor({ index: 1 }), e = evidence();
  e.match!.anchors[0].anchor = { packetId: stored.packetId, ref: stored.ref, index: 1 };
  assert.deepEqual(evaluate(e, [stored]).matchedAnchorIds, [stored.id]);
  const wrongIndex = structuredClone(e); wrongIndex.match!.anchors[0].anchor = { packetId: stored.packetId, ref: stored.ref, index: 0 };
  rejects(() => evaluate(wrongIndex, [stored]), 'unknown_anchor');
  const oldRevision = { ...stored, id: 'old-revision', packetVersion: 1, active: false };
  const newRevision = { ...stored, packetVersion: 2 };
  assert.deepEqual(evaluate(e, [oldRevision, newRevision]).matchedAnchorIds, [stored.id]);
  rejects(() => evaluate(e, [{ ...oldRevision, active: true }, newRevision]), 'ambiguous_anchor_reference');
});

test('current quote checks remain verbatim except whitespace and uniquely repair a wrong source index', () => {
  const whitespace = evidence({ quote: 'brass\n keys with an attached  red tag' });
  whitespace.match!.anchors[0].quote = 'attached\nred tag';
  assert.equal(evaluate(whitespace).status, 'supported');
  rejects(() => evaluate(evidence({ quote: 'brass keys with a blue tag' })), 'current_quote_mismatch');
  assert.equal(evaluate(evidence({ sourceIndex: 0 })).resolvedEvidence!.sourceIndex, 1);
  assert.equal(evaluate(evidence({ sourceIndex: 2 })).resolvedEvidence!.sourceIndex, 1);
  rejects(() => evaluate(evidence({ sourceIndex: 2, quote: 'absent quote' })), 'unknown_current_source');
  const wrongAnchor = evidence({ anchors: [{ kind: 'damage', sourceIndex: 1, quote: 'broken edge' }] });
  rejects(() => evaluate(wrongAnchor), 'current_quote_mismatch');
  const wrongCitation = evidence(); wrongCitation.match!.anchors[0].quote = 'ATTACHED RED TAG';
  rejects(() => evaluate(wrongCitation), 'current_quote_mismatch');
  const otherSource = evidence(); otherSource.match!.anchors[0].sourceIndex = 0;
  assert.equal(evaluate(otherSource).resolvedEvidence!.match!.anchors[0].sourceIndex, 1);
});

test('resolved evidence and new anchors retain actual source indexes without mutating provider evidence', () => {
  const e = evidence({ sourceIndex: 0, anchors: [
    { kind: 'generic', sourceIndex: 0, quote: 'brass keys' },
    { kind: 'attached_item', sourceIndex: 0, quote: 'attached\n red  tag' },
  ] });
  e.match!.anchors[0].sourceIndex = 2;
  const before = structuredClone(e), result = evaluate(e);
  assert.equal(result.status, 'supported'); assert.deepEqual(e, before);
  assert.equal(result.resolvedEvidence!.sourceIndex, 1);
  assert.equal(result.resolvedEvidence!.match!.anchors[0].sourceIndex, 1);
  assert.deepEqual(result.newAnchors.map(item => item.sourceIndex), [1, 1]);
  assert.equal(result.newAnchors[1].quote, 'attached\n red  tag');
  assert.equal(result.newAnchors[1].kind, 'attached_item');
  assert.deepEqual(result.newAnchors, result.resolvedEvidence!.anchors);
});

test('valid requested source wins; a wrong index with multiple matching sources rejects', () => {
  const p = packet('repeated', 10000, [
    'The brass keys with an attached red tag rest on a blue backpack.',
    'The brass keys with an attached red tag rest on the wooden desk.',
  ]);
  const second = evidence({ sourceIndex: 2 }); second.match!.anchors[0].sourceIndex = 2;
  const valid = evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: second, anchors: [anchor()] });
  assert.equal(valid.resolvedEvidence!.sourceIndex, 2);
  assert.equal(valid.resolvedEvidence!.match!.anchors[0].sourceIndex, 2);
  rejects(() => evaluateObjectIdentity({ packet: p, candidateId: 'keys',
    evidence: evidence({ sourceIndex: 0 }), anchors: [anchor()] }), 'ambiguous_current_quote');
  const ambiguousAnchor = evidence({ anchors: [{ kind: 'attached_item', sourceIndex: 0, quote: 'attached red tag' }] });
  rejects(() => evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: ambiguousAnchor, anchors: [anchor()] }), 'ambiguous_current_quote');
  const ambiguousMatch = evidence(); ambiguousMatch.match!.anchors[0].sourceIndex = 0;
  rejects(() => evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: ambiguousMatch, anchors: [anchor()] }), 'ambiguous_current_quote');
});

test('resolver does not use OCR, other frames, case changes or semantically similar text', () => {
  const absent = evidence({ quote: 'keys with a blue tag' });
  const p = { ...packet(), vision: { ...packet().vision,
    readableText: ['keys with a blue tag'], textEvidence: { lines: ['keys with a blue tag'] } } };
  rejects(() => evaluateObjectIdentity({ packet: p, candidateId: 'keys', evidence: absent,
    anchors: [anchor({ quote: 'keys with a blue tag' })] }), 'current_quote_mismatch');
  rejects(() => evaluate(evidence({ sourceIndex: 0, quote: 'Brass keys with an attached red tag' })), 'current_quote_mismatch');
  rejects(() => evaluate(evidence({ sourceIndex: 0, quote: 'metal keys with a red tag' })), 'current_quote_mismatch');
});

test('recorded worktable off-by-one citation resolves to observation five without altering the recorded index', () => {
  const quote = 'A rectangular worktable near the center-left holds assorted containers and small items. Red rolling chairs sit at its near side, with additional green and gray chairs around it.';
  const p = packet('source-2', 10000, [
    'A corridor extends into the distance.', 'The floor has dark square tiles.', 'There are several chairs.',
    'Light-wood benches run along the left wall, including one partly cropped at bottom left and another beside the table area.', quote,
  ]);
  const recorded: ObjectEvidence = { ref: 'table', sourceIndex: 4, quote, anchors: [], match: null };
  const result = evaluateObjectIdentity({ packet: p, candidateId: null, evidence: recorded, anchors: [] });
  assert.equal(result.status, 'new'); assert.equal(result.resolvedEvidence!.sourceIndex, 5);
  assert.equal(result.resolvedEvidence!.quote, quote); assert.equal(recorded.sourceIndex, 4);
});

test('Store saves a repaired anchor source index without changing the caller evidence', () => {
  const store = new Store(':memory:', 3, 'test-vector'); store.createSession('session', 0);
  try {
    const vision = { ...packet().vision, readableText: [], uncertainties: [] };
    const faces: CaptureRecord['faces'] = { frameId: 'capture', streamId: 'faces', capturedAt: 1000,
      status: 'unavailable', width: 640, height: 480, faces: [] };
    const capture: CaptureRecord = { id: 'capture', sessionId: 'session', sequence: 1, capturedAt: 1000,
      width: 640, height: 480, faces, audioStatus: 'unavailable', imagePath: '/fixture/capture.jpg',
      sha256: 'a'.repeat(64), receivedAt: 1001, status: 'ready', error: null, vision };
    store.insertCapture(capture);
    const p: Packet = { ...capture, vision, version: 1, createdAt: 1001, correction: false,
      audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: 1000 } };
    const original = evidence({ sourceIndex: 0, match: null, anchors: [
      { kind: 'attached_item', sourceIndex: 0, quote: 'attached red tag' },
    ] });
    store.commit(p, { state: { location: null, activity: null, summary: 'Keys visible', uncertainties: [] },
      entities: [{ ref: original.ref, existingId: null, kind: 'object', label: 'Keys', description: 'Red-tag keys', personId: null }],
      facts: [], events: [], objectEvidence: [original] });
    const saved = store.entities()[0].identityAnchors![0];
    assert.equal(saved.sourceIndex, 1); assert.equal(saved.packetId, p.id); assert.equal(saved.quote, 'attached red tag');
    assert.equal(original.sourceIndex, 0); assert.equal(original.anchors[0].sourceIndex, 0);
  } finally { store.close(); }
});

test('strict schema bounds and malformed stored anchors reject without leaking quote contents', () => {
  const e = evidence();
  for (const bad of [
    { ...e, surprise: true }, { ...e, sourceIndex: 31 }, { ...e, quote: ' ' },
    { ...e, anchors: Array.from({ length: 7 }, () => ({ kind: 'generic', sourceIndex: 1, quote: 'brass keys' })) },
    { ...e, match: { ...e.match, anchors: [{ anchor: { id: 'x', packetId: 'earlier', ref: 'x', index: 0 }, sourceIndex: 1, quote: 'brass keys' }] } },
    { ...e, match: { ...e.match, conflictingDetails: Array(7).fill('conflict') } },
    { ...e, match: { ...e.match, competingEntityIds: Array(11).fill('other') } },
  ]) {
    assert.equal(ObjectEvidenceSchema.safeParse(bad).success, false);
    rejects(() => evaluate(bad as ObjectEvidence), 'invalid_evidence');
  }
  rejects(() => evaluate(e, [anchor({ index: 6 })]), 'invalid_input');
  rejects(() => evaluate(e, [anchor(), anchor()]), 'duplicate_anchor_id');
  const secret = evidence({ quote: 'private-source-detail-not-present' });
  assert.throws(() => evaluate(secret), error => error instanceof ObjectIdentityError && !error.message.includes(secret.quote));
});
