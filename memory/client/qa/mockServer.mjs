// Isolated mock of the memory+agent HTTP contract for browser QA. Plain node:http, random port, no
// persistence, no camera, no real providers. Serves ../public as the app shell. Records every request at
// GET /__qa/log so the Playwright driver can assert on request bodies. Never used by the real service.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
// The real server proxies /static/* from the perception lab; the mock serves only the speech worklet (read-only) so a
// fake-device Start in headless Chromium can bring its microphone up. No perception model is involved.
const labStatic = resolve(fileURLToPath(new URL('../../../tools/perception_lab/static/', import.meta.url)));

export function createMockServer(options = {}) {
  const log = [];
  const sseClients = new Set();
  let sseConnections = 0;
  const notifications = [
    { id: 'n1', taskId: 't1', text: 'Your keys were last seen on the desk at 21:46 (source photo linked).', createdAt: Date.now() - 60_000, refs: [{ type: 'artifact', id: 'a1', label: 'screenshot' }, { captureId: 'cap_demo' }, { eventId: 'evt-1', revision: 0 }, 'https://example.invalid/never-a-link'] },
  ];
  const tasks = [
    { id: 't1', status: 'running', goal: 'find out where the keys are', result: null, createdAt: Date.now() - 70_000, updatedAt: Date.now() - 5000 },
    // the live bridge returns `result` as a JSON-encoded string carrying receipts (refs, confidence, review flags)
    { id: 't0', status: 'completed', goal: 'summarize the morning', result: JSON.stringify({ text: 'Two meetings, coffee with Sam.', refs: [{ eventId: 'evt-7', revision: 0 }, { eventId: 'scene-note-abc', revision: 1 }], confidence: 0.92, notify: true, reviewRejected: false }), createdAt: Date.now() - 900_000, updatedAt: Date.now() - 800_000 },
  ];
  const commands = [];
  // Web Push mock: a VAPID-shaped public key (65 bytes, URL-safe base64), subscriptions keyed by endpoint, counters.
  // Nothing is delivered from here (no push service); the browser QA injects push events through CDP instead.
  const pushKey = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 53) % 251))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pushSubscriptions = new Map();
  const pushCounters = { pending: 0, sent: 0, failed: 0 };
  let pushTests = 0;
  // ---- memory browser fixture: deterministic synthetic history (no real recordings). 95 observations so paging
  // goes past the old recent-30/recent-100 limits; transcripts across two sessions with revisions; superseded state;
  // entities of every kind (one hidden person never returned); agent facts with sources; reminders in every state.
  const T0 = Date.UTC(2026, 8, 20, 12, 0, 0); // 2026-09-20 12:00:00Z
  const browseFailures = new Set(); // kinds that answer 500 until cleared (POST /__qa/browse-fail)
  let browseDelayMs = 0; let browseDelayKind = null; // one kind answers late (POST /__qa/browse-delay) → stale-response check
  const browseLog = [];
  const observations = Array.from({ length: 95 }, (_, i) => ({ id: `o${i + 1}`, kind: 'observations', at: T0 - i * 60_000, title: i % 7 === 0 ? 'keys on the desk' : i % 5 === 0 ? 'blue bowl on the counter' : `scene note ${i + 1}`, text: i % 7 === 0 ? `keys next to the laptop (observation ${i + 1})` : i % 5 === 0 ? `a blue bowl with two apples (observation ${i + 1})` : `observation ${i + 1}: person walking past the window`, status: i % 11 === 0 ? 'superseded' : 'supported', captureId: `cap_${i + 1}`, entityId: i % 7 === 0 ? 'e1' : i % 5 === 0 ? 'e2' : null, data: { packetId: `cap_${i + 1}`, packetVersion: 1, entityIds: i % 7 === 0 ? ['e1'] : i % 5 === 0 ? ['e2'] : [], candidateEntityIds: i % 13 === 0 ? ['e3'] : [], confidence: i % 3 ? 'high' : 'medium', visual: true, superseded: i % 11 === 0, observedAt: T0 - i * 60_000, endAt: T0 - i * 60_000 + 4000, transcriptKeys: i % 4 === 0 ? [`s1/seg${i}@r1`] : [] } }));
  const captures = Array.from({ length: 60 }, (_, i) => ({ id: `cap_${i + 1}`, kind: 'captures', at: T0 - i * 60_000 + 500, title: `photo #${60 - i}`, text: i % 9 === 0 ? '' : `scene: ${i % 2 ? 'kitchen counter' : 'desk with laptop'}`, status: i % 9 === 0 ? 'queued' : i % 17 === 0 ? 'failed' : 'committed', captureId: `cap_${i + 1}`, entityId: null, data: { sequence: 60 - i, sessionId: i < 30 ? 'sess_b' : 'sess_a', width: 1280, height: 720, capturedAt: T0 - i * 60_000 + 500, receivedAt: T0 - i * 60_000 + 900, error: i % 17 === 0 ? 'vision provider timeout' : null, faces: { status: 'ready', faces: i % 7 === 0 ? [{ name: 'Sam', identityStatus: 'confirmed' }] : [] } } }));
  const transcriptsAll = [];
  for (let i = 0; i < 50; i += 1) { const at = T0 - i * 75_000; const session = i < 25 ? 'sess_b' : 'sess_a'; const text = i % 6 === 0 ? `this is Sam, remember the keys are on the desk (segment ${i})` : `spoken segment ${i} about the ${i % 2 ? 'homework' : 'meeting'}`; transcriptsAll.push({ id: `t${i}@r2`, kind: 'transcripts', at, title: `speech ${session}/seg${i} r2`, text, status: 'final', captureId: null, entityId: null, data: { sessionId: session, streamId: `st_${session}`, segmentId: `seg${i}`, revision: 2, isFinal: true, startAt: at, endAt: at + 4200, superseded: false } }); transcriptsAll.push({ id: `t${i}@r1`, kind: 'transcripts', at, title: `speech ${session}/seg${i} r1`, text: text.replace('keys', 'kees').slice(0, 30), status: 'superseded', captureId: null, entityId: null, data: { sessionId: session, streamId: `st_${session}`, segmentId: `seg${i}`, revision: 1, isFinal: false, startAt: at, endAt: at + 2100, superseded: true } }); }
  const entities = [
    { id: 'e1', kind: 'entities', at: T0, title: 'keys', text: 'house keys on a red carabiner', status: 'active', captureId: 'cap_1', entityId: 'e1', data: { entityKind: 'object', label: 'keys', description: 'house keys on a red carabiner', createdAt: T0 - 6 * 3_600_000, lastSeenAt: T0, attributes: { location: { value: 'desk', observedAt: T0 } } } },
    { id: 'e2', kind: 'entities', at: T0 - 300_000, title: 'blue bowl', text: 'ceramic bowl, blue glaze', status: 'active', captureId: 'cap_6', entityId: 'e2', data: { entityKind: 'object', label: 'blue bowl', createdAt: T0 - 5 * 3_600_000, lastSeenAt: T0 - 300_000, attributes: {} } },
    { id: 'e3', kind: 'entities', at: T0 - 120_000, title: 'Sam', text: 'enrolled person', status: 'active', captureId: 'cap_3', entityId: 'e3', data: { entityKind: 'person', label: 'Sam', personId: 'p_sam', createdAt: T0 - 8 * 3_600_000, lastSeenAt: T0 - 120_000, attributes: {} } },
    { id: 'e4', kind: 'entities', at: T0 - 900_000, title: 'kitchen', text: 'place seen repeatedly', status: 'active', captureId: 'cap_16', entityId: 'e4', data: { entityKind: 'place', label: 'kitchen', createdAt: T0 - 9 * 3_600_000, lastSeenAt: T0 - 900_000, attributes: {} } },
    { id: 'e5', kind: 'entities', at: T0 - 3_000_000, title: 'lecture on graphs', text: 'event, ended', status: 'active', captureId: null, entityId: 'e5', data: { entityKind: 'event', label: 'lecture on graphs', createdAt: T0 - 4 * 3_600_000, lastSeenAt: T0 - 3_000_000, attributes: {} } },
  ];
  const hiddenPerson = { id: 'e9', kind: 'entities', at: T0 - 60_000, title: 'Deleted person', text: 'must never be listed', status: 'hidden', captureId: null, entityId: 'e9', data: { entityKind: 'person', hidden: true } };
  const stateItems = Array.from({ length: 12 }, (_, i) => ({ id: `st${12 - i}`, kind: 'state', at: T0 - i * 600_000, title: i === 0 ? 'at the desk, working' : `state v${12 - i}`, text: `summary of state version ${12 - i}`, status: i === 0 ? 'current' : 'superseded', captureId: `cap_${i * 5 + 1}`, entityId: null, data: { version: 12 - i, location: i % 2 ? 'kitchen' : 'desk', activity: i % 2 ? 'cooking' : 'working', uncertainties: i % 3 ? [] : ['speaker unknown'], observedAt: T0 - i * 600_000, superseded: i !== 0 } }));
  const facts = Array.from({ length: 45 }, (_, i) => ({ id: `f${i + 1}`, kind: 'facts', at: T0 - i * 120_000 + 30_000, title: i % 4 === 0 ? 'person:kenny' : i % 4 === 1 ? 'relation: Kenny — needs — vitamin B info' : i % 4 === 2 ? 'summary: morning' : `fact ${i + 1}`, text: i % 4 === 0 ? 'Kenny, met at the lab; wants to hear about vitamin B' : i % 4 === 1 ? 'tell Kenny about vitamin B when seen' : i % 4 === 2 ? 'Two meetings, coffee with Sam, keys left on the desk.' : `agent fact ${i + 1}`, status: i % 10 === 0 ? 'superseded' : 'current', captureId: null, entityId: null, data: { key: i % 4 === 0 ? 'person:kenny' : `fact:${i + 1}`, kind: i % 4 === 0 ? 'entity' : i % 4 === 1 ? 'relation' : 'summary', refs: i % 4 === 1 ? ['person:kenny', 'topic:vitamin-b'] : [], version: i % 10 === 0 ? 1 : 2, sources: [{ eventId: `evt-${i + 1}`, revision: 1, text: 'tell Kenny about vitamin B when I see him', sourceStart: T0 - i * 120_000, sourceEnd: T0 - i * 120_000 + 3500 }], parsed: i % 4 === 2 ? { meetings: 2, people: ['Sam'] } : undefined } }));
  const reminders = [
    { id: 'r1', kind: 'reminders', at: T0 - 100_000, title: 'Tell Kenny about vitamin B', text: 'when Kenny is seen', status: 'pending', captureId: null, entityId: null, data: { trigger: { type: 'person', personKey: 'person:kenny' }, createdAt: T0 - 100_000, dueAt: null, sourceEventId: 'evt-5' } },
    { id: 'r2', kind: 'reminders', at: T0 - 5_000_000, title: 'Check the oven', text: 'in 20 minutes (from 10:38)', status: 'fired', captureId: null, entityId: null, data: { createdAt: T0 - 5_000_000, dueAt: T0 - 3_800_000, firedAt: T0 - 3_799_000, deliveredNotificationId: 'n-oven' } },
    { id: 'r3', kind: 'reminders', at: T0 - 7_000_000, title: 'Call the dentist', text: 'cancelled by the wearer', status: 'cancelled', captureId: null, entityId: null, data: { createdAt: T0 - 7_000_000, dueAt: T0 + 3_600_000, cancelledAt: T0 - 6_000_000 } },
  ];
  observations.push({ id: 'o-long', kind: 'observations', at: T0 - 90_000, title: 'long lecture summary', text: `Lecture notes: ${'graph traversal, adjacency lists, breadth-first search order, '.repeat(22)}end of notes.`, status: 'supported', captureId: 'cap_2', entityId: null, data: { packetId: 'cap_2', packetVersion: 1, entityIds: [], candidateEntityIds: [], confidence: 'medium', visual: false, superseded: false, observedAt: T0 - 90_000, endAt: T0 - 86_000, transcriptKeys: ['s1/seg3@r2'], note: 'n'.repeat(700) } });
  observations.unshift({ id: 'o-html', kind: 'observations', at: T0 + 1000, title: 'html <b>not bold</b>', text: '<img src=x onerror="window.__xss=1"> & <script>window.__xss=2</script> literal text', status: 'supported', captureId: null, entityId: null, data: { note: '<i>also text</i>', superseded: false } });
  const browseData = { observations, captures, transcripts: transcriptsAll, entities, state: stateItems, facts, reminders };
  const browsePage = (kind, q) => {
    const history = q.history === 'true';
    const query = (q.query ?? '').toLowerCase();
    const from = q.from ? Number(q.from) : null; const to = q.to ? Number(q.to) : null;
    const limit = Math.min(40, Math.max(1, Number(q.limit) || 40));
    const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8').replace(/^off:/, '')) || 0 : 0;
    let items = browseData[kind] ?? [];
    if (!history) items = items.filter((i) => !(i.data && i.data.superseded === true) && i.status !== 'superseded');
    if (query) items = items.filter((i) => `${i.title} ${i.text}`.toLowerCase().includes(query)); // literal, not semantic
    if (from !== null) items = items.filter((i) => i.at >= from);
    if (to !== null) items = items.filter((i) => i.at <= to);
    if (kind === 'entities' && q.entityKind) items = items.filter((i) => i.data.entityKind === q.entityKind);
    items = items.slice().sort((a, b) => b.at - a.at);
    const pageItems = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? Buffer.from(`off:${offset + limit}`).toString('base64url') : null;
    return { kind, items: pageItems, nextCursor: next, total: items.length };
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolveBody) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); try { resolveBody(text ? JSON.parse(text) : {}); } catch { resolveBody({ __raw: text }); } }); });
  const broadcast = (n) => { for (const res of sseClients) res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : null;
    if (!path.startsWith('/__qa/')) log.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, at: Date.now() });

    if (path === '/__qa/log') return json(res, 200, { log, sseConnections });
    if (path === '/__qa/notify' && req.method === 'POST') { const n = { id: body.id ?? `n${Date.now()}`, taskId: body.taskId ?? null, text: body.text ?? 'test', createdAt: Date.now(), refs: body.refs ?? [] }; notifications.push(n); broadcast(n); return json(res, 200, n); }
    if (path === '/__qa/command' && req.method === 'POST') { const c = { id: body.id ?? `cmd${Date.now()}`, type: 'capture', reason: body.reason ?? 'qa', createdAt: Date.now(), expiresAt: Date.now() + (body.ttlMs ?? 10_000), claimedBy: null, result: null }; commands.push(c); return json(res, 200, c); }
    if (path === '/__qa/drop-sse' && req.method === 'POST') { for (const c of sseClients) c.end(); sseClients.clear(); return json(res, 200, { dropped: true }); }
    if (path === '/__qa/push' && req.method === 'GET') return json(res, 200, { subscriptions: [...pushSubscriptions.values()], counters: pushCounters, key: pushKey });
    if (path === '/__qa/browse-fail' && req.method === 'POST') { browseFailures.clear(); for (const k of body.kinds ?? []) browseFailures.add(k); return json(res, 200, { failing: [...browseFailures] }); }
    if (path === '/__qa/browse-delay' && req.method === 'POST') { browseDelayKind = body.kind ?? null; browseDelayMs = Number(body.ms) || 0; return json(res, 200, { kind: browseDelayKind, ms: browseDelayMs }); }
    if (path === '/__qa/browse-log' && req.method === 'GET') return json(res, 200, { browseLog });

    // ---- memory browser contract (GET only; two endpoints, one shape) ----
    if ((path === '/api/memory/browse' || path === '/api/agent/memory/browse') && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const memoryKinds = ['observations', 'captures', 'transcripts', 'entities', 'state']; const agentKinds = ['facts', 'reminders'];
      const allowed = path === '/api/memory/browse' ? memoryKinds : agentKinds;
      browseLog.push({ path, query: q, at: Date.now() });
      if (!allowed.includes(q.kind)) return json(res, 400, { error: `unknown kind ${q.kind} for ${path}` });
      if (browseFailures.has(q.kind)) return json(res, 500, { error: `mock: ${q.kind} unavailable` });
      const page = browsePage(q.kind, q);
      if (browseDelayKind === q.kind && browseDelayMs > 0) { const ms = browseDelayMs; browseDelayKind = null; browseDelayMs = 0; await new Promise((r) => setTimeout(r, ms)); }
      return json(res, 200, page);
    }
    const entityMatch = path.match(/^\/api\/entities\/([^/]+)$/);
    if (entityMatch && req.method === 'GET') {
      const id = decodeURIComponent(entityMatch[1]); const e = entities.find((x) => x.id === id);
      if (!e || id === hiddenPerson.id) return json(res, 404, { error: 'entity not found' });
      const obs = observations.filter((o) => (o.data.entityIds ?? []).includes(id) || (o.data.candidateEntityIds ?? []).includes(id)).map((o) => ({ id: o.id, packetId: o.captureId, packetVersion: 1, entityIds: o.data.entityIds ?? [], candidateEntityIds: o.data.candidateEntityIds ?? [], text: o.text, observedAt: o.at, endAt: o.at + 4000, confidence: o.data.confidence, visual: true, transcriptKeys: o.data.transcriptKeys, superseded: o.data.superseded }));
      return json(res, 200, { entity: { id: e.id, kind: e.data.entityKind, label: e.data.label, description: e.text, personId: e.data.personId ?? null, createdAt: e.data.createdAt, lastSeenAt: e.data.lastSeenAt, attributes: e.data.attributes ?? {} }, observations: obs, encounters: [], events: [] });
    }
    const packetMatch = path.match(/^\/api\/packets\/([^/]+)(\/history)?$/);
    if (packetMatch && req.method === 'GET') {
      const id = decodeURIComponent(packetMatch[1]); const c = captures.find((x) => x.id === id);
      if (!c || c.status !== 'committed') return json(res, 404, { error: 'no packet' }); // queued/failed frames have no packet yet
      const packet = { id, version: 1, sessionId: c.data.sessionId, sequence: c.data.sequence, capturedAt: c.at, faces: { status: 'ready', streamId: 'st_x', faces: c.data.faces.faces.map((f, n) => ({ trackId: String(n), personId: 'p_sam', name: f.name, identityStatus: f.identityStatus, box: [0, 0, 10, 10] })) }, audio: { text: 'spoken words near this photo', wordCount: 5, status: 'live', throughAt: c.at, segments: [{ streamId: 'st_x', segmentId: 'seg1', revision: 2, isFinal: true, text: 'spoken words near this photo' }] }, vision: { scene: c.text || 'scene', observations: ['keys next to the laptop'], readableText: ['EXIT'], uncertainties: [] }, createdAt: c.at + 2000, correction: false };
      return json(res, 200, packetMatch[2] ? { versions: [packet] } : packet);
    }

    // ---- Web Push contract (same-origin proxy of the agent's /v1/push/*) ----
    if (path === '/api/agent/push/key' && req.method === 'GET') return options.pushConfigured === false ? json(res, 503, { error: 'Push is not configured' }) : json(res, 200, { publicKey: pushKey });
    if (path === '/api/agent/push/subscriptions' && req.method === 'POST') {
      if (typeof body.endpoint !== 'string' || !/^https:\/\//.test(body.endpoint) || typeof body.keys?.p256dh !== 'string' || typeof body.keys?.auth !== 'string') return json(res, 400, { error: 'invalid subscription' });
      pushSubscriptions.set(body.endpoint, { endpoint: body.endpoint, keys: body.keys, at: Date.now() });
      return json(res, 200, { subscribed: true });
    }
    if (path === '/api/agent/push/subscriptions' && req.method === 'DELETE') { if (typeof body.endpoint !== 'string') return json(res, 400, { error: 'endpoint required' }); pushSubscriptions.delete(body.endpoint); return json(res, 200, { subscribed: false }); }
    if (path === '/api/agent/push/status' && req.method === 'GET') return json(res, 200, { subscriptions: pushSubscriptions.size, ...pushCounters });
    if (path === '/api/agent/push/test' && req.method === 'POST') {
      pushTests += 1;
      const n = { id: `push-test-${pushTests}`, taskId: null, text: `Test push ${pushTests} from the agent.`, createdAt: Date.now(), refs: [] };
      notifications.push(n); broadcast(n); // the real agent also delivers this as a normal notification over SSE
      pushCounters.sent += pushSubscriptions.size; // the mock "delivers" to every subscription instantly; no device is reached
      return json(res, 200, { id: n.id, queued: true, subscriptions: pushSubscriptions.size });
    }

    // ---- memory contract (minimal) ----
    if (path === '/api/config') return json(res, 200, { captureIntervalMs: 5000, transcriptWords: 200, provider: 'mock', model: 'mock-vision', writerModel: 'mock-writer', perceptionUrl: 'http://localhost:0', speechBackend: 'local', speechNotice: 'QA mock: no speech server' });
    if (path === '/api/dashboard') return json(res, 200, { state: null, entities: [{ id: 'e1', kind: 'object', label: 'keys', description: '', personId: null, createdAt: Date.now() - 100_000, lastSeenAt: Date.now() - 50_000, attributes: {} }], observations: [], events: [], encounters: [], captures: [], stats: { mock: 1 }, pipeline: { running: true, queue: 0, failed: options.pipelineFailed ?? 2, committed: 40, accepted: 43, latestMemoryAgeMs: 95_000, oldestPendingMs: 0, observing: 0, reducing: null, indexing: false, lastError: null, latencies: [] } });
    if (path === '/api/people' && req.method === 'GET') return json(res, 200, { people: [], resetBefore: null });
    if (path === '/api/sessions' && req.method === 'POST') return json(res, 201, { id: `sess_${Date.now()}`, startedAt: Date.now() });
    if (path === '/api/captures' && req.method === 'POST') return json(res, 202, { id: body.id, status: 'queued' });
    if (path === '/api/transcripts' && req.method === 'POST') return json(res, 200, { accepted: true });
    if (path === '/api/search' && req.method === 'POST') {
      const mode = body.mode === 'semantic' ? 'semantic' : 'keyword';
      return json(res, 200, { results: [{ id: 'o1', packetId: 'cap_demo', packetVersion: 1, entityIds: ['e1'], candidateEntityIds: ['e2'], text: `[${mode}] keys on the desk next to the laptop`, observedAt: Date.now() - 50_000, endAt: Date.now() - 50_000, confidence: 'high', visual: true, transcriptKeys: [], superseded: false, distance: mode === 'semantic' ? 0.123 : 0 }] });
    }
    if (path.startsWith('/api/frames/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
    if (path === '/static/speech-worklet.js') { try { const data = await readFile(join(labStatic, 'speech-worklet.js')); res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' }); return res.end(data); } catch { return json(res, 404, { error: 'worklet unavailable' }); } }

    // ---- agent contract ----
    if (path === '/api/agent/status') return json(res, 200, { connected: true, bridge: { pending: 0, lastError: null }, agent: { running: true, activeTurns: 1, lastError: options.agentError ?? null } });
    if (path === '/api/agent/ask' && req.method === 'POST') { if (typeof body.text !== 'string' || !body.text) return json(res, 400, { error: 'text required' }); return json(res, 202, { eventId: `evt_${log.length}` }); }
    if (path === '/api/agent/notifications' && req.method === 'GET') return json(res, 200, { notifications });
    if (path === '/api/agent/events') {
      sseConnections += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 300\n\n');
      sseClients.add(res);
      for (const n of notifications) res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`); // replay on every (re)connect
      if (sseConnections === 1) { const n2 = { id: 'n2', taskId: 't1', text: 'Still looking; I will check the latest photo.', createdAt: Date.now(), refs: [] }; notifications.push(n2); setTimeout(() => broadcast(n2), 200); }
      if (sseConnections === 2) { const n3 = { id: 'n3', taskId: 't1', text: 'After reconnect: keys confirmed on the desk.', createdAt: Date.now(), refs: ['/v1/artifacts/art2'] }; notifications.push(n3); setTimeout(() => broadcast(n3), 200); }
      req.on('close', () => sseClients.delete(res));
      return;
    }
    const ackMatch = path.match(/^\/api\/agent\/notifications\/([^/]+)\/ack$/);
    if (ackMatch && req.method === 'POST') { const n = notifications.find((x) => x.id === decodeURIComponent(ackMatch[1])); if (n) n.acked = true; return json(res, 200, { acked: Boolean(n) }); }
    if (path === '/api/agent/tasks' && req.method === 'GET') return json(res, 200, { tasks });
    const cancelMatch = path.match(/^\/api\/agent\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') { const t = tasks.find((x) => x.id === decodeURIComponent(cancelMatch[1])); if (t) { t.status = 'cancelled'; t.updatedAt = Date.now(); } return json(res, 200, { cancelled: Boolean(t) }); }
    if (path === '/api/agent/commands' && req.method === 'GET') return json(res, 200, { commands: commands.filter((c) => !c.claimedBy && c.expiresAt > Date.now()).map(({ claimedBy, result, ...c }) => c) });
    const claimMatch = path.match(/^\/api\/agent\/commands\/([^/]+)\/claim$/);
    if (claimMatch && req.method === 'POST') { const c = commands.find((x) => x.id === decodeURIComponent(claimMatch[1])); if (!c || c.claimedBy || c.expiresAt <= Date.now()) return json(res, 200, { claimed: false }); c.claimedBy = body.sessionId; return json(res, 200, { claimed: true }); }
    const resultMatch = path.match(/^\/api\/agent\/commands\/([^/]+)\/result$/);
    if (resultMatch && req.method === 'POST') { const c = commands.find((x) => x.id === decodeURIComponent(resultMatch[1])); if (c) c.result = body; return json(res, 200, { recorded: Boolean(c) }); }
    if (path.startsWith('/v1/artifacts/')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`artifact ${path}`); }
    if (path.startsWith('/api/') || path.startsWith('/v1/')) return json(res, 404, { error: `mock: no route for ${req.method} ${path}` });

    // ---- static shell ----
    const rel = path === '/' ? '/index.html' : path;
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch { json(res, 404, { error: 'not found' }); }
  });
  return {
    server, log, commands, notifications, tasks, pushSubscriptions, pushCounters, pushKey, browseData, browseLog,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { for (const c of sseClients) c.end(); server.close(() => r()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mock = createMockServer();
  const port = await mock.listen();
  console.log(`mock memory+agent server: http://127.0.0.1:${port}`);
}
