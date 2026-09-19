import { check, eq, fakeClock } from './harness.mjs';
import { createLiveProvider, MAX_QUEUE } from '../providers/live_adapter.js';
import { validateEnvelope } from '../contracts/envelope.js';

/** Hand-rolled WebSocket stand-in: the test drives onopen/onmessage/onclose itself. */
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  serverClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const LOCATION = { protocol: 'http:', host: 'localhost:8000' };

function setup() {
  FakeWebSocket.instances = [];
  const clock = fakeClock();
  const seen = [];
  const provider = createLiveProvider({ WebSocketImpl: FakeWebSocket, clock, location: LOCATION, fetchImpl: async () => ({ ok: false, status: 503 }) });
  provider.subscribe((env) => seen.push(env));
  const states = () => seen.filter((e) => e.type === 'provider.status').map((e) => e.payload.status.state);
  return { clock, seen, states, provider, sockets: FakeWebSocket.instances };
}

export async function run() {
  console.log('\n# live adapter: stop race');
  {
    const { seen, states, provider, sockets } = setup();
    await provider.start();
    eq(sockets.length, 1, 'start opens one socket');
    eq(sockets[0].url, 'ws://localhost:8000/ws/remember', 'url derived from injected location');
    const old = sockets[0];
    const oldOnOpen = old.onopen; // captured before stop() detaches it
    const oldOnMessage = old.onmessage;
    await provider.stop();
    eq(states(), ['stopped'], 'stop emits exactly one stopped status');
    eq(old.readyState, 3, 'stop closes the socket');
    check(old.onopen === null && old.onmessage === null && old.onclose === null && old.onerror === null, 'stop detaches all handlers');
    oldOnOpen(); // (a) stale onopen after stop
    eq(states(), ['stopped'], 'stale onopen after stop does not emit running');
    const before = seen.length;
    oldOnMessage({ data: JSON.stringify({ type: 'scene.changed', payload: { scene: {} } }) }); // (b)
    eq(seen.length, before, 'stale onmessage after stop is not forwarded');
  }

  console.log('\n# live adapter: reconnect timer');
  {
    const { clock, states, provider, sockets } = setup();
    await provider.start();
    sockets[0].open();
    eq(states(), ['running'], 'open emits running');
    sockets[0].serverClose();
    eq(states(), ['running', 'error'], 'server close emits error');
    eq(clock.pending(), 1, 'reconnect timer scheduled after close');
    await provider.stop();
    eq(clock.pending(), 0, 'stop cancels the reconnect timer'); // (c)
    clock.advance(60_000);
    eq(sockets.length, 1, 'no reconnect after stop');
    eq(states(), ['running', 'error', 'stopped'], 'no status after stopped');
  }
  {
    const { clock, provider, sockets } = setup();
    await provider.start();
    sockets[0].serverClose();
    clock.advance(500);
    eq(sockets.length, 2, 'reconnect happens after backoff while wanted');
    sockets[1].serverClose();
    clock.advance(999);
    eq(sockets.length, 2, 'backoff doubles (not yet reconnected at 999 ms)');
    clock.advance(1);
    eq(sockets.length, 3, 'reconnected at 1000 ms');
    // a stale close on the first socket must not schedule anything or emit
    const pendingBefore = clock.pending();
    sockets[0].onclose?.(); // handlers were detached -> no-op
    eq(clock.pending(), pendingBefore, 'stale socket close does not schedule a timer');
    await provider.stop();
  }

  console.log('\n# live adapter: dispatch and queue');
  {
    const { provider } = setup();
    let threw = null;
    try { await provider.dispatch({ type: 'ask', payload: { q: 'x' } }); } catch (e) { threw = e; }
    check(threw instanceof Error && /stopped/.test(threw.message), 'dispatch while stopped throws'); // (d)
  }
  {
    const { provider, sockets } = setup();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      await provider.start();
      for (let i = 0; i < MAX_QUEUE + 10; i++) await provider.dispatch({ type: 'cmd', payload: { i } });
      eq(warns.length, 1, 'queue overflow warns exactly once');
      sockets[0].open();
      eq(sockets[0].sent.length, MAX_QUEUE, `queue bounded to ${MAX_QUEUE} and flushed on open`);
      const idx = sockets[0].sent.map((m) => JSON.parse(m).payload.i);
      eq(idx[0], 10, 'oldest commands were dropped');
      eq(idx[idx.length - 1], MAX_QUEUE + 9, 'newest command kept');
      check(idx.every((v, k) => k === 0 || v === idx[k - 1] + 1), 'flushed in order');
      await provider.dispatch({ type: 'cmd', payload: { i: 'direct' } });
      eq(sockets[0].sent.length, MAX_QUEUE + 1, 'dispatch while open sends immediately');
      eq(JSON.parse(sockets[0].sent[MAX_QUEUE]), { type: 'cmd', payload: { i: 'direct' } }, 'wire shape is {type, payload}');
      await provider.stop();
    } finally { console.warn = origWarn; }
  }

  console.log('\n# live adapter: local envelopes are valid and truthful');
  {
    const { seen, provider, sockets } = setup();
    await provider.start();
    sockets[0].open();
    sockets[0].serverClose();
    await provider.stop();
    const local = seen.filter((e) => e.type === 'provider.status');
    eq(local.length, 3, 'three local status envelopes (running, error, stopped)');
    check(local.every((e) => validateEnvelope(e).ok), 'every local envelope passes validateEnvelope'); // (e)
    check(local.every((e) => e.payload.status.camera === 'unknown' && e.payload.status.microphone === 'unknown'), 'local status never claims camera/mic are live');
    check(local.every((e) => e.payload.status.provider === 'live'), 'local status provider is live');
    eq(new Set(local.map((e) => e.event_id)).size, local.length, 'local event_ids are unique');
    check(local.every((e) => e.session_id === 'live_unbound'), 'session is live_unbound before the hub names one');
    eq(local[0].payload.status.label, 'Live · connected (awaiting hub status)', 'connected label does not claim capture');
    eq(local[1].payload.status.label, 'Live · disconnected', 'disconnected label');
    eq(local[0].occurred_at, '2026-09-19T14:00:00.000Z', 'occurred_at comes from the injected clock');
  }

  console.log('\n# live adapter: server envelopes and session id');
  {
    const { seen, provider, sockets } = setup();
    await provider.start();
    sockets[0].open();
    const server = { schema_version: '1.0', event_id: 'srv_1', session_id: 'ses_hub', occurred_at: '2026-09-19T14:00:01.000Z', type: 'session.started', payload: { status: { state: 'running', camera: 'live', microphone: 'live' } } };
    sockets[0].message(server);
    eq(seen[seen.length - 1], server, 'server envelope forwarded unchanged (unfiltered)'); // (f)
    const junk = { totally: 'not an envelope', schema_version: '9.9' };
    sockets[0].message(junk);
    eq(seen[seen.length - 1], junk, 'malformed server payload is still forwarded (store validates)');
    const before = seen.length;
    sockets[0].message('{not json');
    eq(seen.length, before, 'unparseable text is dropped');
    await provider.stop();
    eq(seen[seen.length - 1].session_id, 'ses_hub', 'session id learned from session.started is used for local envelopes');
  }
  {
    FakeWebSocket.instances = [];
    const p = createLiveProvider({ WebSocketImpl: FakeWebSocket, clock: fakeClock(), location: LOCATION, fetchImpl: async () => ({ ok: true, json: async () => ({ session_id: 'ses_snap', status: null }) }) });
    const snap = await p.getSnapshot();
    eq(snap.session_id, 'ses_snap', 'getSnapshot returns server json');
    const got = [];
    p.subscribe((e) => got.push(e));
    await p.start();
    FakeWebSocket.instances[0].open();
    eq(got[0].session_id, 'ses_snap', 'session id learned from snapshot is used for local envelopes');
    await p.stop();
  }
}
