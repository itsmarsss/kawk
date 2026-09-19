/**
 * Remember UI contracts — schema_version "1.0".
 *
 * These are the DTOs exchanged between a Provider (demo today, live agent/memory
 * later) and the UI store. The UI never decides significance, identity or intent;
 * it only validates and renders what a provider sends. See ../../../REMEMBER_UI.md.
 */

export type SchemaVersion = '1.0';
export type ISODateTime = string; // ISO-8601 with timezone, e.g. 2026-09-19T14:03:22.120Z

/**
 * Where a record came from. Demo: 'demo-fixture' | 'introduction'. Live V1: 'live-perception'
 * (real faces/objects/speech percepts) and 'v1-rules' (the server's small command grammar and
 * manual actions — NOT an agent decision). 'live-agent' marks records a real decision backend
 * created (Jev moments; automatic conversation notes). 'live-memory' stays reserved.
 */
export type Source = 'demo-fixture' | 'user' | 'introduction' | 'live-perception' | 'v1-rules' | 'live-agent' | 'live-memory';

export interface Note {
  schema_version: SchemaVersion;
  id: string;
  profile_id: string;
  text: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  source: Source;
  /**
   * Automatic conversation notes (source 'live-agent'): Jev decided that ordinary speech heard
   * while exactly one recognised person was in view was worth remembering. The note is bound to
   * that person as *conversation context*; `speaker` is 'unknown' — a visible face is never
   * treated as evidence of who spoke. `source_text` is the verbatim final (≤ 1000 chars).
   * All of these are optional: older payloads and manual notes do not carry them, and the UI
   * passes them through unchanged on edit (the server then sets `edited_by_user`).
   */
  attribution?: 'conversation_context' | string;
  speaker?: 'unknown' | string;
  decision_model?: string;          // 'jev-1.13.0'
  source_segment_id?: string;
  source_session_id?: string;
  source_encounter_id?: string;
  source_text?: string;
  edited_by_user?: boolean;
}

export interface Profile {
  schema_version: SchemaVersion;
  id: string;                       // stable across sessions: e.g. "person_alex_demo"
  kind: 'person' | 'object';
  name: string;
  /** Short descriptor shown under the name: "Teammate · hardware" or "Keyring, 3 keys". */
  descriptor?: string;
  created_at: ISODateTime;
  /** Denormalised for fast cards; the authoritative history is `Encounter`. */
  last_seen_at?: ISODateTime;
  last_seen_location?: string;
  /** Id of the latest Moment that shows this profile, if any. */
  last_moment_id?: string;
  source: Source;
  /** Demo-only: the fixture actor key this profile was generated from. */
  actor_key?: string;
}

export interface Encounter {
  schema_version: SchemaVersion;
  id: string;
  profile_id: string;
  started_at: ISODateTime;
  ended_at?: ISODateTime;
  location?: string;
  /** Categorical, never a raw score (mirrors the hub's snapshot vocabulary). */
  confidence: 'weak' | 'ok' | 'strong';
  source: Source;
}

export type ReminderStatus = 'active' | 'snoozed' | 'completed';

export interface Reminder {
  schema_version: SchemaVersion;
  id: string;
  profile_id: string;
  text: string;
  status: ReminderStatus;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  /** Set while status === 'snoozed'; the reminder is due again after this time. */
  snoozed_until?: ISODateTime;
  /** Encounter during which the wearer dismissed it; hidden for that encounter only. */
  dismissed_for_encounter_id?: string;
  completed_at?: ISODateTime;
  last_shown_at?: ISODateTime;
  source: Source;
}

export interface Clip {
  id: string;
  /** Same-origin URL of a real, playable video. Never a placeholder. */
  url: string;
  poster_url?: string;
  mime: 'video/mp4';
  /** What was asked for: event_at − 5 s … event_at + 5 s. */
  requested_start_at: ISODateTime;
  requested_end_at: ISODateTime;
  /**
   * What the media actually covers. A ring buffer may not have the full pre-roll (e.g. the
   * event happened 2 s after the hub started), so actual bounds sit inside requested bounds.
   * The UI reports the difference instead of pretending the footage exists.
   */
  start_at: ISODateTime;
  end_at: ISODateTime;
  duration_s: number;             // must equal (end_at − start_at) within 1 s
  coverage: 'complete' | 'partial';
  /** Present for live ring-buffer clips: whether PCM was muxed and how much of the window it covers. */
  audio?: { present: boolean; coverage: 'complete' | 'partial' | 'none'; captured_duration_s: number };
  provenance: {
    kind: 'demo-fixture' | 'live-ring-buffer';
    /** Free-form origin note, e.g. "rendered from keys-scene.svg" or a hub frame-ring id. */
    detail?: string;
  };
}

export type MomentStatus = 'recording' | 'saved' | 'failed';

export interface Moment {
  schema_version: SchemaVersion;
  id: string;
  title: string;
  summary?: string;
  event_at: ISODateTime;          // the significant instant; the clip spans ±5 s around it
  /** Wall-clock time at which the +5 s tail has been captured and the clip is durable. */
  saved_at?: ISODateTime;
  status: MomentStatus;
  failure_reason?: string;
  clip: Clip | null;              // null while recording or failed
  profile_ids: string[];
  location?: string;
  source: Source;
  /** Set on moments a real decision backend created (source 'live-agent'), e.g. 'jev-1.13.0'. */
  decision_model?: string;
}

/**
 * Decision backend status, sent by the V1 socket OUTSIDE envelopes as
 * {type:'v1.decision_status', status}. Runtime state of the provider, never stored.
 * 'configured'/'ready' mean the environment is set or the client is initialised — not live-verified.
 */
export interface DecisionStatus {
  backend: 'rules' | 'typesafe';
  phase: 'rules' | 'idle' | 'ready' | 'deciding' | 'dropped' | 'backoff' | 'error' | 'stopped';
  model: string | null;           // 'jev-1.13.0' when typesafe
  message: string;
  timings_ms?: Record<string, number>;
  retry_after_s?: number;
  requires_reconfiguration?: boolean;
  reason?: string;
  event_id?: string;
}

export interface TranscriptSegment {
  schema_version: SchemaVersion;
  id: string;                     // segment id; partials REPLACE earlier text with the same id
  text: string;
  is_final: boolean;
  started_at: ISODateTime;
  updated_at: ISODateTime;
  speaker: 'wearer' | 'other' | 'unknown';
  /** Decided by the provider (the hub's Jev gate later). 'pending' until known. */
  directed: 'pending' | 'device' | 'conversation';
  /**
   * Optional: what the ambient memory gate did with this finalized segment. Present only once the
   * server resolved it; a 'conversation' segment stays a conversation whether or not it was saved.
   * 'not_saved' is normal (no single recognised person in view, limit reached…) — `reason` explains.
   */
  memory?: {
    state: 'saved' | 'duplicate' | 'not_saved';
    note_id?: string | null;
    profile_id?: string;
    profile_name?: string;
    reason?: string;
  };
}

export type AnswerKind = 'found' | 'not_found' | 'unsupported' | 'ignored';

export interface Answer {
  query_id: string;
  question: string;
  kind: AnswerKind;
  text: string;
  /** Optional context lines shown under the answer (when / where). */
  context?: string[];
  profile_id?: string;
  moment_id?: string;
  answered_at: ISODateTime;
}

export interface Recognition {
  track_id: string;
  kind: 'person' | 'object';
  state: 'pending' | 'listening' | 'resolved' | 'unresolved';
  /** Human sentence for the card, e.g. "Someone new — listening for an introduction". */
  label: string;
  started_at: ISODateTime;
  profile_id?: string;
}

export interface Scene {
  kind: 'idle' | 'person' | 'object' | 'conversation';
  caption: string;
  illustration_url?: string;
}

export interface ProviderStatus {
  schema_version: SchemaVersion;
  provider: 'demo' | 'live';
  state: 'idle' | 'running' | 'stopped' | 'error';
  /** Short human label for the status chip, e.g. "Demo · simulated camera". */
  label: string;
  message?: string;
  session_id: string;
  /** 'live' may only be asserted by the backend that owns the capture; a connected socket alone is 'unknown'. */
  camera: 'simulated' | 'off' | 'live' | 'unknown';
  microphone: 'simulated' | 'off' | 'live' | 'unknown';
  since: ISODateTime;
  /**
   * Optional. True only when the server keeps person notes in a durable store on this machine
   * (linked to the enrolled gallery UUID; survives reload, session reset and server restart).
   * Absent or false = notes live in the temporary session only. The UI never assumes true.
   */
  memory_persistent?: boolean;
}

/* ------------------------------------------------------------ device display */

/**
 * AGENTS.md §5/§9 semantic display action for the 240×240 device screen. The server's V1 engine
 * chooses the action, its priority (answer 30 > enroll_prompt/alert 20 > profile 10 > idle 0)
 * and TTL; the browser LCD preview only renders it. `card.reminder` is shown ABOVE the profile
 * text. `card.clip_id` names a Moment whose saved clip may be paced onto the display at ≤10 fps.
 */
export interface DisplayAction {
  schema_version: SchemaVersion;
  id: string;
  display: { w: number; h: number };
  card: {
    template: 'profile' | 'answer' | 'alert' | 'enroll_prompt' | 'idle';
    title: string;
    body: string;
    image_ref: null | string;
    reminder: null | { id: string; text: string };
    clip_id?: string;
  };
  blit: null;
  ttl_ms: number;                 // 0 = no expiry
  priority: number;
  issued_at: ISODateTime;
  expires_at: null | ISODateTime;
}

/** Live enrollment (introduction) progress. Only one bound unknown face can be enrolled. */
export interface EnrollmentState {
  status: 'listening' | 'collecting' | 'complete' | 'ambiguous' | 'error' | 'cancelled';
  message: string;
  target_track_id?: string;
  name?: string;
  collected?: number;
  required?: number;
  profile_id?: string;
}

/** Initial hydration returned by Provider.getSnapshot(). */
export interface Snapshot {
  schema_version: SchemaVersion;
  session_id: string;
  status: ProviderStatus;
  profiles: Profile[];
  notes: Note[];
  encounters: Encounter[];
  reminders: Reminder[];
  moments: Moment[];
  /** Current device display, when the provider has one (live V1). */
  display?: DisplayAction | null;
}

/* ------------------------------------------------------------------ events */

export interface EventMap {
  'session.started': { status: ProviderStatus };
  'session.stopped': { status: ProviderStatus };
  'provider.status': { status: ProviderStatus };
  'scene.changed': { scene: Scene };
  'profile.upserted': { profile: Profile };
  /**
   * A person was deleted (people only). The store removes the profile, its notes, reminders and
   * encounters, untags it from moments (clips are kept), clears answers/recognition that point at
   * it, and tombstones the id so late upserts/encounters/notes/reminders cannot resurrect it.
   */
  'profile.deleted': { profile_id: string };
  'encounter.started': { encounter: Encounter };
  'encounter.ended': { encounter_id: string; ended_at: ISODateTime };
  'recognition.updated': { recognition: Recognition };
  /** track_id '*' clears whatever recognition is pending. */
  'recognition.cleared': { track_id: string };
  'note.upserted': { note: Note };
  'note.deleted': { note_id: string };
  'reminder.upserted': { reminder: Reminder };
  'reminder.deleted': { reminder_id: string };
  'transcript.updated': { segment: TranscriptSegment };
  'transcript.cleared': Record<string, never>;
  'answer.pending': { query_id: string; question: string };
  'answer.resolved': { answer: Answer };
  'moment.recording': { moment: Moment };
  'moment.saved': { moment: Moment };
  'moment.failed': { moment_id: string; reason: string };
  'moment.deleted': { moment_id: string };
  'display.updated': { action: DisplayAction };
  'enrollment.updated': { enrollment: EnrollmentState };
}

export type EventType = keyof EventMap;

export interface Envelope<T extends EventType = EventType> {
  schema_version: SchemaVersion;
  event_id: string;               // unique; the store drops duplicates
  session_id: string;             // must equal the session the store is bound to, else ignored
  occurred_at: ISODateTime;
  /**
   * Optional per-session monotonic sequence. When present, an envelope with seq ≤ the last
   * applied seq is treated as stale and dropped (out-of-order delivery / replays).
   */
  seq?: number;
  type: T;
  payload: EventMap[T];
}

/* ---------------------------------------------------------------- commands */

export interface CommandMap {
  'demo.run_scenario': { scenario: string };
  'demo.run_sequence': Record<string, never>;
  'demo.stop': Record<string, never>;
  'ask': { text: string };
  'note.save': { note: Note };
  'note.delete': { note_id: string };
  'reminder.save': { reminder: Reminder };
  'reminder.delete': { reminder_id: string };
  'reminder.complete': { reminder_id: string };
  'reminder.snooze': { reminder_id: string; minutes: number };
  'reminder.dismiss': { reminder_id: string; encounter_id: string };
  'moment.delete': { moment_id: string };
  /**
   * Delete a person (kind 'person' only). Demo: removes them from this browser's demo data. Live:
   * removes the saved face-gallery enrollment plus the session profile, notes, reminders and
   * encounters on the hub for every live session. Saved moments are kept, untagged. Answered by
   * 'profile.deleted' (or a v1.error, in which case nothing changed).
   */
  'profile.delete': { profile_id: string };
  /* Live V1 only (server-side handlers in tools/perception_lab/product.py): */
  'moment.mark': { title?: string; summary?: string; event_at?: ISODateTime; profile_ids?: string[] };
  'display.clear': Record<string, never>;
  'enrollment.cancel': Record<string, never>;
  /** Explicit typed introduction of the single unknown face in view (not a keyword decision). */
  'enrollment.introduction': { name: string };
  'capture.status': { camera: 'live' | 'off'; microphone: 'live' | 'off' };
}

export type CommandType = keyof CommandMap;

export interface Command<T extends CommandType = CommandType> {
  type: T;
  payload: CommandMap[T];
}

/* ---------------------------------------------------------------- provider */

export type Listener = (envelope: Envelope) => void;

export interface Provider {
  readonly kind: 'demo' | 'live';
  /** The session this provider emits under. The app binds the store to it before any event is applied. */
  readonly sessionId: string;
  /** Register for events; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
  /** Initial hydration. Called once by the app when the local namespace is empty. */
  getSnapshot(): Promise<Snapshot>;
  /** Begin emitting events (demo: enable scenarios; live: open the socket). */
  start(): Promise<void>;
  /** Stop and cancel every pending timer/request. Idempotent. */
  stop(): Promise<void>;
  /** UI intent. The provider responds with events, never by mutating the store. */
  dispatch(command: Command): Promise<void>;
}
