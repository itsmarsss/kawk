import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { BrowseQuery } from '../src/browse.js';
import { MemoryPipeline } from '../src/pipeline.js';
import { createMemoryServer } from '../src/server.js';
import type { CaptureRecord, Packet, Transcript } from '../src/contracts.js';

function capture(s: Store, id: string, at: number, sequence: number, person = false): Packet {
  const c: CaptureRecord = { id, sessionId: 's', sequence, capturedAt: at, width: 10, height: 10,
    faces: { frameId: id, capturedAt: at, streamId: 'faces', status: 'ready', width: 10, height: 10,
      faces: person ? [{ trackId: 't', personId: 'kenny', name: 'Kenny', similarity: .9, box: [0,0,9,9], identityStatus: 'confirmed' }] : [] },
    audioStatus: 'live', imagePath: '/private/photos/test.jpg', sha256: 'a'.repeat(64), receivedAt: at + 1,
    status: 'ready', error: null, vision: { scene: '100% blue_room', observations: [], readableText: [], uncertainties: [] } };
  s.insertCapture(c);
  return { ...c, vision: c.vision!, version: 1, audio: { text: '', wordCount: 0, segments: [], status: 'live', throughAt: at }, createdAt: at + 2, correction: false };
}
function transcript(sessionId: string, revision = 0): Transcript {
  return { sessionId, streamId: 'mic', segmentId: 'word', revision, text: revision ? 'corrected Kenny' : 'partial Ken',
    isFinal: revision > 0, startAt: 100, endAt: 200, receivedAt: 250 + revision, words: [], speakerId: null, timing: 'approximate' };
}

test('browse reaches every old capture with stable ties while new captures arrive', () => {
  const s = new Store(':memory:', 3, 'test'); s.createSession('s', 0);
  try {
    for (let i = 0; i < 125; i++) capture(s, `c${i}`, 1000 + Math.floor(i / 3), i);
    const first = s.browse(BrowseQuery.parse({ kind: 'captures', limit: 17 }));
    assert.equal(first.total, 125); assert.equal(first.items.length, 17); assert.ok(first.nextCursor);
    assert.equal('imagePath' in first.items[0].data, false);
    capture(s, 'new-old-source', 1000, 125);
    const ids = first.items.map(v => v.id); let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = s.browse(BrowseQuery.parse({ kind: 'captures', limit: 17, cursor }));
      assert.equal(page.total, 125); ids.push(...page.items.map(v => v.id)); cursor = page.nextCursor;
    }
    assert.equal(ids.length, 125); assert.equal(new Set(ids).size, 125); assert.ok(!ids.includes('new-old-source'));
    assert.throws(() => s.browse(BrowseQuery.parse({ kind: 'captures', query: 'changed', cursor: first.nextCursor })), /filters changed/);
    assert.throws(() => s.browse(BrowseQuery.parse({ cursor: 'bad' })), /Invalid memory cursor/);
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'captures', query: '% blue_', from: 1030, to: 1040 })).total, 33);
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'captures', query: 'not present' })).total, 0);
  } finally { s.close(); }
});

test('transcript browser spans sessions, preserves revision history and filters overlapping source time', () => {
  const s = new Store(':memory:', 3, 'test'); s.createSession('s', 0); s.createSession('other', 0);
  try {
    s.saveTranscript(transcript('s')); s.saveTranscript(transcript('s', 1)); s.saveTranscript(transcript('other', 1));
    const page = s.browse(BrowseQuery.parse({ kind: 'transcripts', from: 150, to: 180 }));
    assert.equal(page.total, 2); assert.ok(page.items.every(x => x.status === 'final'));
    const history = s.browse(BrowseQuery.parse({ kind: 'transcripts', history: 'true' }));
    assert.equal(history.total, 3); assert.equal(history.items.filter(x => x.status === 'superseded').length, 1);
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'transcripts', query: 'partial' })).total, 0);
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'transcripts', from: 201 })).total, 0);
  } finally { s.close(); }
});

test('facts/entities/state hide removed identities but retain raw sources and marked revisions', () => {
  const s = new Store(':memory:', 3, 'test'); s.createSession('s', 0);
  try {
    const p = capture(s, 'face', 1000, 1, true);
    s.commit(p, { state: { location: 'Room', activity: null, summary: 'Kenny is present', uncertainties: [] }, entities: [], facts: [], events: [] });
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'entities', entityKind: 'person' })).total, 1);
    assert.ok(s.browse(BrowseQuery.parse({ kind: 'observations' })).total > 0);
    s.db.prepare('UPDATE observations SET superseded=1').run();
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'observations' })).total, 0);
    assert.ok(s.browse(BrowseQuery.parse({ kind: 'observations', history: 'true' })).items.every(x => x.status === 'superseded'));
    s.removePeople(['kenny'], false, 2000);
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'entities' })).total, 0);
    const retained = s.browse(BrowseQuery.parse({ kind: 'observations', history: 'true' }));
    assert.ok(retained.items.every(x => !(x.data.entityIds as string[]).includes('kenny')));
    assert.ok(retained.items.every(x => !x.text.includes('Kenny')));
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'state', history: 'true' })).total, 0);
    assert.equal(s.browse(BrowseQuery.parse({ kind: 'captures' })).total, 1);
  } finally { s.close(); }
});

test('browse HTTP is bounded, rejects invalid filters and never starts model/capture work', async () => {
  const s = new Store(':memory:', 3, 'test'); s.createSession('s', 0); capture(s, 'c', 1000, 0);
  let calls = 0;
  const p = new MemoryPipeline(s, { observe: async () => { calls++; throw Error('unused'); }, update: async () => { calls++; throw Error('unused'); } },
    { model: 'test', dimensions: 3, embed: async () => { calls++; return []; } }, { dataDir: tmpdir(), autoStart: false });
  const server = createMemoryServer(p, { perceptionUrl: 'http://127.0.0.1:1', publicDir: tmpdir(), provider: 'test', model: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memory/browse`;
  try {
    const res = await fetch(url + '?kind=captures&limit=1'); assert.equal(res.status, 200);
    assert.equal((await res.json()).total, 1); assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const query of ['limit=101', 'limit=-1', 'from=20&to=1', 'kind=unknown', 'kind=captures&entityKind=person', 'cursor=bad'])
      assert.equal((await fetch(url + '?' + query)).status, 400, query);
    assert.equal((await fetch(url, { headers: { Origin: 'http://other.test' } })).status, 403);
    assert.equal(calls, 0); assert.equal(s.listCaptures().length, 1);
  } finally { await new Promise<void>(r => server.close(() => r())); s.close(); }
});
