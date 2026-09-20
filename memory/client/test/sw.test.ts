// public/sw.js executed in a Node vm sandbox with fake ServiceWorker globals: push payload validation, one
// notification per id, same-origin navigation on click, focus-existing-window vs openWindow, and the rule that
// private routes are never intercepted. No browser; the real worker file is loaded verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://kawk.local';
const source = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');

interface Shown { title: string; options: Record<string, unknown>; closed: boolean }
interface FakeWindow { url: string; visibilityState: string; focused: boolean; focusCalls: number; messages: unknown[]; focus(): Promise<FakeWindow>; postMessage(m: unknown): void }
/** vm-realm objects are not reference-equal to ours; compare their JSON shape. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const win = (over: Partial<FakeWindow> = {}): FakeWindow => {
  const w: FakeWindow = { url: `${ORIGIN}/`, visibilityState: 'visible', focused: true, focusCalls: 0, messages: [],
    async focus() { w.focusCalls += 1; return w; }, postMessage(m) { w.messages.push(m); }, ...over };
  return w;
};

function loadWorker() {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const shown: Shown[] = [];
  const showCalls: { title: string; options: Record<string, unknown> }[] = [];
  let rejectNextShow: string | null = null;
  const opened: string[] = [];
  const windows: FakeWindow[] = [];
  const registration = {
    // Like a browser: a new notification with the tag of a still-open one REPLACES it (no second banner).
    async showNotification(title: string, options: Record<string, unknown>) {
      showCalls.push({ title, options });
      if (rejectNextShow) { const m = rejectNextShow; rejectNextShow = null; throw new Error(m); }
      const idx = shown.findIndex((s) => !s.closed && s.options.tag === options.tag);
      if (idx >= 0) shown[idx] = { title, options, closed: false }; else shown.push({ title, options, closed: false });
    },
    async getNotifications(filter: { tag?: string } = {}) { return shown.filter((s) => !s.closed && (!filter.tag || s.options.tag === filter.tag)).map((s) => ({ tag: s.options.tag, close: () => { s.closed = true; } })); },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`), registration,
    clients: { async matchAll() { return windows; }, async openWindow(url: string) { opened.push(url); return null; }, async claim() {} },
    addEventListener(type: string, fn: (ev: unknown) => void) { (listeners.get(type) ?? listeners.set(type, []).get(type)!).push(fn); },
    async skipWaiting() {},
  };
  const caches = { async open() { return { async addAll() {}, async put() {} }; }, async keys() { return []; }, async match() { return undefined; } };
  const sandbox = { self, caches, URL, Response: class { constructor(public body: unknown, public init: unknown) {} }, fetch: async () => { throw new Error('offline'); }, Date, Map, console, Array, Error, String, Object, Promise };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'sw.js' });
  const dispatch = async (type: string, ev: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    const event = { ...ev, waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    for (const fn of listeners.get(type) ?? []) fn(event);
    await Promise.all(waits);
    return event;
  };
  const pushData = (payload: unknown, asText = false) => ({ json() { if (asText) throw new SyntaxError('Unexpected token'); return payload; }, text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); } });
  return { listeners, shown, showCalls, opened, windows, dispatch, pushData, rejectNextShow: (m: string) => { rejectNextShow = m; } };
}

test('push: every push shows a notification (WebKit rule); a repeated id replaces the banner via the same tag with renotify:false — one identity, no second alert', async () => {
  const w = loadWorker();
  const page = win(); const hidden = win({ visibilityState: 'hidden', focused: false }); const other = win({ url: 'https://other.example/' });
  w.windows.push(page, hidden, other);
  await w.dispatch('push', { data: w.pushData({ id: 'n1', title: 'KAWK', body: 'Keys were on the desk at 21:46.', url: '/' }) });
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0]!.title, 'KAWK');
  assert.equal(w.shown[0]!.options.tag, 'kawk-notification:n1');
  assert.equal(w.shown[0]!.options.renotify, false);
  assert.deepEqual(plain(w.shown[0]!.options.data), { id: 'n1', url: `${ORIGIN}/` });
  assert.equal(page.messages.length, 1); assert.equal(hidden.messages.length, 1); assert.equal(other.messages.length, 0, 'foreign-origin windows get nothing');
  assert.deepEqual(plain(page.messages[0]), { type: 'kawk-push', id: 'n1', title: 'KAWK', body: 'Keys were on the desk at 21:46.', url: `${ORIGIN}/`, foreground: true, duplicate: false, displayed: true });
  // the backend re-pushes the same notification (retry / second subscription): showNotification IS called again (never a
  // silent return), with the same tag and renotify:false → the banner is replaced, no new notification identity
  await w.dispatch('push', { data: w.pushData({ id: 'n1', title: 'KAWK', body: 'Keys were on the desk at 21:46 (updated).', url: '/' }) });
  assert.equal(w.showCalls.length, 2, 'display attempted for every push');
  assert.equal(w.shown.length, 1, 'still one banner'); assert.equal(w.shown[0]!.options.body, 'Keys were on the desk at 21:46 (updated).'); assert.equal(w.shown[0]!.options.tag, 'kawk-notification:n1'); assert.equal(w.showCalls[1]!.options.renotify, false);
  assert.equal((page.messages[1] as { duplicate: boolean }).duplicate, true, 'the page is told it was a repeat');
  // after the user closed the banner a re-push shows again (WebKit needs a visible result); the page still hears duplicate:true
  w.shown[0]!.closed = true;
  await w.dispatch('push', { data: w.pushData({ id: 'n1', body: 'again' }) });
  assert.equal(w.showCalls.length, 3); assert.equal(w.shown.filter((x) => !x.closed).length, 1); assert.equal(w.shown.filter((x) => !x.closed)[0]!.options.tag, 'kawk-notification:n1');
  assert.equal((page.messages[2] as { duplicate: boolean }).duplicate, true);
  w.shown.length = 0;
  await w.dispatch('push', { data: w.pushData({ id: 'n1', body: 'again' }) });
  // a different id is a new notification; foreground false when no window is visible+focused
  page.focused = false;
  await w.dispatch('push', { data: w.pushData({ id: 'n2', body: 'second' }) });
  assert.equal(w.shown.length, 2); assert.equal(w.shown[1]!.options.tag, 'kawk-notification:n2');
  assert.equal((page.messages.at(-1) as { foreground: boolean }).foreground, false);
});

test('push: windows are messaged only after the display settled; a rejected showNotification does not mark the id, is reported, and the next push shows as a first display', async () => {
  const w = loadWorker();
  const page = win(); w.windows.push(page);
  w.rejectNextShow('showNotification refused by the OS');
  await assert.rejects(w.dispatch('push', { data: w.pushData({ id: 'r1', body: 'first try' }) }), /refused by the OS/);
  assert.equal(w.shown.length, 0);
  assert.equal((page.messages[0] as { displayed: boolean }).displayed, false, 'the page is told the banner could not be shown');
  await w.dispatch('push', { data: w.pushData({ id: 'r1', body: 'second try' }) });
  assert.equal(w.shown.length, 1); assert.equal(w.shown[0]!.options.body, 'second try');
  assert.equal((page.messages[1] as { duplicate: boolean }).duplicate, false, 'a display that never happened is not a duplicate');
  await w.dispatch('push', { data: w.pushData({ id: 'r1', body: 'third' }) });
  assert.equal((page.messages[2] as { duplicate: boolean }).duplicate, true);
  assert.equal(w.showCalls.length, 3);
});

test('push: payload validation — unreadable/invalid payloads become an honest generic banner; urls are forced same-origin; text is bounded', async () => {
  const w = loadWorker();
  await w.dispatch('push', { data: w.pushData('not json', true) });
  assert.equal(w.shown.length, 1); assert.equal(w.shown[0]!.options.tag, 'kawk-notification:unreadable'); assert.match(String(w.shown[0]!.options.body), /not readable/);
  assert.equal((w.shown[0]!.options.data as { unreadable: boolean }).unreadable, true);
  await w.dispatch('push', { data: w.pushData({ title: 'no id', body: 'x' }) });
  assert.equal(w.shown.length, 1, 'no-id payload reuses the unreadable tag (same banner replaced, not a second one)');
  await w.dispatch('push', { data: w.pushData(['array']) }); await w.dispatch('push', { data: null });
  assert.equal(w.shown.length, 1);
  await w.dispatch('push', { data: w.pushData({ id: 'x1', title: 'T\u0007itle', body: `${'b'.repeat(2500)}\u0000`, url: 'https://evil.example/steal' }) });
  const s = w.shown.at(-1)!;
  assert.equal(s.title, 'T itle'); assert.equal(String(s.options.body).length, 2000);
  assert.deepEqual(plain(s.options.data), { id: 'x1', url: `${ORIGIN}/` }, 'cross-origin url replaced by our root');
  await w.dispatch('push', { data: w.pushData({ id: 'x2', url: '/api/frames/cap1' }) });
  assert.equal((w.shown.at(-1)!.options.data as { url: string }).url, `${ORIGIN}/api/frames/cap1`, 'same-origin relative url kept');
  await w.dispatch('push', { data: w.pushData({ id: 'x3', url: '//evil.example/x' }) });
  assert.equal((w.shown.at(-1)!.options.data as { url: string }).url, `${ORIGIN}/`, 'protocol-relative url is another origin');
  const before = w.shown.length;
  await w.dispatch('push', { data: w.pushData({ id: 42 }) });
  assert.equal(w.shown.length, before, 'non-string id: the open unreadable banner is replaced, nothing new appears');
  assert.ok(!w.shown.some((x) => String(x.options.tag).includes('42')), 'non-string id never becomes a tag');
});

test('notificationclick: focuses an existing KAWK window and posts the open message (no reload); otherwise opens the same-origin root with the id', async () => {
  const w = loadWorker();
  let closed = 0;
  const notification = { data: { id: 'n1', url: `${ORIGIN}/` }, close: () => { closed += 1; } };
  const hidden = win({ visibilityState: 'hidden', focused: false }); const front = win(); const foreign = win({ url: 'https://other.example/' });
  w.windows.push(foreign, hidden, front);
  await w.dispatch('notificationclick', { notification });
  assert.equal(closed, 1);
  assert.equal(front.focusCalls, 1); assert.equal(hidden.focusCalls, 0); assert.equal(foreign.focusCalls, 0);
  assert.deepEqual(plain(front.messages), [{ type: 'kawk-notification-open', id: 'n1', url: '/?notification=n1' }]);
  assert.deepEqual(w.opened, [], 'no new window while one exists');
  // only a hidden window: it is focused rather than opening a second one
  w.windows.length = 0; w.windows.push(hidden);
  await w.dispatch('notificationclick', { notification });
  assert.equal(hidden.focusCalls, 1); assert.deepEqual(w.opened, []);
  // no window at all → openWindow on our origin with the id; a foreign url in the data never leaks into navigation
  w.windows.length = 0;
  await w.dispatch('notificationclick', { notification: { data: { id: 'n2', url: 'https://evil.example/' }, close() {} } });
  assert.deepEqual(w.opened, [`${ORIGIN}/?notification=n2`]);
  await w.dispatch('notificationclick', { notification: { data: {}, close() {} } });
  assert.equal(w.opened.at(-1), `${ORIGIN}/`, 'unreadable banner opens the plain root');
  await w.dispatch('notificationclick', { notification: { data: { id: 'n3', url: '/api/frames/abc?x=1' }, close() {} } });
  assert.equal(w.opened.at(-1), `${ORIGIN}/api/frames/abc?x=1&notification=n3`);
});

test('fetch: private routes and the worker file itself are never intercepted; shell paths are', async () => {
  const w = loadWorker();
  const handled = (path: string, method = 'GET') => {
    let responded = false;
    const ev = { request: { url: `${ORIGIN}${path}`, method, mode: 'cors' }, respondWith: () => { responded = true; } };
    for (const fn of w.listeners.get('fetch') ?? []) fn(ev);
    return responded;
  };
  for (const p of ['/api/agent/push/key', '/api/agent/events', '/api/frames/cap1', '/ws/faces', '/v1/artifacts/a1', '/static/speech-worklet.js', '/sw.js', '/unknown.txt']) assert.equal(handled(p), false, p);
  assert.equal(handled('/api/agent/push/subscriptions', 'POST'), false);
  for (const p of ['/', '/index.html', '/styles.css', '/client.js', '/manifest.webmanifest', '/icons/icon.svg']) assert.equal(handled(p), true, p);
  let responded = false;
  for (const fn of w.listeners.get('fetch') ?? []) fn({ request: { url: 'https://other.example/styles.css', method: 'GET' }, respondWith: () => { responded = true; } });
  assert.equal(responded, false, 'foreign origins untouched');
});
