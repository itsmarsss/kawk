import { check, eq } from './harness.mjs';
import { createStore, select, restore } from '../store/store.js';
import { createPersistence, memoryStorage } from '../store/persist.js';
import { makeEnvelope, validateEnvelope, sanitizeSnapshot } from '../contracts/envelope.js';

const S = 'ses_test';
const T0 = '2026-09-19T14:00:00.000Z';
const T1 = '2026-09-19T14:01:00.000Z';
const T2 = '2026-09-19T14:02:00.000Z';
const env = (type, payload, extra = {}) => makeEnvelope(type, payload, { session_id: S, occurred_at: T0, ...extra });

// Valid fixture records (the validators are strict on purpose).
const P = (over = {}) => ({ schema_version: '1.0', id: 'p1', kind: 'person', name: 'Maya', created_at: T0, source: 'introduction', ...over });
const E = (over = {}) => ({ schema_version: '1.0', id: 'e1', profile_id: 'p1', started_at: T1, location: 'hall', confidence: 'ok', source: 'demo-fixture', ...over });
const N = (over = {}) => ({ schema_version: '1.0', id: 'n1', profile_id: 'p1', text: 'hi', created_at: T0, updated_at: T0, source: 'user', ...over });
const R = (over = {}) => ({ schema_version: '1.0', id: 'r1', profile_id: 'p1', text: 'x', status: 'active', created_at: T0, updated_at: T0, source: 'user', ...over });
const CLIP = (over = {}) => ({ id: 'c1', url: '/static/remember/fixtures/keys-moment.mp4', mime: 'video/mp4', requested_start_at: '2026-09-19T13:59:55.000Z', requested_end_at: '2026-09-19T14:00:05.000Z', start_at: '2026-09-19T13:59:55.000Z', end_at: '2026-09-19T14:00:05.000Z', duration_s: 10, coverage: 'complete', provenance: { kind: 'demo-fixture' }, ...over });
const M = (over = {}) => ({ schema_version: '1.0', id: 'm1', title: 't', event_at: T0, status: 'recording', clip: null, profile_ids: ['p1'], source: 'demo-fixture', ...over });
const SEG = (over = {}) => ({ schema_version: '1.0', id: 's1', text: 'where are', is_final: false, started_at: T0, updated_at: T0, speaker: 'wearer', directed: 'pending', ...over });
const A = (over = {}) => ({ query_id: 'q1', question: 'where are my keys', kind: 'found', text: 'On the desk.', answered_at: T1, ...over });
const STATUS = (over = {}) => ({ schema_version: '1.0', provider: 'demo', state: 'running', label: 'Demo', session_id: S, camera: 'simulated', microphone: 'simulated', since: T0, ...over });
const SNAP = (over = {}) => ({ session_id: S, status: null, profiles: [], notes: [], encounters: [], reminders: [], moments: [], ...over });

function freshStore() {
  const storage = memoryStorage();
  const store = createStore({ persistence: createPersistence(storage, 'remember.ui.v1.demo'), now: () => Date.parse(T0) });
  store.hydrate(SNAP());
  return { store, storage };
}

export function run() {
  console.log('\n# envelope validation');
  check(validateEnvelope(env('scene.changed', { scene: { kind: 'idle', caption: 'x' } })).ok, 'valid envelope accepted');
  check(!validateEnvelope({ ...env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }), schema_version: '2.0' }).ok, 'major version 2.0 rejected');
  check(validateEnvelope({ ...env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }), schema_version: '1.3' }).ok, 'minor version 1.3 accepted');
  check(!validateEnvelope(env('nope.event', {})).ok, 'unknown type rejected');
  check(!validateEnvelope(env('note.upserted', {})).ok, 'missing payload key rejected');
  check(!validateEnvelope({ ...env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }), occurred_at: 'yesterday' }).ok, 'bad occurred_at rejected');
  check(!validateEnvelope(env('profile.upserted', { profile: null })).ok, 'profile:null rejected (was a crash)');
  check(!validateEnvelope(env('profile.upserted', { profile: P({ kind: 'robot' }) })).ok, 'bad enum rejected');
  check(!validateEnvelope(env('profile.upserted', { profile: P({ created_at: 'soon' }) })).ok, 'bad date rejected');
  check(!validateEnvelope(env('reminder.upserted', { reminder: R({ status: 'later' }) })).ok, 'bad reminder status rejected');
  check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP({ url: 'https://evil.example/x.mp4' }) }) })).ok, 'cross-origin clip url rejected');
  check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP({ url: 'javascript:alert(1)' }) }) })).ok, 'javascript: clip url rejected');
  check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: null }) })).ok, 'saved moment without clip rejected');
  check(!validateEnvelope(env('moment.recording', { moment: M({ clip: CLIP() }) })).ok, 'recording moment with clip rejected');
  check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP({ start_at: '2026-09-19T13:59:50.000Z', duration_s: 15 }) }) })).ok, 'actual bounds outside requested rejected');
  check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP({ start_at: '2026-09-19T13:59:58.000Z', duration_s: 7 }) }) })).ok, 'partial bounds claiming complete rejected');
  check(validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP({ start_at: '2026-09-19T13:59:58.000Z', duration_s: 7, coverage: 'partial' }) }) })).ok, 'partial clip with honest coverage accepted');
  check(!validateEnvelope(env('transcript.updated', { segment: SEG({ is_final: 'yes' }) })).ok, 'non-boolean is_final rejected');
  check(!validateEnvelope({ ...env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }), seq: -1 }).ok, 'negative seq rejected');
  check(validateEnvelope(env('provider.status', { status: STATUS({ camera: 'unknown', microphone: 'unknown' }) })).ok, 'camera unknown accepted');

  console.log('\n# snapshot sanitising');
  {
    eq(sanitizeSnapshot(null).ok, false, 'null snapshot rejected');
    eq(sanitizeSnapshot({ profiles: [] }).ok, false, 'snapshot without session rejected');
    const r = sanitizeSnapshot(SNAP({ profiles: [P(), null, P({ id: 'p2', kind: 'x' })], reminders: 'nope', moments: [M({ status: 'saved', clip: CLIP() })] }));
    eq(r.ok, true, 'partially bad snapshot accepted');
    eq(r.snapshot.profiles.length, 1, 'invalid profiles dropped');
    eq(r.dropped.length, 2, 'drops listed');
    eq(r.snapshot.reminders, [], 'non-array table becomes empty');
    const { store } = freshStore();
    const h = store.hydrate(SNAP({ profiles: [P(), { id: 'zzz' }] }));
    eq(h.dropped.length, 1, 'hydrate reports drops');
    eq(store.getState().diagnostics.rejected.length, 1, 'drops visible in diagnostics');
    eq(store.hydrate({ nope: true }).ok, false, 'malformed snapshot does not replace state');
    eq(Object.keys(store.getState().profiles), ['p1'], 'state intact after bad snapshot');
  }

  console.log('\n# store: dedupe, sessions, rejects never crash');
  {
    const { store } = freshStore();
    const e = env('profile.upserted', { profile: P() }, { event_id: 'evt_1' });
    eq(store.apply(e).applied, true, 'first apply ok');
    eq(store.apply(e).applied, false, 'same event_id dropped');
    eq(store.getState().diagnostics.duplicates, 1, 'duplicate counted');
    const foreign = { ...env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }), session_id: 'ses_other', event_id: 'evt_f' };
    check(store.apply(foreign).reason.startsWith('foreign session'), 'foreign session ignored');
    const bad = store.apply({ ...env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }), schema_version: '9.9', event_id: 'evt_v' });
    check(!bad.applied && store.getState().diagnostics.rejected.length === 2, 'invalid version recorded in diagnostics');
    const r = store.apply(env('profile.upserted', { profile: null }, { event_id: 'evt_null' }));
    check(!r.applied && Object.keys(store.getState().profiles).length === 1, 'profile:null rejected, state intact');
    // Explicit binding (#1): a session.started from another session must NOT revive it.
    const lateStart = { ...env('session.started', { status: STATUS({ session_id: 'ses_old' }) }), session_id: 'ses_old', event_id: 'evt_s' };
    check(!store.apply(lateStart).applied, 'late session.started from an old session rejected');
    eq(store.getState().session_id, S, 'bound session unchanged');
    store.bindSession('ses_new');
    eq(store.getState().session_id, 'ses_new', 'bindSession switches the bound session');
    check(!store.apply(env('scene.changed', { scene: { kind: 'idle', caption: 'x' } }, { event_id: 'evt_oldsess' })).applied, 'old session events rejected after rebind');
    check(store.apply({ ...env('scene.changed', { scene: { kind: 'idle', caption: 'y' } }), session_id: 'ses_new', event_id: 'evt_newsess' }).applied, 'new session events accepted');
  }

  console.log('\n# ordering: seq, stale answers, stale records, tombstones');
  {
    const { store } = freshStore();
    check(store.apply(env('scene.changed', { scene: { kind: 'idle', caption: 'a' } }, { event_id: '1', seq: 5 })).applied, 'seq 5 applied');
    check(!store.apply(env('scene.changed', { scene: { kind: 'idle', caption: 'b' } }, { event_id: '2', seq: 4 })).applied, 'seq 4 after 5 dropped as stale');
    check(!store.apply(env('scene.changed', { scene: { kind: 'idle', caption: 'b' } }, { event_id: '3', seq: 5 })).applied, 'equal seq dropped');
    check(store.apply(env('scene.changed', { scene: { kind: 'idle', caption: 'c' } }, { event_id: '4', seq: 6 })).applied, 'seq 6 applied');
    eq(store.getState().diagnostics.stale, 2, 'stale counted');
    // answers: pending old, pending new, resolved new, resolved old → old ignored
    store.apply(env('answer.pending', { query_id: 'q_old', question: 'old?' }, { event_id: 'a1' }));
    store.apply(env('answer.pending', { query_id: 'q_new', question: 'new?' }, { event_id: 'a2' }));
    store.apply(env('answer.resolved', { answer: A({ query_id: 'q_new', question: 'new?', text: 'NEW' }) }, { event_id: 'a3' }));
    const late = store.apply(env('answer.resolved', { answer: A({ query_id: 'q_old', question: 'old?', text: 'OLD' }) }, { event_id: 'a4' }));
    eq(late.applied, false, 'obsolete answer dropped');
    eq(store.getState().answer.latest.text, 'NEW', 'newest answer stays on screen');
    eq(store.getState().answer.pending, null, 'nothing pending');
    // resolved old while new pending → dropped, new stays pending
    store.apply(env('answer.pending', { query_id: 'q3', question: '3?' }, { event_id: 'a5' }));
    check(!store.apply(env('answer.resolved', { answer: A({ query_id: 'q_new', text: 'again' }) }, { event_id: 'a6' })).applied, 'old result while newer pending dropped');
    eq(store.getState().answer.pending.query_id, 'q3', 'new query still pending');
    // per-record revision
    store.apply(env('note.upserted', { note: N({ text: 'v2', updated_at: T2 }) }, { event_id: 'n1' }));
    check(!store.apply(env('note.upserted', { note: N({ text: 'v1', updated_at: T1 }) }, { event_id: 'n2' })).applied, 'older note revision dropped');
    eq(store.getState().notes.n1.text, 'v2', 'newest note kept');
    store.apply(env('reminder.upserted', { reminder: R({ status: 'completed', updated_at: T2 }) }, { event_id: 'r1' }));
    check(!store.apply(env('reminder.upserted', { reminder: R({ status: 'active', updated_at: T1 }) }, { event_id: 'r2' })).applied, 'older reminder revision dropped');
    // moment status monotonic + tombstones
    store.apply(env('moment.recording', { moment: M() }, { event_id: 'm1' }));
    store.apply(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP() }) }, { event_id: 'm2' }));
    check(!store.apply(env('moment.recording', { moment: M() }, { event_id: 'm3' })).applied, 'recording after saved dropped');
    check(!store.apply(env('moment.failed', { moment_id: 'm1', reason: 'late' }, { event_id: 'm4' })).applied, 'failed after saved dropped');
    store.apply(env('moment.deleted', { moment_id: 'm1' }, { event_id: 'm5' }));
    check(!store.apply(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP() }) }, { event_id: 'm6' })).applied, 'saved for a deleted moment does not resurrect it');
    check(!store.apply(env('moment.recording', { moment: M() }, { event_id: 'm7' })).applied, 'recording for a deleted moment dropped');
    eq(Object.keys(store.getState().moments).length, 0, 'deleted moment stays deleted');
    // partial after final
    store.apply(env('transcript.updated', { segment: SEG({ is_final: true, text: 'final' }) }, { event_id: 't1' }));
    check(!store.apply(env('transcript.updated', { segment: SEG({ text: 'part' }) }, { event_id: 't2' })).applied, 'partial after final dropped');
  }

  console.log('\n# store: profiles / encounters / notes / previous encounter');
  {
    const { store } = freshStore();
    store.apply(env('profile.upserted', { profile: P({ created_at: '2026-09-19T13:00:00.000Z' }) }, { event_id: 'a' }));
    store.apply(env('profile.upserted', { profile: P({ created_at: T0, descriptor: 'again' }) }, { event_id: 'b' }));
    eq(Object.keys(store.getState().profiles).length, 1, 'upsert by stable id does not duplicate');
    eq(store.getState().profiles.p1.created_at, '2026-09-19T13:00:00.000Z', 'upsert keeps original created_at');
    eq(store.getState().profiles.p1.descriptor, 'again', 'upsert updates other fields');
    store.apply(env('encounter.started', { encounter: E() }, { event_id: 'c' }));
    eq(select.activeProfile(store.getState())?.id, 'p1', 'active profile follows encounter');
    eq(select.previousEncounter(store.getState(), 'p1', 'e1'), null, 'no previous encounter → first meeting');
    store.apply(env('encounter.ended', { encounter_id: 'e1', ended_at: T2 }, { event_id: 'd' }));
    eq(select.activeProfile(store.getState()), null, 'encounter ended clears active');
    store.apply(env('encounter.started', { encounter: E({ id: 'e2', started_at: '2026-09-19T15:00:00.000Z' }) }, { event_id: 'e' }));
    eq(select.previousEncounter(store.getState(), 'p1', 'e2')?.id, 'e1', 'previous encounter excludes the active one');
    eq(store.getState().profiles.p1.last_seen_at, '2026-09-19T15:00:00.000Z', 'last_seen_at follows the newest encounter');
    store.apply(env('note.upserted', { note: N() }, { event_id: 'f' }));
    store.apply(env('note.upserted', { note: N({ text: 'edited', updated_at: T1 }) }, { event_id: 'g' }));
    eq(select.notesFor(store.getState(), 'p1').map((n) => n.text), ['edited'], 'note edit replaces by id');
    store.apply(env('note.deleted', { note_id: 'n1' }, { event_id: 'h' }));
    eq(select.notesFor(store.getState(), 'p1').length, 0, 'note deleted');
  }

  console.log('\n# store: transcript, recognition wildcard, session.stopped clears ephemeral state');
  {
    const { store } = freshStore();
    store.apply(env('transcript.updated', { segment: SEG() }, { event_id: '1' }));
    store.apply(env('transcript.updated', { segment: SEG({ text: 'where are my keys', is_final: true }) }, { event_id: '2' }));
    eq(store.getState().transcript.length, 1, 'partial replaced, not appended');
    store.apply(env('recognition.updated', { recognition: { track_id: 'trk_9', kind: 'person', state: 'listening', label: 'Listening…', started_at: T0 } }, { event_id: '3' }));
    store.apply(env('recognition.cleared', { track_id: 'other' }, { event_id: '4' }));
    check(store.getState().recognition, 'clearing another track leaves the card');
    store.apply(env('recognition.cleared', { track_id: '*' }, { event_id: '5' }));
    eq(store.getState().recognition, null, 'wildcard clears any recognition');
    store.apply(env('recognition.updated', { recognition: { track_id: 'trk_10', kind: 'person', state: 'listening', label: 'Listening…', started_at: T0 } }, { event_id: '6' }));
    store.apply(env('transcript.updated', { segment: SEG({ id: 's2', text: 'partial…' }) }, { event_id: '7' }));
    store.apply(env('answer.pending', { query_id: 'q', question: 'x' }, { event_id: '8' }));
    store.apply(env('profile.upserted', { profile: P() }, { event_id: '9' }));
    store.apply(env('encounter.started', { encounter: E() }, { event_id: '10' }));
    store.apply(env('session.stopped', { status: STATUS({ state: 'stopped' }) }, { event_id: '11', occurred_at: T2 }));
    const s = store.getState();
    eq(s.recognition, null, 'session.stopped clears the listening card');
    eq(s.transcript.filter((t) => !t.is_final).length, 0, 'session.stopped drops partials');
    eq(s.answer.pending, null, 'session.stopped drops the pending answer');
    eq(s.active_encounter_id, null, 'session.stopped ends the active encounter');
    eq(s.encounters.e1.ended_at, T2, 'encounter gets an end time');
    eq(s.scene.kind, 'idle', 'scene returns to idle');
  }

  console.log('\n# reminders: due / complete / snooze / dismiss');
  {
    const { store } = freshStore();
    const now = Date.parse(T0);
    store.apply(env('reminder.upserted', { reminder: R() }, { event_id: '1' }));
    eq(select.dueReminders(store.getState(), 'p1', 'e1', now).length, 1, 'active reminder due');
    eq(select.dueReminders(store.getState(), 'p2', 'e1', now).length, 0, 'not due for other profile');
    store.apply(env('reminder.upserted', { reminder: R({ status: 'completed', updated_at: T1 }) }, { event_id: '2' }));
    eq(select.dueReminders(store.getState(), 'p1', 'e1', now).length, 0, 'completed never due');
    store.apply(env('reminder.upserted', { reminder: R({ status: 'snoozed', updated_at: T2, snoozed_until: new Date(now + 15 * 60_000).toISOString() }) }, { event_id: '3' }));
    eq(select.dueReminders(store.getState(), 'p1', 'e1', now).length, 0, 'snoozed not due now');
    eq(select.dueReminders(store.getState(), 'p1', 'e1', now + 16 * 60_000).length, 1, 'snoozed due after snoozed_until');
    store.apply(env('reminder.upserted', { reminder: R({ updated_at: '2026-09-19T14:03:00.000Z', dismissed_for_encounter_id: 'e1' }) }, { event_id: '4' }));
    eq(select.dueReminders(store.getState(), 'p1', 'e1', now).length, 0, 'dismissed hidden for that encounter');
    eq(select.dueReminders(store.getState(), 'p1', 'e2', now).length, 1, 'dismissed shows on the next encounter');
  }

  console.log('\n# moments: recording -> saved / failed; restore is defensive');
  {
    const { store, storage } = freshStore();
    store.apply(env('moment.recording', { moment: M() }, { event_id: '1' }));
    eq(select.moments(store.getState())[0].status, 'recording', 'recording moment present');
    const restored = restore(JSON.parse(storage.getItem('remember.ui.v1.demo')));
    eq(restored.moments.m1.status, 'failed', 'reload marks in-flight recording as failed, not saved');
    eq(restored.session_id, null, 'restored state is unbound until a provider attaches');
    store.apply(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP() }) }, { event_id: '2' }));
    eq(store.getState().moments.m1.status, 'saved', 'saved replaces recording');
    store.apply(env('moment.deleted', { moment_id: 'm1' }, { event_id: '3' }));
    eq(Object.keys(store.getState().moments).length, 0, 'moment deleted');
    // malformed storage
    eq(restore('garbage'), null, 'non-object storage ignored');
    eq(restore({ schema_version: '0.9', hydrated: true }), null, 'other version ignored');
    const messy = JSON.parse(storage.getItem('remember.ui.v1.demo'));
    messy.profiles = { p1: P(), junk: { id: 'junk' }, nul: null };
    messy.reminders = 'not a table';
    messy.transcript = [SEG({ is_final: true }), { garbage: true }, null];
    messy.applied_event_ids = ['ok', 42, null];
    messy.answer = { latest: { broken: true } };
    messy.status = { provider: 'demo' };
    const r = restore(messy);
    eq(Object.keys(r.profiles), ['p1'], 'bad profile records dropped on restore');
    eq(r.reminders, {}, 'bad reminder table dropped');
    eq(r.transcript.length, 1, 'bad transcript rows dropped');
    eq(r.applied_event_ids, ['ok'], 'bad ids dropped');
    eq(r.answer.latest, null, 'bad answer dropped');
    eq(r.status, null, 'bad status dropped');
    const s2 = createStore({ persistence: { load: () => messy, save() {}, clear() {} } });
    check(s2.getState().hydrated, 'store boots from messy storage without throwing');
  }

  console.log('\n# persistence + reset');
  {
    const storage = memoryStorage();
    const store = createStore({ persistence: createPersistence(storage, 'remember.ui.v1.demo') });
    store.hydrate(SNAP({ profiles: [P()] }));
    check(storage.getItem('remember.ui.v1.demo') !== null, 'state persisted under versioned key');
    const again = createStore({ persistence: createPersistence(storage, 'remember.ui.v1.demo') });
    eq(Object.keys(again.getState().profiles), ['p1'], 'state restored from storage');
    again.reset();
    check(storage.getItem('remember.ui.v1.demo') === null, 'reset clears only our key');
    eq(again.getState().hydrated, false, 'reset leaves an empty, un-hydrated state');
  }

  console.log('\n# live V1 events: display.updated, enrollment.updated, clip audio, snapshot display');
  {
    const ACTION = (over = {}) => ({ schema_version: '1.0', id: 'display_1', display: { w: 240, h: 240 }, card: { template: 'profile', title: 'Alex', body: 'Last met: yesterday', image_ref: null, reminder: { id: 'r1', text: 'Ask about the board' } }, blit: null, ttl_ms: 8000, priority: 10, issued_at: T0, expires_at: '2026-09-19T14:00:08.000Z', ...over });
    check(validateEnvelope(env('display.updated', { action: ACTION() })).ok, 'display action accepted');
    check(!validateEnvelope(env('display.updated', { action: ACTION({ card: { template: 'banner', title: 'x', body: '', image_ref: null, reminder: null } }) })).ok, 'unknown template rejected');
    check(!validateEnvelope(env('display.updated', { action: ACTION({ expires_at: '2026-09-19T13:00:00.000Z' }) })).ok, 'expires_at before issued_at rejected');
    check(!validateEnvelope(env('display.updated', { action: ACTION({ card: { template: 'profile', title: 'x', body: '', image_ref: null, reminder: { id: 'r1' } } }) })).ok, 'reminder without text rejected');
    check(validateEnvelope(env('display.updated', { action: ACTION({ card: { template: 'idle', title: '14:00', body: 'Ready', image_ref: null, reminder: null }, ttl_ms: 0, expires_at: null, priority: 0 }) })).ok, 'idle action with no TTL accepted');
    check(validateEnvelope(env('enrollment.updated', { enrollment: { status: 'collecting', message: 'Learning', collected: 2, required: 5, target_track_id: '7', name: 'Maya' } })).ok, 'enrollment state accepted');
    check(!validateEnvelope(env('enrollment.updated', { enrollment: { status: 'done', message: '' } })).ok, 'unknown enrollment status rejected');
    check(validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', source: 'v1-rules', clip: CLIP({ audio: { present: true, coverage: 'partial', captured_duration_s: 6.5 }, provenance: { kind: 'live-ring-buffer', detail: 'Session x; 48 real camera frames' } }) }) })).ok, 'live clip with audio coverage accepted');
    check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', clip: CLIP({ audio: { present: true, coverage: 'some' } }) }) })).ok, 'bad audio coverage rejected');
    check(validateEnvelope(env('profile.upserted', { profile: P({ id: 'object:keys', kind: 'object', name: 'Keys', source: 'live-perception' }) })).ok, 'live-perception source accepted');
    check(validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', source: 'live-agent', decision_model: 'jev-1.13.0', clip: CLIP() }) })).ok, 'live-agent moment with decision_model accepted');
    check(!validateEnvelope(env('moment.saved', { moment: M({ status: 'saved', source: 'live-agent', decision_model: 42, clip: CLIP() }) })).ok, 'non-string decision_model rejected');
    const { store } = freshStore();
    store.apply(env('display.updated', { action: ACTION() }, { event_id: 'd1' }));
    eq(store.getState().display?.card.reminder?.text, 'Ask about the board', 'display stored as sent');
    check(!store.apply(env('display.updated', { action: ACTION({ id: 'display_0', issued_at: '2026-09-19T13:59:00.000Z' }) }, { event_id: 'd0' })).applied, 'older display action dropped as stale');
    store.apply(env('display.updated', { action: ACTION({ id: 'display_2', card: { template: 'answer', title: 'q', body: 'a', image_ref: null, reminder: null }, priority: 30, issued_at: T1, expires_at: null }) }, { event_id: 'd2' }));
    eq(store.getState().display.id, 'display_2', 'newer display action replaces (renderer does not re-judge priority)');
    store.apply(env('enrollment.updated', { enrollment: { status: 'listening', message: 'Say just their name.' } }, { event_id: 'e1' }));
    store.apply(env('session.stopped', { status: STATUS({ state: 'stopped' }) }, { event_id: 'e2' }));
    eq(store.getState().enrollment.status, 'cancelled', 'session.stopped cancels an in-progress enrollment locally');
    const h = store.hydrate(SNAP({ display: ACTION({ id: 'display_snap' }) }));
    eq(store.getState().display?.id, 'display_snap', 'snapshot display hydrated');
    const h2 = store.hydrate(SNAP({ display: { nonsense: true } }));
    eq(store.getState().display, null, 'invalid snapshot display dropped, not applied');
    eq(h2.dropped.length, 1, 'drop reported');
  }
}
