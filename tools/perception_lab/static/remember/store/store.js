// The UI store. It validates envelopes, applies them to plain state, dedupes by event_id, drops
// stale/out-of-order events, ignores everything from a session it is not bound to, and persists
// to one versioned localStorage key. It contains NO product decisions (who is who, what matters,
// what a question means) and never throws on bad input — bad input is logged and dropped.
import { validateEnvelope, sanitizeSnapshot, validators, SCHEMA_VERSION } from '../contracts/envelope.js';
import { createPersistence } from './persist.js';

const MAX_APPLIED_IDS = 800;
const MAX_TRANSCRIPT = 12;
const MAX_LOG = 60;
const MAX_TOMBSTONES = 200;
const IDLE_SCENE = { kind: 'idle', caption: 'Nothing in view' };

export function emptyState() {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: null,          // bound explicitly via hydrate()/bindSession(); never adopted from an event
    last_seq: -1,
    hydrated: false,
    status: null,
    scene: { ...IDLE_SCENE },
    profiles: {}, notes: {}, encounters: {}, reminders: {}, moments: {},
    display: null,             // current DisplayAction for the device screen (live V1)
    enrollment: null,          // current EnrollmentState (live V1)
    deleted_moment_ids: [],    // tombstones: a late recording/saved for a deleted moment is dropped
    deleted_profile_ids: [],   // tombstones: late upserts/encounters/notes/reminders/moment tags cannot resurrect a deleted person
    active_encounter_id: null,
    recognition: null,
    transcript: [],
    answer: { pending: null, latest: null },
    applied_event_ids: [],
    diagnostics: { rejected: [], log: [], duplicates: 0, stale: 0 },
  };
}

/**
 * @param {{persistence?: ReturnType<typeof createPersistence>, now?: () => number}} [opts]
 */
export function createStore(opts = {}) {
  const persistence = opts.persistence ?? createPersistence();
  const now = opts.now ?? (() => Date.now());
  let state = restore(persistence.load()) ?? emptyState();
  const listeners = new Set();

  function emit() { for (const l of listeners) l(state); }
  function commit() { persistence.save(state); emit(); }

  const store = {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * Hydrate from a provider snapshot (fresh namespace or after reset). Invalid records are
     * dropped and listed in diagnostics; the session is bound to the snapshot's session_id.
     * @returns {{ok: boolean, reason?: string, dropped?: string[]}}
     */
    hydrate(snapshot) {
      const r = sanitizeSnapshot(snapshot);
      if (!r.ok) return r;
      const snap = r.snapshot;
      const s = emptyState();
      s.session_id = snap.session_id;
      s.status = snap.status;
      s.display = snap.display ?? null;
      for (const p of snap.profiles) s.profiles[p.id] = p;
      for (const n of snap.notes) s.notes[n.id] = n;
      for (const e of snap.encounters) s.encounters[e.id] = e;
      for (const rm of snap.reminders) s.reminders[rm.id] = rm;
      for (const m of snap.moments) s.moments[m.id] = m;
      s.hydrated = true;
      s.diagnostics.rejected = r.dropped.map((reason) => ({ at: new Date(now()).toISOString(), type: 'snapshot', id: '-', reason })).slice(-MAX_LOG);
      state = s;
      commit();
      return { ok: true, dropped: r.dropped };
    },

    /**
     * Bind the store to a provider session. Only envelopes carrying exactly this session_id are
     * applied — including `session.started`. Called by the app whenever a provider is attached
     * (fresh page load with restored data, reset, provider swap). Resets per-session ordering.
     */
    bindSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return;
      if (state.session_id === sessionId) return;
      state = { ...state, session_id: sessionId, last_seq: -1 };
      commit();
    },

    /** @returns {{applied: boolean, reason?: string}} */
    apply(envelope) {
      const v = validateEnvelope(envelope);
      if (!v.ok) return reject(envelope, v.reason);
      if (state.applied_event_ids.includes(envelope.event_id)) {
        state = { ...state, diagnostics: { ...state.diagnostics, duplicates: state.diagnostics.duplicates + 1 } };
        return { applied: false, reason: 'duplicate event_id' };
      }
      if (envelope.session_id !== state.session_id) return reject(envelope, `foreign session ${envelope.session_id}`);
      if (envelope.seq !== undefined && envelope.seq <= state.last_seq) return stale(envelope, `seq ${envelope.seq} ≤ ${state.last_seq}`);
      const staleReason = staleCheck(state, envelope);
      if (staleReason) return stale(envelope, staleReason);
      let next;
      try { next = reduce(state, envelope); }
      catch (err) { return reject(envelope, `reducer error: ${err?.message ?? err}`); }
      next.applied_event_ids = [...state.applied_event_ids, envelope.event_id].slice(-MAX_APPLIED_IDS);
      if (envelope.seq !== undefined) next.last_seq = envelope.seq;
      next.diagnostics = { ...next.diagnostics, log: [...next.diagnostics.log, { at: envelope.occurred_at, type: envelope.type, id: envelope.event_id }].slice(-MAX_LOG) };
      state = next;
      commit();
      return { applied: true };
    },

    /** Wipe this app's namespace and return to an empty, un-hydrated, unbound state. */
    reset() {
      persistence.clear();
      state = emptyState();
      emit();
    },

    now,
  };
  return store;

  function reject(envelope, reason) {
    const entry = { at: new Date(now()).toISOString(), type: envelope?.type ?? '?', id: envelope?.event_id ?? '?', reason };
    state = { ...state, diagnostics: { ...state.diagnostics, rejected: [...state.diagnostics.rejected, entry].slice(-MAX_LOG) } };
    commit();
    return { applied: false, reason };
  }
  function stale(envelope, reason) {
    const entry = { at: new Date(now()).toISOString(), type: envelope.type, id: envelope.event_id, reason: `stale: ${reason}` };
    state = { ...state, diagnostics: { ...state.diagnostics, stale: state.diagnostics.stale + 1, rejected: [...state.diagnostics.rejected, entry].slice(-MAX_LOG) } };
    commit();
    return { applied: false, reason: `stale: ${reason}` };
  }
}

/**
 * Ordering policy (see REMEMBER_UI.md "Ordering"): an event that describes an older state than
 * what the store already holds is dropped. Returns a reason or null.
 */
export function staleCheck(s, env) {
  const p = env.payload;
  switch (env.type) {
    case 'answer.resolved':
      if (p.answer.profile_id && isDeletedProfile(s, p.answer.profile_id)) return 'answer about a deleted profile';
      if (!s.answer.pending) return s.answer.latest?.query_id === p.answer.query_id ? null : 'answer for a query that is not pending';
      return s.answer.pending.query_id === p.answer.query_id ? null : `answer for obsolete query ${p.answer.query_id}`;
    case 'profile.upserted': return isDeletedProfile(s, p.profile.id) ? 'profile was deleted' : null;
    case 'profile.deleted': return s.profiles[p.profile_id] || !isDeletedProfile(s, p.profile_id) ? null : 'profile already deleted';
    case 'encounter.started': return isDeletedProfile(s, p.encounter.profile_id) ? 'encounter for a deleted profile' : null;
    case 'note.upserted':
      if (isDeletedProfile(s, p.note.profile_id)) return 'note for a deleted profile';
      return olderThanExisting(s.notes[p.note.id], p.note) ? 'note older than stored revision' : null;
    case 'reminder.upserted':
      if (isDeletedProfile(s, p.reminder.profile_id)) return 'reminder for a deleted profile';
      return olderThanExisting(s.reminders[p.reminder.id], p.reminder) ? 'reminder older than stored revision' : null;
    case 'moment.recording': {
      if (s.deleted_moment_ids.includes(p.moment.id)) return 'moment was deleted';
      const cur = s.moments[p.moment.id];
      return cur && cur.status !== 'recording' ? `moment already ${cur.status}` : null;
    }
    case 'moment.saved':
    case 'moment.failed': {
      const id = env.type === 'moment.saved' ? p.moment.id : p.moment_id;
      if (s.deleted_moment_ids.includes(id)) return 'moment was deleted';
      const cur = s.moments[id];
      return cur && cur.status !== 'recording' && cur.status !== (env.type === 'moment.saved' ? 'saved' : 'failed') ? `moment already ${cur.status}` : null;
    }
    case 'transcript.updated': {
      const cur = s.transcript.find((t) => t.id === p.segment.id);
      return cur && cur.is_final && !p.segment.is_final ? 'partial after final' : null;
    }
    case 'display.updated':
      return s.display && Date.parse(p.action.issued_at) < Date.parse(s.display.issued_at) ? 'display action older than the one shown' : null;
    default: return null;
  }
}
const olderThanExisting = (cur, next) => Boolean(cur && Date.parse(next.updated_at) < Date.parse(cur.updated_at));
const isDeletedProfile = (s, id) => Array.isArray(s.deleted_profile_ids) && s.deleted_profile_ids.includes(id);
/** Drop ambient-memory metadata that points at a deleted person; the raw transcript text stays. */
const stripMemory = (seg, deletedIds) => (seg.memory && deletedIds.includes(seg.memory.profile_id) ? { ...seg, memory: undefined } : seg);
/** Moments keep their clips; a deleted person is simply no longer tagged in them. */
const untag = (moment, deletedIds) => (moment.profile_ids?.some((id) => deletedIds.includes(id)) ? { ...moment, profile_ids: moment.profile_ids.filter((id) => !deletedIds.includes(id)) } : moment);

/** Pure reducer: (state, envelope) -> new state. Assumes a validated, non-stale envelope. */
export function reduce(state, env) {
  const s = { ...state };
  const p = env.payload;
  switch (env.type) {
    case 'session.started':
    case 'provider.status':
      s.status = p.status;
      break;
    case 'session.stopped': {
      // The capture stopped: nothing can still be "in view", pending, or half-heard.
      s.status = p.status;
      s.recognition = null;
      s.enrollment = s.enrollment && ['listening', 'collecting'].includes(s.enrollment.status) ? { status: 'cancelled', message: 'Capture stopped' } : s.enrollment;
      s.scene = { ...IDLE_SCENE };
      s.answer = { pending: null, latest: s.answer.latest };
      s.transcript = s.transcript.filter((t) => t.is_final);
      if (s.active_encounter_id) {
        const e = s.encounters[s.active_encounter_id];
        if (e && !e.ended_at) s.encounters = { ...s.encounters, [e.id]: { ...e, ended_at: env.occurred_at } };
        s.active_encounter_id = null;
      }
      break;
    }
    case 'scene.changed':
      s.scene = p.scene;
      break;
    case 'profile.upserted': {
      const prev = s.profiles[p.profile.id];
      // Upsert by stable id: a replayed actor updates, never duplicates.
      s.profiles = { ...s.profiles, [p.profile.id]: prev ? { ...prev, ...p.profile, created_at: prev.created_at } : p.profile };
      break;
    }
    case 'profile.deleted': {
      const id = p.profile_id;
      const gone = s.profiles[id] ?? null;
      const { [id]: _dropProfile, ...profiles } = s.profiles; s.profiles = profiles;
      const removedReminderIds = Object.values(s.reminders).filter((r) => r.profile_id === id).map((r) => r.id);
      s.notes = Object.fromEntries(Object.entries(s.notes).filter(([, n]) => n.profile_id !== id));
      s.reminders = Object.fromEntries(Object.entries(s.reminders).filter(([, r]) => r.profile_id !== id));
      s.encounters = Object.fromEntries(Object.entries(s.encounters).filter(([, e]) => e.profile_id !== id));
      if (s.active_encounter_id && !s.encounters[s.active_encounter_id]) s.active_encounter_id = null;
      // Clips are kept; only the tag goes. last_moment_id on OTHER profiles is untouched.
      s.moments = Object.fromEntries(Object.entries(s.moments).map(([k, m]) => [k, untag(m, [id])]));
      if (s.recognition?.profile_id === id) s.recognition = null;
      if (s.enrollment?.profile_id === id && ['complete', 'collecting', 'listening'].includes(s.enrollment.status)) s.enrollment = null;
      // Mirrors the server: any person deletion clears the latest answer and the pending decision, because
      // generic answers ("recall notes about Alex") carry no profile_id yet may show their notes.
      s.answer = { pending: null, latest: null };
      s.transcript = s.transcript.map((t) => stripMemory(t, [id]));
      // The device display: drop a profile card for them or a card carrying one of their reminders.
      // The server also sends display.updated idle in live mode; this only avoids a stale mirror meanwhile.
      const card = s.display?.card;
      if (card && ((card.template === 'profile' && gone && card.title === gone.name) || (card.reminder && removedReminderIds.includes(card.reminder.id)))) s.display = null;
      if (!isDeletedProfile(s, id)) s.deleted_profile_ids = [...s.deleted_profile_ids, id].slice(-MAX_TOMBSTONES);
      break;
    }
    case 'encounter.started': {
      const e = p.encounter;
      s.encounters = { ...s.encounters, [e.id]: e };
      s.active_encounter_id = e.id;
      const prof = s.profiles[e.profile_id];
      if (prof) s.profiles = { ...s.profiles, [e.profile_id]: { ...prof, last_seen_at: e.started_at, last_seen_location: e.location ?? prof.last_seen_location } };
      break;
    }
    case 'encounter.ended': {
      const e = s.encounters[p.encounter_id];
      if (e) {
        s.encounters = { ...s.encounters, [e.id]: { ...e, ended_at: p.ended_at } };
        const prof = s.profiles[e.profile_id];
        if (prof) s.profiles = { ...s.profiles, [e.profile_id]: { ...prof, last_seen_at: p.ended_at } };
      }
      if (s.active_encounter_id === p.encounter_id) s.active_encounter_id = null;
      break;
    }
    case 'recognition.updated':
      s.recognition = p.recognition;
      break;
    case 'recognition.cleared':
      if (p.track_id === '*' || s.recognition?.track_id === p.track_id) s.recognition = null;
      break;
    case 'note.upserted':
      s.notes = { ...s.notes, [p.note.id]: p.note };
      break;
    case 'note.deleted': {
      const { [p.note_id]: _drop, ...rest } = s.notes; s.notes = rest; break;
    }
    case 'reminder.upserted':
      s.reminders = { ...s.reminders, [p.reminder.id]: p.reminder };
      break;
    case 'reminder.deleted': {
      const { [p.reminder_id]: _drop, ...rest } = s.reminders; s.reminders = rest; break;
    }
    case 'transcript.updated': {
      const seg = stripMemory(p.segment, s.deleted_profile_ids);
      const idx = s.transcript.findIndex((t) => t.id === seg.id);
      const list = idx >= 0 ? s.transcript.map((t, i) => (i === idx ? seg : t)) : [...s.transcript, seg];
      s.transcript = list.slice(-MAX_TRANSCRIPT);
      break;
    }
    case 'transcript.cleared':
      s.transcript = [];
      break;
    case 'answer.pending':
      // A newer question supersedes the pending one; its late result will be dropped by staleCheck.
      s.answer = { pending: { query_id: p.query_id, question: p.question, since: env.occurred_at }, latest: s.answer.latest };
      break;
    case 'answer.resolved':
      s.answer = { pending: null, latest: p.answer };
      break;
    case 'moment.recording':
    case 'moment.saved': {
      const m = untag(p.moment, s.deleted_profile_ids);
      s.moments = { ...s.moments, [m.id]: m };
      if (env.type === 'moment.saved') {
        for (const pid of m.profile_ids ?? []) {
          const prof = s.profiles[pid];
          if (prof) s.profiles = { ...s.profiles, [pid]: { ...prof, last_moment_id: m.id } };
        }
      }
      break;
    }
    case 'moment.failed': {
      const m = s.moments[p.moment_id];
      if (m) s.moments = { ...s.moments, [m.id]: { ...m, status: 'failed', failure_reason: p.reason, clip: null } };
      break;
    }
    case 'moment.deleted': {
      const { [p.moment_id]: _drop, ...rest } = s.moments; s.moments = rest;
      s.deleted_moment_ids = [...s.deleted_moment_ids, p.moment_id].slice(-MAX_TOMBSTONES);
      if (s.answer.latest?.moment_id === p.moment_id) s.answer = { pending: s.answer.pending, latest: { ...s.answer.latest, moment_id: undefined } };
      for (const [pid, prof] of Object.entries(s.profiles)) if (prof.last_moment_id === p.moment_id) s.profiles = { ...s.profiles, [pid]: { ...prof, last_moment_id: undefined } };
      break;
    }
    case 'display.updated':
      // The server engine already applied priority/TTL; the UI shows exactly what it was sent.
      s.display = p.action;
      break;
    case 'enrollment.updated':
      s.enrollment = p.enrollment;
      break;
    default:
      break;
  }
  return s;
}

/**
 * Restore persisted state defensively (anything malformed is dropped record-by-record) and
 * normalise what cannot survive a reload honestly: in-flight recordings become `failed`,
 * pending/partial things are cleared, the session is left unbound until a provider attaches.
 */
export function restore(saved) {
  if (!saved || typeof saved !== 'object' || saved.schema_version !== SCHEMA_VERSION || saved.hydrated !== true) return null;
  const s = emptyState();
  const table = (obj, validator) => {
    const out = {};
    if (obj && typeof obj === 'object') for (const rec of Object.values(obj)) if (rec && typeof rec.id === 'string' && validator(rec, rec.id) === null) out[rec.id] = rec;
    return out;
  };
  s.profiles = table(saved.profiles, validators.profile);
  s.notes = table(saved.notes, validators.note);
  s.encounters = table(saved.encounters, validators.encounter);
  s.reminders = table(saved.reminders, validators.reminder);
  const moments = table(saved.moments, validators.moment);
  for (const m of Object.values(moments)) {
    if (m.status === 'recording') moments[m.id] = { ...m, status: 'failed', failure_reason: 'Recording was interrupted by a page reload', clip: null };
  }
  s.moments = moments;
  s.deleted_moment_ids = Array.isArray(saved.deleted_moment_ids) ? saved.deleted_moment_ids.filter((x) => typeof x === 'string').slice(-MAX_TOMBSTONES) : [];
  s.deleted_profile_ids = Array.isArray(saved.deleted_profile_ids) ? saved.deleted_profile_ids.filter((x) => typeof x === 'string').slice(-MAX_TOMBSTONES) : [];
  if (s.deleted_profile_ids.length) {
    const dead = (pid) => s.deleted_profile_ids.includes(pid);
    for (const id of Object.keys(s.profiles)) if (dead(id)) delete s.profiles[id];
    for (const [id, n] of Object.entries(s.notes)) if (dead(n.profile_id)) delete s.notes[id];
    for (const [id, r] of Object.entries(s.reminders)) if (dead(r.profile_id)) delete s.reminders[id];
    for (const [id, e] of Object.entries(s.encounters)) if (dead(e.profile_id)) delete s.encounters[id];
    for (const [id, m] of Object.entries(s.moments)) s.moments[id] = untag(m, s.deleted_profile_ids);
  }
  for (const e of Object.values(s.encounters)) if (!e.ended_at) s.encounters[e.id] = { ...e, ended_at: e.started_at }; // nothing is in view after a reload
  s.transcript = Array.isArray(saved.transcript) ? saved.transcript.filter((t) => t && t.is_final === true && validators.segment(t, 'segment') === null).slice(-MAX_TRANSCRIPT) : [];
  const latest = saved.answer?.latest;
  s.answer = { pending: null, latest: latest && validators.answer(latest, 'answer') === null ? latest : null };
  s.applied_event_ids = Array.isArray(saved.applied_event_ids) ? saved.applied_event_ids.filter((x) => typeof x === 'string').slice(-MAX_APPLIED_IDS) : [];
  const st = saved.status && validators.status(saved.status, 'status') === null ? saved.status : null;
  s.status = st ? { ...st, state: 'idle', label: st.provider === 'demo' ? 'Demo · paused' : 'Disconnected', message: 'Reloaded. Start the demo to continue.', camera: 'off', microphone: 'off' } : null;
  s.display = null;
  s.enrollment = null;
  s.hydrated = true;
  s.session_id = null; // bound by the app once a provider is attached
  return s;
}

/* ------------------------------------------------------------- selectors */

export const select = {
  activeEncounter: (s) => (s.active_encounter_id ? s.encounters[s.active_encounter_id] ?? null : null),
  activeProfile(s) { const e = select.activeEncounter(s); return e ? s.profiles[e.profile_id] ?? null : null; },
  /** Most recent *completed* encounter with this profile, excluding `excludeId` (the active one). */
  previousEncounter(s, profileId, excludeId) {
    return Object.values(s.encounters)
      .filter((e) => e.profile_id === profileId && e.id !== excludeId && e.ended_at)
      .sort((a, b) => b.ended_at.localeCompare(a.ended_at))[0] ?? null;
  },
  people: (s) => Object.values(s.profiles).filter((p) => p.kind === 'person').sort(byName),
  things: (s) => Object.values(s.profiles).filter((p) => p.kind === 'object').sort(byName),
  notesFor: (s, profileId) => Object.values(s.notes).filter((n) => n.profile_id === profileId).sort((a, b) => b.created_at.localeCompare(a.created_at)),
  remindersFor: (s, profileId) => Object.values(s.reminders).filter((r) => r.profile_id === profileId).sort(byUpdated),
  reminders: (s) => Object.values(s.reminders).sort(byUpdated),
  /**
   * Reminders to surface above a profile right now. Pure and provider-agnostic:
   * active, or snoozed but past snoozed_until; never completed; never dismissed for this encounter.
   */
  dueReminders(s, profileId, encounterId, nowMs) {
    return Object.values(s.reminders).filter((r) => {
      if (r.profile_id !== profileId || r.status === 'completed') return false;
      if (r.status === 'snoozed' && r.snoozed_until && Date.parse(r.snoozed_until) > nowMs) return false;
      if (encounterId && r.dismissed_for_encounter_id === encounterId) return false;
      return true;
    }).sort(byUpdated);
  },
  moments: (s) => Object.values(s.moments).sort((a, b) => b.event_at.localeCompare(a.event_at)),
  momentsFor: (s, profileId) => select.moments(s).filter((m) => m.profile_ids?.includes(profileId)),
  latestSavedMomentFor: (s, profileId) => select.momentsFor(s, profileId).find((m) => m.status === 'saved' && m.clip) ?? null,
  encountersFor: (s, profileId) => Object.values(s.encounters).filter((e) => e.profile_id === profileId).sort((a, b) => b.started_at.localeCompare(a.started_at)),
};
const byName = (a, b) => a.name.localeCompare(b.name);
const byUpdated = (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
