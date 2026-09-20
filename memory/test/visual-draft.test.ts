import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  VisualDraftSchema, VisualDraftWireSchema, VisualDraftModelWireSchema, VisualDraftError,
  decodeVisualDraft, decodeVisualDraftModel, validateVisualDraft, type VisualDraftWire,
  NestedVisionModelSchema, decodeNestedVisionModel, type NestedVisionModel,
} from '../src/visual-draft.js';
import { checkedVision, type FaceEvidence } from '../src/contracts.js';

const vision = {
  scene: 'A person stands near a table in a room.',
  observations: ['A person wears a blue jacket.', 'Metal keys with a red rubber tag rest on a table.', 'A room contains a table.'],
};
const faces: FaceEvidence = {
  frameId: 'exact-image', streamId: 'face-stream', capturedAt: 5000,
  status: 'ready', width: 640, height: 480,
  faces: [{ trackId: '7', personId: 'enrolled-fixture', name: 'Fixture', similarity: .8,
    identityStatus: 'confirmed', box: [100, 100, 210, 250] }],
};
function wire(): VisualDraftWire {
  return {
    n: [{ k: 'person', l: 'Person', v: 1, face: 0 },
      { k: 'object', l: 'Keys', v: 2, face: null }, { k: 'place', l: 'Room', v: 3, face: null }],
    f: [{ r: [0], v: 1, t: null, a: null, value: null, c: 'observed' },
      { r: [1], v: 2, t: 'The tagged keys are on the table.', a: 'location', value: 'table', c: 'observed' },
      { r: [], v: 0, t: null, a: null, value: null, c: 'uncertain' }],
    m: [{ r: 1, v: 2, a: [{ k: 'attached_item', v: 2, q: 'red rubber tag' }] }],
  };
}
function rejection(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof VisualDraftError && error.code === code);
}

test('compact image draft decodes into readable local structure, preserving sources and nullable copies', () => {
  const result = decodeVisualDraft(wire(), vision, faces);
  assert.deepEqual(result.entities[0], { kind: 'person', label: 'Person', descriptionSourceIndex: 1, faceIndex: 0 });
  assert.equal(result.facts[0].text, null);
  assert.equal(result.facts[1].text, 'The tagged keys are on the table.'); // A faithful summary need not be a quotation.
  assert.deepEqual(result.objects[0], { entityIndex: 1, sourceIndex: 2,
    anchors: [{ kind: 'attached_item', sourceIndex: 2, quote: 'red rubber tag' }] });
  assert.deepEqual(validateVisualDraft(result, vision, faces), result);
  assert.ok(VisualDraftSchema.safeParse(result).success);
  assert.ok(VisualDraftWireSchema.safeParse(wire()).success);
});

test('empty image-only structure is valid and requires no face slots', () => {
  const emptyFaces = { ...faces, status: 'unavailable' as const, faces: [] };
  assert.deepEqual(decodeVisualDraft({ n: [], f: [], m: [] }, vision, emptyFaces), { entities: [], facts: [], objects: [] });
  const input = wire(); input.n[0].face = null;
  assert.equal(decodeVisualDraft(input, vision, emptyFaces).entities[0].faceIndex, null);
});

test('all description, fact, object and anchor source indexes must exist in this image', () => {
  const mutations: ((w: VisualDraftWire) => void)[] = [
    w => { w.n[0].v = 4; }, w => { w.f[0].v = 4; },
    w => { w.m[0].v = 4; }, w => { w.m[0].a[0].v = 4; },
  ];
  for (const change of mutations) { const input = wire(); change(input); rejection(() => decodeVisualDraft(input, vision, faces), 'unknown_source'); }
});

test('anchor quotes permit whitespace normalization only and preserve the declared index', () => {
  const input = wire(); input.m[0].a[0].q = ' red\n rubber\t tag ';
  const changed = { ...vision, observations: [vision.observations[0], 'Metal keys with a red   rubber\n tag rest on a table.', vision.observations[2]] };
  const draft = decodeVisualDraft(input, changed, faces);
  assert.equal(draft.objects[0].anchors[0].quote, ' red\n rubber\t tag ');
  assert.equal(draft.objects[0].anchors[0].sourceIndex, 2);
  for (const quote of ['Red rubber tag', 'red-rubber tag', 'blue rubber tag', 'tag red rubber']) {
    const bad = wire(); bad.m[0].a[0].q = quote;
    rejection(() => decodeVisualDraft(bad, vision, faces), 'anchor_quote_mismatch');
  }
  const wrongIndex = wire(); wrongIndex.m[0].a[0].v = 1;
  rejection(() => decodeVisualDraft(wrongIndex, vision, faces), 'anchor_quote_mismatch'); // Do not repair from source 2.
});

test('OCR, audio, future memory and canonical identity fields cannot enter either schema', () => {
  for (const field of ['audio', 'events', 'existingId', 'personId', 'readableText', 'history']) {
    rejection(() => decodeVisualDraft({ ...wire(), [field]: [] }, vision, faces), 'wire_schema_validation');
  }
  const nested: ((w: any) => void)[] = [
    w => { w.n[0].existingId = 'old-person'; }, w => { w.n[0].personId = 'old-person'; },
    w => { w.f[0].transcriptKeys = ['speech@1']; }, w => { w.f[0].speakerId = 'person'; },
    w => { w.m[0].match = { assessment: 'same_instance' }; },
    w => { w.m[0].a[0].id = 'prior-anchor'; },
  ];
  for (const change of nested) { const input: any = wire(); change(input); rejection(() => decodeVisualDraft(input, vision, faces), 'wire_schema_validation'); }
  const domain = decodeVisualDraft(wire(), vision, faces);
  for (const change of [
    (d: any) => { d.audio = {}; }, (d: any) => { d.entities[0].existingId = 'old'; },
    (d: any) => { d.facts[0].transcriptKeys = []; }, (d: any) => { d.objects[0].match = null; },
    (d: any) => { d.objects[0].anchors[0].id = 'old'; },
  ]) { const input: any = structuredClone(domain); change(input); rejection(() => validateVisualDraft(input, vision, faces), 'schema_validation'); }
});

test('wire fields are strictly typed, complete and image-only', () => {
  const changes: ((w: any) => void)[] = [
    w => { delete w.n[0].face; }, w => { delete w.f[0].t; }, w => { delete w.m; },
    w => { w.n[0].k = 'event'; }, w => { w.f[0].c = 'reported'; },
    w => { w.n[0].v = '1'; }, w => { w.f[0].r = ['0']; },
    w => { w.f[0].v = -1; }, w => { w.f[0].v = 1.5; }, w => { w.f[0].v = 31; },
    w => { w.n[0].face = 100; }, w => { w.n[0].face = false; },
    w => { w.m[0].a[0].q = ' \n\t '; }, w => { w.n[0].l = ' '; },
    w => { w.f[0].t = ''; }, w => { w.m[0].a[0].k = 'location'; },
  ];
  for (const change of changes) { const input: any = wire(); change(input); rejection(() => decodeVisualDraft(input, vision, faces), 'wire_schema_validation'); }
});

test('fact local references must exist and cannot repeat', () => {
  const missing = wire(); missing.f[0].r = [3];
  rejection(() => decodeVisualDraft(missing, vision, faces), 'unknown_entity');
  const duplicate = wire(); duplicate.f[0].r = [0, 0];
  rejection(() => decodeVisualDraft(duplicate, vision, faces), 'duplicate_fact_entity');
});

test('attributes require a value and exactly one entity owner', () => {
  for (const owners of [[], [0, 1]]) {
    const input = wire(); input.f[1].r = owners;
    rejection(() => decodeVisualDraft(input, vision, faces), 'attribute_owner');
  }
  const noValue = wire(); noValue.f[1].value = null;
  rejection(() => decodeVisualDraft(noValue, vision, faces), 'attribute_pair');
  const noAttribute = wire(); noAttribute.f[1].a = null;
  rejection(() => decodeVisualDraft(noAttribute, vision, faces), 'attribute_pair');
});

test('every physical object requires exactly one object entry, including generic objects without anchors', () => {
  const absent = wire(); absent.m = [];
  rejection(() => decodeVisualDraft(absent, vision, faces), 'missing_object');
  const duplicate = wire(); duplicate.m.push(structuredClone(duplicate.m[0]));
  rejection(() => decodeVisualDraft(duplicate, vision, faces), 'duplicate_object');
  const unknown = wire(); unknown.m[0].r = 3;
  rejection(() => decodeVisualDraft(unknown, vision, faces), 'unknown_entity');
  for (const index of [0, 2]) {
    const nonObject = wire(); nonObject.m[0].r = index;
    rejection(() => decodeVisualDraft(nonObject, vision, faces), 'object_owner_kind');
  }
  const generic = wire(); generic.m[0].a = [];
  assert.deepEqual(decodeVisualDraft(generic, vision, faces).objects[0].anchors, []);
});

test('face slots belong only to one local person and must exist in ready face evidence', () => {
  for (const index of [1, 2]) {
    const nonPerson = wire(); nonPerson.n[index].face = 0;
    rejection(() => decodeVisualDraft(nonPerson, vision, faces), 'face_owner_kind');
  }
  const duplicate = wire(); duplicate.n.push({ k: 'person', l: 'Other', v: 1, face: 0 });
  rejection(() => decodeVisualDraft(duplicate, vision, faces), 'duplicate_face_slot');
  const missing = wire(); missing.n[0].face = 1;
  rejection(() => decodeVisualDraft(missing, vision, faces), 'unknown_face_slot');
  rejection(() => decodeVisualDraft(wire(), vision, { ...faces, status: 'unavailable' }), 'unknown_face_slot');
  const unknown = structuredClone(faces); unknown.faces[0].personId = null; unknown.faces[0].name = null; unknown.faces[0].identityStatus = 'unknown';
  assert.equal(decodeVisualDraft(wire(), vision, unknown).entities[0].faceIndex, 0); // A slot is not a name or recognition claim.
});

test('cited face boxes must have finite nondegenerate geometry within that derivative', () => {
  for (const box of [[-1, 10, 50, 80], [10, 10, 641, 80], [10, 10, 50, 481], [10, 10, 10, 80], [10, 80, 50, 10], [10, 10, NaN, 80], [10, 10, 50]]) {
    const wrong = structuredClone(faces); wrong.faces[0].box = box as FaceEvidence['faces'][number]['box'];
    rejection(() => decodeVisualDraft(wire(), vision, wrong), 'invalid_face_geometry');
  }
  for (const width of [0, -1, 640.5, Infinity]) rejection(() => decodeVisualDraft(wire(), vision, { ...faces, width }), 'invalid_face_geometry');
});

test('source-copy bounds reject rather than truncate, while the full raw scene remains available', () => {
  const exactly = { ...vision, observations: ['x'.repeat(1500), ...vision.observations.slice(1)] };
  assert.equal(decodeVisualDraft(wire(), exactly, faces).entities[0].descriptionSourceIndex, 1);
  rejection(() => decodeVisualDraft(wire(), { ...exactly, observations: ['x'.repeat(1501), ...vision.observations.slice(1)] }, faces), 'description_source_too_long');
  const longScene = { ...vision, scene: 'x'.repeat(2000) };
  assert.equal(decodeVisualDraft(wire(), longScene, faces).facts[2].text, null);
  assert.equal(longScene.scene.length, 2000);
  const chooseLongDescription = wire(); chooseLongDescription.n[0].v = 0;
  rejection(() => decodeVisualDraft(chooseLongDescription, longScene, faces), 'description_source_too_long');
  rejection(() => decodeVisualDraft(wire(), { ...vision, scene: 'x'.repeat(2001) }, faces), 'invalid_visual_sources');
  rejection(() => decodeVisualDraft(wire(), { ...vision, scene: ' \n\t ' }, faces), 'fact_source_copy_bounds');
  const emptyObject = wire(); emptyObject.m[0].v = 0; emptyObject.f = [];
  rejection(() => decodeVisualDraft(emptyObject, { ...vision, scene: '' }, faces), 'object_source_copy_bounds');
});

test('array and canonical field bounds match the downstream contract', () => {
  const changes: ((w: any) => void)[] = [
    w => { w.n = Array.from({ length: 31 }, () => w.n[0]); },
    w => { w.f = Array.from({ length: 41 }, () => w.f[0]); },
    w => { w.m = Array.from({ length: 31 }, () => w.m[0]); },
    w => { w.f[0].r = Array.from({ length: 11 }, () => 0); },
    w => { w.m[0].a = Array.from({ length: 7 }, () => w.m[0].a[0]); },
    w => { w.n[0].l = 'x'.repeat(201); }, w => { w.f[0].t = 'x'.repeat(2001); },
    w => { w.f[1].a = 'x'.repeat(101); }, w => { w.f[1].value = 'x'.repeat(1001); },
    w => { w.m[0].a[0].q = 'x'.repeat(1001); },
  ];
  for (const change of changes) { const input: any = wire(); change(input); rejection(() => decodeVisualDraft(input, vision, faces), 'wire_schema_validation'); }
});

test('validation is immutable and never overwrites complete vision or face evidence', () => {
  function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
    return value;
  }
  const input = freeze(wire()); const fullVision = freeze({ ...structuredClone(vision), readableText: ['fallible OCR'], uncertainties: ['unmeasured depth'] });
  const frame = freeze(structuredClone(faces));
  const before = JSON.stringify({ input, fullVision, frame });
  const draft = decodeVisualDraft(input, fullVision, frame);
  const checked = validateVisualDraft(freeze(draft), fullVision, frame);
  checked.facts[0].text = 'Only the returned copy changes.';
  checked.objects[0].anchors[0].quote = 'Only the returned anchor changes.';
  assert.equal(draft.facts[0].text, null); assert.equal(draft.objects[0].anchors[0].quote, 'red rubber tag');
  assert.equal(JSON.stringify({ input, fullVision, frame }), before);
});

test('provider fact union enforces paired single-owner attributes in generated JSON Schema', () => {
  const schema = z.toJSONSchema(VisualDraftModelWireSchema) as any;
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  const variants = schema.properties.f.items.anyOf;
  assert.equal(variants.length, 2);
  for (const variant of variants) {
    assert.equal(variant.additionalProperties, false);
    assert.deepEqual(variant.required, ['r', 'v', 't', 'a', 'value', 'c']);
  }
  assert.equal(variants[0].properties.r.maxItems, 10);
  assert.equal(variants[0].properties.a.type, 'null'); assert.equal(variants[0].properties.value.type, 'null');
  assert.equal(variants[1].properties.r.minItems, 1); assert.equal(variants[1].properties.r.maxItems, 1);
  assert.equal(variants[1].properties.a.type, 'string'); assert.equal(variants[1].properties.value.type, 'string');
  assert.ok(VisualDraftModelWireSchema.safeParse(wire()).success);
  for (const owners of [[], [0, 1]]) {
    const input = wire(); input.f[1].r = owners;
    assert.equal(VisualDraftModelWireSchema.safeParse(input).success, false);
    rejection(() => decodeVisualDraft(input, vision, faces), 'attribute_owner');
    rejection(() => decodeVisualDraftModel(input, vision, faces), 'attribute_owner');
  }
  for (const missing of ['a', 'value'] as const) {
    const input = wire(); input.f[1][missing] = null;
    assert.equal(VisualDraftModelWireSchema.safeParse(input).success, false);
    rejection(() => decodeVisualDraft(input, vision, faces), 'attribute_pair');
  }
  const relation = wire(); relation.f[0].r = Array.from({ length: 10 }, (_, i) => i);
  assert.ok(VisualDraftModelWireSchema.safeParse(relation).success);
  relation.f[0].r.push(10); assert.equal(VisualDraftModelWireSchema.safeParse(relation).success, false);
  const extra: any = wire(); extra.f[0].extra = true;
  assert.equal(VisualDraftModelWireSchema.safeParse(extra).success, false);
});

test('model decoder resolves recorded cadence anchor-index errors from unique exact sources', () => {
  const cases = [
    { wrong: 0, correct: 7, kind: 'damage' as const, quote: 'visible scuffs, worn paint, and chipped areas' },
    { wrong: 3, correct: 4, kind: 'distinctive_marking' as const, quote: 'many decorative stickers on its back' },
  ];
  for (const example of cases) {
    const source = { scene: 'An indoor workspace.', observations: Array.from({ length: 7 }, () => 'Other visible details.') };
    source.observations[example.correct - 1] = `The object has ${example.quote}.`;
    const input: VisualDraftWire = {
      n: [{ k: 'object', l: 'Visible object', v: example.correct, face: null }], f: [],
      m: [{ r: 0, v: example.correct, a: [{ k: example.kind, v: example.wrong, q: example.quote }] }],
    };
    rejection(() => decodeVisualDraft(input, source, faces), 'anchor_quote_mismatch');
    const fixed = decodeVisualDraftModel(input, source, faces);
    assert.equal(fixed.objects[0].anchors[0].sourceIndex, example.correct);
    assert.equal(fixed.objects[0].anchors[0].quote, example.quote);
    assert.equal(input.m[0].a[0].v, example.wrong);
    const wrongDomain = structuredClone(fixed); wrongDomain.objects[0].anchors[0].sourceIndex = example.wrong;
    rejection(() => validateVisualDraft(wrongDomain, source, faces), 'anchor_quote_mismatch');
  }
});

test('model anchor repair accepts only unique whitespace-exact same-image matches', () => {
  const input = wire(); input.m[0].a[0].v = 0; input.m[0].a[0].q = 'red\n rubber\t tag';
  assert.equal(decodeVisualDraftModel(input, vision, faces).objects[0].anchors[0].sourceIndex, 2);
  // A nonexistent but structurally bounded index can be resolved by the same unique quote.
  input.m[0].a[0].v = 30;
  assert.equal(decodeVisualDraftModel(input, vision, faces).objects[0].anchors[0].sourceIndex, 2);
  for (const quote of ['Red rubber tag', 'red-rubber tag', 'blue rubber tag', 'tag red rubber']) {
    input.m[0].a[0].q = quote;
    rejection(() => decodeVisualDraftModel(input, vision, faces), 'anchor_quote_mismatch');
  }
  input.m[0].a[0].q = 'unique OCR phrase';
  const ocrOnly = { ...vision, readableText: ['unique OCR phrase'], uncertainties: ['unique OCR phrase'] };
  rejection(() => decodeVisualDraftModel(input, ocrOnly, faces), 'anchor_quote_mismatch');
  input.m[0].a[0].q = 'red rubber tag'; input.m[0].a[0].v = 1;
  const repeated = { ...vision, scene: 'A red rubber tag is visible.' };
  rejection(() => decodeVisualDraftModel(input, repeated, faces), 'anchor_quote_mismatch');
  // Valid explicit references win; ambiguity elsewhere cannot move them.
  for (const valid of [0, 2]) {
    input.m[0].a[0].v = valid;
    assert.equal(decodeVisualDraftModel(input, repeated, faces).objects[0].anchors[0].sourceIndex, valid);
  }
});

test('model anchor repair never changes facts, owners, face slots or other source indexes', () => {
  const changes: [(w: VisualDraftWire) => void, string][] = [
    [w => { w.f[0].v = 30; }, 'unknown_source'],
    [w => { w.n[0].v = 30; }, 'unknown_source'],
    [w => { w.m[0].v = 30; }, 'unknown_source'],
    [w => { w.m[0].r = 0; }, 'object_owner_kind'],
    [w => { w.n[0].face = 1; }, 'unknown_face_slot'],
    [w => { w.n[1].face = 0; }, 'face_owner_kind'],
  ];
  for (const [change, code] of changes) {
    const input = wire(); input.m[0].a[0].v = 0; change(input);
    rejection(() => decodeVisualDraftModel(input, vision, faces), code);
  }
  const input = wire(); input.m[0].a[0].v = 0; input.f[0].v = 3;
  const result = decodeVisualDraftModel(input, vision, faces);
  assert.equal(result.facts[0].sourceIndex, 3); // Valid source indexes are never inferred from prose.
  assert.deepEqual(result.entities.map(entity => entity.faceIndex), [0, null, null]);
});

test('model decoding leaves frozen raw output and all image/face evidence untouched', () => {
  function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
    return value;
  }
  const input = wire(); input.m[0].a[0].v = 0;
  const original = freeze(input), image = freeze(structuredClone(vision)), frame = freeze(structuredClone(faces));
  const before = JSON.stringify({ original, image, frame });
  const result = decodeVisualDraftModel(original, image, frame);
  assert.equal(result.objects[0].anchors[0].sourceIndex, 2);
  assert.equal(JSON.stringify({ original, image, frame }), before);
  assert.deepEqual(result, decodeVisualDraft(wire(), vision, faces));
  const invalid: any = wire(); invalid.audio = {};
  rejection(() => decodeVisualDraftModel(invalid, vision, faces), 'wire_schema_validation');
  rejection(() => decodeVisualDraftModel(wire(), { ...vision, scene: 'x'.repeat(2001) }, faces), 'invalid_visual_sources');
});

function nestedVision(): NestedVisionModel {
  return { scene: 'A room with a desk and a tiled floor.', readableText: ['fallible reading'], uncertainties: ['The phone brand is unclear.'],
    entities: [
      { kind: 'person', label: 'Person', description: 'A person wears a shirt with a yellow sun logo.',
        confidence: 'observed', faceIndex: 0, location: null, anchors: [] },
      { kind: 'object', label: 'Phone', description: 'A phone with a chipped top-left corner is on the desk.',
        confidence: 'uncertain', faceIndex: null, location: { value: 'on the desk', confidence: 'observed' },
        anchors: [{ kind: 'damage', quote: 'chipped top-left corner' }] },
      { kind: 'object', label: 'Bins', description: 'Two lined bins stand beside the wall.',
        confidence: 'observed', faceIndex: null, location: { value: 'beside the wall', confidence: 'uncertain' }, anchors: [] },
      { kind: 'place', label: 'Floor area', description: 'The floor has gray tiles.',
        confidence: 'observed', faceIndex: null, location: null, anchors: [] },
    ] };
}

test('nested descriptions generate all owner-specific sources, facts and object rows mechanically', () => {
  const input = nestedVision(), result = decodeNestedVisionModel(input, faces);
  assert.equal(result.scene, input.scene);
  assert.deepEqual(result.observations, input.entities.map(entity => entity.description));
  assert.deepEqual(result.readableText, input.readableText); assert.deepEqual(result.uncertainties, input.uncertainties);
  assert.deepEqual(result.visualDraft.entities.map(entity => entity.descriptionSourceIndex), [1, 2, 3, 4]);
  assert.deepEqual(result.visualDraft.entities.map(entity => entity.faceIndex), [0, null, null, null]);
  const descriptors = result.visualDraft.facts.filter(fact => fact.attribute === null);
  assert.deepEqual(descriptors.map(fact => [fact.entityIndexes, fact.sourceIndex, fact.text, fact.confidence]), [
    [[0], 1, null, 'observed'], [[1], 2, null, 'uncertain'], [[2], 3, null, 'observed'], [[3], 4, null, 'observed'],
  ]);
  const locations = result.visualDraft.facts.filter(fact => fact.attribute === 'location');
  assert.deepEqual(locations, [
    { entityIndexes: [1], sourceIndex: 2, text: 'Phone: on the desk', attribute: 'location', value: 'on the desk', confidence: 'observed' },
    { entityIndexes: [2], sourceIndex: 3, text: 'Bins: beside the wall', attribute: 'location', value: 'beside the wall', confidence: 'uncertain' },
  ]);
  assert.deepEqual(result.visualDraft.objects, [
    { entityIndex: 1, sourceIndex: 2, anchors: [{ kind: 'damage', quote: 'chipped top-left corner', sourceIndex: 2 }] },
    { entityIndex: 2, sourceIndex: 3, anchors: [] },
  ]);
});

test('nested phone anchors cannot borrow a shirt marking, scene, other entity, or OCR quote', () => {
  for (const quote of ['yellow sun logo', 'gray tiles', 'fallible reading', 'a desk and a tiled floor']) {
    const input = nestedVision(); input.entities[1].anchors = [{ kind: 'distinctive_marking', quote }];
    rejection(() => decodeNestedVisionModel(input, faces), 'anchor_quote_mismatch');
  }
  const whitespace = nestedVision(); whitespace.entities[1].anchors[0].quote = 'chipped\n top-left\t corner';
  assert.equal(decodeNestedVisionModel(whitespace, faces).visualDraft.objects[0].anchors[0].sourceIndex, 2);
  const wrongCase = nestedVision(); wrongCase.entities[1].anchors[0].quote = 'Chipped top-left corner';
  rejection(() => decodeNestedVisionModel(wrongCase, faces), 'anchor_quote_mismatch');
});

test('nested paraphrased locations retain original descriptions, raw wording and supplied confidence', () => {
  const input = nestedVision();
  input.entities[0].description = 'A person occupies the left seating area.';
  input.entities[0].location = { value: 'in the left seating area', confidence: 'observed' };
  input.entities[1].location = { value: 'resting on\n the\t desktop', confidence: 'uncertain' };
  const result = decodeNestedVisionModel(input, faces);
  assert.deepEqual(result.observations, input.entities.map(entity => entity.description));
  const locations = result.visualDraft.facts.filter(fact => fact.attribute === 'location');
  assert.deepEqual(locations[0], { entityIndexes: [0], sourceIndex: 1,
    text: 'Person: in the left seating area', attribute: 'location', value: 'in the left seating area', confidence: 'observed' });
  assert.deepEqual(locations[1], { entityIndexes: [1], sourceIndex: 2,
    text: 'Phone: resting on\n the\t desktop', attribute: 'location', value: 'resting on\n the\t desktop', confidence: 'uncertain' });
  assert.equal(input.entities[1].location.value, 'resting on\n the\t desktop');
  assert.deepEqual(validateVisualDraft(result.visualDraft, result, faces), result.visualDraft);
});

test('nested neighboring entities never exchange location owners or source descriptions mechanically', () => {
  const input = nestedVision();
  input.entities[1].location = { value: 'near the bins', confidence: 'uncertain' };
  input.entities[2].location = { value: 'above the floor area', confidence: 'observed' };
  input.entities[3].location = { value: 'under the bins', confidence: 'uncertain' };
  const result = decodeNestedVisionModel(input, faces);
  const locations = result.visualDraft.facts.filter(fact => fact.attribute === 'location');
  assert.deepEqual(locations.map(fact => [fact.entityIndexes, fact.sourceIndex, fact.value, fact.confidence]), [
    [[1], 2, 'near the bins', 'uncertain'], [[2], 3, 'above the floor area', 'observed'], [[3], 4, 'under the bins', 'uncertain'],
  ]);
  for (const location of locations) {
    const owner = location.entityIndexes[0];
    assert.equal(result.observations[location.sourceIndex - 1], input.entities[owner].description);
    assert.equal(location.text, `${input.entities[owner].label}: ${input.entities[owner].location!.value}`);
  }
});

test('nested provider unions prohibit nonobject anchors and nonperson face slots', () => {
  const schema = z.toJSONSchema(NestedVisionModelSchema) as any;
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  const variants = schema.properties.entities.items.anyOf;
  assert.equal(variants.length, 3);
  for (const variant of variants) {
    assert.equal(variant.additionalProperties, false);
    assert.deepEqual([...variant.required].sort(), ['anchors', 'confidence', 'description', 'faceIndex', 'kind', 'label', 'location']);
    const kind = variant.properties.kind.const;
    assert.equal(variant.properties.anchors.maxItems, kind === 'object' ? 6 : 0);
    if (kind !== 'person') assert.equal(variant.properties.faceIndex.type, 'null');
  }
  for (const index of [0, 3]) {
    const input = nestedVision(); input.entities[index].anchors = [{ kind: 'generic', quote: 'gray tiles' }];
    rejection(() => decodeNestedVisionModel(input, faces), 'nested_schema_validation');
  }
  for (const index of [1, 3]) {
    const input = nestedVision(); input.entities[index].faceIndex = 0;
    rejection(() => decodeNestedVisionModel(input, faces), 'nested_schema_validation');
  }
});

test('nested expansion preserves all 30 descriptions and 60 facts without expanding legacy provider limits', () => {
  const input: NestedVisionModel = { scene: 'x'.repeat(2000), readableText: [], uncertainties: [],
    entities: Array.from({ length: 30 }, (_, index) => ({ kind: 'object', label: `Object ${index}`,
      description: `Object ${index} is on the table. `.padEnd(1500, 'x'), confidence: 'observed', faceIndex: null,
      location: { value: 'on the table', confidence: 'uncertain' }, anchors: [] })) };
  const result = decodeNestedVisionModel(input, faces);
  assert.equal(result.scene.length, 2000); assert.equal(result.observations.length, 30);
  assert.ok(result.observations.every(description => description.length === 1500));
  assert.equal(result.visualDraft.entities.length, 30); assert.equal(result.visualDraft.facts.length, 60);
  assert.equal(result.visualDraft.objects.length, 30);
  assert.equal(result.visualDraft.facts.at(-1)!.sourceIndex, 30);
  assert.deepEqual(result.visualDraft.facts.at(-1)!.entityIndexes, [29]);
  assert.deepEqual(validateVisualDraft(result.visualDraft, result, faces), result.visualDraft);
  const tooMany = structuredClone(result.visualDraft); tooMany.facts.push(structuredClone(tooMany.facts[0]));
  assert.equal(VisualDraftSchema.safeParse(tooMany).success, false);
  const legacy = wire(); legacy.f = Array.from({ length: 41 }, () => legacy.f[0]);
  assert.equal(VisualDraftWireSchema.safeParse(legacy).success, false);
  assert.equal(VisualDraftModelWireSchema.safeParse(legacy).success, false);
});

test('nested input bounds and fields reject excess or blank evidence instead of truncating', () => {
  const changes: ((input: any) => void)[] = [
    input => { input.scene = 'x'.repeat(2001); }, input => { input.entities[0].description = 'x'.repeat(1501); },
    input => { input.entities[0].description = ' \n\t '; }, input => { input.entities[0].label = 'x'.repeat(201); },
    input => { input.entities[1].location.value = ' '; }, input => { input.entities[1].location.value = 'x'.repeat(1001); },
    input => { input.entities[1].anchors[0].quote = ' '; }, input => { input.entities[1].anchors[0].quote = 'x'.repeat(1001); },
    input => { input.entities[1].anchors = Array.from({ length: 7 }, () => input.entities[1].anchors[0]); },
    input => { input.entities = Array.from({ length: 31 }, () => input.entities[0]); },
    input => { input.readableText = Array.from({ length: 21 }, () => 'text'); },
    input => { input.readableText = ['x'.repeat(1001)]; }, input => { input.uncertainties = ['x'.repeat(1001)]; },
    input => { input.uncertainties = Array.from({ length: 11 }, () => 'unknown'); },
    input => { input.entities[0].kind = 'event'; }, input => { input.entities[0].confidence = 'reported'; },
    input => { input.entities[0].existingId = 'old-person'; }, input => { input.entities[0].sourceIndex = 2; },
    input => { input.entities[1].anchors[0].sourceIndex = 1; }, input => { input.entities[1].location.owner = 0; },
    input => { input.audio = {}; }, input => { input.observations = []; },
  ];
  for (const change of changes) {
    const input = nestedVision(); change(input);
    rejection(() => decodeNestedVisionModel(input, faces), 'nested_schema_validation');
  }
  assert.deepEqual(decodeNestedVisionModel({ scene: '', entities: [], readableText: [], uncertainties: [] }, faces),
    { scene: '', observations: [], readableText: [], uncertainties: [], visualDraft: { entities: [], facts: [], objects: [] } });
});

test('nested face associations still require existing same-image slots and valid unique geometry', () => {
  const absent = nestedVision(); absent.entities[0].faceIndex = 1;
  rejection(() => decodeNestedVisionModel(absent, faces), 'unknown_face_slot');
  rejection(() => decodeNestedVisionModel(nestedVision(), { ...faces, status: 'unavailable' }), 'unknown_face_slot');
  const duplicate = nestedVision(); duplicate.entities.push(structuredClone(duplicate.entities[0]));
  rejection(() => decodeNestedVisionModel(duplicate, faces), 'duplicate_face_slot');
  const badBox = structuredClone(faces); badBox.faces[0].box[2] = 641;
  rejection(() => decodeNestedVisionModel(nestedVision(), badBox), 'invalid_face_geometry');
  const anonymous = nestedVision(); anonymous.entities[0].faceIndex = null;
  assert.equal(decodeNestedVisionModel(anonymous, { ...faces, status: 'unavailable', faces: [] }).visualDraft.entities[0].faceIndex, null);
});

test('nested expansion survives persisted correction validation and never mutates provider or face evidence', () => {
  function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
    return value;
  }
  const input = freeze(nestedVision()), frame = freeze(structuredClone(faces));
  const before = JSON.stringify({ input, frame });
  const result = decodeNestedVisionModel(input, frame);
  const capture = { id: faces.frameId, capturedAt: faces.capturedAt, sha256: 'original-image-hash', faces: frame };
  const persisted = JSON.parse(JSON.stringify(result));
  assert.deepEqual(checkedVision(persisted, capture), result);
  // A correction reuses the exact same stored Vision and capture time, without new image interpretation.
  assert.deepEqual(checkedVision(JSON.parse(JSON.stringify(persisted)), capture), result);
  assert.deepEqual(validateVisualDraft(persisted.visualDraft, persisted, frame), result.visualDraft);
  assert.throws(() => checkedVision(persisted, { ...capture, id: 'another-capture' }), /matching capture face evidence/);
  assert.equal(JSON.stringify({ input, frame }), before);
  // The old stored shape remains valid; this adapter does not replace legacy decoding.
  assert.deepEqual(validateVisualDraft(decodeVisualDraft(wire(), vision, faces), vision, faces), decodeVisualDraft(wire(), vision, faces));
});
