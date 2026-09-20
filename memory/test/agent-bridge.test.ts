import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { AgentBridge } from '../src/agent-bridge.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { createMemoryServer } from '../src/server.js';
import type { CaptureRecord, Transcript } from '../src/contracts.js';

const vision = { scene: 'Keys on the desk', observations: ['Blue keyring beside the laptop'], readableText: [], uncertainties: [] };
const capture = (id = 'photo'): CaptureRecord => ({ id, sessionId: 'session', sequence: 0, capturedAt: 1000,
  width: 1, height: 1, imagePath: '/tmp/test-photo.jpg', sha256: 'test', audioStatus: 'live', receivedAt: 1100,
  status: 'queued', error: null, vision: null, faces: { frameId: id, streamId: 'faces', capturedAt: 1000,
    status: 'ready', width: 1, height: 1, faces: [] } });
const transcript = (revision: number, isFinal: boolean): Transcript => ({ sessionId: 'session', streamId: 'mic', segmentId: 'one',
  revision, isFinal, text: isFinal ? 'Where are my keys?' : 'Where are', startAt: 900, endAt: 1000,
  receivedAt: 1100, words: [], speakerId: null, timing: 'approximate' });

test('merged push proxy keeps authentication server-side and forwards DELETE bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-push-bridge-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'x'.repeat(48));
  const store = new Store(':memory:', 3, 'test'); const requests: { url: string; method: string; body?: string; token: string | null }[] = [];
  const bridge = new AgentBridge(store, { url: 'http://agent.test', tokenFile, autoStart: false,
    fetch: (async (url: any, init: any) => {
      requests.push({ url: String(url), method: init.method, body: init.body, token: new Headers(init.headers).get('authorization') });
      return Response.json({ ok: true });
    }) as typeof fetch });
  const pipeline = new MemoryPipeline(store, { observe: async () => vision, update: async () => { throw Error('unused'); } },
    { model: 'test', dimensions: 3, embed: async () => [] }, { dataDir: dir, autoStart: false });
  const server = createMemoryServer(pipeline, { perceptionUrl: 'http://127.0.0.1:1', publicDir: dir, provider: 'test', model: 'test', bridge });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [path, method, body] of [['key', 'GET', undefined], ['status', 'GET', undefined],
      ['test', 'POST', {}], ['subscriptions', 'POST', { endpoint: 'https://push.example/a' }],
      ['subscriptions', 'DELETE', { endpoint: 'https://push.example/a' }]] as const) {
      const r = await fetch(`${base}/api/agent/push/${path}`, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.deepEqual(await r.json(), { ok: true });
    }
    assert.ok(requests.every(r => r.token === `Bearer ${'x'.repeat(48)}`));
    assert.equal(requests.at(-1)?.method, 'DELETE');
    assert.deepEqual(JSON.parse(requests.at(-1)!.body!), { endpoint: 'https://push.example/a' });
    assert.ok(requests.every(r => r.url.startsWith('http://agent.test/v1/push/')));
    const query = '?kind=facts&query=blue%20bowl&limit=2&cursor=a%2Bb';
    assert.equal((await fetch(base + '/api/agent/memory/browse' + query)).status, 200);
    assert.equal(requests.at(-1)?.url, 'http://agent.test/v1/memory/browse' + query);
    assert.equal(requests.at(-1)?.token, `Bearer ${'x'.repeat(48)}`);
    const count = requests.length;
    assert.equal((await fetch(base + '/api/agent/memory/browse', { method: 'POST' })).status, 404);
    assert.equal(requests.length, count, 'browse exposes no write-through method');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await bridge.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('attaching the bridge backfills pre-existing source history once without treating it as live speech', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-history-bridge-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'x'.repeat(48));
  const store = new Store(':memory:', 3, 'test'); store.createSession('session', 0);
  store.saveTranscript(transcript(0, false)); store.saveTranscript(transcript(1, true));
  store.insertCapture(capture()); store.saveVision('photo', vision);
  const requests: any[] = [];
  const send = (async (_url: any, init: any) => { requests.push(JSON.parse(init.body)); return new Response('{}', { status: 202 }); }) as typeof fetch;
  let bridge = new AgentBridge(store, { url: 'http://agent.test', tokenFile, fetch: send, autoStart: false });
  try {
    await bridge.flush(); assert.equal(requests[0].events.length, 4);
    assert.ok(requests[0].events.every((e: any) => e.provenance.endsWith(':backfill')));
    await bridge.stop(); bridge = new AgentBridge(store, { url: 'http://agent.test', tokenFile, fetch: send, autoStart: false });
    await bridge.flush(); assert.equal(requests.length, 1, 'restart does not duplicate backfill');
    store.saveTranscript({ ...transcript(0, true), segmentId: 'new' }); await bridge.flush();
    assert.equal(requests[1].events[0].provenance, 'scene-memory:speech');
  } finally { await bridge.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('transactional bridge survives outage/reopen and preserves raw revisions and vision before memory commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-bridge-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'x'.repeat(48));
  let now = 2000, fail = true;
  const requests: any[] = [];
  const send = (async (_url: any, init: any) => { requests.push(JSON.parse(init.body)); return new Response('{}', { status: fail ? 503 : 202 }); }) as typeof fetch;
  let store = new Store(join(dir, 'memory.sqlite'), 3, 'test');
  let bridge = new AgentBridge(store, { url: 'http://agent.test', tokenFile, fetch: send, now: () => now, autoStart: false });
  try {
    store.createSession('session', 0);
    store.saveTranscript(transcript(0, false)); store.saveTranscript(transcript(1, true));
    store.insertCapture(capture()); store.saveVision('photo', vision);
    assert.equal(store.getCapture('photo')?.status, 'ready');
    assert.equal(bridge.status().pending, 4);
    await bridge.flush(); assert.equal(bridge.status().pending, 4);
    await bridge.stop(); store.close();
    store = new Store(join(dir, 'memory.sqlite'), 3, 'test');
    bridge = new AgentBridge(store, { url: 'http://agent.test', tokenFile, fetch: send, now: () => now, autoStart: false });
    fail = false; now += 2000; await bridge.flush();
    assert.equal(bridge.status().pending, 0);
    const events = requests.at(-1).events;
    assert.deepEqual(events.slice(0, 2).map((e: any) => [e.id, e.revision, e.final]), [[events[0].id, 0, false], [events[0].id, 1, true]]);
    assert.equal(events[1].sourceEnd, 1000); assert.equal(events[1].speakerId, null);
    assert.match(events[3].text, /Blue keyring/);
    assert.equal(store.getPacket('photo'), null, 'vision delivery is independent of memory writer');
    store.saveTranscript(transcript(1, true)); await bridge.flush(); assert.equal(requests.length, 2);
    store.removePeople(['removed-gallery']); await bridge.flush();
    assert.deepEqual(requests.at(-1).forgottenPeople, ['removed-gallery']);
  } finally { await bridge.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('camera commands claim once, bind exact session/capture, and do not complete until image interpretation exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-camera-command-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'x'.repeat(48));
  let now = 2000;
  const store = new Store(':memory:', 3, 'test'); store.createSession('session', 0);
  const bridge = new AgentBridge(store, { url: 'http://127.0.0.1:1', tokenFile, now: () => now, autoStart: false });
  const pipeline = new MemoryPipeline(store, { observe: async () => vision, update: async () => { throw Error('unused'); } },
    { model: 'test', dimensions: 3, embed: async () => [] }, { dataDir: dir, autoStart: false });
  const server = createMemoryServer(pipeline, { perceptionUrl: 'http://127.0.0.1:1', publicDir: dir, provider: 'test', model: 'test', bridge });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.throws(() => bridge.cameraRequest('one', 'read sign'), /No active camera/);
    await fetch(base + '/api/agent/commands?sessionId=session');
    const cmd = bridge.cameraRequest('one', 'read sign', 'session'); assert.equal(cmd.state, 'pending');
    assert.equal((await (await post('/api/agent/commands/one/claim', { sessionId: 'wrong' })).json()).claimed, false);
    assert.equal((await (await post('/api/agent/commands/one/claim', { sessionId: 'session' })).json()).claimed, true);
    assert.equal((await (await post('/api/agent/commands/one/claim', { sessionId: 'session' })).json()).claimed, false);
    const c = { ...capture(), requestId: 'one' }; bridge.validateCapture(c); store.insertCapture(c); bridge.captureAccepted(c);
    assert.equal(bridge.cameraResult('one').state, 'captured');
    assert.throws(() => bridge.validateCapture({ ...c, id: 'different' }), /conflicting/);
    store.saveVision(c.id, vision); assert.equal(bridge.cameraResult('one').state, 'completed');
    assert.equal(bridge.cameraResult('one').event?.sourceStart, 1000);
    now += 46000; bridge.captureAccepted(c); // accepted submission retry remains idempotent
    assert.equal(bridge.cameraResult('one').state, 'completed');
    assert.throws(() => bridge.cameraRequest('two', 'read again'), /No active camera/);
    await fetch(base + '/api/agent/commands?sessionId=session'); bridge.cameraRequest('two', 'read again');
    now += 46000; assert.equal(bridge.cameraResult('two').state, 'expired');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await bridge.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rolled-back source writes never escape into the agent journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-bridge-atomic-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'x'.repeat(48));
  const store = new Store(':memory:', 3, 'test');
  const bridge = new AgentBridge(store, { url: 'http://127.0.0.1:1', tokenFile, autoStart: false });
  try {
    store.createSession('session', 0);
    assert.throws(() => store.db.transaction(() => { store.saveTranscript(transcript(0, true)); throw Error('rollback'); })());
    assert.equal(bridge.status().pending, 0); assert.equal(store.transcripts('session').length, 0);
  } finally { await bridge.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
