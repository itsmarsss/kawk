import { expect, test } from 'bun:test';
import { Store } from '../src/store';
import { Harness } from '../src/harness';
import { Jev } from '../src/jev';
import { TaskContext } from '../src/task-context';
import { refOf } from '../src/contracts';
import { Telemetry, type TelemetryEvent } from '../src/telemetry';
import { call, event, model, until } from './helpers';

test('conversation survives dense face traffic, keeps emitted clarifications after completion/ack/expiry, and excludes future or invalid sources', () => {
  let now = 1_000_000;
  const s = new Store(':memory:', () => now);
  const speech = event('weather', 'What is the weather like?', { sourceStart: now - 1000, sourceEnd: now });
  s.ingest('o', speech, false);
  const task = s.createTask({ owner: 'o', goal: speech.text, refs: [refOf(speech)], capabilities: [] });
  const reply = s.notify(task, 'Which city should I check?', [refOf(speech)], 1000);
  s.setTask(task.id, 'completed');
  s.ack('o', reply.id);
  const expired = s.notify(task, 'Which location?', [refOf(speech)], 1000, 'expired');
  now += 21000;
  s.notifications('o');
  for (let i = 0; i < 80; i++) s.ingest('o', event(`face-${i}`, 'Unknown person visible', {
    kind: 'observation', sourceStart: now - 20000 + i * 200, sourceEnd: now - 20000 + i * 200,
  }), false);
  s.ingest('other', event('private', 'other owner speech', { sourceStart: now, sourceEnd: now }), false);
  s.ingest('o', event('future', 'future speech', { sourceStart: now + 1, sourceEnd: now + 1 }), false);
  s.ingest('o', event('old', 'older than five minutes', { sourceStart: now - 300001, sourceEnd: now - 300001 }), false);
  const location = event('location', 'I live in Waterloo, Ontario.', { sourceStart: now - 1000, sourceEnd: now });
  s.ingest('o', { ...location, final: false }, false);
  expect(s.conversation('o').speech.map(e => e.id)).toEqual(['weather']);
  s.ingest('o', { ...location, revision: 1 }, false);
  try {
    expect(s.recent('o').slice(-12).some(e => e.id === 'weather')).toBe(false);
    expect(s.conversation('o').speech.map(e => e.id)).toEqual(['weather', 'location']);
    expect(s.conversation('o').replies.map(r => r.id).sort()).toEqual([reply.id, expired.id].sort());
    expect(s.conversation('o', speech.sourceEnd - 1).replies).toEqual([]);
    const snapshot = new TaskContext(s, model(() => call('finish', {}))).snapshot(task, 'UTC', []);
    expect(snapshot.conversation.speech.map(e => e.id)).toEqual(['weather', 'location']);
    s.ingest('o', { ...speech, revision: 1, text: 'Never mind the weather.' }, false);
    expect(s.conversation('o').replies).toEqual([]);
    expect(s.conversation('o').speech[0]?.revision).toBe(1);
    s.deleteEvidence('o', 'weather');
    expect(s.conversation('o').speech.map(e => e.id)).toEqual(['location']);
  } finally { s.close(); }
});

test('Jev and the resulting agent turn receive the previous question and completed clarification under face traffic', async () => {
  let now = Date.now() - 21000;
  const s = new Store(':memory:', () => now), log: TelemetryEvent[] = [];
  const question = event('weather', 'What is the weather like?', { sourceStart: now, sourceEnd: now });
  s.ingest('o', question, false);
  const old = s.createTask({ owner: 'o', goal: question.text, refs: [refOf(question)], capabilities: [] });
  s.notify(old, 'Which city or location should I check the weather for?', [refOf(question)]);
  s.setTask(old.id, 'completed');
  now += 21000;
  for (let i = 0; i < 40; i++) s.ingest('o', event(`face-${i}`, 'Unknown face', {
    kind: 'observation', sourceStart: now - 19000 + i * 400, sourceEnd: now - 19000 + i * 400,
  }), false);
  const location = event('location', 'I live in Waterloo, Ontario.', { sourceStart: now - 1000, sourceEnd: now });
  let gateState: any, agentContext: any;
  const jev = new Jev({ apiKey: 'fixture', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); gateState = JSON.parse(body.state);
    expect(gateState.RECENT_SPEECH.map((x: any) => x.text)).toEqual([question.text, location.text]);
    expect(gateState.PREVIOUS_TRANSCRIPT.text).toBe(question.text);
    expect(gateState.GAP_SINCE_PREVIOUS_TRANSCRIPT_MS).toBe(20000);
    expect(gateState.RECENT_AGENT_REPLIES[0].text).toContain('Which city');
    expect(gateState.ACTIVE_TASKS).toEqual([]);
    return Response.json({ model: 'jev-1.13.0', answers: {
      remember: { type: 'noul', noul: 0.9 },
      route: { type: 'choice', choice: 'start', confidence: 0.9, probabilities: { start: 0.97, observe: 0.01, update: 0.01, cancel: 0.01 } },
    } });
  } });
  const h = new Harness({ store: s, gate: jev, telemetry: new Telemetry(e => log.push(e)), tickMs: 5,
    model: model(messages => {
      agentContext = JSON.parse(messages.find(m => m.role === 'user')!.content!);
      expect(agentContext.conversation.speech.map((e: any) => e.id)).toEqual(['weather', 'location']);
      expect(agentContext.conversation.replies[0].goal).toBe(question.text);
      expect(agentContext.mode).toBe('assist');
      // No weather assertion or provider call: this verifies routing/context wiring only.
      return call('finish', { text: '', refs: [refOf(location)], confidence: 1, notify: false });
    }),
  });
  h.start();
  try {
    h.ingest('o', location);
    await until(() => !!agentContext && s.tasks('o', true).length === 0);
    expect(log.find(e => e.name === 'jev.classify.start')?.speechRefs).toEqual([refOf(question), refOf(location)]);
    expect(log.find(e => e.name === 'jev.decision')?.route).toBe('start');
    expect(JSON.stringify(log)).not.toContain('Waterloo');
  } finally { await h.stop(); s.close(); }
});
