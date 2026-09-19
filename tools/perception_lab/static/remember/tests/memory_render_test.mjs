// Ambient (Jev) conversation memory in the UI: optional transcript `memory` outcomes, automatic
// note provenance labels, and persistence copy that follows `status.memory_persistent`.
// Old payloads (no memory, no provenance, no flag) must keep validating and rendering unchanged.
import { check, eq } from './harness.mjs';
import { fakeDocument, FakeNode } from './decision_render_test.mjs';
import { validateEnvelope, validators, sanitizeSnapshot } from '../contracts/envelope.js';
import { createStore, restore } from '../store/store.js';
import { createPersistence, memoryStorage } from '../store/persist.js';

const T0 = '2026-09-19T14:00:00.000Z';
const SID = 'sess_mem';
const BOB = 'bbe11ee7-5dd5-4b12-a638-e0b7a6117bbd';
let n = 0;
const env = (type, payload, seq) => ({ schema_version: '1.0', event_id: `e${++n}`, session_id: SID, occurred_at: T0, type, payload, ...(seq !== undefined ? { seq } : {}) });
const SEG = (o = {}) => ({ schema_version: '1.0', id: 'speech-1:fact', text: 'I prefer coffee.', is_final: true, started_at: T0, updated_at: T0, speaker: 'unknown', directed: 'conversation', ...o });
const NOTE = (o = {}) => ({ schema_version: '1.0', id: 'note_1', profile_id: BOB, text: 'I prefer coffee.', created_at: T0, updated_at: T0, source: 'user', ...o });
const AUTO = (o = {}) => NOTE({ id: 'note_auto', source: 'live-agent', attribution: 'conversation_context', speaker: 'unknown', decision_model: 'jev-1.13.0',
  source_segment_id: 'speech-1:fact', source_session_id: SID, source_encounter_id: 'enc_1', source_text: 'I prefer coffee.', ...o });
const STATUS = (o = {}) => ({ schema_version: '1.0', provider: 'live', state: 'running', label: 'Live · Jev configured', message: 'x', session_id: SID, camera: 'live', microphone: 'live', since: T0, ...o });
const PROFILE = (o = {}) => ({ schema_version: '1.0', id: BOB, kind: 'person', name: 'Bob', created_at: T0, source: 'live-perception', ...o });

/** Depth-first walk of the fake DOM. */
function* walk(el) { yield el; for (const c of el.children ?? []) if (c instanceof FakeNode) yield* walk(c); }
const find = (root, pred) => [...walk(root)].find(pred) ?? null;
const findAll = (root, pred) => [...walk(root)].filter(pred);
const tagWith = (root, text) => find(root, (e) => e.tagName === 'SPAN' && /\btag\b/.test(e.className ?? '') && e.textContent === text);

export async function run() {
  console.log('\n# ambient memory: contracts stay backward compatible');
  check(validateEnvelope(env('transcript.updated', { segment: SEG() })).ok, 'segment without memory (old payload) accepted');
  for (const state of ['saved', 'duplicate', 'not_saved']) {
    check(validateEnvelope(env('transcript.updated', { segment: SEG({ memory: { state, note_id: state === 'not_saved' ? undefined : 'note_auto', profile_id: BOB, profile_name: 'Bob', reason: 'r' } }) })).ok, `segment with memory.state=${state} accepted`);
  }
  check(validateEnvelope(env('transcript.updated', { segment: SEG({ memory: { state: 'duplicate', note_id: null, profile_id: BOB, profile_name: 'Bob', reason: 'Already remembered or previously removed' } }) })).ok, 'duplicate with note_id:null (server shape) accepted');
  check(!validateEnvelope(env('transcript.updated', { segment: SEG({ memory: { state: 'remembered' } }) })).ok, 'unknown memory.state rejected');
  check(!validateEnvelope(env('transcript.updated', { segment: SEG({ memory: 'saved' }) })).ok, 'non-object memory rejected');
  check(!validateEnvelope(env('transcript.updated', { segment: SEG({ memory: { state: 'saved', profile_name: 7 } }) })).ok, 'non-string profile_name rejected');
  check(validateEnvelope(env('note.upserted', { note: NOTE() })).ok, 'plain note (old payload) accepted');
  check(validateEnvelope(env('note.upserted', { note: AUTO() })).ok, 'automatic note with full provenance accepted');
  check(validateEnvelope(env('note.upserted', { note: AUTO({ edited_by_user: true, text: 'Prefers coffee' }) })).ok, 'edited automatic note accepted');
  check(!validateEnvelope(env('note.upserted', { note: AUTO({ edited_by_user: 'yes' }) })).ok, 'non-boolean edited_by_user rejected');
  check(!validateEnvelope(env('note.upserted', { note: AUTO({ source_text: 'x'.repeat(1001) }) })).ok, 'source_text over 1000 chars rejected');
  check(validateEnvelope(env('note.upserted', { note: AUTO({ text: 'I like ' + 'a'.repeat(992) + '.', source_text: 'I like ' + 'a'.repeat(992) + '.' }) })).ok, 'full 1000-character automatic note accepted');
  check(validateEnvelope(env('provider.status', { status: STATUS() })).ok, 'status without memory_persistent (old payload) accepted');
  check(validateEnvelope(env('provider.status', { status: STATUS({ memory_persistent: true }) })).ok, 'status with memory_persistent:true accepted');
  check(validateEnvelope(env('provider.status', { status: STATUS({ memory_persistent: false }) })).ok, 'status with memory_persistent:false accepted');
  check(!validateEnvelope(env('provider.status', { status: STATUS({ memory_persistent: 'yes' }) })).ok, 'non-boolean memory_persistent rejected');

  console.log('\n# ambient memory: provenance survives snapshot, store, restore and edit round-trips');
  const snap = sanitizeSnapshot({ schema_version: '1.0', session_id: SID, status: STATUS({ memory_persistent: true }), profiles: [PROFILE()], notes: [AUTO()], encounters: [], reminders: [], moments: [] });
  check(snap.ok && snap.snapshot.notes[0].source_text === 'I prefer coffee.' && snap.snapshot.notes[0].decision_model === 'jev-1.13.0' && snap.snapshot.notes[0].source_encounter_id === 'enc_1', 'sanitizeSnapshot keeps every provenance field');
  eq(snap.snapshot.status.memory_persistent, true, 'sanitizeSnapshot keeps memory_persistent');
  const store = createStore({ persistence: createPersistence(memoryStorage(), 'test.memory'), now: () => Date.parse(T0) });
  store.hydrate({ schema_version: '1.0', session_id: SID, status: STATUS({ memory_persistent: false }), profiles: [PROFILE()], notes: [], encounters: [], reminders: [], moments: [] });
  store.apply(env('note.upserted', { note: AUTO() }, 1));
  const stored = store.getState().notes.note_auto;
  check(stored && stored.attribution === 'conversation_context' && stored.speaker === 'unknown' && stored.source_segment_id === 'speech-1:fact', 'store keeps automatic note provenance');
  store.apply(env('transcript.updated', { segment: SEG({ memory: { state: 'saved', note_id: 'note_auto', profile_id: BOB, profile_name: 'Bob' } }) }, 2));
  eq(store.getState().transcript[0].memory?.state, 'saved', 'store keeps the segment memory outcome');
  store.apply(env('note.upserted', { note: AUTO({ text: 'Prefers coffee', edited_by_user: true, updated_at: '2026-09-19T14:01:00.000Z' }) }, 3));
  const edited = store.getState().notes.note_auto;
  check(edited.text === 'Prefers coffee' && edited.edited_by_user === true && edited.source_text === 'I prefer coffee.', 'edited automatic note keeps source_text and gains edited_by_user');
  const restored = restore({ ...store.getState(), hydrated: true });
  check(restored?.notes.note_auto?.source_text === 'I prefer coffee.' && restored.notes.note_auto.edited_by_user === true, 'restore() keeps provenance record-by-record');
  check(restored.transcript[0]?.memory?.state === 'saved', 'restore() keeps the final segment memory outcome');
  eq(store.getState().status.memory_persistent, false, 'status flag false is kept as false (not dropped to undefined)');
  // What the edit action sends: `{ ...note, text }` must carry provenance back to the server.
  const outgoing = { ...edited, text: 'Prefers black coffee' };
  check(outgoing.attribution === 'conversation_context' && outgoing.source_text === 'I prefer coffee.' && outgoing.decision_model === 'jev-1.13.0' && outgoing.source === 'live-agent', 'edit payload re-sends provenance (never silently lost)');

  console.log('\n# ambient memory: transcript tags');
  globalThis.document = fakeDocument();
  globalThis.Node = FakeNode;
  const { transcriptList, memoryTag, isConversationNote, noteProvenanceText, noteProvenanceDetail, noteSourceQuote, noteStorageNote } = await import('../ui/components.js');
  const list = (seg) => transcriptList([seg], Date.parse(T0));
  let ul = list(SEG({ memory: { state: 'saved', note_id: 'note_auto', profile_id: BOB, profile_name: 'Bob' } }));
  let saved = tagWith(ul, 'Saved to Bob');
  check(saved && /\bsaved\b/.test(saved.className), 'saved → compact "Saved to Bob" tag with .saved class');
  check(tagWith(ul, 'Conversation') !== null, 'saved line still reads Conversation');
  check(!tagWith(ul, 'For Remember') && !/device/.test(saved.className), 'saved conversation is never shown as a device command');
  check(/does not say who spoke/.test(saved.attrs.title) && /Jev/.test(saved.attrs.title), 'saved tag title: Jev saved it, speaker not claimed');
  ul = list(SEG({ memory: { state: 'saved' } }));
  check(tagWith(ul, 'Saved') !== null, 'saved without profile_name falls back to "Saved"');
  ul = list(SEG({ memory: { state: 'duplicate', note_id: null, profile_name: 'Bob', reason: 'Already remembered or previously removed' } }));
  check(tagWith(ul, 'Already remembered') !== null && tagWith(ul, 'Conversation') !== null, 'duplicate → "Already remembered" beside Conversation');
  ul = list(SEG({ memory: { state: 'not_saved', reason: 'No unambiguous, unchanged person in view' } }));
  const conv = tagWith(ul, 'Conversation');
  check(conv && /No unambiguous, unchanged person in view/.test(conv.attrs.title), 'not_saved → plain Conversation with the reason in the title');
  check(!/Saved|remembered|error|fail/i.test(ul.textContent), 'not_saved shows no alarming text and no saved tag');
  ul = list(SEG());
  check(tagWith(ul, 'Conversation') !== null && !tagWith(ul, 'Conversation').attrs.title && findAll(ul, (e) => /\btag\b/.test(e.className ?? '')).length === 1, 'old payload without memory renders exactly one Conversation tag, no title');
  ul = list(SEG({ directed: 'pending' }));
  check(tagWith(ul, 'Deciding…') !== null, 'pending stays Deciding…');
  // Regression: the ambient gate is independent of addressedness. A useful sentence Jev classed as
  // device-directed (with no supported command) can still be saved and must show the outcome.
  ul = list(SEG({ directed: 'device', memory: { state: 'saved', note_id: 'note_auto', profile_name: 'Bob' } }));
  check(tagWith(ul, 'For Remember') !== null && tagWith(ul, 'Saved to Bob') !== null, 'device-directed + saved → For Remember AND Saved to Bob');
  ul = list(SEG({ directed: 'device', memory: { state: 'duplicate', note_id: null, profile_name: 'Bob' } }));
  check(tagWith(ul, 'For Remember') !== null && tagWith(ul, 'Already remembered') !== null, 'device-directed + duplicate → both tags');
  ul = list(SEG({ directed: 'device', memory: { state: 'not_saved', reason: 'limit' } }));
  check(tagWith(ul, 'For Remember') !== null && /limit/.test(tagWith(ul, 'For Remember').attrs.title) && findAll(ul, (e) => /\btag\b/.test(e.className ?? '')).length === 1, 'device-directed + not_saved → For Remember only, reason in title');
  ul = list(SEG({ directed: 'device' }));
  check(tagWith(ul, 'For Remember') !== null && findAll(ul, (e) => /\btag\b/.test(e.className ?? '')).length === 1, 'device-directed without memory (old payload) unchanged');
  ul = list(SEG({ directed: 'pending', memory: { state: 'saved', profile_name: 'Bob' } }));
  check(tagWith(ul, 'Deciding…') !== null && !tagWith(ul, 'Saved to Bob'), 'pending never shows a memory outcome');
  eq(memoryTag(null), null, 'memoryTag(null) → null');
  eq(memoryTag({ state: 'not_saved', reason: 'x' }), null, 'memoryTag(not_saved) → null');
  eq(memoryTag({ state: 'saved', profile_name: '   ' })?.textContent, 'Saved', 'blank profile_name is ignored');

  console.log('\n# ambient memory: note provenance helpers');
  check(isConversationNote(AUTO()) && !isConversationNote(NOTE()) && !isConversationNote(NOTE({ source: 'live-agent' })) && !isConversationNote(null), 'isConversationNote needs live-agent + conversation_context');
  const prov = noteProvenanceText(AUTO(), 'Bob');
  eq(prov, 'Heard with Bob · saved automatically', 'visible provenance is short: Heard with Bob · saved automatically');
  check(!/jev-1\.13\.0|speaker/.test(prov), 'model version and speaker caveat stay out of the visible row');
  const detail = noteProvenanceDetail(AUTO());
  check(/jev-1\.13\.0/.test(detail) && /speaker is not identified/.test(detail), 'detail (title) carries exact model + speaker caveat');
  eq(noteProvenanceDetail(NOTE()), '', 'manual note has no detail');
  check(!/Bob said|Bob says/.test(prov), 'provenance never claims Bob spoke');
  check(/From conversation/.test(noteProvenanceText(AUTO(), null)), 'no profile name → From conversation');
  check(/edited by you/.test(noteProvenanceText(AUTO({ edited_by_user: true }), 'Bob')), 'edited notes say so');
  eq(noteProvenanceText(NOTE(), 'Bob'), '', 'manual note has no automatic provenance');
  eq(noteSourceQuote(AUTO()), null, 'quote hidden while text equals source_text');
  eq(noteSourceQuote(AUTO({ text: 'Prefers coffee', edited_by_user: true })), 'I prefer coffee.', 'quote shown once the text was edited');
  eq(noteSourceQuote(NOTE()), null, 'manual note has no quote');
  const person = PROFILE(), thing = PROFILE({ id: 'object:keys', kind: 'object', name: 'keys' });
  check(/Saved on this Mac with Bob’s enrolled face/.test(noteStorageNote({ memory_persistent: true }, person)) && /server restarts/.test(noteStorageNote({ memory_persistent: true }, person)), 'persistent + person → durable copy');
  check(/temporary server session only/.test(noteStorageNote({ memory_persistent: true }, thing)), 'persistent + object → still session-temporary');
  check(/temporary server session only/.test(noteStorageNote({ memory_persistent: false }, person)) && /temporary server session only/.test(noteStorageNote(null, person)) && /temporary server session only/.test(noteStorageNote({}, person)), 'false, null or missing flag → never claims durability');
  check(/demo data/.test(noteStorageNote({ memory_persistent: true }, person, { demo: true })), 'demo mode copy unchanged even if a flag is present');

  console.log('\n# ambient memory: profile detail page');
  const { renderProfiles, noteSourceLabel } = await import('../ui/views/profiles.js');
  const baseState = () => ({ profiles: { [BOB]: PROFILE() }, notes: {}, encounters: {}, reminders: {}, moments: {}, transcript: [], answer: { pending: null, latest: null }, recognition: null, enrollment: null, display: null, active_encounter_id: null, applied_event_ids: [], diagnostics: { duplicates: 0, stale: 0, rejected: [], log: [] }, status: STATUS({ memory_persistent: true }), scene: { kind: 'idle', caption: '' } });
  const actions = { note: { create() {}, edit() {}, remove() {} }, reminder: { create() {}, edit() {}, remove() {}, complete() {} }, openMoment() {} };
  let state = baseState();
  state.notes = { note_auto: AUTO(), note_1: NOTE({ created_at: '2026-09-19T13:00:00.000Z' }) };
  let page = renderProfiles({ state, nowMs: Date.parse(T0), actions, mode: 'live' }, 'person', BOB);
  const text = page.textContent;
  check(/Heard with Bob · saved automatically/.test(text) && !/jev-1\.13\.0/.test(text), 'automatic note row: short label, no model version in visible text');
  const provSpan = find(page, (e) => e.tagName === 'SPAN' && e.attrs?.title && /Heard with Bob · saved automatically/.test(e.textContent ?? ''));
  check(provSpan && /jev-1\.13\.0/.test(provSpan.attrs.title) && /speaker is not identified/.test(provSpan.attrs.title), 'row label title carries model + speaker caveat');
  check(/I prefer coffee\.\s*· yours/.test(text), 'manual note row still says yours');
  check(!/Heard: “/.test(text), 'unedited automatic note shows no separate quote (text is the quote)');
  check(/Saved on this Mac with Bob’s enrolled face/.test(text), 'notes section says person notes persist when the flag is true');
  const editBtns = findAll(page, (e) => e.tagName === 'BUTTON' && e.textContent === 'Edit');
  const delBtns = findAll(page, (e) => e.tagName === 'BUTTON' && e.textContent === 'Delete');
  check(editBtns.length === 2 && delBtns.length === 2, 'automatic notes keep Edit and Delete controls');
  state = baseState();
  state.notes = { note_auto: AUTO({ text: 'Prefers coffee', edited_by_user: true }) };
  page = renderProfiles({ state, nowMs: Date.parse(T0), actions, mode: 'live' }, 'person', BOB);
  check(/edited by you/.test(page.textContent) && /Heard: “I prefer coffee\.”/.test(page.textContent), 'edited automatic note keeps its provenance and shows the original quote');
  state = baseState();
  state.status = STATUS({ memory_persistent: false });
  page = renderProfiles({ state, nowMs: Date.parse(T0), actions, mode: 'live' }, 'person', BOB);
  check(/temporary server session only/.test(page.textContent) && !/on this Mac/.test(page.textContent), 'memory_persistent:false → notes section says session only');
  state = baseState();
  state.status = STATUS();
  page = renderProfiles({ state, nowMs: Date.parse(T0), actions, mode: 'live' }, 'person', BOB);
  check(/temporary server session only/.test(page.textContent), 'old status without the flag → session only');
  // Plain-text rendering: markup in a note or quote is text, never elements.
  state = baseState();
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  state.notes = { note_auto: AUTO({ text: 'edited', edited_by_user: true, source_text: hostile }), note_x: NOTE({ id: 'note_x', text: hostile }) };
  page = renderProfiles({ state, nowMs: Date.parse(T0), actions, mode: 'live' }, 'person', BOB);
  check(page.textContent.includes(hostile) && findAll(page, (e) => e.tagName === 'IMG' || e.tagName === 'SCRIPT').length === 0, 'hostile note text and source_text render as plain text (no IMG/SCRIPT elements)');
  eq(noteSourceLabel(NOTE({ source: 'introduction' }), PROFILE()), 'from introduction', 'introduction label unchanged');
  eq(noteSourceLabel(NOTE({ source: 'live-agent' }), PROFILE()), '', 'live-agent without conversation attribution gets no false provenance');

  console.log('\n# ambient memory: Heard / footer / reset copy follows backend + persistence flag');
  const { heardCopy, liveFooterCopy, resetHint, effectiveDecisions, renderLiveNow, memoryLifetimeCopy } = await import('../ui/views/live_now.js');
  const jev = effectiveDecisions({ decision: { backend: 'typesafe', phase: 'ready', model: 'jev-1.13.0', message: 'ok' } }, null);
  const rules = effectiveDecisions(null, null);
  const jevCopy = heardCopy(jev, true, true);
  check(/Talk naturally/.test(jevCopy.note) && /no “remember that” needed/.test(jevCopy.note) && /recognised person/.test(jevCopy.note), 'Jev Heard note: talk naturally, no remember-that, recognised person');
  check(jevCopy.note.split(/(?<=[.!?])\s+/).length <= 2, 'Jev Heard note is at most two sentences');
  check(/speaker is not identified/.test(jevCopy.noteTitle) && !/speaker/.test(jevCopy.note), 'speaker caveat lives once in the title, not the visible note');
  check(/saved on this Mac/.test(jevCopy.note), 'Jev Heard note with persistent store says on this Mac');
  check(/temporary session/.test(heardCopy(jev, true, false).note) && !/on this Mac/.test(heardCopy(jev, true, false).note), 'Jev Heard note without persistent store says temporary');
  check(/temporary session/.test(heardCopy(jev, true).note), 'missing flag defaults to temporary copy');
  const rulesCopy = heardCopy(rules, true, true);
  check(/remembers nothing automatically/.test(rulesCopy.note) && !/can become a note automatically/.test(rulesCopy.note), 'rules Heard note denies automatic memory');
  check(/V1 command rules/.test(rulesCopy.header) && /match the V1 grammar act/.test(rulesCopy.empty), 'rules header/empty copy unchanged');
  eq(heardCopy(rules, false).note, null, 'speech off → no memory note');
  const errCopy = heardCopy(effectiveDecisions({ decision: { backend: 'typesafe', phase: 'error' } }, null), true, true);
  check(/nothing is remembered/.test(errCopy.empty) && /no rules fallback/.test(errCopy.empty), 'Jev error: says nothing is remembered and no fallback');
  check(/decides which useful personal facts, preferences and plans to remember/.test(liveFooterCopy(jev, true)) && /saved on this Mac/.test(liveFooterCopy(jev, true)), 'Jev footer: automatic memory + persistence');
  check(/nothing is remembered automatically in rules mode/.test(liveFooterCopy(rules, true)) && !/Jev/.test(liveFooterCopy(rules, true)), 'rules footer: no automatic memory, no Jev claim');
  check(/no durable store is reported/.test(liveFooterCopy(jev, false)) && !/on this Mac/.test(liveFooterCopy(jev, false)), 'footer with flag false never claims persistence');
  check(liveFooterCopy(jev, true).length < 320 && liveFooterCopy(rules, false).length < 260, 'footer prose stays short');
  check(/saved person notes stay/.test(resetHint(true)) && /including its notes/.test(resetHint(false)), 'reset hint follows the flag');
  check(/survive reloads, session resets and server restarts/.test(memoryLifetimeCopy(true)) && /temporary session/.test(memoryLifetimeCopy(false)), 'lifetime copy both ways');

  // Full render: the flag comes from state.status, the segment tag from state.transcript.
  const settings = { camera: true, microphone: true, faces: { enabled: true, backend: 'local' }, objects: { enabled: true, backend: 'local', vocabulary: ['keys'] }, speech: { enabled: true, backend: 'baseten' } };
  const live = { session: 'connected', sessionMessage: '', capturing: false, capture: { camera: 'off', microphone: 'off', errors: {} }, streams: { faces: { phase: 'idle' }, objects: { phase: 'idle' }, speech: { phase: 'idle' } }, media: { frames_sent: 0, audio_chunks: 0, frames_dropped: 0 }, decision: { backend: 'typesafe', phase: 'ready', model: 'jev-1.13.0', message: 'Client ready' } };
  const liveActions = { reminder: {}, live: { switchMode() {}, start() {}, stop() {}, markMoment() {}, clearDisplay() {}, introduce() {}, cancelEnrollment() {}, updateSettings() {}, refreshDevices() {}, reset() {} }, ask() {}, openMoment() {} };
  state = baseState();
  state.transcript = [SEG({ memory: { state: 'saved', note_id: 'note_auto', profile_id: BOB, profile_name: 'Bob' } })];
  page = renderLiveNow({ state, nowMs: Date.parse(T0), actions: liveActions, live, apiStatus: null, settings, devices: { cameras: [], microphones: [] }, notices: [] });
  check(tagWith(page, 'Saved to Bob') !== null, 'live Now renders the Saved to Bob tag on the heard line');
  check(/saved person notes stay/.test(page.textContent) && /Person notes are saved on this Mac/.test(page.textContent), 'live Now (persistent) reset hint + footer say person notes persist');
  check(/typed text is never remembered automatically/.test(page.textContent), 'typed-command help stays distinct from ambient memory');
  state = baseState(); state.status = STATUS({ memory_persistent: false });
  page = renderLiveNow({ state, nowMs: Date.parse(T0), actions: liveActions, live: { ...live, decision: null }, apiStatus: null, settings, devices: { cameras: [], microphones: [] }, notices: [] });
  check(/remembers nothing automatically/.test(page.textContent) && /including its notes/.test(page.textContent) && !/on this Mac/.test(page.textContent), 'live Now (rules, ephemeral) denies automatic memory and persistence');
  delete globalThis.document; delete globalThis.Node;
}
