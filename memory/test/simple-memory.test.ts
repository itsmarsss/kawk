import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInterpreter } from '../src/interpreter.js';
import { Store } from '../src/store.js';
import type { CaptureRecord, MemoryDelta, Packet } from '../src/contracts.js';

const notes = { scene: 'A desk beside the doorway.', observations: [
  'Brass keys with a red tag rest beside a blue mug on the desk.',
  'A phone lies screen-up beside a notebook, connected to a white cable.',
], readableText: ['Notebook: Meeting at 17:30.'], uncertainties: ['Small text on the phone is unreadable.'] };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
function fixture(id: string, at: number): { capture: CaptureRecord; packet: Packet } {
  const capture: CaptureRecord = { id, sessionId: 'session', sequence: at / 1000, capturedAt: at,
    width: 640, height: 480, faces: { frameId: id, streamId: 'faces', capturedAt: at, status: 'unavailable',
      width: 640, height: 480, faces: [] }, audioStatus: 'unavailable', imagePath: '/fixture/photo.jpg',
    sha256: createHash('sha256').update(jpeg).digest('hex'), receivedAt: at + 1,
    status: 'ready', error: null, vision: { ...notes, interpretation: 'model' } };
  return { capture, packet: { ...capture, vision: capture.vision!, version: 1, createdAt: at + 1,
    correction: false, audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: at } } };
}
function delta(existingId: string | null, location = 'desk', assessment?: 'same_instance' | 'possible'): MemoryDelta {
  return { state: { location: 'office', activity: null, summary: `Keys visible on ${location}.`, uncertainties: [] },
    entities: [{ ref: 'keys', existingId, kind: 'object', label: 'Brass keys', description: `Red-tag keys on ${location}`, personId: null }],
    facts: [{ entityRefs: ['keys'], text: `The red-tag keys are on the ${location}.`, attribute: 'location', value: location,
      visual: true, transcriptKeys: [], confidence: 'observed' }], events: [],
    objectMatches: assessment ? [{ ref: 'keys', assessment, reason: 'Red tag and brass keys match the earlier view.' }] : [] };
}
const response = (value: unknown) => Response.json({ status: 'completed', output: [{ type: 'message',
  role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('simple Responses observation sends the exact image and face context once and retains detailed AI notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-simple-')); const { capture } = fixture('image', 1000);
  capture.imagePath = join(dir, 'image.jpg'); await writeFile(capture.imagePath, jpeg); let requests = 0;
  try {
    const interpreter = createInterpreter({ provider: 'responses', model: 'fixture-model', updateFormat: 'simple',
      env: { OPENAI_API_KEY: 'fixture-only' }, fetch: async (_url, init) => {
        requests++; const body = JSON.parse(String(init?.body));
        assert.equal(body.store, false); assert.deepEqual(body.reasoning, { effort: 'none' });
        assert.equal(body.text.verbosity, 'high'); assert.equal(body.max_output_tokens, 12000);
        const [prompt, image] = body.input[0].content;
        assert.match(prompt.text, /ordinary details|Ordinary details/); assert.match(prompt.text, /Read visible text yourself/);
        assert.ok(prompt.text.endsWith(JSON.stringify(capture.faces))); assert.ok(!prompt.text.includes(capture.imagePath));
        assert.equal(image.detail, 'high'); assert.equal(image.image_url, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
        assert.deepEqual(Object.keys(body.text.format.schema.properties).sort(), ['observations', 'readableText', 'scene', 'uncertainties']);
        return response(notes);
      } });
    assert.deepEqual(await interpreter.observe(capture), { ...notes, interpretation: 'model' });
    assert.equal(requests, 1);
    await assert.rejects(interpreter.observe({ ...capture, faces: { ...capture.faces, frameId: 'another-photo' } }), /face_packet_mismatch/);
    assert.equal(requests, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('simple writer gets complete notes but no withheld partial words or experimental identity anchors', async () => {
  const { packet } = fixture('photo', 1000); const store = new Store(':memory:', 3, 'test-vector');
  try {
    packet.audio = { ...packet.audio, text: 'PARTIAL_SHOULD_NOT_BE_SENT', wordCount: 1, status: 'live',
      segments: [{ sessionId: 'session', streamId: 'speech', segmentId: 'segment', revision: 1,
        text: 'PARTIAL_SHOULD_NOT_BE_SENT', isFinal: false, startAt: 100, endAt: 900, receivedAt: 950,
        words: [], speakerId: null, timing: 'approximate' }] };
    const context = { state: store.currentState(), entities: [{ id: 'old-keys', kind: 'object' as const,
      label: 'Keys', description: 'Red-tag keys', personId: null, createdAt: 100, lastSeenAt: 100,
      attributes: {}, identityAnchors: [] }], related: [] };
    const interpreter = createInterpreter({ provider: 'responses', model: 'fixture-model', updateFormat: 'simple',
      env: { OPENAI_API_KEY: 'fixture-only' }, fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)), prompt = body.input[0].content[0].text;
        for (const text of [notes.scene, ...notes.observations, ...notes.readableText]) assert.ok(prompt.includes(text));
        assert.doesNotMatch(prompt, /PARTIAL_SHOULD_NOT_BE_SENT|identityAnchors/);
        assert.match(prompt, /PARTIAL: text withheld until final/);
        assert.ok(body.text.format.schema.required.includes('objectMatches'));
        assert.ok(!body.text.format.schema.properties.objectEvidence);
        return response(delta('old-keys', 'backpack', 'same_instance'));
      } });
    assert.deepEqual(await interpreter.update(packet, context), delta('old-keys', 'backpack', 'same_instance'));
  } finally { store.close(); }
});

test('AI-assessed continuity updates the same object and preserves raw notes, location history and assessment on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-simple-store-')); const db = join(dir, 'memory.sqlite');
  let store = new Store(db, 3, 'test-vector'); store.createSession('session', 0);
  try {
    const first = fixture('first', 1000); store.insertCapture(first.capture); store.commit(first.packet, delta(null));
    const id = store.entities()[0].id;
    const second = fixture('second', 2000); store.insertCapture(second.capture);
    store.commit(second.packet, delta(id, 'backpack', 'same_instance'));
    assert.equal(store.entities().length, 1); assert.equal(store.entity(id)?.attributes.location.value, 'backpack');
    assert.equal(store.entity(id)?.lastSeenAt, 2000); assert.deepEqual(store.entity(id)?.identityAnchors, []);
    const sighting = store.objectSightings('second')[0];
    assert.equal(sighting.status, 'supported'); assert.equal(sighting.reason, 'model_assessed_same_instance');
    assert.equal(sighting.modelAssessment?.assessment, 'same_instance');
    const all = store.observations({ limit: 1000 });
    for (const text of [notes.scene, ...notes.observations])
      assert.ok(all.some(note => note.text === text && note.confidence === 'uncertain'));
    assert.ok(all.some(note => note.text.includes(notes.readableText[0]) && note.confidence === 'uncertain'));
    for (const location of ['desk', 'backpack'])
      assert.ok(all.some(note => note.text === `The red-tag keys are on the ${location}.` && note.entityIds.includes(id)));
    store.close(); store = new Store(db, 3, 'test-vector');
    assert.equal(store.entity(id)?.attributes.location.value, 'backpack');
    assert.deepEqual(store.objectSightings('second')[0], sighting);
    assert.deepEqual(store.observations({ limit: 1000 }), all);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('possible and missing AI matches keep notes searchable without moving the canonical object', () => {
  for (const assessment of ['possible', undefined] as const) {
    const store = new Store(':memory:', 3, 'test-vector'); store.createSession('session', 0);
    try {
      const first = fixture('first', 1000); store.insertCapture(first.capture); store.commit(first.packet, delta(null));
      const before = store.entities()[0];
      const second = fixture('second', 2000); store.insertCapture(second.capture);
      store.commit(second.packet, delta(before.id, 'backpack', assessment));
      assert.deepEqual(store.entity(before.id), before);
      assert.equal(store.objectSightings('second')[0].status, 'candidate');
      const candidate = store.observations({ limit: 1000 }).find(note => note.packetId === 'second' && note.text === 'The red-tag keys are on the backpack.')!;
      assert.equal(candidate.confidence, 'uncertain'); assert.deepEqual(candidate.entityIds, []);
      assert.deepEqual(candidate.candidateEntityIds, [before.id]);
      store.putEmbedding(candidate.id, [1, 0, 0]);
      assert.ok(store.search([1, 0, 0], { entityId: before.id, limit: 10 }).some(hit => hit.id === candidate.id));
    } finally { store.close(); }
  }
});

test('simple batch references preserve one object while carrying AI continuity judgments', () => {
  const store = new Store(':memory:', 3, 'test-vector'); store.createSession('session', 0);
  try {
    const first = fixture('first', 1000), second = fixture('second', 2000);
    store.insertCapture(first.capture); store.insertCapture(second.capture);
    store.commitBatch([first.packet, second.packet], { updates: [
      { packetId: 'first', packetVersion: 1, delta: delta(null), reuse: [] },
      { packetId: 'second', packetVersion: 1, delta: delta(null, 'backpack', 'same_instance'),
        reuse: [{ ref: 'keys', fromPacketId: 'first', fromRef: 'keys' }] },
    ] });
    assert.equal(store.entities().length, 1); assert.equal(store.entities()[0].attributes.location.value, 'backpack');
  } finally { store.close(); }
});
