import { check, eq, fakeClock } from './harness.mjs';
import { createStore, select } from '../store/store.js';
import { createPersistence, memoryStorage } from '../store/persist.js';
import { createDemoProvider } from '../providers/demo_provider.js';
import { validateEnvelope } from '../contracts/envelope.js';
import { ACTORS } from '../fixtures/fixtures.js';

const T = '2026-09-19T14:00:00.000Z';

/** Same wiring as app.js: hydrate → bindSession → subscribe. */
async function rig() {
  const clock = fakeClock();
  const store = createStore({ persistence: createPersistence(memoryStorage()), now: clock.now });
  const provider = createDemoProvider({ clock, getState: store.getState });
  const invalid = [];
  store.hydrate(await provider.getSnapshot());
  store.bindSession(provider.sessionId);
  provider.subscribe((e) => { const v = validateEnvelope(e); if (!v.ok) invalid.push(v.reason); store.apply(e); });
  return { clock, store, provider, invalid };
}

export async function run() {
  console.log('\n# demo provider: seed + teammate arrives within 2 s');
  {
    const { clock, store, provider, invalid } = await rig();
    eq(select.people(store.getState()).map((p) => p.id), [ACTORS.alex.id], 'seed has one person');
    eq(select.reminders(store.getState()).length, 1, 'seeded reminder present');
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    eq(store.getState().status.state, 'running', 'auto-started');
    eq(store.getState().recognition?.state, 'pending', 'pending recognition shown first');
    clock.advance(2000);
    eq(select.activeProfile(store.getState())?.id, ACTORS.alex.id, 'Alex profile active within 2 s');
    const enc = select.activeEncounter(store.getState());
    eq(select.dueReminders(store.getState(), ACTORS.alex.id, enc.id, clock.now()).map((r) => r.id), ['rem_alex_seed'], 'seeded reminder due on encounter');
    await provider.dispatch({ type: 'reminder.dismiss', payload: { reminder_id: 'rem_alex_seed', encounter_id: enc.id } });
    eq(select.dueReminders(store.getState(), ACTORS.alex.id, enc.id, clock.now()).length, 0, 'dismiss hides for this encounter');
    clock.advance(11_000);
    eq(select.activeProfile(store.getState()), null, 'encounter ends');
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    clock.advance(2000);
    const enc2 = select.activeEncounter(store.getState());
    check(enc2 && enc2.id !== enc.id, 'second encounter has a new id');
    eq(select.dueReminders(store.getState(), ACTORS.alex.id, enc2.id, clock.now()).length, 1, 'dismissed reminder returns on next encounter');
    await provider.dispatch({ type: 'reminder.snooze', payload: { reminder_id: 'rem_alex_seed', minutes: 15 } });
    eq(select.dueReminders(store.getState(), ACTORS.alex.id, enc2.id, clock.now()).length, 0, 'snoozed not due');
    await provider.dispatch({ type: 'reminder.complete', payload: { reminder_id: 'rem_alex_seed' } });
    eq(store.getState().reminders.rem_alex_seed.status, 'completed', 'complete persists status');
    clock.advance(60 * 60_000);
    eq(select.dueReminders(store.getState(), ACTORS.alex.id, enc2.id, clock.now()).length, 0, 'completed never comes back');
    eq(invalid.length, 0, 'every emitted envelope valid');
    eq(select.people(store.getState()).length, 1, 'replay did not duplicate Alex');
  }

  console.log('\n# demo provider: keys scene + clip timing');
  {
    const { clock, store, provider } = await rig();
    eq(select.moments(store.getState()).length, 1, 'seed has one saved keys moment');
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'keys_on_desk' } });
    clock.advance(1000);
    eq(select.activeProfile(store.getState())?.kind, 'object', 'keys card active');
    const rec = select.moments(store.getState()).find((m) => m.status === 'recording');
    check(rec && rec.clip === null, 'moment recording with no clip yet');
    clock.advance(4600);
    eq(store.getState().moments[rec.id].status, 'recording', 'still recording before +5 s');
    clock.advance(200);
    const saved = store.getState().moments[rec.id];
    eq(saved.status, 'saved', 'saved only after +5 s');
    eq(saved.clip?.url, '/static/remember/fixtures/keys-moment.mp4', 'clip URL is the fixture mp4');
    eq(saved.clip.duration_s, 10, '10 s clip');
    eq(Date.parse(saved.clip.end_at) - Date.parse(saved.clip.start_at), 10_000, 'clip spans ±5 s around the event');
    eq(Date.parse(saved.event_at) - Date.parse(saved.clip.start_at), 5000, 'event sits at the centre');
  }

  console.log('\n# demo provider: stop cancels timers and fails in-flight clips');
  {
    const { clock, store, provider } = await rig();
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'significant_moment' } });
    clock.advance(2000);
    const rec = select.moments(store.getState()).find((m) => m.status === 'recording');
    check(rec, 'recording started');
    await provider.stop();
    eq(clock.pending(), 0, 'all timers cancelled');
    eq(store.getState().moments[rec.id].status, 'failed', 'in-flight clip marked failed, not saved');
    eq(store.getState().status.state, 'stopped', 'status stopped');
    clock.advance(20_000);
    eq(store.getState().moments[rec.id].status, 'failed', 'nothing fires after stop');
  }

  console.log('\n# demo provider: introduction uniqueness');
  {
    const { clock, store, provider } = await rig();
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    clock.advance(1500);
    eq(store.getState().recognition?.state, 'listening', 'listening state before the name');
    clock.advance(1000);
    check(store.getState().transcript.some((t) => !t.is_final && t.text.startsWith('Hi')), 'partial transcript visible');
    clock.advance(1500);
    const maya = store.getState().profiles[ACTORS.maya.id];
    check(maya && maya.source === 'introduction', 'Maya profile created from the introduction');
    eq(select.notesFor(store.getState(), maya.id).length, 1, 'introduction note attached');
    clock.advance(15_000);
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    clock.advance(6000);
    eq(select.people(store.getState()).filter((p) => p.name === 'Maya').length, 1, 'replaying the intro does not duplicate Maya');
    eq(select.notesFor(store.getState(), maya.id).length, 1, 'intro note not duplicated');
    eq(store.getState().profiles[ACTORS.maya.id].created_at, maya.created_at, 'created_at preserved on replay');
  }

  console.log('\n# demo provider: asking');
  {
    const { clock, store, provider } = await rig();
    // Paused commands (#13): a reloaded page restores data with no bound session; the app binds the
    // fresh provider's session, and typed recall must answer without starting the simulated camera.
    const stale = createStore({ persistence: createPersistence(memoryStorage()), now: clock.now });
    stale.hydrate({ session_id: 'ses_old', profiles: [], notes: [], encounters: [], reminders: [], moments: [] });
    const fresh = createDemoProvider({ clock, getState: stale.getState });
    fresh.subscribe((e) => stale.apply(e));
    await fresh.dispatch({ type: 'ask', payload: { text: 'where are my keys' } });
    clock.advance(800);
    eq(stale.getState().answer.latest, null, 'unbound: events from the new provider are rejected until the app binds');
    check(stale.getState().diagnostics.rejected.length > 0, 'unbound drops are visible in diagnostics');
    stale.bindSession(fresh.sessionId);
    await fresh.dispatch({ type: 'ask', payload: { text: 'where are my keys' } });
    clock.advance(800);
    check(stale.getState().status?.state !== 'running', 'asking does not start the simulated camera');
    eq(stale.getState().answer.latest?.kind, 'not_found', 'ask works while paused');
    await fresh.dispatch({ type: 'note.save', payload: { note: { id: 'n_p', profile_id: 'x', text: 'paused note', created_at: T, updated_at: T, source: 'user' } } });
    eq(stale.getState().notes.n_p?.text, 'paused note', 'note.save works while paused');
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'ask_keys' } });
    clock.advance(1300);
    check(store.getState().answer.pending, 'answer pending after the final');
    check(store.getState().transcript.find((t) => t.is_final)?.directed === 'device', 'final marked device-directed');
    clock.advance(1000);
    const a = store.getState().answer.latest;
    eq(a.kind, 'found', 'keys answer found');
    eq(a.moment_id, 'moment_keys_seed', 'answer points at the seeded keys moment');
    await provider.dispatch({ type: 'ask', payload: { text: 'where is my wallet' } });
    clock.advance(800);
    eq(store.getState().answer.latest.kind, 'not_found', 'wallet honestly not found');
    await provider.dispatch({ type: 'ask', payload: { text: 'what is the weather' } });
    clock.advance(800);
    eq(store.getState().answer.latest.kind, 'unsupported', 'unsupported query is honest');
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'overheard' } });
    clock.advance(1000);
    eq(store.getState().transcript.at(-1).directed, 'conversation', 'overheard speech labelled conversation');
    check(!store.getState().answer.pending, 'no answer attempted for conversation');
  }

  console.log('\n# demo provider: notes + reminders + full sequence');
  {
    const { clock, store, provider, invalid } = await rig();
    await provider.dispatch({ type: 'note.save', payload: { note: { id: 'note_user_1', profile_id: ACTORS.alex.id, text: 'Likes espresso', created_at: T, updated_at: T, source: 'user' } } });
    eq(select.notesFor(store.getState(), ACTORS.alex.id)[0].text, 'Likes espresso', 'user note saved via command');
    await provider.dispatch({ type: 'reminder.save', payload: { reminder: { id: 'rem_user_1', profile_id: ACTORS.alex.id, text: 'Return the charger', status: 'active', created_at: T, updated_at: T, source: 'user' } } });
    eq(select.remindersFor(store.getState(), ACTORS.alex.id).length, 2, 'user reminder added');
    await provider.dispatch({ type: 'reminder.delete', payload: { reminder_id: 'rem_user_1' } });
    eq(select.remindersFor(store.getState(), ACTORS.alex.id).length, 1, 'user reminder deleted');
    await provider.dispatch({ type: 'demo.run_sequence', payload: {} });
    clock.advance(60_000);
    eq(clock.pending(), 0, 'sequence completes with no dangling timers');
    eq(invalid.length, 0, 'sequence emitted only valid envelopes');
    eq(select.people(store.getState()).length, 2, 'Alex + Maya after the sequence');
    eq(select.moments(store.getState()).filter((m) => m.status === 'saved').length, 3, 'seed + keys + pitch moments saved');
    check(select.moments(store.getState()).every((m) => m.status !== 'recording'), 'no moment stuck recording');
  }

  console.log('\n# scene overlap (#7): stale callbacks never leak into a newer scene');
  {
    const { clock, store, provider, invalid } = await rig();
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    clock.advance(200);
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    clock.advance(1300); // old 900 ms Alex callback would have fired here
    eq(select.activeProfile(store.getState()), null, 'Alex does not appear inside the introduction scene');
    // keys still "in view" from an earlier scene must not linger into a new scene either
    const r0 = await rig();
    await r0.provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'keys_on_desk' } });
    r0.clock.advance(1000);
    eq(select.activeProfile(r0.store.getState())?.id, ACTORS.keys.id, 'keys in view');
    await r0.provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    r0.clock.advance(1500);
    eq(select.activeProfile(r0.store.getState()), null, 'entering a new scene ends the previous encounter');
    eq(r0.store.getState().recognition?.state, 'listening', 'the listening card is what shows');
    r0.clock.advance(4200);
    eq(r0.store.getState().moments[`moment_keys_${r0.provider.sessionId}_1`]?.status, 'saved', 'keys recording tail still completes independently of the scene change');
    eq(store.getState().scene.caption, 'Sponsor hall. Someone is saying hello.', 'introduction scene intact');
    eq(store.getState().recognition?.state, 'listening', 'introduction still progressing');
    clock.advance(3000);
    eq(select.activeProfile(store.getState())?.id, ACTORS.maya.id, 'Maya becomes the active profile');
    clock.advance(9000); // 13.2 s after intro start: intro idle fires (its gen is current)
    eq(select.activeProfile(store.getState()), null, 'introduction ends normally');
    // Full sequence: at 33.2 s Alex is in view with one recording; the old intro idle (t≈33.6) must not clear him.
    const r2 = await rig();
    await r2.provider.dispatch({ type: 'demo.run_sequence', payload: {} });
    r2.clock.advance(33_200);
    eq(select.activeProfile(r2.store.getState())?.id, ACTORS.alex.id, 'sequence: Alex in view at 33.2 s');
    eq(select.moments(r2.store.getState()).filter((m) => m.status === 'recording').length, 1, 'sequence: one recording at 33.2 s');
    r2.clock.advance(600);
    eq(select.activeProfile(r2.store.getState())?.id, ACTORS.alex.id, 'sequence: Alex still in view at 33.8 s');
    eq(r2.store.getState().scene.caption, 'Team table, talking with Alex.', 'sequence: scene not reset by stale idle');
    r2.clock.advance(30_000);
    eq(r2.clock.pending(), 0, 'sequence: no dangling timers');
    eq(r2.invalid.length + invalid.length, 0, 'all envelopes valid');
  }

  console.log('\n# stop / delete races (#7, #8)');
  {
    const { clock, store, provider } = await rig();
    await provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'new_introduction' } });
    clock.advance(1500);
    eq(store.getState().recognition?.state, 'listening', 'listening card shown');
    await provider.stop();
    eq(store.getState().recognition, null, 'Stop removes the listening card');
    eq(store.getState().scene.kind, 'idle', 'Stop returns the scene to idle');
    clock.advance(20_000);
    eq(select.people(store.getState()).length, 1, 'no Maya after stop (callbacks cancelled)');
    // delete a recording moment before its tail completes
    const r2 = await rig();
    await r2.provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'keys_on_desk' } });
    r2.clock.advance(1000);
    const rec = select.moments(r2.store.getState()).find((m) => m.status === 'recording');
    await r2.provider.dispatch({ type: 'moment.delete', payload: { moment_id: rec.id } });
    r2.clock.advance(10_000);
    eq(r2.store.getState().moments[rec.id], undefined, 'deleted recording never comes back as saved');
    // stop → old scene callbacks → start again: no ghost from the previous run
    const r3 = await rig();
    await r3.provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'teammate_arrives' } });
    r3.clock.advance(100);
    await r3.provider.stop();
    await r3.provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'keys_on_desk' } });
    r3.clock.advance(1000);
    eq(select.activeProfile(r3.store.getState())?.id, ACTORS.keys.id, 'after stop+restart the new scene owns the card');
    eq(r3.store.getState().scene.kind, 'object', 'scene is the new one');
  }
}
