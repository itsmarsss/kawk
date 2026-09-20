import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { createMemoryServer } from '../src/server.js';
import { createServer } from 'node:http';

test('people endpoints unify gallery listing/reset, reject cross-origin deletes and propagate upstream failure', async () => {
  const gallery = new Map([['gallery-maya', {id:'gallery-maya', name:'Maya'}]]);
  let failDeletion = true;
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({people:[...gallery.values()]})); return; }
    if (failDeletion) { res.writeHead(503); res.end('{}'); return; }
    if (req.url === '/api/gallery') gallery.clear();
    else gallery.delete(decodeURIComponent(req.url!.split('/').at(-1)!));
    res.end(JSON.stringify({deleted:true}));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const store = new Store(':memory:', 3, 'test');
  const pipeline = new MemoryPipeline(store, {observe:async()=>{throw Error('unused')},update:async()=>{throw Error('unused')}},
    {model:'test',dimensions:3,embed:async()=>[]}, {dataDir:tmpdir(),autoStart:false});
  const server = createMemoryServer(pipeline, { perceptionUrl:`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    publicDir:tmpdir(), provider:'test',model:'test',speechBackend:'local',speechNotice:'Local selected for this test'});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await (await fetch(base+'/api/config')).json()).speechBackend, 'local');
    assert.deepEqual((await (await fetch(base+'/api/people')).json()).people,
      [{id:'gallery-maya',name:'Maya',enrolled:true,lastSeenAt:null}]);
    assert.equal((await fetch(base+'/api/people', {method:'DELETE',headers:{Origin:'http://elsewhere.invalid'}})).status,403);
    assert.equal((await fetch(base+'/api/people', {method:'DELETE'})).status,400);
    assert.equal(store.peopleResetBefore(), null); assert.equal(gallery.size,1);
    failDeletion = false;
    assert.equal((await fetch(base+'/api/people/gallery-maya', {method:'DELETE'})).status,200);
    assert.equal(gallery.size,0);
    assert.equal((await fetch(base+'/api/people', {method:'DELETE'})).status,200);
    assert.ok(store.peopleResetBefore());
    assert.equal((await fetch(base+'/api/people/missing', {method:'DELETE'})).status,404);
  } finally {
    await new Promise<void>(r => server.close(()=>r())); await new Promise<void>(r=>upstream.close(()=>r()));
    store.close();
  }
});

test('HTTP accepts evidence, commits and retrieves durable source-linked semantic results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-http-'));
  const store = new Store(join(dir, 'store.db'), 3, 'test');
  let calls = 0;
  const pipeline = new MemoryPipeline(store, {
    observe: async () => { calls++; return { scene: 'A classroom', observations: ['An open textbook is on the desk.'], readableText: [], uncertainties: [] }; },
    update: async () => ({ state: { location: 'classroom', activity: 'class', summary: 'A textbook is visible.', uncertainties: [] },
      entities: [], facts: [], events: [] }),
  }, { model: 'test', dimensions: 3, embed: async texts => texts.map(() => [1,0,0]) }, { dataDir: dir });
  const server = createMemoryServer(pipeline, { perceptionUrl: 'http://127.0.0.1:1', publicDir: dir,
    provider: 'test', model: 'test-vision', writerModel: 'test-writer' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { 'content-type':'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal(calls, 0);
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.model, 'test-vision'); assert.equal(config.writerModel, 'test-writer');
    assert.equal((await post('/api/sessions', {}, { Origin:'http://other-site.invalid' })).status, 403);
    const session = await (await post('/api/sessions', {})).json();
    const capturedAt = Date.now();
    const jpeg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
    const input = { id: 'photo', sessionId: session.id, sequence: 0, capturedAt, width: 1, height: 1,
      jpegBase64: jpeg.toString('base64'), audioStatus: 'unavailable', faces: { frameId: 'photo',
        streamId: 'face', capturedAt, status: 'unavailable', width: 1, height: 1, faces: [] } };
    assert.equal((await post('/api/captures', { ...input, width: 3 })).status, 400);
    assert.equal((await post('/api/captures', input)).status, 202);
    const deadline = Date.now() + 3000;
    while (store.getCapture('photo')?.status !== 'committed' || store.pendingEmbeddings().length) {
      if (Date.now() > deadline) throw new Error('HTTP pipeline did not drain');
      await new Promise(r => setTimeout(r, 10));
    }
    const packet = await (await fetch(base + '/api/packets/photo')).json();
    assert.equal(packet.faces.status, 'unavailable'); assert.equal(packet.audio.status, 'unavailable');
    assert.equal(packet.vision.scene, 'A classroom');
    const found = await (await post('/api/search', { query: 'textbook', from: capturedAt-1, to: capturedAt+1 })).json();
    assert.ok(found.results.length); assert.ok(found.results.some((r: {text:string}) => r.text.includes('textbook')));
    assert.ok(found.results.every((r: {packetId:string}) => r.packetId === 'photo'));
    assert.deepEqual(Buffer.from(await (await fetch(base + '/api/frames/photo')).arrayBuffer()), jpeg);
    assert.equal((await (await fetch(base + '/api/dashboard')).json()).state.location, 'classroom');
    assert.equal((await fetch(base + '/api/packets/missing')).status, 404);
    const speech = { sessionId: session.id, streamId: 'speech', segmentId: 'one', revision: 1,
      text: 'tentative', isFinal: false, startAt: capturedAt + 1000, endAt: capturedAt + 2000,
      receivedAt: capturedAt + 2100, words: [], speakerId: null, timing: 'approximate' };
    assert.equal((await post('/api/transcripts', speech)).status, 200);
    assert.equal((await post('/api/transcripts', { ...speech, revision: 2, isFinal: true, text: 'final words' })).status, 200);
    const path = `/api/transcripts/${session.id}`;
    assert.equal((await (await fetch(base + path)).json()).length, 1);
    assert.equal((await (await fetch(base + path + '?includeRevisions=true')).json()).length, 2);
    assert.equal((await (await fetch(base + path + `?from=${capturedAt+3000}`)).json()).length, 0);
    assert.equal((await fetch(base + path + '?from=10&to=1')).status, 400);
  } finally {
    await pipeline.stop(); await new Promise<void>(r => server.close(() => r()));
    store.close(); await rm(dir, { recursive: true });
  }
});
