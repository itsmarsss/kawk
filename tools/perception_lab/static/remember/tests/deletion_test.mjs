// Deleting people and marked moments from the UI.
//   - contracts: 'profile.deleted' event + 'profile.delete' command
//   - store: cascade (notes, reminders, encounters, moment tags, answers, display), tombstones that
//     survive a reload and block late upserts, and clip references dropped on moment.deleted
//   - demo provider: people-only deletion, scenarios never resurrect a deleted person
//   - live provider: the dispatch resolves on ack and rejects on v1.error (no pretend success)
//   - rendering: visible Delete controls with accessible names; no nested interactive elements
import { check, eq, fakeClock } from './harness.mjs';
import { fakeDocument, FakeNode } from './decision_render_test.mjs';
import { createStore, select, restore, reduce } from '../store/store.js';
import { createPersistence, memoryStorage } from '../store/persist.js';
import { makeEnvelope, validateEnvelope } from '../contracts/envelope.js';
import { createDemoProvider } from '../providers/demo_provider.js';
import { createV1Provider, SESSION_KEY } from '../live/v1_provider.js';
import { ACTORS } from '../fixtures/fixtures.js';

const S = 'ses_del';
const T0 = '2026-09-19T14:00:00.000Z';
const T1 = '2026-09-19T14:01:00.000Z';
let n = 0;
const env = (type, payload, extra = {}) => makeEnvelope(type, payload, { session_id: S, occurred_at: T0, event_id: `del_${++n}`, ...extra });
const P = (over = {}) => ({ schema_version: '1.0', id: 'p1', kind: 'person', name: 'Maya', created_at: T0, source: 'introduction', ...over });
const E = (over = {}) => ({ schema_version: '1.0', id: 'e1', profile_id: 'p1', started_at: T1, location: 'hall', confidence: 'ok', source: 'demo-fixture', ...over });
const N = (over = {}) => ({ schema_version: '1.0', id: 'n1', profile_id: 'p1', text: 'hi', created_at: T0, updated_at: T0, source: 'user', ...over });
const R = (over = {}) => ({ schema_version: '1.0', id: 'r1', profile_id: 'p1', text: 'x', status: 'active', created_at: T0, updated_at: T0, source: 'user', ...over });
const CLIP = (over = {}) => ({ id: 'c1', url: '/static/remember/fixtures/keys-moment.mp4', mime: 'video/mp4', requested_start_at: '2026-09-19T13:59:55.000Z', requested_end_at: '2026-09-19T14:00:05.000Z', start_at: '2026-09-19T13:59:55.000Z', end_at: '2026-09-19T14:00:05.000Z', duration_s: 10, coverage: 'complete', provenance: { kind: 'demo-fixture' }, ...over });
const M = (over = {}) => ({ schema_version: '1.0', id: 'm1', title: 'Coffee with Maya', event_at: T0, status: 'saved', clip: CLIP(), profile_ids: ['p1', 'p2'], source: 'demo-fixture', ...over });
const A = (over = {}) => ({ query_id: 'q1', question: 'who is this', kind: 'found', text: 'Maya.', answered_at: T1, ...over });
const DISPLAY = (over = {}) => ({ schema_version: '1.0', id: 'd1', display: { w: 240, h: 240 }, card: { template: 'profile', title: 'Maya', body: 'Met earlier', image_ref: null, reminder: null }, blit: null, ttl_ms: 0, priority: 10, issued_at: T0, expires_at: null, ...over });
const SNAP = (over = {}) => ({ session_id: S, status: null, profiles: [], notes: [], encounters: [], reminders: [], moments: [], ...over });

function seeded() {
  const storage = memoryStorage();
  const store = createStore({ persistence: createPersistence(storage, 'remember.ui.v1.demo'), now: () => Date.parse(T0) });
  store.hydrate(SNAP({
    profiles: [P(), P({ id: 'p2', name: 'Alex' })],
    notes: [N(), N({ id: 'n2', profile_id: 'p2' })],
    reminders: [R(), R({ id: 'r2', profile_id: 'p2' })],
    encounters: [E({ ended_at: T1 }), E({ id: 'e2', profile_id: 'p2', ended_at: T1 })],
    moments: [M()],
  }));
  return { store, storage };
}

/* ------------------------------------------------------------------ helpers (fake DOM) */
function* walk(el) { yield el; for (const c of el.children ?? []) if (c instanceof FakeNode) yield* walk(c); }
const all = (root, pred) => [...walk(root)].filter(pred);
const isInteractive = (e) => e.tagName === 'BUTTON' || e.tagName === 'A';
const label = (e) => e.attrs?.['aria-label'] ?? e.textContent;
/** Every interactive element must have no interactive descendant (a11y: no nested controls). */
function nestedInteractive(root) {
  return all(root, isInteractive).filter((e) => all(e, isInteractive).length > 1);
}

export async function run() {
  console.log('\n# deletion: contracts');
  {
    check(validateEnvelope(env('profile.deleted', { profile_id: 'p1' })).ok, 'profile.deleted with profile_id accepted');
    check(!validateEnvelope(env('profile.deleted', {})).ok, 'profile.deleted without profile_id rejected');
    check(!validateEnvelope(env('profile.deleted', { profile_id: 7 })).ok, 'profile.deleted with non-string id rejected');
  }

  console.log('\n# deletion: store cascade');
  {
    const { store } = seeded();
    store.apply(env('answer.pending', { query_id: 'q1', question: 'who is this' }));
    store.apply(env('answer.resolved', { answer: A({ profile_id: 'p1' }) }, { event_id: 'a0' }));
    eq(store.getState().answer.latest?.profile_id, 'p1', 'answer about Maya is on screen');
    store.apply(env('display.updated', { action: DISPLAY() }));
    store.apply(env('encounter.started', { encounter: E({ id: 'e3', ended_at: undefined }) }));
    store.apply(env('recognition.updated', { recognition: { track_id: 't1', kind: 'person', state: 'resolved', label: 'Maya', started_at: T0, profile_id: 'p1' } }));
    eq(select.activeProfile(store.getState())?.id, 'p1', 'Maya is in view before the delete');
    const r = store.apply(env('profile.deleted', { profile_id: 'p1' }));
    eq(r.applied, true, 'profile.deleted applied');
    const s = store.getState();
    eq(s.profiles.p1, undefined, 'profile removed');
    eq(Object.keys(s.profiles), ['p2'], 'other profile kept');
    eq(Object.keys(s.notes), ['n2'], 'her notes removed, others kept');
    eq(Object.keys(s.reminders), ['r2'], 'her reminders removed, others kept');
    eq(Object.keys(s.encounters).sort(), ['e2'], 'her encounters (incl. the active one) removed');
    eq(s.active_encounter_id, null, 'nothing is in view any more');
    eq(s.recognition, null, 'recognition pointing at her cleared');
    eq(s.moments.m1.status, 'saved', 'moment kept');
    eq(s.moments.m1.clip?.id, 'c1', 'clip kept');
    eq(s.moments.m1.profile_ids, ['p2'], 'moment untagged from the deleted person only');
    eq(s.answer.latest, null, 'answer about the deleted person cleared');
    eq(s.display, null, 'profile card about her dropped from the display mirror');
    eq(s.deleted_profile_ids, ['p1'], 'tombstoned');
    // A moment with only her tag keeps its clip with no tags.
    store.apply(env('moment.saved', { moment: M({ id: 'm2', profile_ids: ['p1'] }) }));
    eq(store.getState().moments.m2?.profile_ids, [], 'late saved moment arrives untagged');
    eq(store.getState().moments.m2?.status, 'saved', '…and is still saved (clips are never erased)');
  }

  console.log('\n# deletion: tombstones block resurrection');
  {
    const { store } = seeded();
    store.apply(env('profile.deleted', { profile_id: 'p1' }));
    check(!store.apply(env('profile.upserted', { profile: P() })).applied, 'late profile.upserted dropped');
    check(!store.apply(env('encounter.started', { encounter: E({ id: 'e9' }) })).applied, 'late encounter.started dropped');
    check(!store.apply(env('note.upserted', { note: N({ id: 'n9' }) })).applied, 'late note.upserted dropped');
    check(!store.apply(env('reminder.upserted', { reminder: R({ id: 'r9' }) })).applied, 'late reminder.upserted dropped');
    check(!store.apply(env('profile.deleted', { profile_id: 'p1' })).applied, 'repeated profile.deleted is stale, not an error');
    eq(store.getState().profiles.p1, undefined, 'still gone');
    eq(select.activeEncounter(store.getState()), null, 'no encounter came back');
    check(store.apply(env('profile.upserted', { profile: P({ id: 'p3', name: 'New Maya' }) })).applied, 'a NEW id for the same person is accepted (re-enrolment)');
    check(store.apply(env('profile.deleted', { profile_id: 'never_seen' })).applied, 'deleting an id this client never saw still tombstones it (other live sessions)');
    check(!store.apply(env('profile.upserted', { profile: P({ id: 'never_seen' }) })).applied, '…and blocks its late upsert');
  }

  console.log('\n# deletion: any person deletion clears answers (mirrors the server)');
  {
    const SEG = (over = {}) => ({ schema_version: '1.0', id: 'seg1', text: 'I prefer coffee.', is_final: true, started_at: T0, updated_at: T0, speaker: 'unknown', directed: 'conversation', ...over });
    const { store } = seeded();
    // generic recall answer: no profile_id, but its context lines are Maya's notes
    store.apply(env('answer.pending', { query_id: 'q_recall', question: 'recall notes about Maya' }));
    store.apply(env('answer.resolved', { answer: A({ query_id: 'q_recall', question: 'recall notes about Maya', text: '1 note about Maya', context: ['hi'] }) }));
    eq(store.getState().answer.latest?.text, '1 note about Maya', 'generic recall answer shown');
    store.apply(env('transcript.updated', { segment: SEG({ memory: { state: 'saved', note_id: 'n1', profile_id: 'p1', profile_name: 'Maya' } }) }));
    store.apply(env('transcript.updated', { segment: SEG({ id: 'seg2', text: 'Alex likes tea.', memory: { state: 'saved', note_id: 'n2', profile_id: 'p2', profile_name: 'Alex' } }) }));
    store.apply(env('profile.deleted', { profile_id: 'p1' }));
    eq(store.getState().answer.latest, null, 'generic recall answer (no profile_id) cleared on deletion');
    eq(store.getState().answer.pending, null, 'no pending answer either');
    const t = store.getState().transcript;
    eq(t.map((x) => x.text), ['I prefer coffee.', 'Alex likes tea.'], 'raw transcript text retained');
    eq(t[0].memory, undefined, 'memory metadata pointing at Maya removed');
    eq(t[1].memory?.profile_id, 'p2', 'other person’s memory metadata kept');
    // late events after the tombstone
    check(!store.apply(env('transcript.updated', { segment: SEG({ id: 'seg3', memory: { state: 'saved', note_id: 'n9', profile_id: 'p1', profile_name: 'Maya' } }) })).applied === false, 'late segment is applied…');
    const late = store.getState().transcript.find((x) => x.id === 'seg3');
    eq(late?.text, 'I prefer coffee.', '…with its text');
    eq(late?.memory, undefined, '…but its memory metadata for the tombstoned person stripped');
    store.apply(env('answer.pending', { query_id: 'q_late', question: 'who is this' }));
    const r = store.apply(env('answer.resolved', { answer: A({ query_id: 'q_late', profile_id: 'p1', text: 'Maya.' }) }));
    eq(r.applied, false, 'late answer explicitly about the deleted person rejected');
    check(/deleted profile/.test(r.reason), 'reason names the deleted profile');
    eq(store.getState().answer.pending?.query_id, 'q_late', 'question stays pending for a later honest answer');
    check(store.apply(env('answer.resolved', { answer: A({ query_id: 'q_late', kind: 'not_found', text: 'Nobody I know.' }) })).applied, 'a non-person answer to the same question is accepted');
    // a pending decision is cleared too
    store.apply(env('answer.pending', { query_id: 'q_p', question: 'who is Alex' }));
    store.apply(env('profile.deleted', { profile_id: 'p2' }));
    eq(store.getState().answer.pending, null, 'pending decision cleared by a person deletion');
  }

  console.log('\n# deletion: display cleared only when it shows the deleted person');
  {
    const { store } = seeded();
    store.apply(env('display.updated', { action: DISPLAY({ card: { template: 'answer', title: 'Keys', body: 'On the desk', image_ref: null, reminder: null } }) }));
    store.apply(env('profile.deleted', { profile_id: 'p1' }));
    eq(store.getState().display?.id, 'd1', 'an unrelated answer card stays');
    const { store: s2 } = seeded();
    s2.apply(env('display.updated', { action: DISPLAY({ card: { template: 'profile', title: 'Alex', body: '', image_ref: null, reminder: { id: 'r1', text: 'x' } } }) }));
    s2.apply(env('profile.deleted', { profile_id: 'p1' }));
    eq(s2.getState().display, null, 'a card carrying one of her reminders is dropped');
  }

  console.log('\n# deletion: reload keeps demo deletions (tombstones + cascade in restore)');
  {
    const { store, storage } = seeded();
    store.apply(env('profile.deleted', { profile_id: 'p1' }));
    const saved = JSON.parse(storage.getItem('remember.ui.v1.demo'));
    eq(saved.deleted_profile_ids, ['p1'], 'tombstone persisted');
    const restored = restore(saved);
    eq(restored.deleted_profile_ids, ['p1'], 'tombstone restored');
    eq(restored.profiles.p1, undefined, 'profile absent after restore');
    // Defensive: a persisted blob that still carries her rows (older write) is cleaned on restore.
    const dirty = { ...saved, profiles: { ...saved.profiles, p1: P() }, notes: { ...saved.notes, n1: N() }, reminders: { ...saved.reminders, r1: R() }, encounters: { ...saved.encounters, e1: E({ ended_at: T1 }) }, moments: { m1: M() } };
    const cleaned = restore(dirty);
    eq(cleaned.profiles.p1, undefined, 'stale profile row dropped on restore');
    eq(cleaned.notes.n1, undefined, 'stale note dropped on restore');
    eq(cleaned.reminders.r1, undefined, 'stale reminder dropped on restore');
    eq(cleaned.encounters.e1, undefined, 'stale encounter dropped on restore');
    eq(cleaned.moments.m1.profile_ids, ['p2'], 'moment untagged on restore, clip kept');
    // A second store over the same storage (page reload) starts from the cleaned state, and a live
    // snapshot (authoritative) replaces tombstones rather than accumulating them.
    const again = createStore({ persistence: createPersistence(storage, 'remember.ui.v1.demo'), now: () => Date.parse(T0) });
    eq(again.getState().hydrated, true, 'reload restores without re-seeding');
    eq(again.getState().profiles.p1, undefined, 'deleted person does not return after reload');
    again.hydrate(SNAP({ profiles: [P()] }));
    eq(again.getState().deleted_profile_ids, [], 'authoritative snapshot resets tombstones');
    eq(again.getState().profiles.p1?.name, 'Maya', 'snapshot contents win');
  }

  console.log('\n# deletion: moment.deleted drops clip references');
  {
    const { store } = seeded();
    store.apply(env('answer.pending', { query_id: 'q1', question: 'who is this' }));
    store.apply(env('answer.resolved', { answer: A({ moment_id: 'm1', profile_id: 'p2', text: 'Here is the clip.' }) }, { event_id: 'a1' }));
    eq(store.getState().answer.latest?.moment_id, 'm1', 'answer references the clip');
    store.apply(env('moment.saved', { moment: M({ id: 'm3', profile_ids: ['p2'] }) }));
    eq(store.getState().profiles.p2.last_moment_id, 'm3', 'last_moment_id points at the new clip');
    store.apply(env('moment.deleted', { moment_id: 'm1' }));
    eq(store.getState().answer.latest?.text, 'Here is the clip.', 'answer text stays');
    eq(store.getState().answer.latest?.moment_id, undefined, 'answer no longer references the deleted clip');
    store.apply(env('moment.deleted', { moment_id: 'm3' }));
    eq(store.getState().profiles.p2.last_moment_id, undefined, 'last_moment_id cleared when that moment is deleted');
    eq(store.getState().deleted_moment_ids.sort(), ['m1', 'm3'], 'moment tombstones kept');
    // reduce() is pure: a moment.deleted for an unknown id is harmless
    const s = reduce(store.getState(), env('moment.deleted', { moment_id: 'nope' }));
    eq(Object.keys(s.moments).length, 0, 'unknown moment id: nothing else changes');
  }

  console.log('\n# deletion: demo provider');
  {
    const clock = fakeClock();
    const storage = memoryStorage();
    const store = createStore({ persistence: createPersistence(storage), now: clock.now });
    const provider = createDemoProvider({ clock, getState: store.getState });
    const invalid = [];
    store.hydrate(await provider.getSnapshot());
    store.bindSession(provider.sessionId);
    provider.subscribe((e) => { const v = validateEnvelope(e); if (!v.ok) invalid.push(v.reason); store.apply(e); });
    // people only
    await provider.dispatch({ type: 'profile.delete', payload: { profile_id: ACTORS.keys.id } }).then(() => check(false, 'object delete should reject'), (err) => check(/Only people/.test(err.message), 'deleting a thing is refused'));
    await provider.dispatch({ type: 'profile.delete', payload: { profile_id: 'nobody' } }).then(() => check(false, 'unknown delete should reject'), (err) => check(/not in the demo data/.test(err.message), 'deleting an unknown person is refused'));
    eq(select.people(store.getState()).length, 1, 'nothing deleted by the refused commands');
    // Alex in view with a seeded reminder → delete him while in view
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    clock.advance(2000);
    eq(select.activeProfile(store.getState())?.id, ACTORS.alex.id, 'Alex is in view');
    await provider.dispatch({ type: 'profile.delete', payload: { profile_id: ACTORS.alex.id } });
    const s = store.getState();
    eq(s.profiles[ACTORS.alex.id], undefined, 'Alex removed');
    eq(select.notesFor(s, ACTORS.alex.id).length, 0, 'his notes removed');
    eq(select.remindersFor(s, ACTORS.alex.id).length, 0, 'his reminder removed');
    eq(select.encountersFor(s, ACTORS.alex.id).length, 0, 'his encounters removed');
    eq(select.activeProfile(s), null, 'nobody in view');
    eq(s.deleted_profile_ids, [ACTORS.alex.id], 'tombstoned in the store');
    // the scene that would have re-shown him ends without resurrecting him
    clock.advance(15_000);
    eq(store.getState().profiles[ACTORS.alex.id], undefined, 'scene tail does not bring Alex back');
    // running his scenarios again: recognised as nobody, moment saved without his tag
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    clock.advance(1500);
    eq(store.getState().recognition?.state, 'unresolved', 'Teammate arrives now shows an unresolved recognition');
    check(/deleted/.test(store.getState().recognition?.label ?? ''), 'label says the person was deleted');
    eq(store.getState().profiles[ACTORS.alex.id], undefined, 'no profile re-created');
    clock.advance(12_000);
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'significant_moment' } });
    clock.advance(8_000);
    const pitch = select.moments(store.getState()).find((m) => m.id.startsWith('moment_pitch'));
    eq(pitch?.status, 'saved', 'significant moment still saves its clip');
    eq(pitch?.profile_ids, [], '…without tagging the deleted person');
    eq(store.getState().profiles[ACTORS.alex.id], undefined, 'significant_moment did not re-create Alex');
    // ask about him → not found, phrased for the demo
    await provider.dispatch({ type: 'ask', payload: { text: 'who is Alex?' } });
    clock.advance(1000);
    eq(store.getState().answer.latest?.kind, 'not_found', 'asking about a deleted person is not found');
    // reload: a fresh provider over the persisted store still treats him as deleted
    const store2 = createStore({ persistence: createPersistence(storage), now: clock.now });
    eq(store2.getState().profiles[ACTORS.alex.id], undefined, 'reload: Alex still gone');
    const provider2 = createDemoProvider({ clock, getState: store2.getState });
    store2.bindSession(provider2.sessionId);
    provider2.subscribe((e) => store2.apply(e));
    await provider2.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    clock.advance(1500);
    eq(store2.getState().profiles[ACTORS.alex.id], undefined, 'reload: scenario does not seed him again');
    eq(store2.getState().recognition?.state, 'unresolved', 'reload: provider read the persisted tombstone');
    // Maya: introduce, delete, introduce again → a NEW person (fresh id), not a resurrection
    clock.advance(20_000);
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    clock.advance(5_000);
    eq(store.getState().profiles[ACTORS.maya.id]?.name, 'Maya', 'Maya created by the introduction');
    await provider.dispatch({ type: 'profile.delete', payload: { profile_id: ACTORS.maya.id } });
    eq(store.getState().profiles[ACTORS.maya.id], undefined, 'Maya deleted');
    eq(store.getState().notes[ACTORS.maya.introNoteId], undefined, 'her introduction note deleted');
    clock.advance(10_000);
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    clock.advance(5_000);
    const mayas = select.people(store.getState()).filter((p) => p.name === 'Maya');
    eq(mayas.length, 1, 'introducing herself again creates exactly one Maya');
    check(mayas[0] && mayas[0].id !== ACTORS.maya.id, 'the re-created Maya has a new id');
    eq(mayas[0]?.actor_key, ACTORS.maya.id, 'the fixture actor key is kept for answers');
    eq(select.notesFor(store.getState(), mayas[0]?.id).length, 1, 'her new introduction note is attached to the new id');
    await provider.dispatch({ type: 'ask', payload: { text: 'who is Maya?' } });
    clock.advance(1000);
    eq(store.getState().answer.latest?.kind, 'found', 'asking about the re-created Maya finds her');
    eq(store.getState().answer.latest?.profile_id, mayas[0]?.id, '…by her new id');
    eq(invalid.length, 0, 'every emitted envelope valid');
    await provider.stop();
  }

  console.log('\n# deletion: live dispatch is honest (ack resolves, v1.error rejects)');
  {
    class FakeWS {
      static instances = [];
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; FakeWS.instances.push(this); }
      send(data) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(data); }
      close() { this.readyState = 3; this.onclose?.({ reason: 'client' }); }
      open() { this.readyState = 1; this.onopen?.(); }
      message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
      json() { return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)); }
    }
    const base = fakeClock();
    const clock = { nowMs: () => 0, now: base.now, setTimeout: base.setTimeout, clearTimeout: base.clearTimeout };
    const snap = { schema_version: '1.0', session_id: 'sid', status: null, profiles: [], notes: [], encounters: [], reminders: [], moments: [], display: null };
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ session_id: 'sid', snapshot: snap, websocket_url: '/ws/v1/sid' }) });
    const storage = new Map();
    const provider = createV1Provider({ getState: () => ({}), capture: null, streams: {}, deps: { fetchImpl, WebSocketImpl: FakeWS, clock, sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) }, location: { protocol: 'http:', host: 'h' } } });
    const events = []; provider.subscribe((e) => events.push(e));
    await provider.getSnapshot(); await provider.start();
    const w = FakeWS.instances.at(-1); w.open(); w.message({ type: 'v1.ack', receipt: { hello: true }, snapshot: snap });
    const p1 = provider.dispatch({ type: 'profile.delete', payload: { profile_id: 'bob' } });
    const cmd1 = w.json().find((m) => m.type === 'command' && m.command.type === 'profile.delete');
    eq(cmd1?.command.payload, { profile_id: 'bob' }, 'profile.delete sent with the profile_id payload');
    w.message({ schema_version: '1.0', event_id: 'srv_1', session_id: 'sid', occurred_at: T0, type: 'profile.deleted', payload: { profile_id: 'bob' } });
    w.message({ type: 'v1.ack', request_id: cmd1.request_id, receipt: { ok: true } });
    eq((await p1).ok, true, 'ack resolves the delete');
    eq(events.at(-1)?.type, 'profile.deleted', 'server envelope delivered to the store path');
    const p2 = provider.dispatch({ type: 'profile.delete', payload: { profile_id: 'zed' } });
    const cmd2 = w.json().filter((m) => m.type === 'command').at(-1);
    w.message({ type: 'v1.error', request_id: cmd2.request_id, message: 'Person deletion is not available in this session' });
    await p2.then(() => check(false, 'should reject'), (err) => check(/not available/.test(err.message), 'v1.error rejects the delete so the UI does not pretend'));
    const p3 = provider.dispatch({ type: 'moment.delete', payload: { moment_id: 'm9' } });
    const cmd3 = w.json().filter((m) => m.type === 'command').at(-1);
    w.message({ type: 'v1.error', request_id: cmd3.request_id, message: 'Unknown moment' });
    await p3.then(() => check(false, 'should reject'), () => check(true, 'moment.delete failure rejects too'));
    const p4 = provider.dispatch({ type: 'moment.delete', payload: { moment_id: 'm10' } });
    base.advance(11_000);
    await p4.then(() => check(false, 'should reject'), (err) => check(/No reply/.test(err.message), 'a silent server times out instead of hanging or succeeding'));
    eq(SESSION_KEY.length > 0, true, 'session key exported');
    await provider.stop();
  }

  console.log('\n# deletion: rendering (People, person detail, moment tiles/rows) — a11y');
  {
    globalThis.document = fakeDocument();
    globalThis.Node = FakeNode;
    const { renderProfiles } = await import('../ui/views/profiles.js');
    const { renderMoments } = await import('../ui/views/moments.js');
    const { momentRow, momentTile } = await import('../ui/components.js');
    const { store } = seeded();
    store.apply(env('moment.recording', { moment: M({ id: 'rec', title: 'Recording one', status: 'recording', clip: null, event_at: T1 }) }));
    store.apply(env('moment.recording', { moment: M({ id: 'bad', title: 'Broken one', status: 'recording', clip: null, event_at: T0 }) }));
    store.apply(env('moment.failed', { moment_id: 'bad', reason: 'Buffer empty' }));
    const calls = { profile: [], moment: [], open: [] };
    const actions = { profile: { remove: (p) => calls.profile.push(p.id) }, moment: { remove: (m) => calls.moment.push(m.id) }, openMoment: (m) => calls.open.push(m.id), reminder: {}, note: {} };
    const ctx = { state: store.getState(), nowMs: Date.parse(T1), actions, mode: 'demo' };

    const people = renderProfiles(ctx, 'person', null);
    const rowDeletes = all(people, (e) => e.tagName === 'BUTTON' && /^Delete (Maya|Alex)$/.test(label(e)));
    eq(rowDeletes.map(label).sort(), ['Delete Alex', 'Delete Maya'], 'each People row has a Delete named for the person');
    eq(nestedInteractive(people).length, 0, 'People list: no interactive element nested in another');
    const things = renderProfiles({ ...ctx, state: { ...ctx.state, profiles: { k: { ...P({ id: 'k', kind: 'object', name: 'Keys', source: 'demo-fixture' }) } } } }, 'object', null);
    eq(all(things, (e) => e.tagName === 'BUTTON' && /Delete/.test(label(e))).length, 0, 'Things rows have no Delete (people only)');

    const detail = renderProfiles(ctx, 'person', 'p1');
    const detailDelete = all(detail, (e) => e.tagName === 'BUTTON' && label(e) === 'Delete Maya');
    eq(detailDelete.length, 1, 'person detail has exactly one Delete person control');
    eq(detailDelete[0].textContent, 'Delete person', 'visible text says Delete person');
    check(/Saved moments are kept/.test(detail.textContent), 'detail explains that saved moments are kept');
    eq(nestedInteractive(detail).length, 0, 'person detail: no nested interactive elements');
    const detailMomentDeletes = all(detail, (e) => e.tagName === 'BUTTON' && /^Delete moment: /.test(label(e)));
    check(detailMomentDeletes.length >= 1, 'moments listed on the profile carry their own Delete');
    const gone = renderProfiles({ ...ctx, mode: 'live' }, 'person', 'nobody');
    check(/deleted/.test(gone.textContent), 'a missing profile page explains it may have been deleted');

    const grid = renderMoments(ctx);
    const tiles = all(grid, (e) => e.tagName === 'ARTICLE' && /moment-tile/.test(e.className));
    eq(tiles.length, 3, 'one tile per moment (saved, recording, failed)');
    const tileDeletes = all(grid, (e) => e.tagName === 'BUTTON' && /^Delete moment: /.test(label(e)));
    eq(tileDeletes.map(label).sort(), ['Delete moment: Broken one', 'Delete moment: Coffee with Maya', 'Delete moment: Recording one'], 'recording, failed and saved tiles all have a named Delete');
    eq(nestedInteractive(grid).length, 0, 'moment grid: no button inside a button');
    check(all(grid, (e) => e.tagName === 'BUTTON' && /open/.test(e.className)).length === 3, 'each tile still has its open button');

    // component-level: callbacks reach the right handlers; optional onDelete keeps old call sites working
    const row = momentRow(ctx.state.moments.rec, ctx.nowMs, actions.openMoment, actions.moment.remove);
    eq(all(row, (e) => e.tagName === 'BUTTON').length, 2, 'row = open + delete');
    const legacyRow = momentRow(ctx.state.moments.rec, ctx.nowMs, actions.openMoment);
    eq(all(legacyRow, (e) => e.tagName === 'BUTTON').length, 1, 'row without onDelete renders no Delete (backward compatible)');
    const legacyTile = momentTile(ctx.state.moments.m1, ctx.nowMs, actions.openMoment, ctx.state.profiles);
    eq(all(legacyTile, (e) => e.tagName === 'BUTTON').length, 1, 'tile without onDelete renders no Delete');
    delete globalThis.document; delete globalThis.Node;
  }
}
