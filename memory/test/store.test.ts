import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { transcriptWindow } from '../src/transcripts.js';
import { transcriptKey, type CaptureRecord, type MemoryBatch, type MemoryDelta, type Packet, type Transcript } from '../src/contracts.js';

const vision = { scene: 'A room', observations: ['A wooden desk holds metal keys with a red tab'], readableText: [], uncertainties: [] };
let sequence = 0;
function store(): Store { const s = new Store(':memory:', 3, 'test-vectors'); s.createSession('s', 0); return s; }
function packet(s: Store, id: string, at: number, people: { id: string | null; name?: string; track?: string }[] = [],
  status: 'ready' | 'unavailable' = 'ready', streamId = 'faces1'): Packet {
  const faces = { frameId: id, streamId, capturedAt: at, status, width: 640, height: 480,
    faces: people.map((person, index) => ({ trackId: person.track ?? `track${index}`, personId: person.id, name: person.name ?? null,
      similarity: person.id ? 0.8 : null, box: [10, 10, 100, 100] as [number, number, number, number],
      identityStatus: person.id ? 'confirmed' as const : 'unknown' as const })) };
  const c: CaptureRecord = { id, sessionId: 's', sequence: sequence++, capturedAt: at, width: 640, height: 480,
    faces, audioStatus: 'live', imagePath: `/frames/${id}.jpg`, sha256: 'a'.repeat(64), receivedAt: at + 1,
    status: 'ready', error: null, vision };
  s.insertCapture(c);
  return { id, version: 1, sessionId: 's', sequence: c.sequence, capturedAt: at, imagePath: c.imagePath,
    sha256: c.sha256, faces, audio: { text: '', wordCount: 0, segments: [], status: 'live', throughAt: at },
    vision, createdAt: at + 10, correction: false };
}
function delta(location: string | null = 'Room A'): MemoryDelta {
  return { state: { location, activity: null, summary: `At ${location ?? 'an unclear location'}`, uncertainties: [] }, entities: [], facts: [], events: [] };
}
function keys(existingId: string | null, location: string, priorPacketId?: string): MemoryDelta {
  const d = delta();
  d.entities.push({ ref: 'keys', existingId, kind: 'object', label: 'Keys', description: 'Metal keys with a red tab', personId: null });
  d.facts.push({ entityRefs: ['keys'], text: `The keys are ${location}.`, attribute: 'location', value: location,
    visual: true, transcriptKeys: [], confidence: 'observed' });
  d.objectEvidence = [{ ref: 'keys', sourceIndex: 1, quote: 'metal keys with a red tab',
    anchors: [{ kind: 'attached_item', sourceIndex: 1, quote: 'red tab' }],
    match: priorPacketId ? { assessment: 'same_instance', conflictingDetails: [], competingEntityIds: [],
      anchors: [{ anchor: { packetId: priorPacketId, ref: 'keys', index: 0 }, sourceIndex: 1, quote: 'red tab' }] } : null }];
  return d;
}
function transcript(revision = 1, text = 'The exam is Monday', isFinal = true): Transcript {
  return { sessionId: 's', streamId: 'speech1', segmentId: 'segment1', revision, text, isFinal,
    startAt: 800, endAt: 900, receivedAt: 1000 + revision, words: [], speakerId: null, timing: 'approximate' };
}
function speechPacket(p: Packet, t: Transcript): Packet {
  return { ...p, audio: { ...p.audio, text: t.text, wordCount: t.text.split(' ').length, segments: [t] } };
}
function speechDelta(t: Transcript, text = t.text): MemoryDelta {
  const d = delta(); d.facts.push({ entityRefs: [], text, attribute: null, value: null,
    visual: false, transcriptKeys: [transcriptKey(t)], confidence: 'reported' }); return d;
}

test('deleting a person removes active profile and linked retrieval without losing source evidence or resurrecting on delayed commits', () => {
  const s = store();
  const first = packet(s, 'delete-first', 1000, [{ id: 'gallery-maya', name: 'Maya' }]);
  s.commit(first, delta());
  for (const note of s.pendingEmbeddings(100)) s.putEmbedding(note.id, [1,0,0]);
  assert.ok(s.search([1,0,0], { entityId: 'gallery-maya' }).length);
  s.removePeople(['gallery-maya'], false, 2000);
  assert.equal(s.entities().some(e => e.id === 'gallery-maya'), false);
  assert.equal(s.entityHistory('gallery-maya').length, 0);
  assert.equal(s.search([1,0,0], { entityId: 'gallery-maya' }).length, 0);
  assert.equal(s.encounters().length, 0);
  assert.ok(s.getPacket(first.id)); assert.ok(s.getCapture(first.id));
  s.commit(packet(s, 'late-person', 1500, [{ id: 'gallery-maya', name: 'Maya' }]), delta());
  assert.equal(s.entities().some(e => e.id === 'gallery-maya'), false);
  assert.equal(s.observations({entityId:'gallery-maya'}).length, 0);
  assert.equal(s.currentState().packetId, null);
  s.close();
});

test('people reset survives reopening and hides old in-flight provisional people while allowing fresh introductions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kawk-reset-')); const path = join(dir, 'store.sqlite');
  let s = new Store(path, 3, 'test-vectors'); s.createSession('s', 0);
  s.removePeople([], true, 2000);
  s.commit(packet(s, 'old-provisional', 1000, [{ id: null, track: 'old' }]), delta());
  assert.equal(s.entities().length, 0); assert.equal(s.currentState().packetId, null);
  s.close(); s = new Store(path, 3, 'test-vectors');
  assert.equal(s.peopleResetBefore(), 2000); assert.equal(s.entities().length, 0);
  s.commit(packet(s, 'fresh-introduction', 3000, [{ id: 'new-gallery', name: 'Maya' }]), delta());
  assert.deepEqual(s.entities().map(e => e.label), ['Maya']);
  s.close(); rmSync(dir, {recursive:true});
});

test('capture retries preserve immutable evidence and reject conflicting IDs and face geometry', () => {
  const s = store(); packet(s, 'p1', 1000);
  const c = s.getCapture('p1')!;
  assert.equal(s.insertCapture({ ...c, status: 'committed', receivedAt: 5000 }), false);
  assert.throws(() => s.insertCapture({ ...c, sha256: 'b'.repeat(64) }), /Conflicting/);
  assert.throws(() => s.insertCapture({ ...c, id: 'bad', sequence: sequence++, faces: { ...c.faces, frameId: 'bad', width: 480 } }), /geometry/);
  assert.equal(s.listCaptures(10000).length, 1); s.close();
});

test('room exit and return preserve keys, person UUID, rename and separate encounters', () => {
  const s = store(); const p1 = packet(s, 'p1', 1000, [{ id: 'gallery-bob', name: 'Bob' }]);
  s.commit(p1, keys(null, 'on the desk'));
  const keyId = s.entities().find(e => e.kind === 'object')!.id;
  s.commit(packet(s, 'p2', 2000), delta('Corridor'));
  s.commit(packet(s, 'p3', 3000, [{ id: 'gallery-bob', name: 'Robert' }]), delta('Room A'));
  assert.equal(s.currentState().location, 'Room A');
  assert.deepEqual(s.history().map(h => h.location), ['Room A', 'Corridor', 'Room A']);
  assert.equal(s.entity(keyId)!.attributes.location.value, 'on the desk');
  assert.equal(s.entity('gallery-bob')!.label, 'Robert');
  assert.equal(s.entities().filter(e => e.personId).length, 1);
  const visits = s.encounters().filter(e => e.personId === 'gallery-bob');
  assert.equal(visits.length, 2); assert.equal(visits[0].endAt, 2000); assert.equal(visits[1].endAt, null);
  assert.equal(s.observations({ entityId: 'gallery-bob' }).length, 2); s.close();
});

test('objects move without erasing history or merging identical labels', () => {
  const s = store(); s.commit(packet(s, 'p1', 1000), keys(null, 'on the desk'));
  const first = s.entities()[0].id;
  s.commit(packet(s, 'p2', 2000), keys(first, 'inside the backpack', 'p1'));
  s.commit(packet(s, 'p3', 3000), keys(null, 'on another table'));
  assert.equal(s.entities().length, 2);
  assert.equal(s.entity(first)!.attributes.location.value, 'inside the backpack');
  assert.equal(s.observations({ entityId: first }).length, 2);
  // Out-of-order processing keeps the historical sighting without rewinding the latest location.
  s.commit(packet(s, 'old', 1500), keys(first, 'on the windowsill', 'p1'));
  assert.equal(s.entity(first)!.attributes.location.value, 'inside the backpack');
  assert.equal(s.entity(first)!.lastSeenAt, 2000); s.close();
});

test('uncertain candidate locations remain searchable without replacing the last supported location', () => {
  const s = store(); s.commit(packet(s, 'certain', 1000), keys(null, 'on the desk'));
  const id = s.entities()[0].id;
  const candidate = keys(id, 'possibly inside a drawer'); candidate.facts[0].confidence = 'uncertain';
  s.commit(packet(s, 'uncertain', 2000), candidate);
  assert.equal(s.entity(id)!.attributes.location.value, 'on the desk');
  assert.ok(s.observations({ entityId: id }).some(o => o.confidence === 'uncertain' && o.text.includes('possibly inside a drawer')));
  s.close();
});

test('conflicting OCR candidates stay uncertain and exact-image provenance survives storage', () => {
  const s = store(), p = packet(s, 'sign', 1000);
  p.vision = { ...vision, readableText: ['Room 44 – The Grounds'], textEvidence: {
    frameId: p.id, capturedAt: p.capturedAt, sha256: p.sha256, engine: 'apple-vision', revision: 3,
    status: 'ready', durationMs: 80, error: null, lines: [{ box: [.1, .2, .3, .1], candidates: [
      { text: 'Room 4A – The Grasslands', confidence: 1 }, { text: 'Room 44 – The Grasslands', confidence: .5 },
    ] }],
  } };
  s.saveVision(p.id, p.vision); s.commit(p, delta());
  assert.deepEqual(s.getPacket(p.id)!.vision.textEvidence, p.vision.textEvidence);
  const readings = s.observations().filter(o => o.text.startsWith('Unverified text reading'));
  assert.equal(readings.length, 2); assert.ok(readings.every(o => o.confidence === 'uncertain'));
  for (const mismatch of [{ frameId: 'other' }, { capturedAt: 2000 }, { sha256: 'b'.repeat(64) }]) {
    const bad = { ...p.vision, textEvidence: { ...p.vision.textEvidence!, ...mismatch } };
    assert.throws(() => s.saveVision(p.id, bad), /exact capture/);
    assert.throws(() => s.savePacket({ ...p, version: 2, vision: bad }), /exact capture/);
  }
  s.close();
});

test('unknown tracks are stable only within their stream namespace; missing faces do not assert exit', () => {
  const s = store(); s.commit(packet(s, 'p1', 1000, [{ id: null, track: 't1' }]), delta());
  const unknown = s.entities()[0].id;
  s.commit(packet(s, 'p2', 2000, [{ id: null, track: 't1' }]), delta());
  assert.equal(s.entities().length, 1); assert.equal(s.entities()[0].id, unknown);
  const unavailable = packet(s, 'p3', 3000, [], 'unavailable'); s.commit(unavailable, delta());
  assert.equal(s.encounters()[0].endAt, null);
  s.commit(packet(s, 'p4', 4000, [{ id: null, track: 't1' }], 'ready', 'faces2'), delta());
  assert.equal(s.entities().length, 2); s.close();
});

test('first-frame face context supplies canonical IDs without writes; model reference creates only one person', () => {
  const s = store(); const p = packet(s, 'p1', 1000, [{ id: null, track: 'new-track' }]);
  const candidates = s.faceEntities(p); assert.equal(candidates.length, 1); assert.equal(s.entities().length, 0);
  const d = delta(); d.entities.push({ ref: 'visible-person', existingId: candidates[0].id, kind: 'person',
    label: 'Unknown person in a blue shirt', description: 'Visible person, identity unconfirmed', personId: null });
  d.facts.push({ entityRefs: ['visible-person'], text: 'The unidentified person is beside the desk.',
    visual: true, transcriptKeys: [], attribute: null, value: null, confidence: 'observed' });
  s.commit(p, d); assert.equal(s.entities().length, 1); assert.equal(s.entities()[0].id, candidates[0].id);
  const before = s.entity(candidates[0].id)!;
  const next = packet(s, 'p2', 2000, [{ id: 'gallery-known', name: 'Bob', track: 'new-track' }]);
  assert.equal(s.faceEntities(next)[0].id, 'gallery-known'); assert.equal(s.entities().length, 1);
  s.commit(next, delta()); assert.equal(s.entities().length, 2);
  assert.deepEqual(s.entity(candidates[0].id), before);
  assert.equal(s.entity('gallery-known')!.personId, 'gallery-known');
  assert.equal(s.entity(candidates[0].id)!.personId, null); s.close();
});

test('event updates retain an ongoing span, end it, and reject reopening as a new occurrence', () => {
  const s = store(); const d = delta('Lecture room');
  d.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Calculus class', description: 'Current class occurrence', personId: null });
  d.events.push({ entityRef: 'class', status: 'ongoing', summary: 'Limits are discussed' });
  s.commit(packet(s, 'p1', 1000), d); const id = s.entities()[0].id;
  d.entities[0].existingId = id; d.events[0].summary = 'Derivatives are discussed';
  s.commit(packet(s, 'p2', 2000), d);
  d.events[0].status = 'ended'; s.commit(packet(s, 'p3', 3000), d);
  assert.deepEqual(s.events().map(e => [e.startAt, e.endAt]), [[1000, 3000]]);
  s.commit(packet(s, 'p4', 4000), d);
  assert.deepEqual(s.events().map(e => [e.startAt, e.endAt]), [[1000, 3000]]);
  d.events[0].status = 'ongoing'; assert.throws(() => s.commit(packet(s, 'late-reopen', 3500), d), /new event entity/);
  assert.throws(() => s.commit(packet(s, 'p5', 5000), d), /new event entity/);
  assert.equal(s.getPacket('p5'), null); s.close();
});

test('speech overlap deduplicates paraphrases but distinct sources retain notes', () => {
  const s = store(); const t = transcript(); s.saveTranscript(t);
  s.commit(speechPacket(packet(s, 'p1', 1000), t), speechDelta(t));
  s.commit(speechPacket(packet(s, 'p2', 2000), t), speechDelta(t, 'An exam will take place on Monday.'));
  assert.equal(s.observations().filter(o => o.transcriptKeys.length && !o.text.startsWith('Conversation transcript')).length, 1);
  const other = { ...t, segmentId: 'segment2', text: 'Bring a calculator', startAt: 2100, endAt: 2200 };
  s.saveTranscript(other); s.commit(speechPacket(packet(s, 'p3', 3000), other), speechDelta(other));
  assert.equal(s.observations().filter(o => o.transcriptKeys.length && !o.text.startsWith('Conversation transcript')).length, 2); s.close();
});

test('expanded source windows retain new facts while repeated covered windows deduplicate', () => {
  const s = store(); const t: Transcript = { ...transcript(), text: 'Keys desk wallet bag', startAt: 100, endAt: 1900,
    words: [{ text: 'Keys', startAt: 100, endAt: 400 }, { text: 'desk', startAt: 400, endAt: 900 },
      { text: 'wallet', startAt: 1100, endAt: 1400 }, { text: 'bag', startAt: 1400, endAt: 1900 }] };
  s.saveTranscript(t);
  const first = packet(s, 'first', 1000); first.audio = transcriptWindow([t], 1000, 20, 'live');
  s.commit(first, speechDelta(t, 'The keys are on the desk.'));
  const expanded = packet(s, 'expanded', 2000); expanded.audio = transcriptWindow([t], 2000, 20, 'live');
  s.commit(expanded, speechDelta(t, 'The wallet is in the bag.'));
  const repeated = packet(s, 'repeated', 3000); repeated.audio = transcriptWindow([t], 3000, 20, 'live');
  s.commit(repeated, speechDelta(t, 'A wallet was placed in a bag.'));
  const facts = s.observations().filter(o => o.transcriptKeys.length && !o.text.startsWith('Conversation transcript'));
  assert.deepEqual(new Set(facts.map(o => o.text)), new Set(['The keys are on the desk.', 'The wallet is in the bag.']));
  assert.equal(s.observations().filter(o => o.text.startsWith('Conversation transcript')).length, 1); s.close();
});

test('final speech is directly searchable despite empty model facts, with full text and source-time people', () => {
  const s = store(); s.commit(packet(s, 'source', 500, [{ id: 'bob', name: 'Bob' }]), delta());
  const t = transcript(); s.saveTranscript(t);
  const anchor = packet(s, 'anchor', 1000, [{ id: 'alice', name: 'Alice' }]);
  anchor.audio = transcriptWindow([t], 1000, 2, 'live');
  assert.equal(anchor.audio.text, 'is Monday'); s.commit(anchor, delta());
  const raw = s.observations().find(o => o.text.startsWith('Conversation transcript'))!;
  assert.equal(raw.text, 'Conversation transcript (speaker unknown): The exam is Monday');
  assert.deepEqual(raw.entityIds, ['bob']); assert.equal(raw.visual, false);
  assert.deepEqual([raw.observedAt, raw.endAt], [800, 900]);
  assert.deepEqual(raw.transcriptKeys, [transcriptKey(t)]);
  s.putEmbedding(raw.id, [1, 0, 0]);
  assert.equal(s.search([1, 0, 0], { entityId: 'bob', from: 850, to: 850 })[0].id, raw.id);
  const overlap = packet(s, 'overlap', 2000); overlap.audio = transcriptWindow([t], 2000, 2, 'live');
  s.commit(overlap, delta()); assert.equal(s.observations().filter(o => o.text.startsWith('Conversation transcript')).length, 1);
  const corrected = transcript(2, 'The exam is Tuesday'); s.saveTranscript(corrected);
  assert.equal(s.search([1, 0, 0]).length, 0);
  const replacement = { ...anchor, version: 2, correction: true, audio: transcriptWindow([corrected], 1000, 2, 'live') };
  s.commit(replacement, delta());
  assert.equal(s.observations({ includeSuperseded: true }).find(o => o.id === raw.id)!.superseded, true);
  const active = s.observations().filter(o => o.text.startsWith('Conversation transcript'));
  assert.equal(active.length, 1); assert.ok(active[0].text.endsWith('The exam is Tuesday'));
  s.putEmbedding(raw.id, [1, 0, 0]); assert.equal(s.search([1, 0, 0]).length, 0); s.close();
});

test('the final anchor indexes every completed ledger segment even when last N omits one entirely', () => {
  const s = store(); const first = transcript(); const second = { ...transcript(), segmentId: 'segment2', text: 'Bring a calculator', startAt: 910, endAt: 990 };
  s.saveTranscript(first); s.saveTranscript(second);
  const p = packet(s, 'p1', 1000); p.audio = transcriptWindow([first, second], 1000, 2, 'live');
  assert.deepEqual(p.audio.segments.map(t => t.segmentId), ['segment2']); s.commit(p, delta());
  const raw = s.observations().filter(o => o.text.startsWith('Conversation transcript'));
  assert.equal(raw.length, 2); assert.ok(raw.some(o => o.text.endsWith(first.text)));
  assert.ok(raw.every(o => o.entityIds.length === 0)); s.close();
});

test('new finals dirty only their first source-time capture and late corrections dirty dependent captures', () => {
  const s = store(); const before = packet(s, 'before', 500); const first = packet(s, 'first', 1000);
  const later = packet(s, 'later', 400_000); const newest = packet(s, 'newest', 900_000);
  for (const p of [before, first, later, newest]) s.commit(p, delta());
  const original = transcript(); s.saveTranscript(original);
  assert.deepEqual(s.pendingCaptures().map(c => c.id), ['first']);
  s.commit({ ...speechPacket(first, original), version: 2, correction: true }, speechDelta(original));
  const dependent = speechDelta(original, 'Exam context for the class');
  dependent.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Class', description: 'Current class', personId: null });
  dependent.facts[0].entityRefs = ['class'];
  s.commit({ ...speechPacket(later, original), version: 2, correction: true }, dependent);
  assert.equal(s.pendingCaptures().length, 0);
  const corrected = transcript(2, 'The exam is Tuesday'); s.saveTranscript(corrected);
  assert.deepEqual(s.pendingCaptures().map(c => c.id), ['first', 'later']);
  assert.equal(s.getCapture('newest')!.status, 'committed'); assert.equal(s.getCapture('before')!.status, 'committed');
  assert.deepEqual(s.capturesForSession('s').map(c => c.id), ['before', 'first', 'later', 'newest']); s.close();
});

test('corrected finals invalidate state-only overlapping packets without rewinding the current source cursor', () => {
  const s = store(); const original = transcript(); s.saveTranscript(original);
  const first = speechPacket(packet(s, 'first', 1000), original);
  const overlap = speechPacket(packet(s, 'overlap', 2000), original);
  const old = delta('Office'); old.state.summary = 'The exam is Monday';
  s.commit(first, old); s.commit(overlap, old);
  const corrected = transcript(2, 'The exam is Tuesday'); s.saveTranscript(corrected);
  assert.deepEqual(s.pendingCaptures().map(c => c.id), ['first', 'overlap']);
  assert.equal(s.currentState().observedAt, 2000); assert.equal(s.currentState().packetId, 'overlap');
  assert.equal(s.currentState().summary, ''); assert.equal(s.currentState().location, null);
  assert.match(s.currentState().uncertainties.join(' '), /pending.*corrected/);
  assert.ok(s.history().every(h => h.superseded));
  const replacement = delta('Office'); replacement.state.summary = corrected.text;
  s.commit({ ...speechPacket(first, corrected), version: 2, correction: true }, replacement);
  assert.equal(s.currentState().observedAt, 2000); assert.equal(s.currentState().summary, '');
  s.commit({ ...speechPacket(overlap, corrected), version: 2, correction: true }, replacement);
  assert.equal(s.currentState().summary, corrected.text); assert.equal(s.currentState().location, 'Office');
  assert.equal(s.currentState().uncertainties.length, 0);
  assert.equal(s.history().filter(h => !h.superseded).length, 2);
  assert.equal(s.observations().filter(o => o.text === vision.scene).length, 2); s.close();
});

test('event projections invalidate even when overlapping source coverage deduplicated their notes', () => {
  const s = store(); const original = transcript(); s.saveTranscript(original);
  const first = speechPacket(packet(s, 'first', 1000), original);
  const overlap = speechPacket(packet(s, 'overlap', 2000), original);
  const d = delta('Classroom');
  d.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Math class', description: 'This class occurrence', personId: null });
  d.events.push({ entityRef: 'class', status: 'ongoing', summary: original.text });
  s.commit(first, d); const id = s.entities()[0].id;
  d.entities[0].existingId = id; d.events[0].summary = 'Students are discussing the Monday exam';
  s.commit(overlap, d);
  assert.equal(s.entityHistory(id).filter(o => o.text.startsWith('Event context:')).length, 1);
  const corrected = transcript(2, 'The exam is Tuesday'); s.saveTranscript(corrected);
  assert.deepEqual(s.pendingCaptures().map(c => c.id), ['first', 'overlap']);
  assert.deepEqual(s.events(), []); assert.equal(s.entity(id)!.description, '');
  d.events[0].summary = corrected.text;
  s.commit({ ...speechPacket(first, corrected), version: 2, correction: true }, d);
  s.commit({ ...speechPacket(overlap, corrected), version: 2, correction: true }, d);
  assert.equal(s.events()[0].summary, corrected.text); assert.equal(s.events()[0].lastObservedAt, 2000);
  assert.equal(s.entity(id)!.label, 'Math class');
  assert.ok(s.entityHistory(id).some(o => o.superseded && o.text.includes('Monday'))); s.close();
});

test('corrected-away person descriptions disappear even when the replacement omits that person', () => {
  const s = store(); const original = transcript(1, 'Bob has a cat named Luna'); s.saveTranscript(original);
  const first = speechPacket(packet(s, 'first', 1000, [{ id: 'bob', name: 'Bob' }]), original);
  const d = speechDelta(original);
  d.entities.push({ ref: 'bob', existingId: 'bob', kind: 'person', label: 'Bob', description: original.text, personId: 'bob' });
  d.facts[0].entityRefs = ['bob']; s.commit(first, d);
  const later = delta('Corridor'); later.entities = structuredClone(d.entities);
  // A model echo of existing context is not independent confirmation of the claim.
  s.commit(packet(s, 'newer-appearance', 2000, [{ id: 'bob', name: 'Robert' }]), later);
  const before = s.entity('bob')!;
  const corrected = transcript(2, 'Rob has a cat named Luna'); s.saveTranscript(corrected);
  assert.equal(s.entity('bob')!.description, ''); assert.equal(s.entity('bob')!.label, 'Robert');
  assert.deepEqual([s.entity('bob')!.createdAt, s.entity('bob')!.lastSeenAt], [before.createdAt, before.lastSeenAt]);
  assert.equal(s.currentState().location, 'Corridor');
  s.commit({ ...speechPacket(first, corrected), version: 2, correction: true }, delta());
  assert.equal(s.context().entities.find(e => e.id === 'bob')!.description, '');
  assert.equal(s.entity('bob')!.personId, 'bob'); assert.equal(s.entity('bob')!.label, 'Robert');
  assert.ok(s.entityHistory('bob').some(o => o.text === original.text && o.superseded));
  assert.ok(s.entityHistory('bob', { includeSuperseded: false }).every(o => o.visual)); s.close();
});

test('entity metadata rebuilds valid versions and clears invalid legacy descriptors across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kawk-metadata-')); const path = join(dir, 'memory.sqlite');
  let s = new Store(path, 3, 'test-vectors'); s.createSession('s', 0);
  try {
    const baseline = keys(null, 'on desk'); s.commit(packet(s, 'baseline', 500), baseline);
    const id = s.entities()[0].id;
    const original = transcript(); s.saveTranscript(original);
    const d = keys(id, 'on desk', 'baseline'); d.entities[0].label = 'Monday keys'; d.entities[0].description = 'Keys for the Monday exam';
    const first = speechPacket(packet(s, 'first', 1000), original); s.commit(first, d);
    s.saveTranscript(transcript(2, 'The exam is Tuesday'));
    assert.equal(s.entity(id)!.label, baseline.entities[0].label);
    assert.equal(s.entity(id)!.description, baseline.entities[0].description);
    s.close(); s = new Store(path, 3, 'test-vectors');
    assert.equal(s.entity(id)!.description, baseline.entities[0].description);
    assert.equal(s.getCapture('first')!.status, 'ready');
    // Simulate an existing database whose entity prose predates versioned metadata.
    s.close(); const raw = new Database(path);
    raw.exec('DROP TABLE entity_metadata_history');
    const entity = JSON.parse((raw.prepare('SELECT body FROM entities WHERE id=?').get(id) as { body: string }).body);
    entity.label = 'Unproven old label'; entity.description = 'Unproven old description';
    raw.prepare('UPDATE entities SET body=? WHERE id=?').run(JSON.stringify(entity), id); raw.close();
    s = new Store(path, 3, 'test-vectors'); s.saveTranscript(transcript(3, 'The exam is Wednesday'));
    assert.equal(s.entity(id)!.description, ''); assert.equal(s.entity(id)!.label, 'Unspecified object');
    assert.equal(s.entity(id)!.attributes.location.value, 'on desk');
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('the final anchor has no age cutoff and a late partial cannot demote or invalidate final speech', () => {
  const s = store(); const p = packet(s, 'long-after-speech', 900_000); s.commit(p, delta());
  const final = transcript(); s.saveTranscript(final);
  assert.equal(s.getCapture(p.id)!.status, 'ready');
  s.commit({ ...speechPacket(p, final), version: 2, correction: true }, speechDelta(final));
  const note = s.observations().find(o => o.transcriptKeys.length)!;
  s.putEmbedding(note.id, [1, 0, 0]);
  assert.equal(s.saveTranscript(transcript(2, 'The exam is maybe', false)), false);
  assert.equal(s.getCapture(p.id)!.status, 'committed'); assert.equal(s.search([1, 0, 0])[0].id, note.id);
  assert.equal(s.transcripts('s')[0].revision, 1); assert.equal(s.transcripts('s')[0].isFinal, true);
  assert.equal(s.saveTranscript(transcript(2, 'The exam is Tuesday')), true);
  assert.equal(s.transcripts('s')[0].revision, 2); assert.equal(s.getCapture(p.id)!.status, 'ready'); s.close();
});

test('partial, stale and fabricated references roll back the whole commit', () => {
  const s = store(); const t = transcript(0, 'The exam is maybe', false); s.saveTranscript(t);
  const p = speechPacket(packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), t);
  assert.throws(() => s.commit(p, speechDelta(t)), /only final/);
  assert.equal(s.entities().length, 0); assert.equal(s.getPacket('p1'), null);
  const d = keys('nonexistent-id', 'on desk'); assert.throws(() => s.commit(p, d), /Unknown existing/);
  const invented = delta(); invented.facts.push({ entityRefs: ['invented'], text: 'A phone', attribute: null,
    value: null, visual: true, transcriptKeys: [], confidence: 'observed' });
  assert.throws(() => s.commit(p, invented), /Unknown fact entity/);
  assert.equal(s.history().length, 0); assert.equal(s.stats().pendingEmbeddings, 0); s.close();
});

test('late correction supersedes old claims, preserves visual evidence and never rewinds current state', () => {
  const s = store(); const t = transcript(); s.saveTranscript(t);
  const p1 = speechPacket(packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), t);
  const d1 = keys(null, 'on the desk'); d1.facts.push(...speechDelta(t).facts);
  s.commit(p1, d1); const keyId = s.entities().find(e => e.kind === 'object')!.id;
  const oldSpeech = s.observations().find(o => o.transcriptKeys.length)!;
  s.putEmbedding(oldSpeech.id, [1, 0, 0]);
  s.commit(packet(s, 'p2', 3000, [{ id: 'alice', name: 'Alice' }]), { ...keys(keyId, 'in the bag', 'p1'), state: delta('Corridor').state });
  const corrected = transcript(2, 'The exam is Tuesday'); s.saveTranscript(corrected);
  assert.equal(s.search([1, 0, 0]).length, 0);
  assert.equal(s.getCapture('p1')!.status, 'ready');
  const p2 = { ...speechPacket(p1, corrected), version: 2, correction: true, createdAt: 5000 };
  const d2 = keys(keyId, 'on the desk'); d2.facts.push(...speechDelta(corrected).facts);
  s.commit(p2, d2);
  assert.equal(s.currentState().location, 'Corridor');
  assert.equal(s.entity(keyId)!.attributes.location.value, 'in the bag');
  assert.equal(s.observations().filter(o => o.text === 'The keys are on the desk.').length, 1);
  assert.equal(s.observations({ includeSuperseded: true }).find(o => o.id === oldSpeech.id)!.superseded, true);
  assert.equal(s.observations().filter(o => o.transcriptKeys.length && !o.text.startsWith('Conversation transcript')).length, 1);
  assert.equal(s.packetVersions('p1').length, 2);
  assert.equal(s.transcripts('s')[0].text, 'The exam is Tuesday');
  assert.equal(s.encounters().filter(e => e.personId === 'bob').length, 1);
  // An embedding returned after invalidation must not resurrect its old observation.
  s.putEmbedding(oldSpeech.id, [1, 0, 0]); assert.equal(s.search([1, 0, 0]).length, 0); s.close();
});

test('clipped final word windows are valid evidence; invented clips are rejected', () => {
  const s = store(); const full = transcript(); s.saveTranscript(full);
  const part: Transcript = { ...full, text: 'exam is Monday', startAt: 825, endAt: 900,
    words: [{ text: 'exam', startAt: 825, endAt: 850 }, { text: 'is', startAt: 850, endAt: 875 }, { text: 'Monday', startAt: 875, endAt: 900 }] };
  s.commit(speechPacket(packet(s, 'p1', 1000), part), speechDelta(part));
  assert.equal(s.observations().find(o => o.transcriptKeys.length)!.observedAt, 825);
  const invented = { ...part, text: 'exam is Friday', words: [...part.words.slice(0, 2), { ...part.words[2], text: 'Friday' }] };
  assert.throws(() => s.commit(speechPacket(packet(s, 'p2', 2000), invented), speechDelta(invented)), /stale or unpersisted/);
  const wrongInterval = { ...part, startAt: 100 };
  assert.throws(() => s.commit(speechPacket(packet(s, 'p3', 3000), wrongInterval), delta()), /stale or unpersisted/); s.close();
});

test('all final packet sources are validated even when the model emits only state and event updates', () => {
  const s = store(); const original = transcript(); s.saveTranscript(original);
  const p = speechPacket(packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), original);
  const d = delta('Lecture room');
  d.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Class', description: 'Current class', personId: null });
  d.events.push({ entityRef: 'class', status: 'ongoing', summary: 'The exam is Monday' });
  s.saveTranscript(transcript(2, 'The exam is Tuesday'));
  assert.throws(() => s.commit(p, d), /Packet references stale or unpersisted/);
  assert.equal(s.getPacket(p.id), null); assert.equal(s.entities().length, 0);
  assert.equal(s.history().length, 0); assert.equal(s.events().length, 0);
  assert.equal(s.stats().pendingEmbeddings, 0);
  const unpersisted = { ...original, segmentId: 'invented' };
  assert.throws(() => s.commit(speechPacket(p, unpersisted), delta()), /stale or unpersisted/); s.close();
});

test('partial event summaries are not mislabeled as visual semantic memories', () => {
  const s = store(); const partial = transcript(1, 'The exam is maybe Monday', false); s.saveTranscript(partial);
  const p = speechPacket(packet(s, 'p1', 1000), partial); const d = delta('Lecture room');
  d.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Class', description: 'Current class', personId: null });
  d.events.push({ entityRef: 'class', status: 'ongoing', summary: 'The exam is maybe Monday' });
  s.commit(p, d);
  assert.equal(s.observations().some(o => o.text.startsWith('Event context:')), false);
  const final = transcript(2, 'The exam is Tuesday'); s.saveTranscript(final);
  const correction = { ...speechPacket(p, final), version: 2, correction: true };
  d.events[0].summary = 'The exam is Tuesday'; s.commit(correction, d);
  const notes = s.observations().filter(o => o.text.startsWith('Event context:'));
  assert.equal(notes.length, 1); assert.equal(notes[0].visual, false);
  assert.deepEqual(notes[0].transcriptKeys, [transcriptKey(final)]); s.close();
});

test('an event-only ending remains searchable with unrelated partials and invalidates on final correction', () => {
  const s = store(); const d = delta('Classroom');
  d.entities.push({ ref: 'class', existingId: null, kind: 'event', label: 'Calculus class', description: 'This class occurrence', personId: null });
  d.events.push({ entityRef: 'class', status: 'ongoing', summary: 'The class is ongoing' });
  s.commit(packet(s, 'class-start', 500), d); const id = s.entities()[0].id;
  const final = transcript(1, 'The calculus class has ended');
  const partial = { ...transcript(1, 'Tomorrow maybe', false), segmentId: 'unrelated', startAt: 910, endAt: 990 };
  s.saveTranscript(final); s.saveTranscript(partial);
  const ending = packet(s, 'class-end', 1000); ending.audio = transcriptWindow([final, partial], 1000, 200, 'live');
  d.entities[0].existingId = id; d.events[0] = { entityRef: 'class', status: 'ended', summary: final.text };
  s.commit(ending, d);
  const note = s.entityHistory(id).find(o => o.text === `Event context: ${final.text}`)!;
  assert.ok(note); assert.equal(note.visual, false); assert.deepEqual(note.transcriptKeys, [transcriptKey(final)]);
  assert.deepEqual([note.observedAt, note.endAt], [final.startAt, final.endAt]);
  s.putEmbedding(note.id, [1, 0, 0]);
  assert.deepEqual(s.search([1, 0, 0], { entityId: id, from: 850, to: 850 }).map(o => o.id), [note.id]);
  assert.equal(s.events()[0].status, 'ended'); assert.equal(s.events()[0].endAt, 1000);
  const corrected = transcript(2, 'The calculus class is still ongoing'); s.saveTranscript(corrected);
  assert.equal(s.getCapture(ending.id)!.status, 'ready');
  assert.equal(s.search([1, 0, 0], { entityId: id, from: 850, to: 850 }).length, 0);
  assert.equal(s.entityHistory(id).find(o => o.id === note.id)!.superseded, true);
  d.events[0] = { entityRef: 'class', status: 'ongoing', summary: corrected.text };
  s.commit({ ...ending, version: 2, correction: true, audio: transcriptWindow([corrected, partial], 1000, 200, 'live') }, d);
  const replacement = s.entityHistory(id, { includeSuperseded: false }).find(o => o.text === `Event context: ${corrected.text}`)!;
  assert.deepEqual(replacement.transcriptKeys, [transcriptKey(corrected)]);
  s.putEmbedding(replacement.id, [1, 0, 0]);
  assert.deepEqual(s.search([1, 0, 0], { entityId: id, from: 850, to: 850 }).map(o => o.id), [replacement.id]);
  assert.equal(s.events()[0].endAt, null); s.close();
});

test('late references do not overwrite newer entity descriptions when no visual sighting updates lastSeenAt', () => {
  const s = store(); const d = delta();
  d.entities.push({ ref: 'topic', existingId: null, kind: 'event', label: 'Class', description: 'Initial topic', personId: null });
  s.commit(packet(s, 'p1', 1000), d); const id = s.entities()[0].id;
  d.entities[0] = { ...d.entities[0], existingId: id, label: 'Physics class', description: 'A later clarified topic' };
  s.commit(packet(s, 'p2', 3000), d); assert.equal(s.entity(id)!.lastSeenAt, 0);
  d.entities[0] = { ...d.entities[0], label: 'Earlier class', description: 'Old inferred topic' };
  s.commit(packet(s, 'late', 2000), d);
  assert.equal(s.entity(id)!.label, 'Physics class'); assert.equal(s.entity(id)!.description, 'A later clarified topic'); s.close();
});

test('complete person history retains superseded notes; transcript retrieval intersects source intervals', () => {
  const s = store(); const original = transcript(); s.saveTranscript(original);
  const p = speechPacket(packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), original);
  const d = speechDelta(original);
  d.entities.push({ ref: 'bob', existingId: 'bob', kind: 'person', label: 'Bob', description: 'An enrolled person', personId: 'bob' });
  d.facts[0].entityRefs = ['bob']; s.commit(p, d);
  const final = transcript(2, 'The exam is Tuesday'); s.saveTranscript(final);
  d.facts[0] = { ...d.facts[0], text: final.text, transcriptKeys: [transcriptKey(final)] };
  s.commit({ ...speechPacket(p, final), version: 2, correction: true }, d);
  assert.equal(s.entityHistory('bob').length, 3);
  assert.equal(s.entityHistory('bob').filter(o => o.superseded).length, 1);
  assert.equal(s.entityHistory('bob', { includeSuperseded: false }).length, 2);
  assert.equal(s.entityHistory('bob', { from: 850, to: 850 }).length, 2);
  assert.deepEqual(s.transcripts('s', { from: 850, to: 850 }).map(t => t.revision), [2]);
  assert.deepEqual(s.transcripts('s', { from: 850, to: 850, includeRevisions: true }).map(t => t.revision), [1, 2]);
  assert.equal(s.transcripts('s', { from: 901 }).length, 0);
  assert.equal(s.transcripts('s', { to: 799 }).length, 0); s.close();
});

test('vectors, outbox and history survive restart; semantic distance respects entity and time filters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kawk-store-')); const path = join(dir, 'memory.sqlite');
  try {
    let s = new Store(path, 3, 'test-vectors'); s.createSession('s', 0);
    s.commit(packet(s, 'p1', 1000), keys(null, 'on the desk')); const keyId = s.entities()[0].id;
    const original = s.pendingEmbeddings().find(o => o.entityIds.includes(keyId))!; s.close();
    s = new Store(path, 3, 'test-vectors'); assert.ok(s.pendingEmbeddings().some(o => o.id === original.id));
    s.putEmbedding(original.id, [1, 0, 0]); assert.equal(s.pendingEmbeddings().length, 2);
    s.commit(packet(s, 'p2', 2000), keys(null, 'on another table'));
    const other = s.pendingEmbeddings().find(o => o.entityIds.length)!; s.putEmbedding(other.id, [0, 1, 0]);
    assert.equal(s.search([0.9, 0.1, 0])[0].id, original.id);
    assert.equal(s.search([0, 1, 0], { entityId: keyId })[0].id, original.id);
    assert.equal(s.search([1, 0, 0], { from: 1500 })[0].id, other.id);
    assert.equal(s.search([1, 0, 0], { to: 500 }).length, 0);
    assert.equal(s.stats().indexed, 2); s.close();
    assert.throws(() => new Store(path, 4, 'test-vectors'), /dimensions mismatch/);
    assert.throws(() => new Store(path, 3, 'wrong-model'), /embeddingModel mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit supported location and missing identities preserve context while ready absence ends a visit', () => {
  const s = store(); s.commit(packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), delta('Room A'));
  const p2 = packet(s, 'p2', 2000, [{ id: null, track: 'uncertain' }]);
  const uncertain = delta('Room A'); uncertain.state.uncertainties = ['The person is partly obscured.'];
  s.commit(p2, uncertain); assert.equal(s.currentState().location, 'Room A');
  assert.equal(s.encounters().find(e => e.personId === 'bob')!.endAt, null);
  s.commit(packet(s, 'p3', 3000), delta('Corridor'));
  assert.equal(s.encounters().find(e => e.personId === 'bob')!.endAt, 3000); s.close();
});

test('complete state can clear an ended activity and unknown location without erasing history', () => {
  const s = store();
  const ongoing = delta('Lecture room'); ongoing.state.activity = 'Calculus workshop ongoing';
  s.commit(packet(s, 'class-start', 1000), ongoing);
  const ended = delta('Lecture room'); ended.state.summary = 'The calculus workshop has ended.';
  s.commit(packet(s, 'class-end', 2000), ended);
  assert.equal(s.currentState().activity, null);
  assert.equal(s.currentState().location, 'Lecture room');
  const unknown = delta(null); unknown.state.uncertainties = ['The current room identity is uncertain.'];
  s.commit(packet(s, 'unclear-room', 3000), unknown);
  assert.equal(s.currentState().location, null);
  assert.equal(s.history()[0].activity, 'Calculus workshop ongoing');
  assert.equal(s.history()[0].location, 'Lecture room');
  // A historical repair must still not rewind the current source-time cursor.
  const old = s.getPacket('class-start')!;
  s.commit({ ...old, version: 2, correction: true }, ongoing);
  assert.equal(s.currentState().observedAt, 3000);
  assert.equal(s.currentState().location, null);
  s.close();
});

test('batch commits preserve each timestamp and reuse only an earlier row entity', () => {
  const s = store(); const packets = [packet(s, 'p1', 1000), packet(s, 'p2', 2000), packet(s, 'p3', 3000)];
  const batch: MemoryBatch = { updates: packets.map((p, i) => ({ packetId: p.id, packetVersion: 1,
    delta: keys(null, ['on the desk', 'in the bag', 'on the shelf'][i], i ? packets[i - 1].id : undefined),
    reuse: i ? [{ ref: 'keys', fromPacketId: packets[i - 1].id, fromRef: 'keys' }] : [] })) };
  s.commitBatch(packets, batch);
  assert.equal(s.entities().length, 1); const id = s.entities()[0].id;
  assert.equal(s.entity(id)!.attributes.location.value, 'on the shelf');
  assert.deepEqual(s.entityHistory(id).map(o => o.observedAt), [1000, 2000, 3000]);
  assert.equal(s.currentState().observedAt, 3000); assert.equal(s.pendingCaptures().length, 0);
  const before = s.stats(); s.commitBatch(packets, batch); assert.deepEqual(s.stats(), before); s.close();
});

test('a batch may report a named person before their first face row without inventing earlier presence', () => {
  const s = store(); const t = transcript(1, 'Bob is bringing a notebook'); s.saveTranscript(t);
  const first = speechPacket(packet(s, 'speech-first', 1000), t);
  const second = packet(s, 'face-later', 2000, [{ id: 'bob', name: 'Bob' }]);
  const reported = speechDelta(t); reported.entities.push({ ref: 'bob', existingId: 'bob', personId: 'bob',
    kind: 'person', label: 'Bob', description: 'Named person from the verified gallery' });
  reported.facts[0].entityRefs = ['bob'];
  s.commitBatch([first, second], { updates: [
    { packetId: first.id, packetVersion: 1, delta: reported, reuse: [] },
    { packetId: second.id, packetVersion: 1, delta: delta(), reuse: [] },
  ] });
  const bob = s.entity('bob')!;
  assert.equal(bob.createdAt, 2000); assert.equal(bob.lastSeenAt, 2000);
  assert.ok(s.entityHistory('bob').some(o => o.packetId === first.id && !o.visual && o.text === t.text));
  assert.ok(s.entityHistory('bob').filter(o => o.visual).every(o => o.observedAt === 2000));
  assert.deepEqual(s.encounters().map(e => [e.personId, e.startAt]), [['bob', 2000]]); s.close();
});

test('batch face registration rolls back on failure and mixed sessions are rejected', () => {
  const s = store(); const first = packet(s, 'first', 1000); const second = packet(s, 'second', 2000, [{ id: 'bob', name: 'Bob' }]);
  const bad = delta(); bad.facts.push({ entityRefs: ['missing'], text: 'Invalid link', visual: true,
    transcriptKeys: [], attribute: null, value: null, confidence: 'observed' });
  const batch: MemoryBatch = { updates: [
    { packetId: first.id, packetVersion: 1, delta: bad, reuse: [] },
    { packetId: second.id, packetVersion: 1, delta: delta(), reuse: [] },
  ] };
  assert.throws(() => s.commitBatch([first, second], batch), /Unknown fact entity/);
  assert.equal(s.entity('bob'), null); assert.equal(s.encounters().length, 0); assert.equal(s.history().length, 0);
  assert.throws(() => s.commitBatch([first, { ...second, sessionId: 'other-session' }], batch), /share one session/);
  assert.equal(s.stats().packets, 0); s.close();
});

test('multi-target relationships retain text and links without writing ambiguous attributes', () => {
  const s = store(); s.commit(packet(s, 'before', 1000), keys(null, 'on the desk'));
  const keyId = s.entities()[0].id;
  const d = keys(keyId, 'in the room', 'before');
  d.entities.push({ ref: 'room', existingId: null, personId: null, kind: 'place', label: 'Work area', description: 'A shared work area' });
  d.facts[0] = { ...d.facts[0], entityRefs: ['keys', 'room'], text: 'The keys are beside the work area.' };
  s.commit(packet(s, 'relation', 2000), d);
  const room = s.entities().find(e => e.kind === 'place')!;
  assert.equal(s.entity(keyId)!.attributes.location.value, 'on the desk'); assert.deepEqual(room.attributes, {});
  const relation = s.observations().find(o => o.text === 'The keys are beside the work area.')!;
  assert.deepEqual(new Set(relation.entityIds), new Set([keyId, room.id]));
  s.commit(packet(s, 'single-target', 3000), keys(keyId, 'in the bag', 'before'));
  assert.equal(s.entity(keyId)!.attributes.location.value, 'in the bag'); assert.deepEqual(s.entity(room.id)!.attributes, {}); s.close();
});

test('batch rejects mismatched rows, invalid backward references and identity conflicts atomically', () => {
  const cases: [string, (batch: MemoryBatch) => void][] = [
    ['row order', b => b.updates.reverse()],
    ['version', b => { b.updates[1].packetVersion = 2; }],
    ['length', b => { b.updates.pop(); }],
    ['forward', b => { b.updates[0].reuse = [{ ref: 'keys', fromPacketId: 'p2', fromRef: 'keys' }]; }],
    ['missing target', b => { b.updates[1].reuse[0].ref = 'missing'; }],
    ['missing source', b => { b.updates[1].reuse[0].fromRef = 'missing'; }],
    ['outside batch', b => { b.updates[1].reuse[0].fromPacketId = 'outside'; }],
    ['duplicate link', b => { b.updates[1].reuse.push({ ...b.updates[1].reuse[0] }); }],
    ['explicit existing identity', b => { b.updates[1].delta.entities[0].existingId = 'some-id'; }],
    ['explicit person identity', b => { b.updates[1].delta.entities[0].personId = 'gallery-id'; }],
    ['kind conflict', b => { b.updates[1].delta.entities[0].kind = 'person'; }],
    ['duplicate entity ref', b => { b.updates[1].delta.entities.push({ ...b.updates[1].delta.entities[0] }); }],
    ['duplicate resolved identity', b => {
      b.updates[1].delta.entities.push({ ...b.updates[1].delta.entities[0], ref: 'other' });
      b.updates[1].reuse.push({ ...b.updates[1].reuse[0], ref: 'other' });
    }],
  ];
  for (const [name, mutate] of cases) {
    const s = store(); const packets = [packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), packet(s, 'p2', 2000)];
    const batch: MemoryBatch = { updates: packets.map((p, i) => ({ packetId: p.id, packetVersion: 1,
      delta: keys(null, 'on desk'), reuse: i ? [{ ref: 'keys', fromPacketId: 'p1', fromRef: 'keys' }] : [] })) };
    mutate(batch); assert.throws(() => s.commitBatch(packets, batch), /./, name);
    assert.equal(s.entities().length, 0, name); assert.equal(s.history().length, 0, name);
    assert.equal(s.encounters().length, 0, name); assert.equal(s.stats().packets, 0, name);
    assert.ok(s.pendingCaptures().every(c => c.status === 'ready'), name); s.close();
  }
});

test('a later batch failure restores superseded vectors, capture status, history and encounters', () => {
  const s = store(); const t = transcript(); s.saveTranscript(t);
  const original = speechPacket(packet(s, 'p1', 1000, [{ id: 'bob', name: 'Bob' }]), t);
  s.commit(original, speechDelta(t)); const note = s.observations().find(o => o.text === t.text)!;
  s.putEmbedding(note.id, [1, 0, 0]);
  const next = packet(s, 'p2', 2000, [{ id: 'alice', name: 'Alice' }]);
  const correction = { ...original, version: 2, correction: true };
  const bad = delta(); bad.facts.push({ ...speechDelta(t).facts[0], transcriptKeys: [], visual: true, entityRefs: ['missing'] });
  const stats = s.stats(), encounters = s.encounters(), history = s.history();
  assert.throws(() => s.commitBatch([correction, next], { updates: [
    { packetId: 'p1', packetVersion: 2, delta: speechDelta(t, 'An exam is on Monday.'), reuse: [] },
    { packetId: 'p2', packetVersion: 1, delta: bad, reuse: [] },
  ] }), /Unknown fact entity/);
  assert.deepEqual(s.stats(), stats); assert.deepEqual(s.encounters(), encounters); assert.deepEqual(s.history(), history);
  assert.equal(s.search([1, 0, 0])[0].id, note.id); assert.equal(s.getCapture('p1')!.status, 'committed');
  assert.equal(s.getCapture('p2')!.status, 'ready'); s.close();
});

test('correction aliases may refer to a different verified person without changing the old history', () => {
  const s = store(); s.commit(packet(s, 'gallery', 500, [{ id: 'bob', name: 'Bob' }, { id: 'alice', name: 'Alice' }]), delta());
  const first = transcript(1, 'Bob brought the keys'); s.saveTranscript(first);
  const p = speechPacket(packet(s, 'speech', 1000), first); const original = speechDelta(first);
  original.entities.push({ ref: 'person', existingId: 'bob', personId: 'bob', kind: 'person', label: 'Bob', description: 'Known person' });
  original.facts[0].entityRefs = ['person']; s.commit(p, original);
  const corrected = transcript(2, 'Alice brought the keys'); s.saveTranscript(corrected);
  const replacement = speechDelta(corrected);
  replacement.entities.push({ ref: 'person', existingId: 'alice', personId: 'alice', kind: 'person', label: 'Alice', description: 'Known person' });
  replacement.facts[0].entityRefs = ['person'];
  s.commit({ ...speechPacket(p, corrected), version: 2, correction: true }, replacement);
  assert.ok(s.entityHistory('bob').some(o => o.text === first.text && o.superseded));
  assert.ok(s.entityHistory('alice').some(o => o.text === corrected.text && !o.superseded));
  assert.equal(s.entities().length, 2); s.close();
});

test('a new proposal in a correction does not silently reuse the old revision alias', () => {
  const s = store(); const original = transcript(1, 'I met Bob'); s.saveTranscript(original);
  const p = speechPacket(packet(s, 'p1', 1000), original); const d = speechDelta(original);
  d.entities.push({ ref: 'person', existingId: null, personId: null, kind: 'person', label: 'Bob', description: 'Named in speech, identity unverified' });
  d.facts[0].entityRefs = ['person']; s.commit(p, d);
  const corrected = transcript(2, 'I met Rob'); s.saveTranscript(corrected);
  d.entities[0].label = 'Rob'; d.facts[0] = { ...d.facts[0], text: corrected.text, transcriptKeys: [transcriptKey(corrected)] };
  s.commit({ ...speechPacket(p, corrected), version: 2, correction: true }, d);
  assert.deepEqual(new Set(s.entities().map(e => e.label)), new Set(['Unknown person', 'Rob']));
  assert.ok(s.observations({ includeSuperseded: true }).some(o => o.text === original.text && o.superseded)); s.close();
});

test('retrying an older failed capture restores its bounded historical encounter', () => {
  const s = store(); const bob = packet(s, 'bob', 1000, [{ id: 'bob', name: 'Bob' }]); s.setCaptureStatus('bob', 'failed', 'Transient model error');
  const gap = packet(s, 'gap', 1500); s.setCaptureStatus('gap', 'failed', 'Missing inference');
  s.commit(packet(s, 'alice', 2000, [{ id: 'alice', name: 'Alice' }]), delta());
  assert.deepEqual(s.encounters().map(e => e.personId), ['alice']); s.commit(bob, delta());
  assert.deepEqual(s.encounters().map(e => [e.personId, e.startAt, e.endAt]), [['bob', 1000, 2000], ['alice', 2000, null]]);
  assert.equal(s.getCapture(gap.id)!.status, 'failed'); s.close();
});

test('an older corrected ending retains the boundary and exposes contradictory later ongoing evidence', () => {
  const s = store(); const d = delta();
  d.entities.push({ ref: 'class', existingId: null, kind: 'event', personId: null, label: 'Class', description: 'This occurrence' });
  d.events.push({ entityRef: 'class', status: 'ongoing', summary: 'The class is continuing' });
  s.commit(packet(s, 'p1', 1000), d); const id = s.entities()[0].id; d.entities[0].existingId = id;
  const second = packet(s, 'p2', 2000); s.commit(second, d); s.commit(packet(s, 'p3', 3000), d);
  d.events[0] = { entityRef: 'class', status: 'ended', summary: 'The class ended at this frame' };
  s.commit({ ...second, version: 2, correction: true }, d);
  const event = s.events()[0]; assert.equal(event.status, 'ended'); assert.equal(event.endAt, 2000);
  assert.deepEqual(event.conflicts, [{ packetId: 'p3', observedAt: 3000, summary: 'The class is continuing' }]);
  assert.equal(event.summary, 'The class ended at this frame');
  const notes = s.entityHistory(id).filter(o => o.packetId === 'p2');
  assert.ok(notes.some(o => o.packetVersion === 1 && o.superseded));
  assert.ok(notes.some(o => o.packetVersion === 2 && !o.superseded && o.text.includes('ended'))); s.close();
});

test('legacy packet aliases migrate to exact saved versions and remain reusable in a batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kawk-store-alias-')); const path = join(dir, 'memory.sqlite');
  try {
    let s = new Store(path, 3, 'test-vectors'); s.createSession('s', 0);
    const first = packet(s, 'p1', 1000); s.commit(first, keys(null, 'on desk')); const id = s.entities()[0].id;
    const correction = { ...first, version: 2, correction: true }; s.commit(correction, keys(id, 'on desk')); s.close();
    const old = new Database(path); old.exec(`ALTER TABLE entity_refs RENAME TO version_refs;
      CREATE TABLE entity_refs(packet_id TEXT NOT NULL,ref TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(packet_id,ref));
      INSERT INTO entity_refs SELECT packet_id,ref,entity_id FROM version_refs WHERE packet_version=1;
      DROP TABLE version_refs;`); old.close();
    s = new Store(path, 3, 'test-vectors'); const next = packet(s, 'p2', 2000);
    s.commitBatch([correction, next], { updates: [
      { packetId: 'p1', packetVersion: 2, delta: keys(id, 'on desk'), reuse: [] },
      { packetId: 'p2', packetVersion: 1, delta: keys(null, 'in bag', 'p1'), reuse: [{ ref: 'keys', fromPacketId: 'p1', fromRef: 'keys' }] },
    ] });
    assert.equal(s.entities().length, 1); assert.equal(s.entity(id)!.attributes.location.value, 'in bag'); s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
