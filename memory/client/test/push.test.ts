// PushController state machine with fake browser seams: permission, key fetch, browser subscribe, agent record,
// rollback, re-sync, disable, test push, delivery polling, re-entrancy. No browser, no network, no agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from './fakes.ts';
import { PushController, classifyPushSupport, notificationIdFromSearch, parseWorkerMessage, pushGuidance, sameKey, urlBase64ToUint8Array, type PushDeliveryStatus, type PushEnvironment, type PushPermission, type PushRegistrationLike, type PushState, type PushSubscriptionLike } from '../src/push.ts';

const env = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, isSecureContext: true, protocol: 'https:', hostname: 'kawk.local', isIOS: false, standalone: false, permission: 'default', ...over });
// 65-byte uncompressed P-256 point shape (0x04 + 64 bytes) in URL-safe base64, as web-push generates.
const KEY_BYTES = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : (i * 37) % 251));
const KEY = Buffer.from(KEY_BYTES).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class FakeSub implements PushSubscriptionLike {
  unsubscribed = 0;
  constructor(public endpoint: string, public key: Uint8Array, private readonly failUnsub = false) {}
  get options() { return { applicationServerKey: this.key.buffer.slice(this.key.byteOffset, this.key.byteOffset + this.key.byteLength) as ArrayBuffer }; }
  toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } }; }
  async unsubscribe() { this.unsubscribed += 1; if (this.failUnsub) throw new Error('browser refused'); return true; }
}
/** Browser-like: subscribe() is what prompts; a denied/dismissed prompt rejects with NotAllowedError. */
class FakePushManager {
  subscribeCalls = 0; failSubscribe: string | null = null; subscribeSyncMarker = 0;
  permission: PushPermission = 'granted'; onPrompt: (() => void) | null = null;
  constructor(public sub: FakeSub | null = null) {}
  async getSubscription() { return this.sub; }
  subscribe(o: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<FakeSub> {
    this.subscribeCalls += 1; this.subscribeSyncMarker = this.subscribeCalls; // set synchronously when called
    return (async () => {
      assert.equal(o.userVisibleOnly, true);
      this.onPrompt?.();
      if (this.failSubscribe) throw new Error(this.failSubscribe); // push-service failures happen after the permission was granted
      if (this.permission !== 'granted') { const e = new Error('Registration failed - permission denied'); (e as { name: string }).name = 'NotAllowedError'; throw e; }
      this.sub = new FakeSub(`https://push.example.net/sub/${this.subscribeCalls}`, new Uint8Array(o.applicationServerKey as ArrayBuffer));
      return this.sub;
    })();
  }
}

function harness(over: { env?: Partial<PushEnvironment>; permission?: PushPermission; sub?: FakeSub | null; keyError?: string; subscribeError?: string; unsubscribeError?: string; testError?: string; noRegistration?: boolean } = {}) {
  const clock = new FakeClock();
  const pm = new FakePushManager(over.sub ?? null);
  const reg: PushRegistrationLike = { pushManager: pm };
  const calls: string[] = [];
  const states: PushState[] = [];
  let currentEnv = env(over.env);
  pm.permission = over.permission ?? 'granted';
  pm.onPrompt = () => { currentEnv = { ...currentEnv, permission: pm.permission }; }; // the browser prompt settles Notification.permission
  let statusValue: PushDeliveryStatus = { subscriptions: 1, pending: 0, sent: 3, failed: 0 };
  const c = new PushController({
    env: () => currentEnv,
    registration: async () => (over.noRegistration ? null : reg),
    api: {
      key: async () => { calls.push('key'); if (over.keyError) throw new Error(over.keyError); return { publicKey: KEY }; },
      subscribe: async (json) => { calls.push(`subscribe:${(json as { endpoint: string }).endpoint}`); if (over.subscribeError) throw new Error(over.subscribeError); return { subscribed: true }; },
      unsubscribe: async (endpoint) => { calls.push(`unsubscribe:${endpoint}`); if (over.unsubscribeError) throw new Error(over.unsubscribeError); return { subscribed: false }; },
      status: async () => { calls.push('status'); return statusValue; },
      test: async () => { calls.push('test'); if (over.testError) throw new Error(over.testError); return { id: 'ntest-1', queued: true }; },
    },
    clock, onState: (s) => states.push(s),
  });
  return { c, pm, calls, states, clock, setPermission: (p: PushPermission) => { pm.permission = p; }, setStatus: (s: PushDeliveryStatus) => { statusValue = s; }, last: () => states.at(-1)! };
}

test('support classification and guidance', () => {
  assert.deepEqual(classifyPushSupport(env()), { kind: 'supported' });
  assert.deepEqual(classifyPushSupport(env({ isSecureContext: false, protocol: 'http:', hostname: '192.168.1.20' })), { kind: 'insecure-context' });
  assert.deepEqual(classifyPushSupport(env({ isSecureContext: false, protocol: 'http:', hostname: 'localhost' })), { kind: 'supported' }, 'localhost is a secure context for push');
  assert.deepEqual(classifyPushSupport(env({ isIOS: true, standalone: false, hasPushManager: false })), { kind: 'ios-not-installed' });
  assert.deepEqual(classifyPushSupport(env({ isIOS: true, standalone: true })), { kind: 'supported' }, 'installed iOS web app with PushManager');
  assert.deepEqual(classifyPushSupport(env({ hasPushManager: false, hasNotification: false })), { kind: 'unsupported', missing: ['PushManager', 'Notification'] });
  assert.match(pushGuidance(env({ isSecureContext: false, protocol: 'http:', hostname: '10.0.0.5' }), { kind: 'insecure-context' }, false), /HTTPS/);
  assert.match(pushGuidance(env({ isIOS: true, hasPushManager: false }), { kind: 'ios-not-installed' }, false), /Add to Home Screen/);
  assert.match(pushGuidance(env({ permission: 'denied' }), { kind: 'supported' }, false), /blocked/);
  assert.match(pushGuidance(env({ isIOS: true, standalone: true }), { kind: 'supported' }, true), /proven only when .* iOS background receipt still needs that real test/);
  assert.match(pushGuidance(env(), { kind: 'supported' }, false), /No token is needed/);
});

test('VAPID key decoding and comparison', () => {
  const bytes = urlBase64ToUint8Array(KEY);
  assert.equal(bytes.length, 65); assert.equal(bytes[0], 4);
  assert.deepEqual([...bytes], [...KEY_BYTES]);
  assert.equal(sameKey(bytes.buffer as ArrayBuffer, KEY_BYTES), true);
  assert.equal(sameKey(new Uint8Array([1, 2, 3]).buffer, KEY_BYTES), false);
  assert.equal(sameKey(null, KEY_BYTES), false);
  assert.throws(() => urlBase64ToUint8Array('not base64!!'), /URL-safe base64/);
  assert.throws(() => urlBase64ToUint8Array(''), /URL-safe base64/);
});

test('prepare on load: key + registration cached, Enable becomes possible, NO subscribe/prompt/POST happens', async () => {
  const h = harness();
  assert.equal(h.c.snapshot.stage, 'not-ready'); assert.equal(h.c.snapshot.prepared, false);
  await h.c.prepare();
  assert.deepEqual(h.calls, ['key']);
  assert.equal(h.pm.subscribeCalls, 0);
  const s = h.last();
  assert.equal(s.stage, 'ready'); assert.equal(s.prepared, true); assert.equal(s.subscribed, false); assert.match(s.message, /press Enable/);
  assert.ok(h.states.some((x) => x.stage === 'preparing'));
});

test('enable: pushManager.subscribe() is invoked SYNCHRONOUSLY from the click with the cached key, before any await; then the agent records it', async () => {
  const h = harness();
  await h.c.prepare();
  const callsBefore = h.calls.length;
  const p = h.c.enable(); // no await yet: still inside the (simulated) click handler's synchronous run
  assert.equal(h.pm.subscribeSyncMarker, 1, 'subscribe() ran before enable() returned its promise');
  assert.equal(h.calls.length, callsBefore, 'no network call happened before subscribe()');
  await p;
  assert.deepEqual(h.calls.slice(callsBefore), ['subscribe:https://push.example.net/sub/1', 'status']);
  const s = h.last();
  assert.equal(s.stage, 'subscribed'); assert.equal(s.subscribed, true); assert.equal(s.endpointHost, 'push.example.net'); assert.equal(s.permission, 'granted'); assert.equal(s.lastError, null); assert.equal(s.busy, false);
  assert.deepEqual(h.pm.sub!.key, KEY_BYTES, 'subscribed with the cached agent key');
  assert.deepEqual(s.delivery, { subscriptions: 1, pending: 0, sent: 3, failed: 0 });
  h.setStatus({ subscriptions: 1, pending: 1, sent: 3, failed: 1 });
  h.clock.advance(5000); await flush();
  assert.equal(h.calls.filter((c) => c === 'status').length, 2, 'poll fires every 5 s');
  assert.deepEqual(h.last().delivery, { subscriptions: 1, pending: 1, sent: 3, failed: 1 });
});

test('enable before prepare finished (or after it failed) never calls subscribe; it says to retry setup', async () => {
  const h = harness();
  await h.c.enable();
  assert.equal(h.pm.subscribeCalls, 0); assert.equal(h.last().stage, 'not-ready'); assert.match(h.last().message, /Retry push setup/);
  const h2 = harness({ keyError: 'GET /api/agent/push/key → HTTP 503: {"error":"Push is not configured"}' });
  await h2.c.prepare();
  assert.equal(h2.last().stage, 'not-ready'); assert.equal(h2.last().prepared, false); assert.match(h2.last().lastError!, /not configured on the agent/);
  await h2.c.enable();
  assert.equal(h2.pm.subscribeCalls, 0);
  const h3 = harness({ noRegistration: true });
  await h3.c.prepare();
  assert.match(h3.last().lastError!, /service worker registration unavailable/); assert.equal(h3.last().prepared, false);
  const h4 = harness({ keyError: 'GET /api/agent/push/key → HTTP 502: Agent unavailable' });
  await h4.c.prepare();
  assert.match(h4.last().lastError!, /push key unavailable/);
  // Retry setup after the agent came back: a fresh harness key works and Enable proceeds
  const h5 = harness();
  await h5.c.prepare(); await h5.c.enable();
  assert.equal(h5.last().subscribed, true); assert.equal(h5.last().counts.prepares, 1);
});

test('enable: the browser prompt is denied → NotAllowedError → denied state with settings guidance; dismissed → ready', async () => {
  const h = harness({ permission: 'denied' });
  await h.c.prepare(); await h.c.enable();
  assert.equal(h.pm.subscribeCalls, 1, 'subscribe() is the prompt');
  assert.equal(h.calls.filter((c) => c.startsWith('subscribe:')).length, 0, 'nothing recorded on the agent');
  assert.equal(h.last().stage, 'denied'); assert.equal(h.last().permission, 'denied'); assert.match(h.last().guidance, /blocked/);
  const h2 = harness({ permission: 'default' });
  await h2.c.prepare(); await h2.c.enable();
  assert.equal(h2.last().stage, 'ready'); assert.match(h2.last().message, /not granted/);
});

test('enable: agent refuses the subscription → browser subscription rolled back so state stays consistent', async () => {
  const h = harness({ subscribeError: 'POST /api/agent/push/subscriptions → HTTP 502: Agent unavailable' });
  await h.c.prepare(); await h.c.enable();
  assert.equal(h.pm.subscribeCalls, 1);
  assert.equal(h.pm.sub!.unsubscribed, 1, 'rolled back');
  assert.equal(h.last().stage, 'error'); assert.equal(h.last().subscribed, false); assert.match(h.last().lastError!, /rolled back/);
  assert.equal(h.clock.pending, 0, 'no delivery poll armed');
});

test('enable: browser subscribe failure (e.g. headless push service) is visible; prepare replaces a subscription made for a rotated key', async () => {
  const h = harness();
  await h.c.prepare();
  h.pm.failSubscribe = 'AbortError: Registration failed - push service error';
  await h.c.enable();
  assert.equal(h.last().stage, 'error'); assert.match(h.last().lastError!, /push service error/);
  assert.equal(h.calls.filter((c) => c.startsWith('subscribe:')).length, 0);
  // rotated key: the browser holds a subscription signed for an old key → dropped during prepare, not during the click
  const old = new FakeSub('https://push.example.net/old', new Uint8Array(65).fill(9));
  const h2 = harness({ sub: old });
  await h2.c.prepare();
  assert.equal(old.unsubscribed, 1, 'old-key subscription dropped'); assert.equal(h2.last().stage, 'ready'); assert.equal(h2.last().subscribed, false);
  await h2.c.enable();
  assert.equal(h2.pm.subscribeCalls, 1); assert.ok(h2.calls.includes('subscribe:https://push.example.net/sub/1'));
  // same key: re-synced by prepare, no click needed, no new subscribe
  const same = new FakeSub('https://push.example.net/same', KEY_BYTES);
  const h3 = harness({ sub: same });
  await h3.c.prepare();
  assert.deepEqual(h3.calls, ['key', 'subscribe:https://push.example.net/same']); // idempotent upsert, no prompt
  assert.equal(h3.pm.subscribeCalls, 0); assert.equal(same.unsubscribed, 0);
  assert.equal(h3.last().stage, 'subscribed'); assert.equal(h3.last().counts.syncs, 1);
  const h4 = harness({ sub: same, subscribeError: 'HTTP 502' });
  await h4.c.prepare();
  assert.equal(h4.last().subscribed, true); assert.match(h4.last().lastError!, /existing subscription/); assert.match(h4.last().message, /Retry push setup/);
  const h5 = harness({ env: { hasPushManager: false } });
  await h5.c.prepare(); await h5.c.enable();
  assert.deepEqual(h5.calls, []); assert.equal(h5.last().stage, 'unsupported');
  const h6 = harness({ env: { permission: 'denied' } });
  await h6.c.prepare();
  assert.equal(h6.last().stage, 'denied'); assert.equal(h6.last().prepared, true, 'the user can still press Enable after unblocking');
});

test('disable: browser unsubscribes and the agent forgets the endpoint; failures are visible and honest', async () => {
  const h = harness();
  await h.c.prepare(); await h.c.enable();
  const endpoint = h.pm.sub!.endpoint;
  const sub = h.pm.sub!;
  await h.c.disable();
  assert.equal(sub.unsubscribed, 1);
  assert.ok(h.calls.includes(`unsubscribe:${endpoint}`));
  assert.equal(h.last().stage, 'ready'); assert.equal(h.last().subscribed, false); assert.equal(h.last().endpointHost, null); assert.equal(h.last().prepared, true, 'Enable works again without another prepare');
  h.clock.advance(20_000); await flush();
  assert.equal(h.calls.filter((c) => c === 'status').length, 1, 'delivery polling stopped after disable');
  const h2 = harness({ unsubscribeError: 'HTTP 502' });
  await h2.c.prepare(); await h2.c.enable(); await h2.c.disable();
  assert.equal(h2.last().subscribed, false); assert.match(h2.last().lastError!, /agent did not remove/);
  const stubborn = new FakeSub('https://push.example.net/stubborn', KEY_BYTES, true);
  const h3 = harness({ sub: stubborn });
  await h3.c.prepare(); await h3.c.disable();
  assert.equal(h3.last().subscribed, true); assert.ok(h3.calls.includes('unsubscribe:https://push.example.net/stubborn')); assert.match(h3.last().message, /browser kept its subscription/);
  const h4 = harness();
  await h4.c.prepare(); await h4.c.disable();
  assert.equal(h4.last().stage, 'ready'); assert.match(h4.last().message, /was not enabled/);
});

test('test push: queues one real notification and only records the id; failure visible; clearStatus keeps subscription and preparation', async () => {
  const h = harness();
  await h.c.prepare(); await h.c.enable();
  await h.c.sendTest();
  assert.equal(h.calls.filter((c) => c === 'test').length, 1);
  assert.deepEqual(h.last().lastTest, { id: 'ntest-1', at: h.clock.now() });
  assert.match(h.last().message, /not that the device showed it/);
  h.c.clearStatus();
  assert.equal(h.last().lastTest, null); assert.equal(h.last().lastError, null); assert.equal(h.last().subscribed, true); assert.equal(h.last().stage, 'subscribed'); assert.equal(h.last().prepared, true);
  const h2 = harness({ testError: 'HTTP 503' });
  await h2.c.prepare(); await h2.c.enable(); await h2.c.sendTest();
  assert.match(h2.last().lastError!, /test push could not be queued/); assert.equal(h2.last().stage, 'subscribed', 'a failed test does not unsubscribe');
  h2.c.clearStatus();
  assert.equal(h2.last().lastError, null);
});

test('one operation at a time: a second click joins the first (one browser subscribe); stop() ends polling', async () => {
  const h = harness();
  await h.c.prepare();
  const a = h.c.enable(); const b = h.c.enable(); const d = h.c.disable();
  assert.equal(h.c.busy, true);
  await Promise.all([a, b, d]);
  assert.equal(h.pm.subscribeCalls, 1);
  assert.equal(h.last().subscribed, true, 'the disable() issued during enable() joined it instead of racing it');
  h.c.stop();
  h.clock.advance(60_000); await flush();
  assert.equal(h.calls.filter((c) => c === 'status').length, 1);
});

test('service worker messages and the opened-notification URL are parsed strictly', () => {
  assert.deepEqual(parseWorkerMessage({ type: 'kawk-push', id: 'n1', body: 'hi', foreground: true, duplicate: false, displayed: true }), { type: 'push', id: 'n1', text: 'hi', foreground: true, duplicate: false, displayed: true });
  assert.deepEqual(parseWorkerMessage({ type: 'kawk-push', id: 'n1' }), { type: 'push', id: 'n1', text: '', foreground: false, duplicate: false, displayed: true });
  assert.equal(parseWorkerMessage({ type: 'kawk-push', id: 'n1', displayed: false })!.type === 'push' && (parseWorkerMessage({ type: 'kawk-push', id: 'n1', displayed: false }) as { displayed: boolean }).displayed, false);
  assert.equal(parseWorkerMessage({ type: 'kawk-push' }), null);
  assert.deepEqual(parseWorkerMessage({ type: 'kawk-notification-open', id: 'n2', url: '/?notification=n2' }), { type: 'open', id: 'n2', url: '/?notification=n2' });
  assert.deepEqual(parseWorkerMessage({ type: 'kawk-notification-open', url: '//evil.example/' }), { type: 'open', id: null, url: null });
  assert.equal(parseWorkerMessage({ type: 'other' }), null); assert.equal(parseWorkerMessage('x'), null); assert.equal(parseWorkerMessage(null), null);
  assert.equal(notificationIdFromSearch('?notification=abc%2F1&x=2'), 'abc/1');
  assert.equal(notificationIdFromSearch('?x=2'), null);
  assert.equal(notificationIdFromSearch(''), null);
  assert.equal(notificationIdFromSearch(`?notification=${'a'.repeat(201)}`), null);
});

const flush = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise<void>((r) => setTimeout(r, 0)); };
