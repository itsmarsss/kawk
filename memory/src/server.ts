import express from 'express';
import { createServer, type Server } from 'node:http';
import { createServer as createSecureServer, type ServerOptions as TlsOptions } from 'node:https';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { MemoryPipeline } from './pipeline.js';
import { peopleRoutes } from './people.js';
import type { AgentBridge } from './agent-bridge.js';
import { BrowseQuery } from './browse.js';

interface ServerOptions {
  perceptionUrl: string; publicDir: string; provider: string; model: string; writerModel?: string; writerProvider?: string;
  updateFormat?: string; textReader?: string;
  speechBackend?: 'local' | 'baseten'; speechNotice?: string;
  bridge?: AgentBridge;
  tls?: Pick<TlsOptions, 'cert' | 'key'>;
}
const searchSchema = z.object({
  query: z.string().trim().min(1).max(2000), entityId: z.string().optional(),
  from: z.number().finite().optional(), to: z.number().finite().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  mode: z.enum(['keyword', 'semantic']).default('keyword'),
}).refine(v => v.from === undefined || v.to === undefined || v.to >= v.from, 'Invalid time range');
const transcriptFilterSchema = z.object({
  from: z.coerce.number().finite().nonnegative().optional(),
  to: z.coerce.number().finite().nonnegative().optional(),
  includeRevisions: z.enum(['true', 'false']).optional().transform(value => value === 'true'),
}).refine(v => v.from === undefined || v.to === undefined || v.to >= v.from, 'Invalid time range');

export function createMemoryServer(pipeline: MemoryPipeline, options: ServerOptions): Server {
  const app = express();
  const server = options.tls ? createSecureServer(options.tls, app) : createServer(app);
  const upstream = new URL(options.perceptionUrl);
  function sameOrigin(origin: string | undefined, host: string | undefined) {
    if (!origin) return true;
    try { return new URL(origin).host === host; } catch { return false; }
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!sameOrigin(req.headers.origin, req.headers.host)) { res.status(403).json({ error: 'Use this server’s page' }); return; }
    next();
  });
  app.use(express.json({ limit: '16mb' }));
  options.bridge?.routes(app);
  app.get('/api/health', (_req, res) => res.json({ ok: true, pipeline: pipeline.snapshot() }));
  app.get('/api/memory/browse', (req, res) => res.json(pipeline.store.browse(BrowseQuery.parse(req.query))));
  app.get('/api/config', (_req, res) => res.json({ captureIntervalMs: 5000,
    transcriptWords: pipeline.transcriptWords, perceptionUrl: options.perceptionUrl,
    provider: options.provider, model: options.model, writerModel: options.writerModel ?? options.model,
    writerProvider: options.writerProvider ?? options.provider,
    updateFormat: options.updateFormat, textReader: options.textReader,
    speechBackend: options.speechBackend ?? 'baseten', speechNotice: options.speechNotice }));
  peopleRoutes(app, pipeline, upstream);
  app.post('/api/sessions', (_req, res) => {
    const session = { id: randomUUID(), startedAt: Date.now() };
    pipeline.store.createSession(session.id, session.startedAt); res.status(201).json(session);
  });
  app.post('/api/captures', async (req, res) => {
    options.bridge?.validateCapture(req.body);
    const c = await pipeline.capture(req.body); options.bridge?.captureAccepted(c);
    res.status(202).json({ id: c.id, status: c.status });
  });
  app.post('/api/captures/:id/retry', (req, res) => {
    pipeline.retry(req.params.id); res.json({ accepted: true });
  });
  app.post('/api/transcripts', (req, res) => res.json({ accepted: pipeline.transcript(req.body) }));
  app.get('/api/dashboard', (_req, res) => res.json({
    state: pipeline.store.currentState(), entities: pipeline.store.entities(),
    observations: pipeline.store.observations({ limit: 100 }), events: pipeline.store.events(),
    encounters: pipeline.store.encounters(), captures: pipeline.store.listCaptures(100),
    stats: pipeline.store.stats(), pipeline: pipeline.snapshot(),
  }));
  app.get('/api/packets/:id/history', (req, res) => res.json(pipeline.store.packetVersions(req.params.id)));
  app.get('/api/packets/:id', (req, res) => {
    const p = pipeline.store.getPacket(req.params.id);
    if (!p) { res.status(404).json({ error: 'Packet is not complete yet' }); return; }
    res.json(p);
  });
  app.get('/api/entities/:id', (req, res) => {
    const entity = pipeline.store.entity(req.params.id);
    if (!entity || pipeline.store.isPersonRemoved(entity)) { res.status(404).json({ error: 'Unknown entity' }); return; }
    res.json({ entity, observations: pipeline.store.entityHistory(entity.id),
      encounters: pipeline.store.encounters().filter(e => e.entityId === entity.id),
      events: pipeline.store.events().filter(e => e.entityId === entity.id) });
  });
  app.get('/api/history', (_req, res) => res.json(pipeline.store.history()));
  app.get('/api/object-sightings', (req, res) => res.json(pipeline.store.objectSightings(
    typeof req.query.packetId === 'string' ? req.query.packetId : undefined)));
  app.get('/api/transcripts/:sessionId', (req, res) =>
    res.json(pipeline.store.transcripts(req.params.sessionId, transcriptFilterSchema.parse(req.query))));
  app.post('/api/search', async (req, res) => {
    const { query, mode, ...filter } = searchSchema.parse(req.body);
    if (mode === 'keyword') { res.json({ results: pipeline.store.keywordSearch(query, filter) }); return; }
    const [vector] = await pipeline.embedder.embed([query]);
    res.json({ results: pipeline.store.search(vector, filter) });
  });
  app.get('/api/frames/:id', (req, res) => {
    const capture = pipeline.store.getCapture(req.params.id);
    if (!capture) { res.status(404).json({ error: 'Unknown capture' }); return; }
    res.sendFile(resolve(capture.imagePath));
  });
  // Only perception resources are exposed: old product/decision routes are not the new state.
  app.use(async (req, res, next) => {
    if (!(req.path.startsWith('/static/') || ['/api/gallery', '/api/status'].includes(req.path))) return next();
    if (req.method !== 'GET') { res.sendStatus(405); return; }
    try {
      const response = await fetch(new URL(req.originalUrl, upstream), { signal: AbortSignal.timeout(15000) });
      res.status(response.status).type(response.headers.get('content-type') ?? 'application/octet-stream');
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch { res.status(502).json({ error: 'Perception service unavailable; run the existing lab on port 8081' }); }
  });
  app.use(express.static(options.publicDir));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid evidence', details: error.issues }); return; }
    const message = error instanceof Error ? error.message : 'Request failed';
    res.status(message.includes('queue is full') ? 429 : 400).json({ error: message.slice(0, 400) });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 500_000, perMessageDeflate: false });
  const remoteSockets = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    if (!['/ws/faces', '/ws/speech'].includes(requestUrl.pathname) || !sameOrigin(req.headers.origin, req.headers.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    sockets.handleUpgrade(req, socket, head, client => {
      const url = new URL(requestUrl.pathname + requestUrl.search, upstream);
      url.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
      const remote = new WebSocket(url, { origin: upstream.origin, perMessageDeflate: false,
        handshakeTimeout: 15000, maxPayload: 2_000_000 });
      remoteSockets.add(remote);
      // Browser waits for upstream's ready message, so no pre-connect audio queue is needed.
      client.on('message', (data, binary) => {
        if (remote.readyState !== WebSocket.OPEN) return;
        if (remote.bufferedAmount > 500_000) { client.close(1013, 'Perception backpressure'); remote.close(); return; }
        remote.send(data, { binary });
      });
      remote.on('message', (data, binary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      const end = () => { remoteSockets.delete(remote); client.close(); remote.close(); };
      remote.on('error', () => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error',
          message: 'Perception service unavailable', retryable: true }));
        end();
      });
      client.on('error', end); client.on('close', end); remote.on('close', end);
    });
  });
  server.on('close', () => { for (const ws of sockets.clients) ws.terminate();
    for (const ws of remoteSockets) ws.terminate(); sockets.close(); });
  return server;
}
