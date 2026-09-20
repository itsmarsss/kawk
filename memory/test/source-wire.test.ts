import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { createInterpreter, type CodexRunner, type ModelTiming } from '../src/interpreter.js';
import { decodeSourceBatch, sourceUpdatePrompt, SourceModelBatchSchema, type SourceBatch } from '../src/source-wire.js';
import type { ObjectAnchor } from '../src/object-identity.js';
import { Store } from '../src/store.js';
import { transcriptKey, type CaptureRecord, type Entity, type MemoryContext, type Packet, type Transcript } from '../src/contracts.js';

const state = { location: null, activity: null, summary: '', uncertainties: [] };
const context: MemoryContext = { state: { ...state, version: 0, observedAt: 0, packetId: null }, entities: [], related: [] };
function speech(segmentId: string, text: string, startAt: number, endAt: number, isFinal = true): Transcript {
  return { sessionId: 'quality', streamId: 'quality-speech', segmentId, text, startAt, endAt,
    isFinal, revision: 1, receivedAt: endAt + 1, words: [], speakerId: null, timing: 'approximate' };
}
const lecture = speech('lecture', 'The derivative of x squared is two x.', 2000, 4000);
const personal = speech('personal', 'Bob is visiting Toronto this weekend and enjoys hiking.', 6000, 9000);
const partial = speech('partial', 'Alice hates hiking', 9300, 9900, false);
const ending = speech('ending', 'The calculus workshop has ended. We will meet again next week.', 17000, 19500);
const keysSource = 'A brass keyring with the same distinctive red tag is visible on top of a blue backpack beside the wooden desk.';
function packet(index = 0): Packet {
  const id = `quality-${index}`, capturedAt = (index + 1) * 5000, bob = index < 2;
  const segments = index === 0 ? [lecture] : index < 3 ? [lecture, personal, partial] : [lecture, personal, ending];
  return { id, version: 1, sessionId: 'quality', sequence: index + 1, capturedAt,
    imagePath: '/private/not-in-prompt.jpg', sha256: 'a'.repeat(64), createdAt: capturedAt + 10, correction: false,
    faces: { frameId: id, streamId: 'faces', capturedAt, status: 'ready', width: 640, height: 480,
      faces: [{ trackId: bob ? 'bob-track' : 'alice-track', personId: bob ? 'bob-gallery' : 'alice-gallery',
        name: bob ? 'Bob' : 'Alice', identityStatus: 'confirmed', similarity: .8, box: [10, 10, 100, 100] }] },
    vision: { scene: 'The same lecture room with whiteboard, wooden tables and green chairs.',
      observations: [keysSource, bob ? 'One person is seated facing the whiteboard.' : 'One person stands beside the whiteboard.'],
      readableText: [], uncertainties: ['A still image does not establish how the keys reached the backpack or who is speaking.'] },
    audio: { text: segments.map(t => t.text).join(' '), wordCount: 30, segments, status: 'live', throughAt: capturedAt,
      contexts: segments.filter(t => t.isFinal).map(t => ({ transcriptKey: transcriptKey(t),
        captureIds: [t === lecture ? 'quality-prior' : t === personal ? 'quality-0' : 'quality-2'],
        personIds: [t === ending ? 'alice-gallery' : 'bob-gallery'], ambiguous: false })) } };
}
function known(id: string, kind: Entity['kind'], label: string, personId: string | null = null): Entity {
  return { id, kind, label, personId, description: `${label} already known`, createdAt: 1000, lastSeenAt: 1000, attributes: {} };
}
function qualityContext(): MemoryContext {
  return { ...context, entities: [known('keys', 'object', 'Brass keys'), known('bob-gallery', 'person', 'Bob', 'bob-gallery'),
    known('class', 'event', 'Calculus workshop'), known('room', 'place', 'Lecture room'),
    known('alice-gallery', 'person', 'Alice', 'alice-gallery')] };
}
function wire(count = 1): SourceBatch {
  return { rows: Array.from({ length: count }, (_, i) => ({ i, s: { ...state }, n: [], f: [], e: [], m: [] })) };
}
function fact(source = 'v1', references = ['e0']): SourceBatch['rows'][number]['f'][number] {
  return { r: references, src: source, t: null, a: null, v: null, c: source.startsWith('v') ? 'observed' : 'reported' };
}
const newObject = { r: 'n0', k: 'object' as const, l: 'Brass keys', d: null, dv: 'v1' };
function events(value: unknown): string {
  return [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }].map(value => JSON.stringify(value)).join('\n');
}
const runner = (value: unknown): CodexRunner => async () => ({ stdout: events(value), durationMs: 1 });

test('source decoder copies exact visual/final evidence and preserves known metadata', () => {
  const input = wire(); input.rows[0].f = [fact(), fact('t0', ['e2'])];
  const before = qualityContext();
  const result = decodeSourceBatch(input, [packet()], before).updates[0];
  assert.equal(result.packetId, 'quality-0'); assert.equal(result.packetVersion, 1);
  assert.equal(result.delta.facts[0].text, keysSource);
  assert.equal(result.delta.facts[1].text, lecture.text);
  assert.deepEqual(result.delta.facts[1].transcriptKeys, [transcriptKey(lecture)]);
  assert.equal(result.delta.facts[1].visual, false);
  assert.deepEqual(result.delta.entities[0], { ref: 'e0', existingId: 'keys', kind: 'object', label: 'Brass keys',
    description: 'Brass keys already known', personId: null });
  assert.deepEqual(before, qualityContext());
  input.rows[0].f[0].t = 'A precise shorter claim.';
  assert.equal(decodeSourceBatch(input, [packet()], before).updates[0].delta.facts[0].text, 'A precise shorter claim.');
});

test('OCR has distinct uncertain sources and high reader confidence cannot promote it to an observed attribute', () => {
  const p = packet();
  p.vision.readableText = ['Room 44 – The Grounds'];
  p.vision.textEvidence = { frameId: p.id, capturedAt: p.capturedAt, sha256: p.sha256,
    engine: 'apple-vision', revision: 3, status: 'ready', durationMs: 100, error: null,
    lines: [{ box: [.1, .2, .3, .1], candidates: [{ text: 'Room 4A – The Grasslands', confidence: 1 }] }] };
  const input = wire();
  input.rows[0].f = ['o0', 'o1'].map(src => ({ ...fact(src, ['e3']), c: 'observed', a: 'name', v: 'Unverified name' }));
  const result = decodeSourceBatch(input, [p], qualityContext()).updates[0].delta;
  assert.deepEqual(result.facts.map(f => f.text), ['Room 44 – The Grounds', 'Room 4A – The Grasslands']);
  assert.ok(result.facts.every(f => f.visual && f.confidence === 'uncertain'));
  const prompt = sourceUpdatePrompt([p], qualityContext());
  const data = JSON.parse(prompt.split('Evidence JSON:\n')[1]);
  assert.deepEqual(Object.values(data.packets[0].v), [p.vision.scene, ...p.vision.observations]);
  assert.equal(data.packets[0].o.o1.score, 1);
  input.rows[0].f[0].src = 'o999';
  assert.throws(() => decodeSourceBatch(input, [p], qualityContext()), /source_unknown_evidence/);
  input.rows[0].f[0].src = 'v3';
  assert.throws(() => decodeSourceBatch(input, [p], qualityContext()), /source_unknown_evidence/);
});

test('new source descriptions and backward reuse survive even an empty-fact declaration row', async () => {
  const input = wire(3); input.rows[0].n = [newObject]; input.rows[2].f = [fact('v1', ['n0'])];
  const packets = [packet(0), packet(1), packet(2)];
  const result = await createInterpreter({ updateFormat: 'source', runner: runner(input) }).updateBatch!(packets, context);
  assert.equal(result.updates[0].delta.entities[0].description, keysSource);
  assert.equal(result.updates[0].delta.entities[0].personId, null);
  assert.deepEqual(result.updates[2].reuse, [{ ref: 'n0', fromPacketId: 'quality-0', fromRef: 'n0' }]);
  assert.equal(result.updates[2].delta.entities[0].existingId, null);
});

test('source object evidence retains exact anchor references across backward batch reuse', async () => {
  const packets = [packet(), packet(1)], input = wire(2);
  input.rows[0].n = [newObject];
  input.rows[0].m = [{ ref: 'n0', sourceIndex: 1, quote: keysSource,
    anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'distinctive red tag' }], match: null }];
  input.rows[1].f = [fact('v1', ['n0'])];
  input.rows[1].m = [{ ref: 'n0', sourceIndex: 1, quote: keysSource, anchors: [],
    match: { assessment: 'same_instance', anchors: [{ anchor: { packetId: packets[0].id, ref: 'n0', index: 0 },
      sourceIndex: 1, quote: 'distinctive red tag' }], conflictingDetails: [], competingEntityIds: [] } }];
  const result = decodeSourceBatch(input, packets, context);
  assert.deepEqual(result.updates[1].delta.objectEvidence, input.rows[1].m);
  assert.deepEqual(result.updates[1].reuse, [{ ref: 'n0', fromPacketId: packets[0].id, fromRef: 'n0' }]);
  input.rows[0].m!.push(input.rows[0].m![0]);
  assert.throws(() => decodeSourceBatch(input, packets, context), /source_duplicate_object_evidence/);
});

test('object evidence cannot bind a person or undeclared entity through source aliases', async () => {
  const input = wire(); input.rows[0].m = [{ r: 'e1', src: 'v1', a: [], match: null }];
  await assert.rejects(createInterpreter({ updateFormat: 'source', runner: runner(input) }).update(packet(), qualityContext()), /source_invalid_object_ref/);
  input.rows[0].m = [{ r: 'e999', src: 'v1', a: [], match: null }];
  assert.throws(() => decodeSourceBatch(input, [packet()], qualityContext()), /source_unknown_entity/);
});

test('reject null/incomplete states, row omissions, duplicate rows and unknown fields', () => {
  const invalid = [
    { rows: [{ ...wire().rows[0], s: null }] },
    { rows: [{ ...wire().rows[0], s: { summary: 'Missing fields' } }] },
    wire(), { rows: [wire().rows[0], wire().rows[0]] },
    { rows: [{ ...wire().rows[0], surprise: true }, wire(2).rows[1]] },
  ];
  for (const value of invalid) assert.throws(() => decodeSourceBatch(value, [packet(0), packet(1)], context), /source_(schema_validation|row_count|row_order)/);
  const cleared = decodeSourceBatch(wire(), [packet()], { ...context, state: { ...context.state, location: 'old', activity: 'ongoing' } });
  assert.equal(cleared.updates[0].delta.state.location, null); assert.equal(cleared.updates[0].delta.state.activity, null);
});

test('reject forward, unknown, redeclared aliases and gallery identity injection', () => {
  const unknown = wire(); unknown.rows[0].f = [fact('v1', ['e99'])];
  assert.throws(() => decodeSourceBatch(unknown, [packet()], context), /source_unknown_entity/);
  const forward = wire(2); forward.rows[0].f = [fact('v1', ['n0'])]; forward.rows[1].n = [newObject];
  assert.throws(() => decodeSourceBatch(forward, [packet(), packet(1)], context), /source_unknown_entity/);
  const repeated = wire(2); repeated.rows.forEach(row => { row.n = [newObject]; });
  assert.throws(() => decodeSourceBatch(repeated, [packet(), packet(1)], context), /source_entity_redeclared/);
  const injected = wire(); injected.rows[0].n = [{ ...newObject, k: 'person', personId: 'invented-gallery' } as unknown as typeof newObject];
  assert.throws(() => decodeSourceBatch(injected, [packet()], context), /source_schema_validation/);
  injected.rows[0].n = [{ ...newObject, k: 'person' }];
  assert.equal(decodeSourceBatch(injected, [packet()], context).updates[0].delta.entities[0].personId, null);
});

test('source aliases are row-local, finalized only and cannot promote speech to observed', () => {
  for (const source of ['v99', 't1']) {
    const value = wire(); value.rows[0].f = [fact(source, [])];
    assert.throws(() => decodeSourceBatch(value, [packet()], context), /source_unknown_evidence/);
  }
  const partialReference = wire(); partialReference.rows[0].f = [fact('t2', [])];
  assert.throws(() => decodeSourceBatch(partialReference, [packet(1)], context), /source_unknown_evidence/);
  const observedSpeech = wire(); observedSpeech.rows[0].f = [{ ...fact('t0', []), c: 'observed' }];
  assert.throws(() => decodeSourceBatch(observedSpeech, [packet()], context), /source_speech_as_observed/);
});

test('typed changes have one owner, matching attribute/value and no duplicate owners', () => {
  const cases = [
    { ...fact('v1', ['e0', 'e3']), a: 'location', v: 'backpack' },
    { ...fact(), a: 'location', v: null }, { ...fact(), a: null, v: 'backpack' },
    fact('v1', ['e0', 'e0']),
  ];
  for (const value of cases) {
    const input = wire(); input.rows[0].f = [value];
    assert.throws(() => decodeSourceBatch(input, [packet()], qualityContext()), /source_(attribute_owner|attribute_pair|duplicate_fact_entity)/);
  }
  const relation = wire(); relation.rows[0].f = [fact('v1', ['e0', 'e3'])];
  assert.equal(decodeSourceBatch(relation, [packet()], qualityContext()).updates[0].delta.facts[0].entityRefs.length, 2);
});

test('descriptions choose one valid visual source; oversized copies reject without truncation', () => {
  for (const declaration of [{ ...newObject, d: 'also set' }, { ...newObject, dv: null }, { ...newObject, dv: 'v99' }]) {
    const input = wire(); input.rows[0].n = [declaration];
    assert.throws(() => decodeSourceBatch(input, [packet()], context), /source_(description_conflict|unknown_description)/);
  }
  const longVisual = packet(); longVisual.vision.observations[0] = 'x'.repeat(1501);
  const description = wire(); description.rows[0].n = [newObject];
  assert.throws(() => decodeSourceBatch(description, [longVisual], context), /source_expanded_schema/);
  const longSpeech = packet(); longSpeech.audio.segments = [{ ...lecture, text: 'x'.repeat(2001) }];
  const input = wire(); input.rows[0].f = [fact('t0', [])];
  assert.throws(() => decodeSourceBatch(input, [longSpeech], context), /source_expanded_schema/);
  input.rows[0].f[0].t = 'A faithful concise paraphrase.';
  assert.equal(decodeSourceBatch(input, [longSpeech], context).updates[0].delta.facts[0].text, input.rows[0].f[0].t);
});

test('packet bounds/order/session and duplicate initial identities reject before provider calls', () => {
  const cases = [[], [packet(), packet()], [packet(1), packet()], Array.from({ length: 5 }, (_, i) => packet(i)),
    [packet(), { ...packet(1), sessionId: 'different' }]];
  for (const packets of cases) assert.throws(() => sourceUpdatePrompt(packets, context), /source_/);
  const duplicate = qualityContext(); duplicate.entities.push({ ...duplicate.entities[0] });
  assert.throws(() => sourceUpdatePrompt([packet()], duplicate), /source_duplicate_identity/);
  duplicate.entities[5].id = 'other'; duplicate.entities[5].personId = 'bob-gallery';
  assert.throws(() => sourceUpdatePrompt([packet()], duplicate), /source_duplicate_person/);
});

test('source adapter invokes one safe schema call, withholds partial text and labels timing', async () => {
  const packets = [packet(), packet(1)], input = wire(2), timings: ModelTiming[] = []; let calls = 0;
  const model = createInterpreter({ env: {}, updateFormat: 'source', onTiming: timing => timings.push(timing), runner: async request => {
    calls++; assert.equal(request.timeoutMs, 90000); assert.ok(!request.args.includes('-i'));
    for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(request.args.includes(flag));
    assert.ok(!request.stdin.includes(partial.text)); assert.ok(!request.stdin.includes('/private/'));
    assert.match(request.stdin, /"pendingSpeech":\[\{"startAt":9300,"endAt":9900\}\]/);
    assert.match(request.stdin, /"transcriptKey":"quality-speech\/personal@1"/);
    assert.match(request.stdin, /1500 characters/); assert.match(request.stdin, /2000 characters/);
    const schema = JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema') + 1], 'utf8'));
    assert.equal(schema.properties.rows.maxItems, 4); assert.equal(schema.properties.updates, undefined);
    return { stdout: events(input), durationMs: 1 };
  } });
  assert.deepEqual(await model.updateBatch!(packets, qualityContext()), decodeSourceBatch(input, packets, qualityContext()));
  assert.equal(calls, 1); assert.equal(timings[0].updateFormat, 'source'); assert.equal(timings[0].success, true);
  const single = await createInterpreter({ updateFormat: 'source', runner: runner(wire()) }).update(packet(), context);
  assert.deepEqual(single, decodeSourceBatch(wire(), [packet()], context).updates[0].delta);
});

test('source adapter retains canonical person-context and event-kind checks with sanitized errors', async () => {
  const input = wire(); input.rows[0].f = [fact('t1', ['e4'])];
  const timings: ModelTiming[] = [];
  const model = createInterpreter({ updateFormat: 'source', runner: runner(input), onTiming: timing => timings.push(timing) });
  await assert.rejects(model.update(packet(2), qualityContext()), /person_speech_context_mismatch/);
  assert.equal(timings[0].updateFormat, 'source'); assert.equal(timings[0].success, false);
  input.rows[0].f[0].r = ['e1'];
  assert.equal((await model.update(packet(2), qualityContext())).facts[0].text, personal.text);
  input.rows[0].f = []; input.rows[0].e = [{ r: 'e0', status: 'ended', summary: 'bad object event' }];
  await assert.rejects(model.update(packet(), qualityContext()), /invalid_event_ref/);
  input.rows[0].e = []; input.rows[0].f = [fact('v99', [])];
  await assert.rejects(model.update(packet(), qualityContext()), error => error instanceof Error &&
    error.message.endsWith('source_unknown_evidence') && !error.message.includes('v99'));
});

test('source updates use the same Responses transport and canonical remains the default', async () => {
  const input = wire(), timings: ModelTiming[] = [];
  const model = createInterpreter({ provider: 'responses', model: 'test-model', updateFormat: 'source',
    env: { OPENAI_API_KEY: 'test-only' }, onTiming: timing => timings.push(timing), fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); assert.equal(body.tools.length, 0); assert.equal(body.store, false);
      assert.equal(body.text.format.schema.properties.rows.maxItems, 4);
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(input) }] }] });
    } });
  assert.deepEqual(await model.update(packet(), context), decodeSourceBatch(input, [packet()], context).updates[0].delta);
  assert.equal(timings[0].updateFormat, 'source'); assert.ok(!JSON.stringify(timings).includes('test-only'));
  const canonical = { state, entities: [], facts: [], events: [], objectEvidence: [] };
  await createInterpreter({ env: {}, runner: runner(canonical), onTiming: timing => timings.push(timing) }).update(packet(), context);
  assert.equal(timings[1].updateFormat, 'canonical');
});

// Exact wire output from the second bounded real Terra source-reference probe.
// Input speech/scene was synthetic. This replay makes no provider call and checks
// decoder + canonical guards + storage, not live model quality or measured latency.
function recordedProbe(): SourceBatch {
  const uncertainty = ['Still image does not establish how keys reached the backpack or who is speaking.'];
  const snapshots = [
    'Bob is seated facing the whiteboard; keys are on a blue backpack beside the desk.',
    'Bob is seated facing the whiteboard.', 'Alice is standing beside the whiteboard.',
    'Alice is standing beside the whiteboard; the calculus workshop was reported ended.',
  ];
  const output = wire(4);
  output.rows.forEach((row, i) => { row.s = { location: 'Lecture room', activity: i < 3 ? 'Calculus workshop ongoing' : null,
    summary: snapshots[i], uncertainties: uncertainty }; });
  output.rows[0].f = [
    { r: ['e0'], src: 'v1', t: null, a: 'location', v: 'on a blue backpack beside the wooden desk', c: 'observed' },
    { r: ['e2'], src: 't0', t: null, a: 'derivative rule', v: lecture.text, c: 'reported' },
  ];
  output.rows[1].f = [{ r: ['e1'], src: 't1', t: null, a: 'weekend plan', v: 'visiting Toronto this weekend and enjoys hiking', c: 'reported' }];
  output.rows[3].e = [{ r: 'e2', status: 'ended', summary: 'Calculus workshop reported ended; meeting again next week.' }];
  return output;
}
function insertCapture(store: Store, p: Packet): void {
  const c: CaptureRecord = { id: p.id, sessionId: p.sessionId, sequence: p.sequence, capturedAt: p.capturedAt,
    width: 640, height: 480, faces: p.faces, audioStatus: p.audio.status, imagePath: p.imagePath,
    sha256: p.sha256, receivedAt: p.capturedAt + 1, status: 'ready', error: null, vision: p.vision };
  store.insertCapture(c);
}

test('legacy real probe keeps unproven keys relocation as a candidate while preserving Bob, lecture and ending', async () => {
  const store = new Store(':memory:', 3, 'test-vectors'); store.createSession('quality', 0);
  try {
    const seed = packet(); seed.id = 'quality-prior'; seed.sequence = 0; seed.capturedAt = 1000;
    seed.faces = { ...seed.faces, frameId: seed.id, capturedAt: seed.capturedAt,
      faces: [...seed.faces.faces, ...packet(2).faces.faces] };
    seed.audio = { ...seed.audio, segments: [], contexts: [], text: '', wordCount: 0, throughAt: 1000 };
    insertCapture(store, seed);
    store.commit(seed, { state: { location: 'Lecture room', activity: 'Calculus workshop ongoing', summary: 'Class in progress', uncertainties: [] },
      entities: [qualityContext().entities[0], qualityContext().entities[2], qualityContext().entities[3]]
        .map(entity => ({ ref: entity.id, existingId: null, kind: entity.kind, label: entity.label, description: entity.description, personId: null })),
      facts: [{ entityRefs: ['keys'], text: 'Keys on the wooden desk.', attribute: 'location', value: 'wooden desk',
        visual: true, transcriptKeys: [], confidence: 'observed' }],
      events: [{ entityRef: 'class', status: 'ongoing', summary: 'Calculus workshop in progress' }] });
    const lookup = (label: string) => store.entities().find(entity => entity.label === label)!;
    const current: MemoryContext = { state: store.currentState(), related: [], entities: [lookup('Brass keys'), lookup('Bob'),
      lookup('Calculus workshop'), lookup('Lecture room'), lookup('Alice')] };
    const packets = [packet(), packet(1), packet(2), packet(3)];
    packets.forEach(p => insertCapture(store, p));
    for (const t of [lecture, personal, partial, ending]) store.saveTranscript(t);
    const batch = await createInterpreter({ updateFormat: 'source', runner: runner(recordedProbe()) }).updateBatch!(packets, current);
    assert.equal(batch.updates[3].delta.facts.length, 0);
    store.commitBatch(packets, batch);
    assert.equal(store.entity(current.entities[0].id)!.attributes.location.value, 'wooden desk');
    assert.ok(store.observations({ entityId: current.entities[0].id }).some(note =>
      note.candidateEntityIds?.includes(current.entities[0].id) && note.confidence === 'uncertain' && note.text.includes('blue backpack')));
    assert.match(store.entity('bob-gallery')!.attributes['weekend plan'].value, /Toronto.*hiking/);
    assert.equal(store.entity('alice-gallery')!.attributes['weekend plan'], undefined);
    assert.equal(store.entity(current.entities[2].id)!.attributes['derivative rule'].value, lecture.text);
    assert.equal(store.currentState().activity, null);
    assert.equal(store.events().find(event => event.entityId === current.entities[2].id)!.endAt, 20000);
    assert.match(store.history().find(row => row.packetId === 'quality-2')!.summary, /^Alice/);
    const notes = store.observations();
    assert.ok(!notes.some(note => note.text.includes(partial.text)));
    const eventNote = notes.find(note => note.text === 'Event context: Calculus workshop reported ended; meeting again next week.')!;
    assert.ok(eventNote); assert.equal(eventNote.visual, false);
    assert.ok(eventNote.entityIds.includes(current.entities[2].id));
    assert.ok(eventNote.transcriptKeys.includes(transcriptKey(ending)));
    assert.ok(notes.some(note => note.text.includes(ending.text)));
    store.putEmbedding(eventNote.id, [1, 0, 0]);
    assert.ok(store.search([1, 0, 0], { entityId: current.entities[2].id }).some(hit => hit.id === eventNote.id));
    store.saveTranscript({ ...ending, revision: 2, text: 'The workshop is still ongoing.', receivedAt: 21000 });
    assert.ok(store.observations({ includeSuperseded: true }).find(note => note.id === eventNote.id)!.superseded);
    assert.ok(!store.search([1, 0, 0], { entityId: current.entities[2].id }).some(hit => hit.id === eventNote.id));
  } finally { store.close(); }
});

type CompactEvidence = z.infer<typeof SourceModelBatchSchema>['rows'][number]['m'][number];
function compactMatch(): CompactEvidence {
  return { r: 'e0', src: 'v1', a: [], match: { assessment: 'same_instance',
    anchors: [{ anchor: 'a0', src: 'v1', q: 'distinctive red tag' }], conflicts: [], competitors: [] } };
}
function anchoredContext(overrides: Partial<ObjectAnchor> = {}): MemoryContext {
  const value = qualityContext(); value.entities[0].identityAnchors = [{ id: 'persisted-tag', entityId: 'keys',
    packetId: 'prior', packetVersion: 1, ref: 'old-keys', index: 0, sourceIndex: 1,
    kind: 'attached_item', quote: 'distinctive red tag', observedAt: 1000, active: true, ...overrides }];
  return value;
}
function compactWire(evidence = compactMatch()): SourceBatch {
  const value = wire(); value.rows[0].m = [evidence]; return value;
}

test('compact identity evidence restores exactly the readable canonical contract; legacy remains readable', () => {
  const current = anchoredContext(), compact = compactWire();
  const legacy = wire(); legacy.rows[0].m = [{ ref: 'e0', sourceIndex: 1, quote: keysSource, anchors: [],
    match: { assessment: 'same_instance', anchors: [{ anchor: { id: 'persisted-tag' }, sourceIndex: 1, quote: 'distinctive red tag' }],
      conflictingDetails: [], competingEntityIds: [] } }];
  assert.deepEqual(decodeSourceBatch(compact, [packet()], current), decodeSourceBatch(legacy, [packet()], current));
  assert.equal(SourceModelBatchSchema.safeParse(compact).success, true);
  assert.equal(SourceModelBatchSchema.safeParse(legacy).success, false); // New provider emits only the compact wire.
  const prompt = sourceUpdatePrompt([packet()], current);
  assert.match(prompt, /"anchorRefs":\["a0"\]/);
  assert.match(prompt, /"priorAnchors":\{"a0":\{"owner":"e0"/);
  assert.ok(!prompt.includes('persisted-tag')); // Long anchor IDs belong to the host mapping.
});

test('compact aliases reject unknown, wrong-owner, inactive and non-earlier prior anchors', () => {
  const unknown = compactMatch(); unknown.match!.anchors[0].anchor = 'a999';
  assert.throws(() => decodeSourceBatch(compactWire(unknown), [packet()], anchoredContext()), /source_unknown_anchor/);
  const other = anchoredContext(); other.entities.push({ ...other.entities[0], id: 'other-keys', identityAnchors: [] });
  const wrongOwner = compactMatch(); wrongOwner.r = 'e5';
  assert.throws(() => decodeSourceBatch(compactWire(wrongOwner), [packet()], other), /source_anchor_owner_mismatch/);
  assert.throws(() => decodeSourceBatch(compactWire(), [packet()], anchoredContext({ active: false })), /source_inactive_anchor/);
  for (const override of [{ observedAt: 5000 }, { observedAt: 6000 }, { packetId: packet().id }])
    assert.throws(() => decodeSourceBatch(compactWire(), [packet()], anchoredContext(override)), /source_non_earlier_anchor/);
  assert.throws(() => sourceUpdatePrompt([packet()], anchoredContext({ entityId: 'wrong' })), /source_anchor_owner_mismatch/);
});

test('compact anchors require exact visual substrings; OCR and speech are not identity sources', () => {
  const mismatch = compactMatch(); mismatch.match!.anchors[0].q = 'a blue identification tag';
  assert.throws(() => decodeSourceBatch(compactWire(mismatch), [packet()], anchoredContext()), /source_anchor_quote_mismatch/);
  mismatch.match!.anchors[0].q = 'distinctive red tag'; mismatch.match!.anchors[0].src = 'v2';
  assert.throws(() => decodeSourceBatch(compactWire(mismatch), [packet()], anchoredContext()), /source_anchor_quote_mismatch/);
  const unknown = compactMatch(); unknown.src = 'v99';
  assert.throws(() => decodeSourceBatch(compactWire(unknown), [packet()], anchoredContext()), /source_unknown_object_source/);
  for (const source of ['o0', 't0']) {
    const evidence = compactMatch(); evidence.src = source;
    assert.throws(() => decodeSourceBatch(compactWire(evidence), [packet()], anchoredContext()), /source_schema_validation/);
    evidence.src = 'v1'; evidence.match!.anchors[0].src = source;
    assert.throws(() => decodeSourceBatch(compactWire(evidence), [packet()], anchoredContext()), /source_schema_validation/);
  }
  const whitespace = compactMatch(); whitespace.match!.anchors[0].q = 'distinctive\nred tag';
  assert.equal(decodeSourceBatch(compactWire(whitespace), [packet()], anchoredContext()).updates[0].delta.objectEvidence?.[0].match?.anchors[0].quote,
    'distinctive\nred tag');
});

test('compact backward anchors preserve indices, ownership and strict earlier-row timing', () => {
  const inputs = [packet(), packet(1)], value = wire(2);
  value.rows[0].n = [newObject];
  value.rows[0].m = [{ r: 'n0', src: 'v1', a: [
    { k: 'generic', src: 'v1', q: 'brass keyring' },
    { k: 'attached_item', src: 'v1', q: 'distinctive red tag' },
  ], match: null }];
  const reuse = compactMatch(); reuse.r = 'n0'; reuse.match!.anchors[0].anchor = { i: 0, r: 'n0', n: 1 };
  value.rows[1].m = [reuse];
  const result = decodeSourceBatch(value, inputs, context);
  assert.deepEqual(result.updates[1].delta.objectEvidence?.[0].match?.anchors[0].anchor,
    { packetId: inputs[0].id, ref: 'n0', index: 1 });
  assert.deepEqual(result.updates[1].reuse, [{ ref: 'n0', fromPacketId: inputs[0].id, fromRef: 'n0' }]);
  for (const reference of [{ i: 1, r: 'n0', n: 1 }, { i: 2, r: 'n0', n: 1 }]) {
    reuse.match!.anchors[0].anchor = reference;
    assert.throws(() => decodeSourceBatch(value, inputs, context), /source_non_earlier_anchor/);
  }
  reuse.match!.anchors[0].anchor = { i: 0, r: 'n0', n: 5 };
  assert.throws(() => decodeSourceBatch(value, inputs, context), /source_unknown_anchor/);
  reuse.match!.anchors[0].anchor = { i: 0, r: 'n0', n: 1 };
  const equalTime = structuredClone(inputs); equalTime[1].capturedAt = equalTime[0].capturedAt;
  assert.throws(() => decodeSourceBatch(value, equalTime, context), /source_non_earlier_anchor/);
  value.rows[1].n = [{ ...newObject, r: 'n1' }]; reuse.r = 'n1';
  assert.throws(() => decodeSourceBatch(value, inputs, context), /source_anchor_owner_mismatch/);
});

test('compact conflicts and competing aliases expand without suppressing ambiguity', () => {
  const current = anchoredContext(); current.entities.push({ ...current.entities[0], id: 'other-keys', identityAnchors: [] });
  const evidence = compactMatch(); evidence.match!.conflicts = ['Different tag shape']; evidence.match!.competitors = ['e5'];
  const expanded = decodeSourceBatch(compactWire(evidence), [packet()], current).updates[0].delta.objectEvidence![0];
  assert.deepEqual(expanded.match!.conflictingDetails, ['Different tag shape']);
  assert.deepEqual(expanded.match!.competingEntityIds, ['other-keys']);
  evidence.match!.competitors = ['e99'];
  assert.throws(() => decodeSourceBatch(compactWire(evidence), [packet()], current), /source_unknown_competitor/);
  evidence.match!.competitors = ['e1']; // Gallery person cannot become an object competitor.
  assert.throws(() => decodeSourceBatch(compactWire(evidence), [packet()], current), /source_unknown_competitor/);
});

test('compact model response commits real anchored relocation through canonical and Store gates', async () => {
  const store = new Store(':memory:', 3, 'test-vectors'); store.createSession('quality', 0);
  try {
    const first = packet(); first.audio = { ...first.audio, segments: [], contexts: [], text: '', wordCount: 0 };
    first.vision.observations[0] = 'The brass keyring with a distinctive red tag is on the wooden desk.';
    insertCapture(store, first);
    const initial = wire(); initial.rows[0].n = [newObject];
    initial.rows[0].f = [{ ...fact('v1', ['n0']), a: 'location', v: 'wooden desk' }];
    initial.rows[0].m = [{ r: 'n0', src: 'v1', a: [{ k: 'attached_item', src: 'v1', q: 'distinctive red tag' }], match: null }];
    store.commit(first, await createInterpreter({ updateFormat: 'source', runner: runner(initial) }).update(first, context));
    const keys = store.entities().find(entity => entity.kind === 'object')!;
    assert.equal(keys.identityAnchors?.[0].quote, 'distinctive red tag');
    const next = packet(1); next.audio = { ...next.audio, segments: [], contexts: [], text: '', wordCount: 0 };
    insertCapture(store, next);
    const current: MemoryContext = { state: store.currentState(), entities: [keys], related: [] };
    const moved = compactWire(); moved.rows[0].f = [{ ...fact('v1'), a: 'location', v: 'blue backpack' }];
    moved.rows[0].m![0] = { ...compactMatch(), a: [{ k: 'attached_item', src: 'v1', q: 'distinctive red tag' }] };
    store.commit(next, await createInterpreter({ updateFormat: 'source', runner: runner(moved) }).update(next, current));
    assert.equal(store.entity(keys.id)!.attributes.location.value, 'blue backpack');
    assert.equal(store.objectSightings(next.id)[0].status, 'supported');
    assert.equal(store.objectSightings(next.id)[0].evidence?.quote, keysSource);
    assert.deepEqual(store.objectSightings(next.id)[0].matchedAnchorIds, [keys.identityAnchors![0].id]);
    assert.ok(store.observations({ entityId: keys.id }).some(note => note.text.includes('wooden desk') && note.packetId === first.id));
  } finally { store.close(); }
});
