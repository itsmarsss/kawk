// Demo fixture data. Everything here is invented for the demo and labelled as such in the UI.
// Stable ids are the contract: replaying a scene upserts the same records instead of duplicating them.
import { SCHEMA_VERSION } from '../contracts/envelope.js';

export const MEDIA = {
  keysScene: '/static/remember/fixtures/keys-scene.svg',
  conversationScene: '/static/remember/fixtures/conversation-scene.svg',
  keysClip: '/static/remember/fixtures/keys-moment.mp4',
  conversationClip: '/static/remember/fixtures/conversation-moment.mp4',
};

/** Fixture actors. `id` is stable across sessions and reloads. */
export const ACTORS = {
  alex: {
    id: 'person_alex_demo', kind: 'person', name: 'Alex Chen', descriptor: 'Teammate · hardware',
    seeded: true, location: 'Team table, E7 atrium',
    notes: [
      { id: 'note_alex_seed_1', text: 'Owns the glasses build; soldering the mic board.', hoursAgo: 26 },
      { id: 'note_alex_seed_2', text: 'Prefers coffee, not tea. Asked about the display brightness.', hoursAgo: 20 },
    ],
  },
  maya: {
    id: 'person_maya_demo', kind: 'person', name: 'Maya', descriptor: 'Met at the demo', seeded: false,
    location: 'Sponsor hall',
    introduction: 'Hi, I’m Maya',
    introNoteId: 'note_maya_intro',
  },
  keys: {
    id: 'object_keys_demo', kind: 'object', name: 'Keys', descriptor: 'Keyring · 3 keys, blue tag',
    seeded: true, location: 'On your desk, next to the laptop',
    notes: [{ id: 'note_keys_seed_1', text: 'Usually left by the laptop or in the backpack side pocket.', hoursAgo: 30 }],
  },
};

const iso = (ms) => new Date(ms).toISOString();
const hours = (h) => h * 3600_000;

/** Build the seed snapshot relative to `nowMs`. Called once per fresh namespace. */
export function seedSnapshot({ nowMs, sessionId, status }) {
  const profiles = [];
  const notes = [];
  const encounters = [];
  const reminders = [];
  const moments = [];

  const alexLast = nowMs - hours(19.5);
  const keysLast = nowMs - hours(2.2);

  profiles.push(profile(ACTORS.alex, { created_at: iso(nowMs - hours(30)), last_seen_at: iso(alexLast), last_seen_location: ACTORS.alex.location }));
  profiles.push(profile(ACTORS.keys, { created_at: iso(nowMs - hours(31)), last_seen_at: iso(keysLast), last_seen_location: ACTORS.keys.location, last_moment_id: 'moment_keys_seed' }));

  for (const a of [ACTORS.alex, ACTORS.keys]) {
    for (const n of a.notes) notes.push(note({ id: n.id, profile_id: a.id, text: n.text, at: iso(nowMs - hours(n.hoursAgo)), source: 'demo-fixture' }));
  }

  encounters.push({ schema_version: SCHEMA_VERSION, id: 'enc_alex_seed', profile_id: ACTORS.alex.id, started_at: iso(alexLast - 600_000), ended_at: iso(alexLast), location: ACTORS.alex.location, confidence: 'strong', source: 'demo-fixture' });
  encounters.push({ schema_version: SCHEMA_VERSION, id: 'enc_keys_seed', profile_id: ACTORS.keys.id, started_at: iso(keysLast - 45_000), ended_at: iso(keysLast), location: ACTORS.keys.location, confidence: 'strong', source: 'demo-fixture' });

  reminders.push({
    schema_version: SCHEMA_VERSION, id: 'rem_alex_seed', profile_id: ACTORS.alex.id,
    text: 'Ask Alex for the mic board schematic before the pitch.',
    status: 'active', created_at: iso(nowMs - hours(18)), updated_at: iso(nowMs - hours(18)), source: 'demo-fixture',
  });

  moments.push(keysMoment({ id: 'moment_keys_seed', eventAtMs: keysLast, location: ACTORS.keys.location, savedAtMs: keysLast + 5_500 }));

  return { schema_version: SCHEMA_VERSION, session_id: sessionId, status, profiles, notes, encounters, reminders, moments };
}

export function profile(actor, extra = {}) {
  return {
    schema_version: SCHEMA_VERSION, id: actor.id, kind: actor.kind, name: actor.name, descriptor: actor.descriptor,
    created_at: extra.created_at ?? new Date().toISOString(), source: 'demo-fixture', actor_key: actor.id, ...extra,
  };
}

export function note({ id, profile_id, text, at, source }) {
  return { schema_version: SCHEMA_VERSION, id, profile_id, text, created_at: at, updated_at: at, source };
}

/**
 * Demo clips always cover the full requested ±5 s (the fixture MP4s are exactly 10 s), so
 * requested and actual bounds coincide and coverage is 'complete'. A live ring buffer would set
 * start_at later than requested_start_at (and coverage 'partial') when pre-roll is missing.
 */
export function clip({ id, url, poster_url, eventAtMs, detail }) {
  return {
    id, url, poster_url, mime: 'video/mp4',
    requested_start_at: iso(eventAtMs - 5_000), requested_end_at: iso(eventAtMs + 5_000),
    start_at: iso(eventAtMs - 5_000), end_at: iso(eventAtMs + 5_000), duration_s: 10, coverage: 'complete',
    provenance: { kind: 'demo-fixture', detail },
  };
}

export function keysMoment({ id, eventAtMs, location, savedAtMs }) {
  return {
    schema_version: SCHEMA_VERSION, id,
    title: 'Keys set down on the desk', summary: 'Keys left next to the laptop, by the coffee mug.',
    event_at: iso(eventAtMs), saved_at: savedAtMs ? iso(savedAtMs) : undefined,
    status: 'saved', profile_ids: [ACTORS.keys.id], location, source: 'demo-fixture',
    clip: clip({ id: `${id}_clip`, url: MEDIA.keysClip, poster_url: MEDIA.keysScene, eventAtMs, detail: 'Demo clip rendered from keys-scene.svg' }),
  };
}

export function conversationMoment({ id, eventAtMs, location, profileIds }) {
  return {
    schema_version: SCHEMA_VERSION, id,
    title: 'Alex: the pitch moved to 3 pm', summary: 'Alex mentioned the judging slot moved earlier; slides need to be ready by 2:30.',
    event_at: iso(eventAtMs), status: 'recording', profile_ids: profileIds, location, source: 'demo-fixture', clip: null,
  };
}

export function conversationClip(eventAtMs, id) {
  return clip({ id, url: MEDIA.conversationClip, poster_url: MEDIA.conversationScene, eventAtMs, detail: 'Demo clip rendered from conversation-scene.svg' });
}
