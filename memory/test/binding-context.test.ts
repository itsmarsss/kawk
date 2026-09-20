import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindingDraftContext, bindingRelatedContext } from '../src/binding-context.js';
import type { MemoryContext, Observation } from '../src/contracts.js';
import type { VisualDraft } from '../src/visual-draft.js';

test('grouped context retains separate confidence, identity links, source times and retrieval order', () => {
  const note: Observation = { id: 'a', packetId: 'p', packetVersion: 1, entityIds: [],
    text: 'Blue keys beside the bag.', observedAt: 10, endAt: 10, confidence: 'observed',
    visual: true, transcriptKeys: [], superseded: false };
  const context: MemoryContext = { state: { version: 0, observedAt: 0, location: null,
    activity: null, summary: '', uncertainties: [], packetId: null }, entities: [], related: [
    note,
    { ...note, id: 'b', text: 'A different observation.', entityIds: ['bag'], observedAt: 11, endAt: 12 },
    { ...note, id: 'c', entityIds: ['keys'], confidence: 'uncertain', candidateEntityIds: ['other-keys'], observedAt: 20, endAt: 22 },
    { ...note, id: 'd', text: 'Blue keys beside the bag. ', confidence: 'reported', visual: false },
    { ...note, id: 'superseded', superseded: true, text: 'Outdated private detail.' },
  ] };
  const before = structuredClone(context), aliases = new Map([['keys', 'e0'], ['other-keys', 'e1'], ['bag', 'e2']]);
  const result = bindingRelatedContext(context, aliases);
  assert.equal(result.length, 3);
  assert.equal(result[0].occurrences.length, 2);
  assert.deepEqual(result[0].occurrences.map(o => [o.entities, o.candidateEntities, o.confidence]),
    [[[], [], 'observed'], [['e0'], ['e1'], 'uncertain']]);
  const expanded = result.flatMap(group => group.occurrences.map(occurrence => ({ text: group.text, ...occurrence })))
    .sort((a, b) => a.rank - b.rank);
  assert.deepEqual(expanded, context.related.filter(note => !note.superseded).map((row, rank) => ({
    text: row.text, rank, entities: row.entityIds.map(id => aliases.get(id)),
    candidateEntities: (row.candidateEntityIds ?? []).map(id => aliases.get(id)),
    observedAt: row.observedAt, endAt: row.endAt, confidence: row.confidence, visual: row.visual,
  })));
  assert.equal(JSON.stringify(result).includes('Outdated private detail.'), false);
  assert.deepEqual(context, before);
});

test('compact draft round-trips all sixty facts without changing owners, sources, text or face slots', () => {
  const draft: VisualDraft = {
    entities: Array.from({ length: 30 }, (_, i) => ({ kind: i === 0 ? 'person' : 'object',
      label: `Item ${i}`, descriptionSourceIndex: i + 1, faceIndex: i === 0 ? 2 : null })),
    facts: Array.from({ length: 60 }, (_, i) => ({ entityIndexes: [i % 30], sourceIndex: i % 30 + 1,
      text: i % 2 ? 'Complete text — including spacing. ' : null, attribute: i % 2 ? null : 'location',
      value: i % 2 ? null : 'beside the green bag', confidence: i % 3 ? 'observed' : 'uncertain' })),
    objects: Array.from({ length: 29 }, (_, i) => ({ entityIndex: i + 1, sourceIndex: i + 2,
      anchors: [{ kind: 'distinctive_marking', sourceIndex: i + 2, quote: `Exact pattern ${i} 🎒` }] })),
  };
  const before = structuredClone(draft), compact = bindingDraftContext(draft);
  const expanded = {
    entities: compact.n.map(n => ({ kind: n.k, label: n.l, descriptionSourceIndex: n.v, faceIndex: n.face })),
    facts: compact.f.map(f => ({ entityIndexes: f.r, sourceIndex: f.v, text: f.t, attribute: f.a, value: f.value, confidence: f.c })),
    objects: compact.m.map(m => ({ entityIndex: m.r, sourceIndex: m.v,
      anchors: m.a.map(a => ({ kind: a.k, sourceIndex: a.v, quote: a.q })) })),
  };
  assert.deepEqual(expanded, before); assert.deepEqual(draft, before);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(draft)));
});
