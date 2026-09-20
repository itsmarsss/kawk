import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { createInterpreter } from '../src/interpreter.js';

const photo = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
const vision = { scene: 'Keys on a desk.', readableText: [], uncertainties: [],
  entities: [{ kind: 'object', label: 'Brass keys',
    description: 'Brass keys with a distinctive red tag rest on the desk.', confidence: 'observed',
    faceIndex: null, location: { value: 'on the desk', confidence: 'observed' },
    anchors: [{ kind: 'attached_item', quote: 'distinctive red tag' }] }] };
function events(value: unknown) { return [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed' }].map(e => JSON.stringify(e)).join('\n'); }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); }
}

test('a final arriving during binding retries only text and keeps the original structured image in both packet versions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-visual-correction-'));
  const store = new Store(join(dir, 'memory.sqlite'), 3, 'test-vectors'); store.createSession('s', 0);
  let imageCalls = 0, bindingCalls = 0, release!: () => void;
  const firstBinding = new Promise<void>(resolve => { release = resolve; });
  const model = createInterpreter({ env: {}, updateFormat: 'binding', runner: async request => {
    if (request.args.includes('-i')) { imageCalls++; return { stdout: events(vision), durationMs: 1 }; }
    const input = JSON.parse(request.stdin.split('Evidence JSON:\n')[1]);
    const hasFinal = Boolean(input.packets[0].t.t0);
    assert.ok(!request.stdin.includes('UNFINISHED_WORDS'));
    if (++bindingCalls === 1) { assert.equal(hasFinal, false); await firstBinding; }
    else assert.equal(hasFinal, true);
    return { stdout: events({ rows: [{ i: 0, s: { location: 'Office', activity: null,
      summary: hasFinal ? 'Keys visible; a class plan was heard.' : 'Keys visible.', extraUncertainties: [] },
      b: [{ r: 0, to: null, match: null }], n: [], e: [], f: hasFinal ? [{ r: [], src: 't0',
        t: null, a: null, value: null, c: 'reported' }] : [] }] }), durationMs: 1 };
  } });
  const pipeline = new MemoryPipeline(store, model,
    { model: 'test-vectors', dimensions: 3, embed: async texts => texts.map(() => [1, 0, 0]) }, { dataDir: dir });
  try {
    const speech = { sessionId: 's', streamId: 'speech', segmentId: 'one', revision: 1, text: 'UNFINISHED_WORDS',
      isFinal: false, startAt: 2000, endAt: 4000, receivedAt: 4100, words: [], speakerId: null, timing: 'approximate' };
    pipeline.transcript(speech);
    await pipeline.capture({ id: 'photo', sessionId: 's', sequence: 0, capturedAt: 5000, width: 1, height: 1,
      jpegBase64: photo.toString('base64'), audioStatus: 'live', faces: { frameId: 'photo', streamId: 'faces',
        capturedAt: 5000, status: 'ready', width: 1, height: 1, faces: [] } });
    await until(() => {
      assert.notEqual(store.getCapture('photo')?.status, 'failed', store.getCapture('photo')?.error ?? '');
      return bindingCalls === 1;
    });
    const first = store.getPacket('photo')!;
    pipeline.transcript({ ...speech, revision: 2, isFinal: true, text: 'The class starts tomorrow.', receivedAt: 6000 });
    release(); await until(() => store.getCapture('photo')?.status === 'committed');
    assert.equal(imageCalls, 1); assert.equal(bindingCalls, 2);
    const versions = store.packetVersions('photo'); assert.equal(versions.length, 2);
    assert.equal(store.isPacketCommitted('photo', 1), false); assert.equal(store.isPacketCommitted('photo', 2), true);
    const latest = store.getPacket('photo')!;
    assert.deepEqual(latest.vision, first.vision); assert.deepEqual(latest.faces, first.faces);
    assert.equal(latest.capturedAt, 5000); assert.equal(latest.sha256, first.sha256);
    assert.equal(store.entities().length, 1); assert.equal(store.entityHistory(store.entities()[0].id).filter(n => n.visual).length > 0, true);
    assert.ok(store.observations().some(n => n.text === 'The class starts tomorrow.'));
    assert.ok(!JSON.stringify(store.observations()).includes('UNFINISHED_WORDS'));
  } finally { release(); await pipeline.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
