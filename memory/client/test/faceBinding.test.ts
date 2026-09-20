import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceEvidenceFromReply, sanitizeBox, verifyReplyGeometry, displayName } from '../src/faceBinding.ts';

const meta = { id: 'cap', capturedAt: 1000, width: 640, height: 480, streamId: 'faces_x' };

test('identity comes only from stable_id/stable_name; a raw gallery match never confirms', () => {
  const { evidence } = faceEvidenceFromReply({ type: 'frame', input_wh: [640, 480], faces: [
    { track_id: 1, box: [10, 20, 100, 120], stable_id: null, stable_name: null, match: { id: 'gallery-uuid', name: 'Sarah', similarity: 0.62 } },
    { track_id: 2, box: [200, 20, 300, 120], stable_id: 'gallery-uuid', stable_name: 'Sarah', match: { id: 'gallery-uuid', name: 'Sarah', similarity: 0.71 } },
    { track_id: 3, box: [400, 20, 500, 120], stable_id: null, stable_name: 'Ghost', match: { id: null, name: null, similarity: null } },
  ] }, meta);
  assert.equal(evidence.faces.length, 3);
  assert.deepEqual(evidence.faces.map((f) => [f.identityStatus, f.personId, f.name]), [
    ['unknown', null, null], ['confirmed', 'gallery-uuid', 'Sarah'], ['unknown', null, null],
  ]);
  assert.equal(evidence.faces[0]!.similarity, 0.62, 'raw similarity is kept as information only');
  assert.deepEqual(evidence.faces.map(displayName), ['Unknown', 'Sarah', 'Unknown']);
  assert.equal(evidence.frameId, 'cap'); assert.equal(evidence.capturedAt, 1000); assert.equal(evidence.streamId, 'faces_x');
});

test('boxes: non-finite rejected, out-of-bounds clamped, degenerate rejected', () => {
  assert.equal(sanitizeBox([Number.NaN, 0, 10, 10], 640, 480), null);
  assert.equal(sanitizeBox([0, 0, Infinity, 10], 640, 480), null);
  assert.deepEqual(sanitizeBox([-5, -5, 700, 500], 640, 480), [0, 0, 640, 480]);
  assert.equal(sanitizeBox([100, 100, 100, 200], 640, 480), null);
  assert.equal(sanitizeBox([650, 10, 700, 20], 640, 480), null, 'fully outside collapses to zero width');
  assert.equal(sanitizeBox('nope', 640, 480), null);
  const { evidence, rejectedBoxes } = faceEvidenceFromReply({ type: 'frame', input_wh: [640, 480], faces: [{ track_id: 1, box: [1, 2, 'x', 4] as unknown as number[] }] }, meta);
  assert.equal(evidence.faces.length, 0); assert.equal(rejectedBoxes, 1);
});

test('geometry check requires input_wh to equal the sent derivative', () => {
  assert.deepEqual(verifyReplyGeometry({ type: 'frame', input_wh: [640, 480] }, meta), { ok: true });
  assert.equal(verifyReplyGeometry({ type: 'frame', input_wh: [640, 360] }, meta).ok, false);
  assert.equal(verifyReplyGeometry({ type: 'frame' }, meta).ok, false);
  assert.equal(verifyReplyGeometry({ type: 'frame', input_wh: ['640', '480'] }, meta).ok, false);
});
