// DemoProvider: the only place demo decisions are made — who appears, what is heard, what the
// answer is, what counts as a significant moment. It speaks the same Provider interface a live
// agent/memory provider will, so swapping it out is a one-line change in config.js.
import { SCHEMA_VERSION, makeEnvelope } from '../contracts/envelope.js';
import { ACTORS, MEDIA, seedSnapshot, profile, note, keysMoment, conversationMoment, conversationClip } from '../fixtures/fixtures.js';
import { createEmitter, realClock } from './provider.js';

export const SCENARIOS = [
  { key: 'keys_on_desk', title: 'Keys on the desk', hint: 'Object card, last-seen, saves a keys clip' },
  { key: 'teammate_arrives', title: 'Teammate arrives', hint: 'Alex is recognised; reminder above profile' },
  { key: 'overheard', title: 'Overheard conversation', hint: 'Speech that is not for Remember' },
  { key: 'ask_keys', title: 'Ask: “Where are my keys?”', hint: 'Device-directed speech, answer with clip' },
  { key: 'new_introduction', title: 'New introduction', hint: '“Hi, I’m Maya” → new profile' },
  { key: 'significant_moment', title: 'Significant moment', hint: '−5 s / event / +5 s clip save' },
];

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {{clock?: typeof realClock, getState?: () => any, sessionId?: string}} [opts]
 * @returns {import('../contracts/types').Provider & {sessionId: string, scenarios: typeof SCENARIOS}}
 */
export function createDemoProvider(opts = {}) {
  const clock = opts.clock ?? realClock;
  const getState = opts.getState ?? (() => ({ profiles: {}, reminders: {}, moments: {}, notes: {} }));
  const sessionId = opts.sessionId ?? `ses_${clock.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const emitter = createEmitter();

  let running = false;
  let eventSeq = 0;
  let runSeq = 0;
  /** Scene generation: bumped per scenario run; stale visual/recognition/encounter callbacks check it. */
  let sceneGen = 0;
  const timers = new Set();
  /** @type {{id: string, profileId: string} | null} */
  let activeEncounter = null;
  /** Moments still recording → their +5 s timer. Failed if the demo stops before it fires; cancelled on delete. */
  const recording = new Map();
  /** People deleted in this provider's lifetime. The store's persisted tombstones cover reloads. */
  const deletedHere = new Set();
  const isDeleted = (id) => deletedHere.has(id) || Boolean(getState().deleted_profile_ids?.includes(id));
  /** The live profile for a fixture actor: same id, or a re-created one (actor_key) after a deletion. */
  const actorProfile = (st, actor) => {
    const direct = st.profiles?.[actor.id];
    if (direct && !isDeleted(direct.id)) return direct;
    return Object.values(st.profiles ?? {}).find((p) => p.actor_key === actor.id && !isDeleted(p.id)) ?? null;
  };

  const status = (state, extra = {}) => ({
    schema_version: SCHEMA_VERSION, provider: 'demo', state,
    label: state === 'running' ? 'Demo · simulated camera & speech' : state === 'idle' ? 'Demo · not started' : 'Demo · stopped',
    message: state === 'running' ? 'Nothing here is real inference. Scenes are scripted fixtures.' : 'No camera or microphone is used. Start the demo to run scripted scenes.',
    session_id: sessionId, camera: state === 'running' ? 'simulated' : 'off', microphone: state === 'running' ? 'simulated' : 'off',
    since: iso(clock.now()), ...extra,
  });

  let announced = false;
  /** Every session's first envelope is `session.started`, so the store adopts the session before anything else. */
  function emit(type, payload, atMs = clock.now()) {
    if (!announced && type !== 'session.started') { announced = true; raw('session.started', { status: status(running ? 'running' : 'idle') }, atMs); }
    if (type === 'session.started') announced = true;
    raw(type, payload, atMs);
  }
  function raw(type, payload, atMs) {
    eventSeq += 1;
    emitter.emit(makeEnvelope(type, payload, { session_id: sessionId, occurred_at: iso(atMs), event_id: `${sessionId}_${eventSeq}`, seq: eventSeq }));
  }

  /** Unscoped timer: cancelled only by stop()/reset. Used for recording tails, answers, sequence steps. */
  function after(ms, fn) {
    const id = clock.setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }
  /** Scene-scoped timer: also a no-op once a newer scenario has started (no ghost callbacks in a new scene). */
  function sceneAfter(gen, ms, fn) { return after(ms, () => { if (gen === sceneGen) fn(); }); }
  function cancelTimers() { for (const id of timers) clock.clearTimeout(id); timers.clear(); }

  /* ------------------------------------------------------------ scene helpers */

  function endActiveEncounter() {
    if (!activeEncounter) return;
    emit('encounter.ended', { encounter_id: activeEncounter.id, ended_at: iso(clock.now()) });
    activeEncounter = null;
  }
  /** End an encounter only if it is still the active one (a newer scene may have replaced it). */
  function endEncounterIf(id) { if (activeEncounter?.id === id) endActiveEncounter(); }
  function startEncounter(actor, location, confidence = 'strong') {
    endActiveEncounter();
    const id = `enc_${actor.id}_${sessionId}_${runSeq}`;
    activeEncounter = { id, profileId: actor.id };
    emit('encounter.started', { encounter: { schema_version: SCHEMA_VERSION, id, profile_id: actor.id, started_at: iso(clock.now()), location, confidence, source: 'demo-fixture' } });
    return id;
  }
  function scene(kind, caption, illustration_url) { emit('scene.changed', { scene: { kind, caption, illustration_url } }); }
  function idle() { endActiveEncounter(); scene('idle', 'Nothing in view'); }
  /** Start a recording job: independent of scene generation, cancelled by stop/reset or moment.delete. */
  function record(momentId, recordingMoment, buildSaved) {
    emit('moment.recording', { moment: recordingMoment });
    const id = after(5_000, () => {
      recording.delete(momentId);
      emit('moment.saved', { moment: buildSaved(clock.now()) });
    });
    recording.set(momentId, id);
  }
  function recognition(track_id, kind, state, label, extra = {}) {
    emit('recognition.updated', { recognition: { track_id, kind, state, label, started_at: iso(clock.now()), ...extra } });
  }
  function segment(id, text, is_final, speaker, directed, startedAt) {
    emit('transcript.updated', { segment: { schema_version: SCHEMA_VERSION, id, text, is_final, started_at: startedAt, updated_at: iso(clock.now()), speaker, directed } });
  }

  /* ---------------------------------------------------------------- scenarios */

  const scenarios = {
    keys_on_desk(run, gen) {
      const track = `trk_keys_${run}`;
      endActiveEncounter(); // the view changed: whatever was in view before is not any more
      scene('object', 'Your desk. Something was just set down.', MEDIA.keysScene);
      recognition(track, 'object', 'pending', 'Recognising an object…');
      sceneAfter(gen, 700, () => {
        const at = clock.now();
        emit('profile.upserted', { profile: profile(ACTORS.keys, { last_seen_location: ACTORS.keys.location }) });
        startEncounter(ACTORS.keys, ACTORS.keys.location);
        emit('recognition.cleared', { track_id: track });
        const momentId = `moment_keys_${sessionId}_${run}`;
        record(momentId,
          { ...keysMoment({ id: momentId, eventAtMs: at, location: ACTORS.keys.location }), status: 'recording', clip: null, saved_at: undefined },
          (savedAt) => keysMoment({ id: momentId, eventAtMs: at, location: ACTORS.keys.location, savedAtMs: savedAt }));
      });
      sceneAfter(gen, 8_000, idle);
      return 8_500;
    },

    teammate_arrives(run, gen) {
      const track = `trk_alex_${run}`;
      endActiveEncounter();
      scene('person', 'Team table. Someone just walked up.', MEDIA.conversationScene);
      recognition(track, 'person', 'pending', 'Recognising…');
      let encId = null;
      sceneAfter(gen, 900, () => {
        if (isDeleted(ACTORS.alex.id)) {
          // Alex was deleted from the demo data: the face is no longer known, so nothing is re-created.
          recognition(track, 'person', 'unresolved', 'No match in memory. This person was deleted from the demo data; no introduction heard.');
          sceneAfter(gen, 4_000, () => emit('recognition.cleared', { track_id: track }));
          return;
        }
        emit('profile.upserted', { profile: profile(ACTORS.alex, { last_seen_location: ACTORS.alex.location }) });
        encId = startEncounter(ACTORS.alex, ACTORS.alex.location);
        emit('recognition.cleared', { track_id: track });
      });
      // Alex may still be in view when the next sequence step runs; end only if nothing replaced it.
      after(12_000, () => { if (gen === sceneGen) idle(); else endEncounterIf(encId); });
      return 3_500; // sequence moves on while Alex stays in view
    },

    overheard(run) {
      const seg = `seg_overheard_${run}`;
      const started = iso(clock.now());
      segment(seg, 'Yeah, I keep losing', false, 'wearer', 'pending', started);
      after(900, () => segment(seg, 'Yeah, I keep losing stuff, honestly.', true, 'wearer', 'conversation', started));
      after(2_400, () => {
        const seg2 = `seg_overheard_reply_${run}`;
        segment(seg2, 'Same. I lost my badge twice today.', true, 'other', 'conversation', iso(clock.now()));
      });
      return 3_500;
    },

    ask_keys(run) {
      const seg = `seg_ask_${run}`;
      const started = iso(clock.now());
      segment(seg, 'Where are', false, 'wearer', 'pending', started);
      after(600, () => segment(seg, 'Where are my', false, 'wearer', 'pending', started));
      after(1_200, () => {
        segment(seg, 'Where are my keys?', true, 'wearer', 'device', started);
        answer(`q_ask_${run}`, 'Where are my keys?', 800);
      });
      return 4_000;
    },

    new_introduction(run, gen) {
      const track = `trk_intro_${run}`;
      endActiveEncounter();
      const existing = actorProfile(getState(), ACTORS.maya);
      const known = Boolean(existing);
      // A deleted Maya is gone for good; introducing herself again enrols a NEW person (fresh id), as live would.
      const maya = existing ? { ...ACTORS.maya, id: existing.id } : isDeleted(ACTORS.maya.id) ? { ...ACTORS.maya, id: `${ACTORS.maya.id}_${run}` } : ACTORS.maya;
      const introNoteId = maya.id === ACTORS.maya.id ? ACTORS.maya.introNoteId : `${ACTORS.maya.introNoteId}_${maya.id}`;
      scene('conversation', 'Sponsor hall. Someone is saying hello.', MEDIA.conversationScene);
      recognition(track, 'person', 'pending', 'Recognising…');
      sceneAfter(gen, 1_200, () => recognition(track, 'person', 'listening', known ? 'Recognised — waiting for them to speak' : 'Someone new. No match in memory — listening for an introduction.'));
      const seg = `seg_intro_${run}`;
      sceneAfter(gen, 2_200, () => segment(seg, 'Hi, I’m', false, 'other', 'pending', iso(clock.now())));
      sceneAfter(gen, 3_200, () => segment(seg, ACTORS.maya.introduction, true, 'other', 'conversation', iso(clock.now() - 1000)));
      sceneAfter(gen, 3_900, () => {
        const now = clock.now();
        emit('profile.upserted', { profile: profile(maya, { created_at: iso(now), source: 'introduction', last_seen_location: ACTORS.maya.location, actor_key: ACTORS.maya.id }) });
        emit('note.upserted', { note: note({ id: introNoteId, profile_id: maya.id, text: `Introduced themselves: “${ACTORS.maya.introduction}” — ${ACTORS.maya.location}.`, at: iso(now), source: 'introduction' }) });
        startEncounter(maya, ACTORS.maya.location, 'ok');
        recognition(track, 'person', 'resolved', known ? 'Recognised: Maya' : 'New profile created from the introduction', { profile_id: maya.id });
      });
      sceneAfter(gen, 5_500, () => emit('recognition.cleared', { track_id: track }));
      sceneAfter(gen, 13_000, idle);
      return 10_500;
    },

    significant_moment(run, gen) {
      scene('conversation', 'Team table, talking with Alex.', MEDIA.conversationScene);
      const alexKnown = !isDeleted(ACTORS.alex.id);
      if (alexKnown && activeEncounter?.profileId !== ACTORS.alex.id) {
        emit('profile.upserted', { profile: profile(ACTORS.alex, { last_seen_location: ACTORS.alex.location }) });
        startEncounter(ACTORS.alex, ACTORS.alex.location);
      }
      const seg = `seg_pitch_${run}`;
      sceneAfter(gen, 500, () => segment(seg, 'Heads up, the pitch', false, 'other', 'pending', iso(clock.now())));
      sceneAfter(gen, 1_500, () => segment(seg, 'Heads up — the pitch moved to 3 pm.', true, 'other', 'conversation', iso(clock.now() - 1000)));
      const momentId = `moment_pitch_${sessionId}_${run}`;
      sceneAfter(gen, 1_600, () => {
        const eventAt = clock.now();
        const m = conversationMoment({ id: momentId, eventAtMs: eventAt, location: ACTORS.alex.location, profileIds: alexKnown ? [ACTORS.alex.id] : [] });
        record(momentId, m, (savedAt) => ({ ...m, status: 'saved', saved_at: iso(savedAt), clip: conversationClip(eventAt, `${momentId}_clip`) }));
      });
      sceneAfter(gen, 12_000, idle);
      return 12_500;
    },
  };

  const SEQUENCE = ['keys_on_desk', 'teammate_arrives', 'overheard', 'ask_keys', 'new_introduction', 'significant_moment'];

  /** Scenarios that take over the camera view; speech-only scenarios leave the current scene alone. */
  const VISUAL = new Set(['keys_on_desk', 'teammate_arrives', 'new_introduction', 'significant_moment']);
  function runScenario(key) {
    const fn = scenarios[key];
    if (!fn) throw new Error(`Unknown demo scenario "${key}"`);
    runSeq += 1;
    if (VISUAL.has(key)) sceneGen += 1;
    return fn(runSeq, sceneGen);
  }

  function runSequence() {
    let offset = 0;
    for (const key of SEQUENCE) {
      const gap = SCENARIO_GAP[key] ?? 0;
      after(offset, () => runScenario(key));
      offset += gap;
    }
  }
  const SCENARIO_GAP = { keys_on_desk: 8_500, teammate_arrives: 3_500, overheard: 3_500, ask_keys: 5_000, new_introduction: 10_500, significant_moment: 12_500 };

  /* ------------------------------------------------------------------ answers */

  /** The demo's stand-in for the hub's Jev gate + task handlers: keyword rules, nothing more. */
  function answer(queryId, question, delayMs) {
    emit('answer.pending', { query_id: queryId, question });
    after(delayMs, () => {
      const st = getState();
      const q = question.toLowerCase();
      const answered_at = iso(clock.now());
      let result;
      if (/\bkeys?\b/.test(q)) {
        const keys = st.profiles?.[ACTORS.keys.id];
        const moment = latestSavedMoment(st, ACTORS.keys.id);
        if (keys) {
          result = {
            kind: 'found', profile_id: keys.id, moment_id: moment?.id,
            text: `Your keys are ${lower(keys.last_seen_location ?? 'somewhere I saw earlier')}.`,
            context: [keys.last_seen_at ? `Last seen ${whenText(keys.last_seen_at, clock.now())}` : 'Last seen: unknown', moment ? 'Clip saved from that moment' : 'No clip for that moment'],
          };
        } else {
          result = { kind: 'not_found', text: 'I haven’t seen your keys in this demo yet.', context: ['Run the “Keys on the desk” scene first.'] };
        }
      } else if (/\b(wallet|phone|badge|laptop|bottle|glasses|backpack|charger)\b/.test(q)) {
        const thing = q.match(/\b(wallet|phone|badge|laptop|bottle|glasses|backpack|charger)\b/)[1];
        result = { kind: 'not_found', text: `I haven’t seen your ${thing}.`, context: ['Only the keys are in demo memory.'] };
      } else if (/\b(alex|maya)\b/.test(q) || /who (is|was|did)/.test(q)) {
        const key = /maya/.test(q) ? 'maya' : 'alex';
        const person = actorProfile(st, ACTORS[key]);
        if (person) {
          const reminders = Object.values(st.reminders ?? {}).filter((r) => r.profile_id === person.id && r.status === 'active');
          result = {
            kind: 'found', profile_id: person.id,
            text: `${person.name}${person.descriptor ? ` — ${lower(person.descriptor)}` : ''}.`,
            context: [person.last_seen_at ? `Last met ${whenText(person.last_seen_at, clock.now())}` : 'Not met yet', reminders.length ? `${reminders.length} open reminder${reminders.length > 1 ? 's' : ''}` : 'No open reminders'],
          };
        } else {
          result = { kind: 'not_found', text: `I don’t have anyone called ${cap(key)} in demo memory.`, context: ['Run “New introduction” to meet Maya.'] };
        }
      } else {
        result = {
          kind: 'unsupported',
          text: 'The demo only answers “where are my keys?” and “who is Alex / Maya?”.',
          context: ['A live memory would search encounters, notes and the transcript for this.'],
        };
      }
      emit('answer.resolved', { answer: { query_id: queryId, question, answered_at, ...result } });
    });
  }

  /* ----------------------------------------------------------------- commands */

  const commands = {
    'demo.run_scenario': ({ scenario }) => { runScenario(scenario); },
    'demo.run_sequence': () => { runSequence(); },
    'demo.stop': () => stopScenes(),
    'ask': ({ text }) => {
      const q = String(text ?? '').trim();
      if (!q) return;
      const id = `q_typed_${sessionId}_${++runSeq}`;
      answer(id, q, 700);
    },
    'note.save': ({ note: n }) => emit('note.upserted', { note: { ...n, schema_version: SCHEMA_VERSION, updated_at: iso(clock.now()) } }),
    'note.delete': ({ note_id }) => emit('note.deleted', { note_id }),
    'reminder.save': ({ reminder }) => emit('reminder.upserted', { reminder: { ...reminder, schema_version: SCHEMA_VERSION, updated_at: iso(clock.now()) } }),
    'reminder.delete': ({ reminder_id }) => emit('reminder.deleted', { reminder_id }),
    'reminder.complete': ({ reminder_id }) => updateReminder(reminder_id, (r) => ({ ...r, status: 'completed', completed_at: iso(clock.now()), snoozed_until: undefined })),
    'reminder.snooze': ({ reminder_id, minutes }) => updateReminder(reminder_id, (r) => ({ ...r, status: 'snoozed', snoozed_until: iso(clock.now() + Math.max(1, minutes ?? 15) * 60_000), dismissed_for_encounter_id: undefined })),
    'reminder.dismiss': ({ reminder_id, encounter_id }) => updateReminder(reminder_id, (r) => ({ ...r, dismissed_for_encounter_id: encounter_id })),
    'moment.delete': ({ moment_id }) => {
      const timer = recording.get(moment_id);
      if (timer !== undefined) { clock.clearTimeout(timer); timers.delete(timer); recording.delete(moment_id); }
      emit('moment.deleted', { moment_id });
    },
    /** People only. The store cascades (notes, reminders, encounters, moment tags) and tombstones the id. */
    'profile.delete': ({ profile_id }) => {
      const id = typeof profile_id === 'string' ? profile_id : '';
      const p = id ? getState().profiles?.[id] : null;
      if (!p || isDeleted(id)) throw new Error('That person is not in the demo data');
      if (p.kind !== 'person') throw new Error('Only people can be deleted; things are tracked automatically');
      deletedHere.add(id);
      if (activeEncounter?.profileId === id) activeEncounter = null; // the encounter goes with the person; no encounter.ended for a removed row
      emit('profile.deleted', { profile_id: id });
    },
  };

  function updateReminder(id, fn) {
    const r = getState().reminders?.[id];
    if (!r) return;
    emit('reminder.upserted', { reminder: { ...fn(r), updated_at: iso(clock.now()) } });
  }

  function stopScenes() {
    cancelTimers();
    sceneGen += 1;
    for (const [id] of recording) emit('moment.failed', { moment_id: id, reason: 'Demo stopped before the +5 s tail was captured' });
    recording.clear();
    if (running) idle();
  }

  return {
    kind: 'demo',
    sessionId,
    scenarios: SCENARIOS,
    subscribe: emitter.subscribe,
    async getSnapshot() { return seedSnapshot({ nowMs: clock.now(), sessionId, status: status('idle') }); },
    async start() {
      if (running) return;
      running = true;
      emit(announced ? 'provider.status' : 'session.started', { status: status('running') });
      idle();
    },
    async stop() {
      if (!running) { cancelTimers(); return; }
      stopScenes();
      running = false;
      emit('recognition.cleared', { track_id: '*' });
      emit('session.stopped', { status: status('stopped') });
    },
    async dispatch(command) {
      const handler = commands[command?.type];
      if (!handler) throw new Error(`Unsupported command "${command?.type}"`);
      const needsRun = command.type.startsWith('demo.') && command.type !== 'demo.stop';
      if (needsRun && !running) await this.start();
      handler(command.payload ?? {});
    },
  };
}

function latestSavedMoment(st, profileId) {
  return Object.values(st.moments ?? {})
    .filter((m) => m.status === 'saved' && m.clip && m.profile_ids?.includes(profileId))
    .sort((a, b) => b.event_at.localeCompare(a.event_at))[0] ?? null;
}
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "2 h ago (12:04)" — short relative + absolute time, used in answers. */
export function whenText(isoStr, nowMs) {
  const t = Date.parse(isoStr);
  const d = Math.max(0, nowMs - t);
  const time = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d < 45_000) return `just now (${time})`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago (${time})`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago (${time})`;
  const days = Math.round(d / 86_400_000);
  return `${days === 1 ? 'yesterday' : `${days} days ago`} (${time})`;
}
