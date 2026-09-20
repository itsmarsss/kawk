import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationLedger, NotificationStream, describeAgentConnection, isActiveTask, parseNotification, refView, taskResultText, taskResultView, type AgentNotification, type EventSourceLike, type StreamState } from '../src/agentFeed.ts';
import { FakeClock } from './fakes.ts';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((this: unknown, ev: unknown) => unknown) | null = null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null = null;
  private listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void { (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)!).push(fn); }
  close(): void { this.closed = true; this.readyState = 2; }
  serverOpen(): void { this.readyState = 1; this.onopen?.call(this, {}); }
  serverEvent(type: string, obj: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(obj) }); }
  serverDrop(): void { this.readyState = 2; this.onerror?.call(this, {}); }
  serverBlip(): void { this.readyState = 0; this.onerror?.call(this, {}); }
}

function streamHarness() {
  FakeEventSource.instances = [];
  const clock = new FakeClock();
  const ledger = new NotificationLedger(50);
  const rendered: string[] = [];
  const states: StreamState[] = [];
  const errors: string[] = [];
  const stream = new NotificationStream({ url: '/api/agent/events', clock, create: (url) => new FakeEventSource(url),
    onNotification: (n) => { if (ledger.add(n)) rendered.push(n.id); }, onState: (s) => states.push(s), onError: (m) => errors.push(m) });
  return { clock, ledger, rendered, states, errors, stream, es: () => FakeEventSource.instances.at(-1)! };
}
const note = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({ id, taskId: 't1', text: `answer ${id}`, createdAt, refs: [], ...extra });

test('notifications are rendered once across initial GET, SSE delivery and a reconnect replay', () => {
  const h = streamHarness();
  // initial GET
  for (const raw of [note('n1', 1000), note('n2', 2000)]) { const n = parseNotification(raw, h.clock.now()); if (n && h.ledger.add(n)) h.rendered.push(n.id); }
  h.stream.start();
  const es1 = h.es();
  es1.serverOpen();
  assert.equal(h.states.at(-1)!.phase, 'open');
  es1.serverEvent('notification', note('n2', 2000)); // stream repeats what GET already returned
  es1.serverEvent('notification', note('n3', 3000));
  assert.deepEqual(h.rendered, ['n1', 'n2', 'n3']);
  assert.equal(h.ledger.duplicates, 1);
  // stream closed by the server → reopen with backoff; the replay must not re-render anything
  es1.serverDrop();
  assert.equal(h.states.at(-1)!.phase, 'reconnecting');
  assert.equal(FakeEventSource.instances.length, 1, 'reopen waits for the backoff');
  h.clock.advance(1000);
  assert.equal(FakeEventSource.instances.length, 2);
  const es2 = h.es();
  es2.serverOpen();
  es2.serverEvent('notification', note('n1', 1000));
  es2.serverEvent('notification', note('n3', 3000));
  es2.serverEvent('notification', note('n4', 4000));
  assert.deepEqual(h.rendered, ['n1', 'n2', 'n3', 'n4']);
  assert.equal(h.ledger.duplicates, 3);
  assert.equal(h.states.at(-1)!.connections, 2);
  // late event from the dead first stream is ignored
  es1.serverEvent('notification', note('n5', 5000));
  assert.deepEqual(h.rendered, ['n1', 'n2', 'n3', 'n4']);
  // a transient error while the browser itself retries does not open a second stream
  es2.serverBlip();
  h.clock.advance(20_000);
  assert.equal(FakeEventSource.instances.length, 2);
  assert.deepEqual(h.ledger.list().map((n) => n.id), ['n4', 'n3', 'n2', 'n1'], 'newest first');
  h.stream.stop();
  assert.equal(es2.closed, true);
  assert.equal(h.states.at(-1)!.phase, 'closed');
});

test('wake(): a stream dropped while the tab was hidden reopens immediately; a healthy stream is left alone', () => {
  const h = streamHarness();
  h.stream.start(); const es1 = h.es(); es1.serverOpen();
  h.stream.wake();
  assert.equal(FakeEventSource.instances.length, 1, 'open stream untouched');
  es1.serverDrop();
  assert.equal(h.states.at(-1)!.phase, 'reconnecting');
  assert.equal(h.clock.pending, 1, 'backoff timer armed');
  h.stream.wake(); // tab became visible: do not wait out the backoff
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(h.clock.pending, 0, 'backoff timer cancelled, not doubled');
  const es2 = h.es(); es2.serverOpen();
  assert.equal(h.states.at(-1)!.connections, 2);
  h.clock.advance(60_000);
  assert.equal(FakeEventSource.instances.length, 2, 'no ghost reopen from the cancelled timer');
  // browser reports CLOSED without ever firing onerror (background eviction): wake still recovers
  es2.readyState = 2;
  h.stream.wake();
  assert.equal(FakeEventSource.instances.length, 3); assert.equal(es2.closed, true);
  h.stream.stop();
  h.stream.wake();
  assert.equal(FakeEventSource.instances.length, 3, 'stopped stream never reopens');
});

test('push markers and ack reasons live on the ledger; last-event age is shown when a clock is given', () => {
  const ledger = new NotificationLedger(10);
  assert.equal(ledger.markPush('unknown', 5), false);
  ledger.add(parseNotification(note('n1', 1000), 2000)!);
  assert.equal(ledger.markPush('n1', 3000), true); assert.equal(ledger.get('n1')!.pushAt, 3000);
  ledger.markPush('n1', 9000); assert.equal(ledger.get('n1')!.pushAt, 3000, 'first push time kept');
  ledger.ack('n1', 'opened from notification');
  assert.equal(ledger.get('n1')!.acked, true); assert.equal(ledger.get('n1')!.ackReason, 'opened from notification');
  const st: StreamState = { phase: 'open', attempt: 0, connections: 1, lastEventAt: 10_000, lastError: null };
  assert.match(describeAgentConnection({ connected: true }, null, st, 22_400).text, /live updates on · last event 12 s ago$/);
  assert.doesNotMatch(describeAgentConnection({ connected: true }, null, st).text, /last event/);
  const rc: StreamState = { phase: 'reconnecting', attempt: 3, connections: 1, lastEventAt: null, lastError: 'stream closed' };
  assert.match(describeAgentConnection({ connected: true }, null, rc, 1).text, /reconnecting \(attempt 3, stream closed\)/);
});

test('malformed events are reported, not rendered; ack state only flips after the caller confirms', () => {
  const h = streamHarness();
  h.stream.start(); h.es().serverOpen();
  h.es().serverEvent('notification', { text: 'no id' });
  h.es().serverEvent('notification', note('ok', 10));
  assert.deepEqual(h.errors, ['notification event without an id']);
  assert.deepEqual(h.rendered, ['ok']);
  assert.equal(h.ledger.get('ok')!.acked, false);
  h.ledger.ack('ok');
  assert.equal(h.ledger.get('ok')!.acked, true);
  const repeat = parseNotification(note('ok', 10, { acked: true }), 0)!;
  assert.equal(h.ledger.add(repeat), false);
  const n: AgentNotification | null = parseNotification('nope', 0);
  assert.equal(n, null);
  h.stream.stop();
});

test('refs become links only for same-origin paths; artifact ids map to the proxy route', () => {
  assert.deepEqual(refView('/v1/artifacts/abc'), { label: '/v1/artifacts/abc', href: '/v1/artifacts/abc' });
  assert.deepEqual(refView('https://evil.example/x'), { label: 'https://evil.example/x', href: null });
  assert.deepEqual(refView('//evil.example/x'), { label: '//evil.example/x', href: null });
  assert.deepEqual(refView({ artifactId: 'a b' }), { label: 'artifact a b', href: null }, 'no valid proxy path → text, not an invented link');
  assert.deepEqual(refView({ artifactId: '3f2a-0b' }), { label: 'artifact 3f2a-0b', href: '/v1/artifacts/3f2a-0b' });
  assert.deepEqual(refView({ type: 'artifact', id: 'ABC', label: 'screenshot' }), { label: 'screenshot', href: null }, 'uppercase ids are not proxied');
  assert.deepEqual(refView({ type: 'artifact', id: 'e1', label: 'screenshot' }), { label: 'screenshot', href: '/v1/artifacts/e1' });
  assert.deepEqual(refView({ eventId: 'evt-9', revision: 2 }), { label: 'evidence event evt-9 r2', href: null }, 'bridge evidence refs are plain text');
  assert.deepEqual(refView({ eventId: 'evt-9' }), { label: 'evidence event evt-9', href: null });
  assert.deepEqual(refView({ captureId: 'cap1' }), { label: 'source image cap1', href: '/api/frames/cap1' });
  assert.deepEqual(refView({ type: 'memory', id: 'm1' }), { label: 'memory m1', href: null });
  assert.deepEqual(refView({ url: 'http://x/y' }), { label: '{"url":"http://x/y"}', href: null });
});

test('task and connection helpers', () => {
  assert.equal(isActiveTask('running'), true); assert.equal(isActiveTask('queued'), true);
  assert.equal(isActiveTask('done'), false); assert.equal(isActiveTask('Cancelled'), false); assert.equal(isActiveTask(undefined), false);
  assert.equal(isActiveTask('abstained'), false, 'Jev abstained: finished, no Cancel');
  assert.equal(isActiveTask('superseded'), false, 'superseded by a newer task: finished, no Cancel');
  assert.equal(isActiveTask('Superseded'), false);
  assert.equal(taskResultText({ summary: 'found it' }), 'found it'); assert.equal(taskResultText(null), null); assert.equal(taskResultText('x'), 'x');
  // live bridge shape: a JSON-encoded string with receipts → only the answer text is wearer-facing; receipts stay raw
  const encoded = '{"text":"In Toronto, it’s overcast and 14°C.","refs":[{"eventId":"4467b181","revision":0}],"confidence":0.92,"notify":true,"reviewRejected":false}';
  const v = taskResultView(encoded);
  assert.equal(v.text, 'In Toronto, it’s overcast and 14°C.'); assert.equal(v.structured, true); assert.match(v.raw ?? '', /"confidence": 0.92/); assert.doesNotMatch(v.text ?? '', /refs|confidence/);
  assert.equal(taskResultText(encoded), 'In Toronto, it’s overcast and 14°C.');
  const abstained = taskResultView('{"text":"","refs":[{"eventId":"x","revision":0}],"confidence":1,"notify":false}');
  assert.equal(abstained.text, null); assert.equal(abstained.structured, true); assert.match(abstained.raw ?? '', /"notify": false/);
  assert.deepEqual(taskResultView('{not json'), { text: '{not json', raw: null, structured: false });
  assert.deepEqual(taskResultView({ refs: [] }), { text: null, raw: '{\n  "refs": []\n}', structured: true });
  assert.deepEqual(taskResultView(''), { text: null, raw: null, structured: false });
  const open: StreamState = { phase: 'open', attempt: 0, connections: 1, lastEventAt: null, lastError: null };
  assert.deepEqual(describeAgentConnection({ connected: true, bridge: { pending: 0, lastError: null }, agent: { running: true, activeTurns: 1, lastError: null } }, null, open),
    { text: 'connected · running · 1 active turn(s) · 0 pending · live updates on', tone: 'ok' });
  assert.equal(describeAgentConnection({ connected: false, bridge: { pending: 2, lastError: 'socket closed' } }, null, open).tone, 'bad');
  assert.equal(describeAgentConnection(null, 'GET /api/agent/status → HTTP 404', open).tone, 'bad');
  assert.equal(describeAgentConnection({ connected: true, agent: { running: true, lastError: 'provider 403' } }, null, open).tone, 'warn');
});
