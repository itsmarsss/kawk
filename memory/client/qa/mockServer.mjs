// Isolated mock of the memory+agent HTTP contract for browser QA. Plain node:http, random port, no
// persistence, no camera, no real providers. Serves ../public as the app shell. Records every request at
// GET /__qa/log so the Playwright driver can assert on request bodies. Never used by the real service.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createMockServer(options = {}) {
  const log = [];
  const sseClients = new Set();
  let sseConnections = 0;
  const notifications = [
    { id: 'n1', taskId: 't1', text: 'Your keys were last seen on the desk at 21:46 (source photo linked).', createdAt: Date.now() - 60_000, refs: [{ type: 'artifact', id: 'a1', label: 'screenshot' }, { captureId: 'cap_demo' }, { eventId: 'evt-1', revision: 0 }, 'https://example.invalid/never-a-link'] },
  ];
  const tasks = [
    { id: 't1', status: 'running', goal: 'find out where the keys are', result: null, createdAt: Date.now() - 70_000, updatedAt: Date.now() - 5000 },
    { id: 't0', status: 'done', goal: 'summarize the morning', result: { summary: 'Two meetings, coffee with Sam.' }, createdAt: Date.now() - 900_000, updatedAt: Date.now() - 800_000 },
  ];
  const commands = [];
  // Web Push mock: a VAPID-shaped public key (65 bytes, URL-safe base64), subscriptions keyed by endpoint, counters.
  // Nothing is delivered from here (no push service); the browser QA injects push events through CDP instead.
  const pushKey = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 53) % 251))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pushSubscriptions = new Map();
  const pushCounters = { pending: 0, sent: 0, failed: 0 };
  let pushTests = 0;
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
    server, log, commands, notifications, tasks, pushSubscriptions, pushCounters, pushKey,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { for (const c of sseClients) c.end(); server.close(() => r()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mock = createMockServer();
  const port = await mock.listen();
  console.log(`mock memory+agent server: http://127.0.0.1:${port}`);
}
