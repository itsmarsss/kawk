// Example live provider: a same-origin WebSocket adapter for backend agent/memory events.
// It is NOT wired by default (config.js selects the demo provider). It never holds credentials —
// the server authenticates to Baseten/TypeSafe; the browser only talks to its own origin.
//
// Wire contract (to be implemented server-side, see REMEMBER_UI.md §"Live adapter"):
//   server → browser : JSON envelopes exactly as in contracts/schema.json
//   browser → server : {"type": <CommandType>, "payload": {...}} (contracts/types.d.ts CommandMap)
//   GET <httpBase>/snapshot : JSON Snapshot for initial hydration
//
// Truthfulness: a socket being open proves only that the hub is reachable. Locally generated
// status envelopes therefore report camera/microphone as 'unknown'; only envelopes that come
// from the backend may claim 'live'.
import { createEmitter, realClock } from './provider.js';
import { SCHEMA_VERSION } from '../contracts/envelope.js';

/** Commands buffered while (re)connecting. Oldest is dropped when full. */
export const MAX_QUEUE = 50;
const UNBOUND_SESSION = 'live_unbound';
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * @param {{
 *   path?: string,
 *   snapshotPath?: string,
 *   WebSocketImpl?: typeof WebSocket,
 *   fetchImpl?: typeof fetch,
 *   clock?: {now: () => number, setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void},
 *   location?: {protocol: string, host: string},
 * }} [opts]
 * @returns {import('../contracts/types').Provider}
 */
export function createLiveProvider(opts = {}) {
  const path = opts.path ?? '/ws/remember';
  const snapshotPath = opts.snapshotPath ?? '/api/remember/snapshot';
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const clock = opts.clock ?? realClock;
  const loc = opts.location ?? globalThis.location;
  const emitter = createEmitter();

  let socket = null;          // the current socket; callbacks from any other socket are ignored
  let generation = 0;         // bumped on every connect() and stop(); stale callbacks compare against it
  let wanted = false;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer = null;
  let sessionId = UNBOUND_SESSION;
  let localSeq = 0;
  let warnedQueueFull = false;
  const queue = [];

  function isoNow() { return new Date(clock.now()).toISOString(); }

  function status(state, message) {
    const label = state === 'running' ? 'Live · connected (awaiting hub status)' : 'Live · disconnected';
    return {
      schema_version: SCHEMA_VERSION, provider: 'live', state, label, message,
      session_id: sessionId, camera: 'unknown', microphone: 'unknown', since: isoNow(),
    };
  }
  function localStatus(state, message) {
    // Locally generated status envelopes so the UI can show connection state even when the hub is silent.
    localSeq += 1;
    emitter.emit({
      schema_version: SCHEMA_VERSION,
      event_id: `local_${clock.now().toString(36)}_${localSeq.toString(36)}`,
      session_id: sessionId,
      occurred_at: isoNow(),
      type: 'provider.status',
      payload: { status: status(state, message) },
    });
  }

  function detach(s) {
    if (!s) return;
    s.onopen = null; s.onmessage = null; s.onclose = null; s.onerror = null;
  }
  function clearReconnect() {
    if (reconnectTimer !== null) { clock.clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function connect() {
    reconnectTimer = null;
    if (!wanted) return;
    const gen = ++generation;
    const url = `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${path}`;
    const s = new WS(url);
    socket = s;
    const current = () => wanted && socket === s && generation === gen;

    s.onopen = () => {
      if (!current()) return;
      backoff = INITIAL_BACKOFF_MS;
      while (queue.length) s.send(queue.shift());
      localStatus('running', 'Connected');
    };
    s.onmessage = (ev) => {
      if (!current()) return;
      let env;
      try { env = JSON.parse(ev.data); } catch { return; }
      if (env?.type === 'session.started' && typeof env.session_id === 'string' && env.session_id) sessionId = env.session_id;
      emitter.emit(env); // the store validates version/shape; the adapter does not filter
    };
    s.onclose = () => {
      if (!current()) return;
      detach(s);
      socket = null;
      localStatus('error', `Disconnected — retrying in ${Math.round(backoff / 1000)} s`);
      clearReconnect();
      reconnectTimer = clock.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
    s.onerror = () => { /* onclose follows */ };
  }

  return {
    kind: 'live',
    /** Session learned from the snapshot or the hub's session.started; 'live_unbound' before that. */
    get sessionId() { return sessionId; },
    subscribe: emitter.subscribe,
    async getSnapshot() {
      if (!fetchImpl) throw new Error('live provider: no fetch implementation available');
      const res = await fetchImpl(snapshotPath, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const snap = await res.json();
      if (typeof snap?.session_id === 'string' && snap.session_id) sessionId = snap.session_id;
      return snap;
    },
    async start() {
      if (wanted) return;
      if (!WS) throw new Error('live provider: no WebSocket implementation available');
      wanted = true;
      backoff = INITIAL_BACKOFF_MS;
      connect();
    },
    async stop() {
      wanted = false;
      generation += 1;
      clearReconnect();
      queue.length = 0;
      warnedQueueFull = false;
      const s = socket;
      socket = null;
      if (s) {
        detach(s);
        try { s.close(); } catch { /* ignore */ }
      }
      localStatus('stopped', 'Stopped');
    },
    async dispatch(command) {
      if (!wanted) throw new Error('live provider is stopped');
      const msg = JSON.stringify({ type: command.type, payload: command.payload ?? {} });
      if (socket?.readyState === 1) { socket.send(msg); return; }
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        if (!warnedQueueFull) {
          warnedQueueFull = true;
          console.warn(`live provider: command queue full (${MAX_QUEUE}); dropping oldest while disconnected`);
        }
      }
      queue.push(msg);
    },
  };
}
