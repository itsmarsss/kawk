import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultSpeechBackend, describeSpeechBackend, normalizeSpeechBackend, transcriptStatusLine } from '../src/speechBackend.ts';
import { FakeClock, FakeWebSocket, installFakeWebSocket } from './fakes.ts';

installFakeWebSocket();
const { SpeechLink } = await import('../src/speechLink.ts');

test('config decides the preselected backend; an absent value keeps the historical baseten default', () => {
  assert.equal(defaultSpeechBackend({ speechBackend: 'local' }), 'local');
  assert.equal(defaultSpeechBackend({ speechBackend: 'baseten' }), 'baseten');
  assert.equal(defaultSpeechBackend({}), 'baseten');
  assert.equal(defaultSpeechBackend(null), 'baseten');
  assert.equal(defaultSpeechBackend({ speechBackend: 'whisper-cpp' }), 'baseten', 'unknown values are not trusted');
  assert.equal(normalizeSpeechBackend('LOCAL'), null);
});

test('labels never call the local model cloud (or the cloud model local); a mismatch names both sides', () => {
  const local = describeSpeechBackend('local', { backend: 'local', model: 'Whisper Small · int8 CPU' });
  assert.match(local, /local \(this Mac\)/); assert.match(local, /Whisper Small/); assert.doesNotMatch(local, /cloud|Baseten/);
  const cloud = describeSpeechBackend('baseten', { backend: 'baseten', model: 'Whisper Large v3 streaming' });
  assert.match(cloud, /cloud \(Baseten\)/); assert.doesNotMatch(cloud, /this Mac/);
  assert.match(describeSpeechBackend('local', null), /requested; not yet confirmed/);
  assert.match(describeSpeechBackend('local', { backend: 'baseten', model: null }), /requested local \(this Mac\) but server reports cloud \(Baseten\)/);
});

test('the Live transcript header distinguishes stopped / loading / reconnecting / error / listening', () => {
  const speech = (phase: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'stopping' | 'stopped' | 'error', message: string, backend: string | null = null) =>
    ({ phase, message, backend, model: backend === 'local' ? 'Whisper Small · int8 CPU' : null });
  const base = { microphone: 'live' as const, requested: 'local' as const, segments: 0 };
  assert.match(transcriptStatusLine({ ...base, runPhase: null, speech: speech('idle', 'idle') }), /^stopped · press Start/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'stopped', speech: speech('stopped', 'stopped') }), /^stopped · no live transcript/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'running', speech: speech('connecting', 'connected, waiting for the speech backend') }), /^loading .*Whisper Small.*audio is not sent until ready/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'running', speech: speech('reconnecting', 'speech connection closed; reconnecting in 2 s (attempt 2)') }), /^reconnecting · .*attempt 2/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'running', speech: speech('error', 'Baseten model INACTIVE') }), /^speech error · Baseten model INACTIVE · not listening/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'running', speech: speech('ready', 'listening', 'local') }), /^listening via local \(this Mac\) Whisper Small · int8 CPU · no speech transcribed yet/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'running', segments: 3, speech: speech('ready', 'listening', 'local') }), /3 recent segment\(s\).*speaker is never identified/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'running', microphone: 'error', speech: speech('idle', 'microphone unavailable') }), /^microphone unavailable/);
  assert.match(transcriptStatusLine({ ...base, runPhase: 'stopping', speech: speech('stopping', 'flushing') }), /^stopping · waiting for the last final/);
  for (const phase of ['connecting', 'reconnecting', 'error'] as const) assert.doesNotMatch(transcriptStatusLine({ ...base, runPhase: 'running', speech: speech(phase, 'x') }), /no speech/);
});

test('SpeechLink records the backend the server actually reported in `ready`', () => {
  const clock = new FakeClock();
  const link = new SpeechLink({ url: 'ws://localhost:8082/ws/speech?backend=local', sessionId: 's', clock, onTranscript: () => {}, onStatus: () => {}, onError: () => {} });
  link.start();
  const ws = FakeWebSocket.instances.at(-1)!;
  assert.match(ws.url, /backend=local/);
  assert.equal(link.current.backend, null);
  ws.serverOpen(); ws.serverSend({ type: 'ready', backend: 'local', model: 'Whisper Small · int8 CPU', sample_rate: 16000, chunk_samples: 512 });
  assert.equal(link.current.backend, 'local'); assert.equal(link.current.model, 'Whisper Small · int8 CPU');
  assert.match(link.current.message, /via local/);
});

test('Run and page wiring: selector → Run.start; final-only forwarding after an accepted POST; epoch bound at receipt', async () => {
  const session = await readFile(new URL('../src/session.ts', import.meta.url), 'utf8');
  assert.match(session, /faceEpoch: this\.faceLink\.currentEpoch/, 'the face epoch is captured when the transcript is received');
  assert.match(session, /if \(accepted && t\.isFinal\) this\.forwardIntroduction\(t, q\.faceEpoch\)/, 'forwarded only after POST /api/transcripts accepted a final');
  assert.match(session, /wsUrl\('\/ws\/speech', \{ backend: this\.speechBackend \}\)/, 'the requested backend is what the socket asks for');
  assert.ok(!session.includes("{ backend: 'baseten' }"), 'no hard-coded cloud backend remains');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /speechBackend: selectedSpeechBackend\(\)/, 'Start passes the selector value');
  assert.match(main, /current\?\.resetFaces\(what\)/, 'a confirmed deletion recycles the live face link');
  assert.match(main, /if \(!r \|\| r\.deleted !== true\) throw/, 'the row is never cleared before the server confirms');
});
