import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { buildMemoryContext as buildContext } from '../src/memory-context.js';
// These legacy fixtures exercise the explicitly optional semantic mode.
const buildMemoryContext = (store: Store, embedder: Embedder, packets: Packet[], onFailure?: () => void) =>
  buildContext(store, embedder, packets, onFailure, 'semantic');
import { transcriptKey, type CaptureRecord, type Embedder, type MemoryDelta, type Packet,
  type Transcript, type Vision } from '../src/contracts.js';

const baseVision: Vision = { scene: 'An office.', observations: [], readableText: [], uncertainties: [] };
const delta = (): MemoryDelta => ({ state: { location: 'Office', activity: null,
  summary: 'An office.', uncertainties: [] }, entities: [], facts: [], events: [] });
function packet(id: string, at: number, vision = baseVision): Packet {
  return { id, version: 1, sessionId: 'session', sequence: at, capturedAt: at,
    imagePath: '/fixture.jpg', sha256: 'a'.repeat(64), createdAt: at, correction: false, vision,
    faces: { frameId: id, streamId: 'faces', capturedAt: at, status: 'ready', width: 1, height: 1, faces: [] },
    audio: { text: '', wordCount: 0, segments: [], status: 'live', throughAt: at } };
}
function commit(store: Store, p: Packet, value: MemoryDelta) {
  const capture: CaptureRecord = { id: p.id, sessionId: p.sessionId, sequence: p.sequence,
    capturedAt: p.capturedAt, width: 1, height: 1, imagePath: p.imagePath, sha256: p.sha256,
    receivedAt: p.capturedAt, faces: p.faces, audioStatus: 'live', status: 'ready', error: null, vision: p.vision };
  store.insertCapture(capture); store.commit(p, value);
}
function face(p: Packet, personId: string, name: string) {
  p.faces.faces = [{ personId, name, trackId: 'track', similarity: .9,
    identityStatus: 'confirmed', box: [0, 0, 1, 1] }];
}
function seedObjects(store: Store, id: string, at: number, count: number) {
  const value = delta();
  for (let i = 0; i < count; i++) {
    const ref = `item-${i}`;
    value.entities.push({ ref, existingId: null, kind: 'object', label: `${id} item ${i}`,
      description: `A distinct item numbered ${i} in ${id}.`, personId: null });
    value.facts.push({ entityRefs: [ref], text: `${id} item ${i} rests on a desk.`, visual: true,
      transcriptKeys: [], confidence: 'observed', attribute: null, value: null });
  }
  commit(store, packet(id, at), value);
  return store.packetEntities(id);
}
const unavailable: Embedder = { model: 'fixture', dimensions: 3, embed: async () => { throw new Error('offline'); } };

test('default writer retrieval uses literal indexed history without embedding inference and excludes removed people', async t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  const old = packet('old-keys', 10, { ...baseVision, observations: ['A distinctive magenta keyring beside the sink.'] });
  const value = delta();
  value.entities.push({ ref: 'keys', existingId: null, kind: 'object', label: 'Magenta keyring', description: 'A magenta keyring.', personId: null });
  value.facts.push({ entityRefs: ['keys'], text: 'The magenta keyring is beside the sink.', visual: true,
    transcriptKeys: [], confidence: 'observed', attribute: 'location', value: 'sink' });
  commit(store, old, value);
  seedObjects(store, 'later-items', 20, 30);
  let embeddingCalls = 0;
  const context = await buildContext(store, { ...unavailable, embed: async () => { embeddingCalls++; throw Error('must not embed'); } },
    [packet('now', 30, { ...baseVision, scene: 'Magenta keyring', observations: [] })]);
  assert.equal(embeddingCalls, 0);
  assert.ok(context.related.some(note => note.text.includes('magenta keyring')));
  const remembered = context.entities.find(entity => entity.label === 'Magenta keyring');
  assert.equal(remembered?.attributes.location.value, 'sink');
  const bob = packet('bob', 40); face(bob, 'bob', 'Zebediah'); commit(store, bob, delta());
  assert.ok(store.contextNotes(['Zebediah']).length);
  store.removePeople(['bob']);
  assert.equal(store.contextNotes(['Zebediah']).length, 0);
  store.db.prepare("UPDATE observations SET superseded=1 WHERE text LIKE '%magenta%'").run();
  assert.equal(store.contextNotes(['magenta']).length, 0, 'superseded evidence stays out despite retained index entries');
});

test('lexical writer index quotes untrusted words and tracks text corrections', t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  commit(store, packet('source', 10, { ...baseVision, scene: 'UniqueA', observations: [] }), delta());
  assert.equal(store.contextNotes(['UniqueA " OR ( *']).length, 1);
  store.db.prepare("UPDATE observations SET text='UniqueB' WHERE text='UniqueA'").run();
  assert.equal(store.contextNotes(['UniqueA']).length, 0);
  assert.equal(store.contextNotes(['UniqueB']).length, 1);
  store.db.prepare("UPDATE observations SET text='李雷 studies AI' WHERE text='UniqueB'").run();
  assert.equal(store.contextNotes(['李雷']).length, 1, 'short non-Latin names remain searchable');
  assert.equal(store.contextNotes(['AI']).length, 1, 'short acronyms remain searchable');
});

test('a rare term in a later query chunk can retrieve an old note beyond the first chunk result limit', t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  commit(store, packet('rare', 10, { ...baseVision, scene: 'Zebulon keyring', observations: [] }), delta());
  const common = Array.from({ length: 128 }, (_, i) => `commonword${i}`).join(' ');
  commit(store, packet('many', 20, { ...baseVision, scene: common,
    observations: Array.from({ length: 30 }, (_, i) => `${common} visible item ${i}`) }), delta());
  const notes = store.contextNotes([common, 'Zebulon']);
  assert.equal(notes.length, 24);
  assert.ok(notes.some(note => note.text === 'Zebulon keyring'), 'later source terms must not lose to insertion-order truncation');
});

test('continuity retains the full latest scene, ongoing events and exact faces without unrelated anonymous bodies', async t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  const known = packet('known', 10); face(known, 'bob', 'Old name'); commit(store, known, delta());
  const classDelta = delta();
  classDelta.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Math class', description: 'An ongoing lecture', personId: null });
  classDelta.events.push({ entityRef: 'class', status: 'ongoing', summary: 'The lecture started.' });
  commit(store, packet('class', 20), classDelta);
  const eventId = store.events()[0].entityId;
  const oldItems = seedObjects(store, 'old-items', 30, 30);
  const currentItems = seedObjects(store, 'current-items', 40, 30);
  const anonymous = delta();
  anonymous.entities.push({ ref: 'body', existingId: null, kind: 'person', label: 'Person in blue', description: 'A back-facing person.', personId: null });
  anonymous.facts.push({ entityRefs: ['body'], text: 'A back-facing person.', visual: true,
    transcriptKeys: [], confidence: 'observed', attribute: null, value: null });
  // Anonymous bodies must not consume the continuity fallback even when newest.
  commit(store, packet('body', 50), anonymous);
  const incoming = packet('incoming', 60); face(incoming, 'bob', 'Bob');
  let failed = 0; const before = store.entities();
  const context = await buildMemoryContext(store, unavailable, [incoming], () => failed++);
  const ids = new Set(context.entities.map(entity => entity.id));
  assert.equal(failed, 1); assert.equal(context.related.length, 0);
  assert.equal(context.entities.find(entity => entity.id === 'bob')?.label, 'Bob');
  assert.ok(ids.has(eventId), 'an ongoing event survives beyond the recency window');
  assert.ok(context.entities.every(entity => entity.kind !== 'person' || entity.personId !== null));
  assert.ok(oldItems.every(entity => !ids.has(entity.id)), 'unrelated old items are not unsolicited context');
  assert.ok(currentItems.some(entity => ids.has(entity.id)));
  assert.deepEqual(store.entities(), before, 'context selection does not mutate or delete history');

  // When the current scene itself has more than 24 items, keep every one.
  const fullScene = seedObjects(store, 'full-scene', 70, 30);
  const next = await buildMemoryContext(store, unavailable, [packet('next', 80)]);
  assert.ok(fullScene.every(entity => next.entities.some(selected => selected.id === entity.id)));
});

test('every visual source is queried and old candidate identities retain complete anchors outside recency', async t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  const old = delta(), description = 'Keys with a distinctive red tag.';
  old.entities.push({ ref: 'keys', existingId: null, kind: 'object', label: 'Keys', description, personId: null });
  old.facts.push({ entityRefs: ['keys'], text: description, visual: true,
    transcriptKeys: [], confidence: 'observed', attribute: 'location', value: 'desk' });
  old.objectEvidence = [{ ref: 'keys', sourceIndex: 1, quote: description,
    anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'distinctive red tag' }], match: null }];
  commit(store, packet('keys', 10, { ...baseVision, observations: [description] }), old);
  const keys = store.entities()[0];
  const possible = structuredClone(old); possible.entities[0].existingId = keys.id;
  possible.facts[0].text = 'Possible keys beside the sink.';
  possible.objectEvidence![0].match = { assessment: 'possible', anchors: [], conflictingDetails: [], competingEntityIds: [] };
  commit(store, packet('possible', 20, { ...baseVision, observations: [description] }), possible);
  seedObjects(store, 'new-items', 30, 30);
  assert.ok(!store.recentContextEntities().some(entity => entity.id === keys.id));
  for (const note of store.pendingEmbeddings(10000)) store.putEmbedding(note.id,
    note.text === 'Possible keys beside the sink.' ? [1, 0, 0] : [0, 1, 0]);
  const query = 'A key ring beside the sink, with a red tag.';
  const observations = Array.from({ length: 15 }, (_, i) => i === 14 ? query : `Visible detail ${i}.`);
  const incoming = packet('incoming', 40, { ...baseVision, observations });
  const requested: string[] = [];
  const embedder: Embedder = { model: 'fixture', dimensions: 3, embed: async texts => {
    requested.push(...texts); return texts.map(text => text === query ? [1, 0, 0] : [0, 1, 0]);
  } };
  const context = await buildMemoryContext(store, embedder, [incoming]);
  assert.ok(observations.every(text => requested.includes(text)), 'sources after index ten must participate');
  assert.ok(context.related.some(note => note.text === 'Possible keys beside the sink.' && note.candidateEntityIds?.includes(keys.id)));
  assert.deepEqual(context.entities.find(entity => entity.id === keys.id), store.entity(keys.id));
  assert.ok(context.entities.find(entity => entity.id === keys.id)!.identityAnchors!.length > 0);
});

test('only finalized speech selects retrieval and its original conversation partner', async t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  const old = packet('bob', 10); face(old, 'bob', 'Bob'); commit(store, old, delta());
  seedObjects(store, 'recent', 20, 30);
  const speech = (segmentId: string, text: string, isFinal: boolean): Transcript => ({
    sessionId: 'session', streamId: 'audio', segmentId, revision: 1, text, isFinal,
    startAt: 11, endAt: 19, receivedAt: 21, words: [], speakerId: null, timing: 'approximate' });
  const final = speech('final', 'The final words about a trip.', true);
  const partial = speech('partial', 'UNVERIFIED PARTIAL', false);
  const incoming = packet('incoming', 30);
  incoming.audio = { ...incoming.audio, text: `${final.text} ${partial.text}`, segments: [final, partial],
    contexts: [{ transcriptKey: transcriptKey(partial), personIds: ['bob'], captureIds: ['bob'], ambiguous: false }] };
  let requested: string[] = [];
  const embedder: Embedder = { ...unavailable, embed: async texts => { requested = texts; throw new Error('offline'); } };
  const first = await buildMemoryContext(store, embedder, [incoming]);
  assert.ok(requested.includes(final.text)); assert.ok(!requested.some(text => text.includes(partial.text)));
  assert.ok(!first.entities.some(entity => entity.id === 'bob'), 'a partial association must not select a partner');
  incoming.audio.contexts![0].transcriptKey = transcriptKey(final);
  const second = await buildMemoryContext(store, embedder, [incoming]);
  assert.ok(second.entities.some(entity => entity.id === 'bob'));
});

test('invalid embedding count exposes retrieval failure without losing current entities', async t => {
  const store = new Store(':memory:', 3, 'fixture'); t.after(() => store.close()); store.createSession('session', 0);
  const current = seedObjects(store, 'current', 10, 2);
  let failures = 0;
  const context = await buildMemoryContext(store, { ...unavailable, embed: async () => [] }, [packet('incoming', 20)], () => failures++);
  assert.equal(failures, 1); assert.ok(current.every(entity => context.entities.some(selected => selected.id === entity.id)));
});
