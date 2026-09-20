import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSSIBLE_MATCH_LABEL, possibleMatchLabel, searchRowLabel, targetRelation, unresolvedCandidates } from '../src/candidates.ts';

test('canonical target is never labelled uncertain, even when unrelated candidates are present', () => {
  const o = { entityIds: ['keys'], candidateEntityIds: ['wallet'] };
  assert.equal(targetRelation(o, 'keys'), 'canonical');
  assert.equal(possibleMatchLabel(o, 'keys'), null);
  assert.deepEqual(unresolvedCandidates(o), ['wallet']);
});

test('target present only as a candidate gets the exact label; candidates are not promoted', () => {
  const o = { entityIds: ['desk'], candidateEntityIds: ['keys'] };
  assert.equal(targetRelation(o, 'keys'), 'possible');
  assert.equal(possibleMatchLabel(o, 'keys'), 'Possible match — identity unconfirmed');
  assert.equal(POSSIBLE_MATCH_LABEL, 'Possible match — identity unconfirmed');
  assert.deepEqual(o.entityIds, ['desk'], 'canonical set untouched');
});

test('missing/empty candidateEntityIds preserves old behaviour; overlap resolves to canonical', () => {
  assert.equal(targetRelation({ entityIds: ['a'] }, 'b'), 'none');
  assert.equal(possibleMatchLabel({ entityIds: ['a'], candidateEntityIds: [] }, 'a'), null);
  assert.deepEqual(unresolvedCandidates({ entityIds: ['a'] }), []);
  assert.deepEqual(unresolvedCandidates({ entityIds: ['a'], candidateEntityIds: ['a', 'b', 'b', ''] }), ['b']);
  assert.equal(targetRelation({ entityIds: ['a'], candidateEntityIds: ['a'] }, 'a'), 'canonical');
});

test('unfiltered context: no target label, but unresolved candidates are exposed for explicit display', () => {
  const o = { entityIds: ['a'], candidateEntityIds: ['b'] };
  assert.equal(targetRelation(o, null), 'none');
  assert.equal(possibleMatchLabel(o, undefined), null);
  assert.deepEqual(unresolvedCandidates(o), ['b']);
});

test('filter context is whatever the caller captured at submission, not a later value', () => {
  const capturedFilter = 'keys';
  let selectorNow = 'keys';
  const o = { entityIds: [], candidateEntityIds: ['keys'] };
  selectorNow = 'wallet'; // user changed the selector while the response was in flight
  assert.equal(possibleMatchLabel(o, capturedFilter), POSSIBLE_MATCH_LABEL);
  assert.equal(possibleMatchLabel(o, selectorNow), null);
});

test('search row label: unfiltered rows with unresolved candidates carry the exact label; filtered canonical target does not', () => {
  const o = { entityIds: ['keys'], candidateEntityIds: ['wallet'] };
  assert.equal(searchRowLabel(o, null), POSSIBLE_MATCH_LABEL);
  assert.equal(searchRowLabel(o, 'keys'), null, 'unrelated candidate never marks the confirmed target uncertain');
  assert.equal(searchRowLabel(o, 'wallet'), POSSIBLE_MATCH_LABEL);
  assert.equal(searchRowLabel({ entityIds: ['keys'] }, null), null);
  assert.equal(searchRowLabel({ entityIds: ['keys'], candidateEntityIds: ['keys'] }, null), null, 'overlap is canonical, not unresolved');
});
