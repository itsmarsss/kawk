// Envelope + payload validation, construction. Pure, no DOM.
// Mirrors contracts/schema.json and contracts/types.d.ts (schema_version "1.0").
// Everything a provider sends is checked here BEFORE it reaches the reducer, so a malformed
// event is logged in diagnostics and dropped instead of crashing the UI.

export const SCHEMA_VERSION = '1.0';
const SUPPORTED_MAJOR = 1;

export const ENUMS = {
  kind: ['person', 'object'],
  source: ['demo-fixture', 'user', 'introduction', 'live-perception', 'v1-rules', 'live-agent', 'live-memory'],
  confidence: ['weak', 'ok', 'strong'],
  reminderStatus: ['active', 'snoozed', 'completed'],
  momentStatus: ['recording', 'saved', 'failed'],
  coverage: ['complete', 'partial'],
  provenance: ['demo-fixture', 'live-ring-buffer'],
  speaker: ['wearer', 'other', 'unknown'],
  directed: ['pending', 'device', 'conversation'],
  /** Optional outcome of the ambient (Jev) memory decision on a finalized conversation segment. */
  memoryState: ['saved', 'duplicate', 'not_saved'],
  answerKind: ['found', 'not_found', 'unsupported', 'ignored'],
  recognitionState: ['pending', 'listening', 'resolved', 'unresolved'],
  sceneKind: ['idle', 'person', 'object', 'conversation'],
  providerKind: ['demo', 'live'],
  providerState: ['idle', 'running', 'stopped', 'error'],
  capture: ['simulated', 'off', 'live', 'unknown'],
  template: ['profile', 'answer', 'alert', 'enroll_prompt', 'idle'],
  enrollmentStatus: ['listening', 'collecting', 'complete', 'ambiguous', 'error', 'cancelled'],
  audioCoverage: ['complete', 'partial', 'none'],
};

/* ------------------------------------------------------------ primitives */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 2000;
const optStr = (v) => v === undefined || v === null || typeof v === 'string';
const date = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const optDate = (v) => v === undefined || v === null || date(v);
const bool = (v) => typeof v === 'boolean';
const optBool = (v) => v === undefined || v === null || typeof v === 'boolean';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (list) => (v) => list.includes(v);
const optOneOf = (list) => (v) => v === undefined || v === null || list.includes(v);
const strArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Same-origin only: an absolute path, or an absolute http(s) URL whose origin matches `origin`. Without a known origin only paths pass. */
export function isSameOriginUrl(url, origin = globalThis.location?.origin) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (!origin) return false;
  try { const u = new URL(url); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin; } catch { return false; }
}

/** shape(spec)(value) → first problem or null. spec values are predicates. */
function shape(spec) {
  return (v, path) => {
    if (!isObj(v)) return `${path} is not an object`;
    for (const [k, pred] of Object.entries(spec)) {
      const r = pred(v[k], `${path}.${k}`);
      if (r === false) return `${path}.${k} is invalid`;
      if (typeof r === 'string') return r;
    }
    return null;
  };
}

/* ------------------------------------------------------------- records */

/**
 * `TranscriptSegment.memory` (optional): what the ambient memory gate did with a finalized
 * conversation segment. Absent on every older payload and on partials/pending segments.
 */
const memoryOutcome = (v, path) => (v === undefined || v === null ? null
  : shape({ state: oneOf(ENUMS.memoryState), note_id: optStr, profile_id: optStr, profile_name: optStr, reason: optStr })(v, path));

export const validators = {
  profile: shape({ id: str, kind: oneOf(ENUMS.kind), name: str, descriptor: optStr, created_at: date, last_seen_at: optDate, last_seen_location: optStr, last_moment_id: optStr, source: oneOf(ENUMS.source), actor_key: optStr }),
  encounter: shape({ id: str, profile_id: str, started_at: date, ended_at: optDate, location: optStr, confidence: oneOf(ENUMS.confidence), source: oneOf(ENUMS.source) }),
  // Provenance fields are optional (older payloads lack them) and are carried through untouched:
  // shape() never strips unknown keys, so an automatic note keeps its origin across store/restore/edit.
  note: shape({ id: str, profile_id: str, text: str, created_at: date, updated_at: date, source: oneOf(ENUMS.source),
    attribution: optStr, speaker: optStr, decision_model: optStr, source_segment_id: optStr, source_session_id: optStr, source_encounter_id: optStr,
    source_text: (t) => t === undefined || t === null || (typeof t === 'string' && t.length <= 1000), edited_by_user: optBool }),
  reminder: shape({ id: str, profile_id: str, text: str, status: oneOf(ENUMS.reminderStatus), created_at: date, updated_at: date, snoozed_until: optDate, dismissed_for_encounter_id: optStr, completed_at: optDate, last_shown_at: optDate, source: oneOf(ENUMS.source) }),
  clip: (v, path) => {
    const r = shape({ id: str, url: (u) => isSameOriginUrl(u), poster_url: (u) => u === undefined || u === null || isSameOriginUrl(u), mime: oneOf(['video/mp4']), requested_start_at: date, requested_end_at: date, start_at: date, end_at: date, duration_s: num, coverage: oneOf(ENUMS.coverage),
      audio: (a, ap) => (a === undefined || a === null ? null : shape({ present: bool, coverage: oneOf(ENUMS.audioCoverage), captured_duration_s: num })(a, ap)),
      provenance: shape({ kind: oneOf(ENUMS.provenance), detail: optStr }) })(v, path);
    if (r) return r;
    const s = Date.parse(v.start_at), e = Date.parse(v.end_at), rs = Date.parse(v.requested_start_at), re = Date.parse(v.requested_end_at);
    if (!(e > s)) return `${path}: end_at must be after start_at`;
    if (!(re > rs)) return `${path}: requested_end_at must be after requested_start_at`;
    if (s < rs - 1000 || e > re + 1000) return `${path}: actual bounds exceed requested bounds`;
    if (v.duration_s <= 0 || Math.abs(v.duration_s - (e - s) / 1000) > 1) return `${path}: duration_s does not match bounds`;
    const complete = s <= rs + 250 && e >= re - 250;
    if (v.coverage === 'complete' && !complete) return `${path}: coverage says complete but bounds are partial`;
    return null;
  },
  moment: (v, path) => {
    const r = shape({ id: str, title: str, summary: optStr, event_at: date, saved_at: optDate, status: oneOf(ENUMS.momentStatus), failure_reason: optStr, profile_ids: strArray, location: optStr, source: oneOf(ENUMS.source), decision_model: optStr })(v, path);
    if (r) return r;
    if (v.status === 'saved') { if (!isObj(v.clip)) return `${path}.clip is required when saved`; return validators.clip(v.clip, `${path}.clip`); }
    if (v.clip !== null && v.clip !== undefined) return `${path}.clip must be null unless saved`;
    return null;
  },
  segment: shape({ id: str, text: (t) => typeof t === 'string', is_final: bool, started_at: date, updated_at: date, speaker: oneOf(ENUMS.speaker), directed: oneOf(ENUMS.directed), memory: memoryOutcome }),
  answer: shape({ query_id: str, question: str, kind: oneOf(ENUMS.answerKind), text: str, context: (c) => c === undefined || strArray(c), profile_id: optStr, moment_id: optStr, answered_at: date }),
  recognition: shape({ track_id: str, kind: oneOf(ENUMS.kind), state: oneOf(ENUMS.recognitionState), label: str, started_at: date, profile_id: optStr }),
  scene: shape({ kind: oneOf(ENUMS.sceneKind), caption: str, illustration_url: (u) => u === undefined || u === null || isSameOriginUrl(u) }),
  status: shape({ provider: oneOf(ENUMS.providerKind), state: oneOf(ENUMS.providerState), label: str, message: optStr, session_id: str, camera: oneOf(ENUMS.capture), microphone: oneOf(ENUMS.capture), since: date, memory_persistent: optBool }),
  displayAction: (v, path) => {
    const r = shape({
      id: str, display: shape({ w: (n) => num(n) && n > 0 && n <= 4096, h: (n) => num(n) && n > 0 && n <= 4096 }),
      card: shape({ template: oneOf(ENUMS.template), title: (t) => typeof t === 'string' && t.length <= 400, body: (t) => typeof t === 'string' && t.length <= 4000, image_ref: (x) => x === null || x === undefined || typeof x === 'string',
        reminder: (rm, rp) => (rm === null || rm === undefined ? null : shape({ id: str, text: str })(rm, rp)), clip_id: optStr }),
      blit: (b) => b === null || b === undefined, ttl_ms: (n) => num(n) && n >= 0, priority: num, issued_at: date, expires_at: (x) => x === null || x === undefined || date(x),
    })(v, path);
    if (r) return r;
    if (v.expires_at && Date.parse(v.expires_at) < Date.parse(v.issued_at)) return `${path}: expires_at before issued_at`;
    return null;
  },
  enrollment: shape({ status: oneOf(ENUMS.enrollmentStatus), message: (t) => typeof t === 'string', target_track_id: (t) => t === undefined || t === null || typeof t === 'string' || Number.isInteger(t), name: optStr, collected: (n) => n === undefined || n === null || num(n), required: (n) => n === undefined || n === null || num(n), profile_id: optStr }),
};

/** Per event type: payload field → validator (a record validator or a primitive predicate). */
const PAYLOADS = {
  'session.started': { status: validators.status },
  'session.stopped': { status: validators.status },
  'provider.status': { status: validators.status },
  'scene.changed': { scene: validators.scene },
  'profile.upserted': { profile: validators.profile },
  'profile.deleted': { profile_id: str },            // person removed everywhere; the store cascades + tombstones the id
  'encounter.started': { encounter: validators.encounter },
  'encounter.ended': { encounter_id: str, ended_at: date },
  'recognition.updated': { recognition: validators.recognition },
  'recognition.cleared': { track_id: str },          // '*' clears whatever is pending
  'note.upserted': { note: validators.note },
  'note.deleted': { note_id: str },
  'reminder.upserted': { reminder: validators.reminder },
  'reminder.deleted': { reminder_id: str },
  'transcript.updated': { segment: validators.segment },
  'transcript.cleared': {},
  'answer.pending': { query_id: str, question: str },
  'answer.resolved': { answer: validators.answer },
  'moment.recording': { moment: validators.moment },
  'moment.saved': { moment: validators.moment },
  'moment.failed': { moment_id: str, reason: str },
  'moment.deleted': { moment_id: str },
  'display.updated': { action: validators.displayAction },
  'enrollment.updated': { enrollment: validators.enrollment },
};
export const EVENT_TYPES = new Set(Object.keys(PAYLOADS));

/** @returns {{ok: true} | {ok: false, reason: string}} */
export function validateEnvelope(env) {
  if (!isObj(env)) return bad('not an object');
  for (const k of ['schema_version', 'event_id', 'session_id', 'occurred_at', 'type']) {
    if (!str(env[k])) return bad(`missing ${k}`);
  }
  const m = /^(\d+)\.(\d+)$/.exec(env.schema_version);
  if (!m) return bad(`malformed schema_version "${env.schema_version}"`);
  if (Number(m[1]) !== SUPPORTED_MAJOR) return bad(`unsupported schema_version ${env.schema_version} (supports ${SUPPORTED_MAJOR}.x)`);
  if (!EVENT_TYPES.has(env.type)) return bad(`unknown event type "${env.type}"`);
  if (!date(env.occurred_at)) return bad('occurred_at is not a date');
  if (env.seq !== undefined && !(Number.isInteger(env.seq) && env.seq >= 0)) return bad('seq must be a non-negative integer');
  if (!isObj(env.payload)) return bad('missing payload');
  for (const [k, check] of Object.entries(PAYLOADS[env.type])) {
    if (!(k in env.payload)) return bad(`payload missing ${k} for ${env.type}`);
    const r = check(env.payload[k], `payload.${k}`);
    if (r === false) return bad(`payload.${k} is invalid for ${env.type}`);
    if (typeof r === 'string') return bad(r);
  }
  return { ok: true };
}
const bad = (reason) => ({ ok: false, reason });

/**
 * Validate a Snapshot. Invalid records are dropped (and listed), the rest is returned.
 * A snapshot without a usable session_id is rejected outright.
 */
export function sanitizeSnapshot(snap) {
  if (!isObj(snap) || !str(snap.session_id)) return { ok: false, reason: 'snapshot missing session_id' };
  const dropped = [];
  const keep = (list, validator, label) => (Array.isArray(list) ? list : []).filter((rec) => {
    const r = validator(rec, label);
    if (r) dropped.push(r);
    return !r;
  });
  const status = snap.status && validators.status(snap.status, 'status') === null ? snap.status : null;
  let display = null;
  if (snap.display) { const dr = validators.displayAction(snap.display, 'display'); if (dr) dropped.push(dr); else display = snap.display; }
  return {
    ok: true,
    dropped,
    snapshot: {
      schema_version: snap.schema_version ?? SCHEMA_VERSION,
      session_id: snap.session_id,
      status,
      display,
      profiles: keep(snap.profiles, validators.profile, 'profile'),
      notes: keep(snap.notes, validators.note, 'note'),
      encounters: keep(snap.encounters, validators.encounter, 'encounter'),
      reminders: keep(snap.reminders, validators.reminder, 'reminder'),
      moments: keep(snap.moments, validators.moment, 'moment'),
    },
  };
}

let counter = 0;
/** Unique id. Providers may use their own scheme; only uniqueness matters. */
export function newId(prefix = 'id') {
  counter = (counter + 1) % 1_000_000;
  const rand = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}

/** Build an envelope. `occurred_at` defaults to now; pass a clock for tests. */
export function makeEnvelope(type, payload, { session_id, occurred_at, event_id, seq } = {}) {
  const env = {
    schema_version: SCHEMA_VERSION,
    event_id: event_id ?? newId('evt'),
    session_id,
    occurred_at: occurred_at ?? new Date().toISOString(),
    type,
    payload,
  };
  if (seq !== undefined) env.seq = seq;
  return env;
}
