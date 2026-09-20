// Headless browser QA of the merged page against the isolated mock server (random port). Uses the
// Playwright already installed under ../agent/node_modules (read-only). No camera/mic: Start is never
// pressed; camera paths are covered by the Node tests. Prints a PASS/FAIL table and writes screenshots to
// /tmp/kawk-merged-ui-qa/. Exit code 1 on any failure.
// Web Push here is exercised with (a) a fake PushManager injected before page scripts (headless Chromium has no
// push service, so real subscribe() would fail) and (b) push events injected into the REAL registered service
// worker through CDP `ServiceWorker.deliverPushMessage`. This proves the page flow and the worker's handlers,
// not OS/Apple delivery.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createMockServer } from './mockServer.mjs';

const require = createRequire(import.meta.url);
const agentDir = resolve(fileURLToPath(new URL('../../../agent/', import.meta.url)));
const { chromium } = require(require.resolve('playwright', { paths: [agentDir] }));

const outDir = '/tmp/kawk-merged-ui-qa';
await mkdir(outDir, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = createMockServer();
const port = await mock.listen();
const base = `http://127.0.0.1:${port}`;
// Full Chromium (new headless) honours granted notification permission; the headless shell reports Notification.permission
// 'denied' regardless of the grant, which would make every push check fail for the wrong reason. Fall back with a notice.
let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chromium' }); }
catch (e) { console.log(`note: full Chromium channel unavailable (${e.message.split('\n')[0]}); using the headless shell — push permission checks may report denied`); browser = await chromium.launch({ headless: true }); }
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
await context.grantPermissions(['notifications'], { origin: base });
// Fake PushManager on the real registration: subscription persisted in localStorage so a reload sees it (re-sync path).
const FAKE_PUSH_MANAGER = `(() => {
  const store = () => JSON.parse(localStorage.getItem('qa-push-sub') || 'null');
  const save = (v) => localStorage.setItem('qa-push-sub', JSON.stringify(v));
  const mk = (rec) => ({ endpoint: rec.endpoint, options: { applicationServerKey: Uint8Array.from(rec.key).buffer },
    toJSON: () => ({ endpoint: rec.endpoint, keys: { p256dh: 'BFakeP256dhKey_' + 'x'.repeat(24), auth: 'fakeAuth12345678' } }),
    unsubscribe: async () => { save(null); window.__qaUnsubscribed = (window.__qaUnsubscribed || 0) + 1; return true; } });
  // Like a browser: subscribe() itself prompts (via Notification.requestPermission) and rejects with NotAllowedError when not granted.
  const pm = { getSubscription: async () => { const r = store(); return r ? mk(r) : null; },
    subscribe: (o) => { window.__qaSubscribeCalledSync = (window.__qaSubscribeCalledSync || 0) + 1; return (async () => {
      if (!o.userVisibleOnly) throw new Error('userVisibleOnly required');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { const e = new Error('Registration failed - permission denied'); e.name = 'NotAllowedError'; throw e; }
      const key = [...new Uint8Array(o.applicationServerKey)]; const rec = { endpoint: 'https://push.qa.invalid/sub/' + Math.random().toString(36).slice(2), key }; save(rec); window.__qaSubscribed = (window.__qaSubscribed || 0) + 1; return mk(rec); })(); } };
  Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => pm, configurable: true });
})();`;
await context.addInitScript(FAKE_PUSH_MANAGER);
const page = await context.newPage();
const qaLog = async () => (await (await fetch(`${base}/__qa/log`)).json()).log;
const qaPush = async () => (await (await fetch(`${base}/__qa/push`)).json());
const notificationsShown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ tag: n.tag, title: n.title, body: n.body, data: n.data })));
// The worker tells the page about a push BEFORE showNotification resolves; wait (bounded) for the banner list to satisfy `pred`.
const waitShown = async (pred, ms = 4000) => { let list = []; for (let t = 0; t < ms; t += 200) { list = await notificationsShown(); if (pred(list)) return list; await sleep(200); } return list; };
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => { const t = document.getElementById('agent-status')?.textContent ?? ''; return t.includes('connected') && t.includes('live updates on'); }, null, { timeout: 8000 });
  const status = await page.textContent('#agent-status');
  check('agent status line shows connection + live updates', /connected · running · 1 active turn\(s\) · 0 pending · live updates on/.test(status), status.trim());

  // notifications: GET returns n1; SSE replays n1 (dup) and adds n2 → exactly 2 rows
  await page.waitForFunction(() => document.querySelectorAll('#agent-notifications li:not(.empty)').length >= 2, null, { timeout: 5000 });
  await sleep(300);
  let rows = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((e) => e.querySelector('.text')?.textContent));
  check('initial GET + SSE deduped (n1 once, n2 once)', rows.length === 2 && rows.some((t) => t.includes('keys were last seen')) && rows.some((t) => t.includes('Still looking')), JSON.stringify(rows));
  const links = await page.$$eval('#agent-notifications li .refs a', (as) => as.map((a) => a.getAttribute('href')));
  const plain = await page.$$eval('#agent-notifications li .refs span', (ss) => ss.map((s) => s.textContent.trim()));
  check('artifact/capture refs are same-origin links; external ref is text', links.includes('/v1/artifacts/a1') && links.includes('/api/frames/cap_demo') && plain.some((t) => t.includes('example.invalid')) && plain.some((t) => t.includes('evidence event evt-1 r0')), `links=${JSON.stringify(links)} text=${JSON.stringify(plain)}`);

  // reconnect: server drops the SSE stream; browser reconnects; replay of n1+n2 must not duplicate; n3 appears once
  await fetch(`${base}/__qa/drop-sse`, { method: 'POST' });
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty) .text')].some((e) => e.textContent.includes('After reconnect')), null, { timeout: 8000 });
  await sleep(500);
  rows = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((e) => e.querySelector('.text')?.textContent));
  const qa = await (await fetch(`${base}/__qa/log`)).json();
  check('SSE reconnect: no repeated notifications, new one shown once', rows.length === 3 && new Set(rows).size === 3 && qa.sseConnections >= 2, `rows=${rows.length} sseConnections=${qa.sseConnections}`);
  const statusAfter = await page.textContent('#agent-status');
  check('duplicate deliveries counted, not rendered', /duplicate deliveries ignored [1-9]/.test(statusAfter), statusAfter.trim());

  // ack: local state flips only after {acked:true}
  const ackButton = page.locator('#agent-notifications li:not(.empty)').first().locator('button:has-text("Ack")');
  await ackButton.click();
  await page.waitForFunction(() => document.querySelector('#agent-notifications li.acked') !== null, null, { timeout: 4000 });
  const ackLog = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => /\/ack$/.test(l.path));
  check('ack posts to /api/agent/notifications/:id/ack and marks the row acked', ackLog.length === 1, JSON.stringify(ackLog.map((l) => l.path)));

  // tasks: active shows Cancel; cancel posts; terminal task shows result text
  const taskSummary = await page.textContent('#agent-tasks-summary');
  check('tasks summary counts active tasks', /Tasks \(2, 1 active\)/.test(taskSummary), taskSummary.trim());
  const cancelButtons = await page.$$('#agent-tasks button:has-text("Cancel")');
  check('only the active task has a Cancel button', cancelButtons.length === 1, `${cancelButtons.length} button(s)`);
  await cancelButtons[0].click();
  await page.waitForFunction(() => document.getElementById('agent-tasks-summary')?.textContent?.includes('0 active'), null, { timeout: 6000 });
  const cancelLog = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => /\/cancel$/.test(l.path));
  check('cancel posts to /api/agent/tasks/:id/cancel and the list refreshes', cancelLog.length === 1 && cancelLog[0].path === '/api/agent/tasks/t1/cancel', JSON.stringify(cancelLog.map((l) => l.path)));
  const taskText = await page.textContent('#agent-tasks');
  check('terminal task result text is shown', taskText.includes('Two meetings, coffee with Sam.'), '');

  // ask: camera stopped → no sessionId in the body; 202 → note
  await page.fill('#agent-input', 'where are my keys');
  await page.click('#agent-send');
  await page.waitForFunction(() => document.getElementById('agent-note')?.textContent?.includes('accepted as event'), null, { timeout: 5000 });
  const askLog = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => l.path === '/api/agent/ask');
  check('manual ask works with the camera stopped and omits sessionId', askLog.length === 1 && askLog[0].body.text === 'where are my keys' && !('sessionId' in askLog[0].body), JSON.stringify(askLog.map((l) => l.body)));
  check('input cleared after acceptance', (await page.inputValue('#agent-input')) === '', '');

  // search: keyword default, semantic optional; rows keep source image + candidate labels
  const modeDefault = await page.inputValue('#search-mode');
  check('search mode selector defaults to keyword', modeDefault === 'keyword', modeDefault);
  await page.fill('#search-query', 'keys');
  await page.click('#search-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('search-note')?.textContent?.includes('keyword mode'), null, { timeout: 5000 });
  let searchRows = await page.$$eval('#search-results li', (els) => els.map((e) => e.textContent));
  check('keyword search renders results with "keyword match", source image cite and candidate label', searchRows.length === 1 && /keyword match/.test(searchRows[0]) && /source image/.test(searchRows[0]) && /possible \(unconfirmed\)/.test(searchRows[0]), searchRows[0]?.slice(0, 160));
  await page.selectOption('#search-mode', 'semantic');
  await page.click('#search-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('search-note')?.textContent?.includes('semantic mode'), null, { timeout: 5000 });
  searchRows = await page.$$eval('#search-results li', (els) => els.map((e) => e.textContent));
  const searchLog = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => l.path === '/api/search').map((l) => l.body);
  check('search bodies carry mode (keyword then semantic) with the existing args', searchLog.length === 2 && searchLog[0].mode === 'keyword' && searchLog[1].mode === 'semantic' && searchLog[0].query === 'keys' && searchLog[0].limit === 10, JSON.stringify(searchLog));
  check('semantic rows show distance', /distance 0\.123/.test(searchRows[0] ?? ''), searchRows[0]?.slice(0, 120));

  // status rows: Agent capture row present and honest while idle; camera/mic/speech selectors still exist
  const statusText = await page.textContent('#status');
  check('Agent capture status row present (idle text)', /Agent capture/.test(statusText) && /polls GET \/api\/agent\/commands every 400 ms while running/.test(statusText), statusText.replace(/\s+/g, ' ').slice(0, 200));
  const selectors = await page.$$eval('#camera, #mic, #speech-backend', (els) => els.map((e) => e.id));
  check('camera / microphone / speech selectors preserved', selectors.join(',') === 'camera,mic,speech-backend', selectors.join(','));
  const speechDefault = await page.inputValue('#speech-backend');
  check('speech default follows config (local)', speechDefault === 'local', speechDefault);
  check('no token/key inputs in the page', (await page.$$('input[type=password], input[name*=token i], input[name*=key i]')).length === 0, '');

  // PWA: manifest + SW registered; API never intercepted by SW
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  check('manifest served with manifest MIME', manifest.ok && /manifest\+json/.test(manifest.headers.get('content-type')), manifest.headers.get('content-type'));
  const swState = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return { scope: reg.scope, active: Boolean(reg.active) }; });
  check('service worker registered and active', swState.active && swState.scope.endsWith('/'), JSON.stringify(swState));
  const pwaNote = await page.textContent('#pwa-note');
  check('PWA note is honest (API/media never cached; push/hardware not verified)', /never cached/.test(pwaNote) && /not verified/.test(pwaNote), pwaNote.trim());
  const reloadAt = Date.now();
  await page.reload({ waitUntil: 'load' }); // now under SW control (second page load: a second prepare() is expected)
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  const before = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => l.path === '/api/agent/status').length;
  await page.evaluate(() => fetch('/api/agent/status').then((r) => r.json()));
  const after = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => l.path === '/api/agent/status').length;
  check('under SW control, /api requests still reach the network (not cached)', controlled && after > before, `controlled=${controlled} before=${before} after=${after}`);
  const cacheKeys = await page.evaluate(async () => { const names = await caches.keys(); const out = []; for (const n of names) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname); return out; });
  check('cache holds only shell paths', cacheKeys.length > 0 && cacheKeys.every((p) => ['/', '/index.html', '/styles.css', '/client.js', '/manifest.webmanifest', '/icons/icon.svg'].includes(p)), JSON.stringify(cacheKeys));

  // ---- Web Push: page flow with the fake PushManager ----
  await page.waitForFunction(() => /notifications: ready/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 5000 });
  const pushIdle = await page.textContent('#push-status');
  const loadPushCalls = (await qaLog()).filter((l) => l.at >= reloadAt && l.path.startsWith('/api/agent/push/')).map((l) => `${l.method} ${l.path}`);
  check('load: prepare fetched the key once and cached the registration; Enable enabled; no subscribe/POST/prompt on load', /notifications: ready · permission granted/.test(pushIdle) && !(await page.isDisabled('#push-enable')) && loadPushCalls.join(',') === 'GET /api/agent/push/key' && (await page.evaluate(() => window.__qaSubscribeCalledSync || 0)) === 0, `${pushIdle.trim()} calls=${JSON.stringify(loadPushCalls)}`);
  const howTo = await page.textContent('#how-to');
  check('short how-to visible: Start = camera/mic, Agent box = questions/actions, Memory search = stored history', /Start/.test(howTo) && /Agent/.test(howTo) && /Memory search/.test(howTo) && howTo.length < 400, howTo.trim());
  const pipelineText = await page.textContent('#pipeline');
  check('server pipeline shows outcome counters (failed persist note, committed, accepted) and derived-memory source age, not just the queue', /failed 2 \(old failures persist until repaired; raw photos\/transcripts stay saved\) · committed 40 · accepted 43 · derived memory source 95\.0 s old/.test(pipelineText) && (await page.$eval('#pipeline', (e) => e.classList.contains('bad'))), pipelineText.slice(0, 200));
  check('push guidance explains the click requirement and that no token is needed', /No token is needed/.test(await page.textContent('#push-guidance')), (await page.textContent('#push-guidance')).trim());
  // The click: subscribe() must run inside the click handler's synchronous execution (Safari user-activation rule).
  const syncResult = await page.evaluate(() => { window.__qaSubscribeCalledSync = 0; document.getElementById('push-enable').click(); return { calledDuringClick: window.__qaSubscribeCalledSync }; });
  check('Enable click → pushManager.subscribe() called synchronously inside the click handler (no awaited work first)', syncResult.calledDuringClick === 1, JSON.stringify(syncResult));
  await page.waitForFunction(() => /notifications: subscribed/.test(document.getElementById('push-status')?.textContent ?? '') && !/working/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  let pushState = await qaPush();
  const pushCalls = (await qaLog()).filter((l) => l.at >= reloadAt && l.path.startsWith('/api/agent/push/')).map((l) => `${l.method} ${l.path}`);
  check('Enable: (key already cached) browser subscribe → POST subscription (endpoint + keys) recorded by the mock agent → status', pushCalls.join(',') === 'GET /api/agent/push/key,POST /api/agent/push/subscriptions,GET /api/agent/push/status' && pushState.subscriptions.length === 1 && pushState.subscriptions[0].endpoint.startsWith('https://push.qa.invalid/') && typeof pushState.subscriptions[0].keys.p256dh === 'string', `${JSON.stringify(pushCalls)} subs=${pushState.subscriptions.length}`);
  const subscribedKey = await page.evaluate(() => JSON.parse(localStorage.getItem('qa-push-sub')).key);
  check('browser subscription used the agent VAPID key (65 bytes, 0x04 prefix)', subscribedKey.length === 65 && subscribedKey[0] === 4, `len=${subscribedKey.length}`);
  check('after Enable: Disable + Send test push visible, Enable hidden, delivery counters shown', (await page.isHidden('#push-enable')) && (await page.isVisible('#push-disable')) && (await page.isVisible('#push-test')) && /1 device\(s\)/.test(await page.textContent('#push-delivery')), (await page.textContent('#push-delivery')).trim().slice(0, 160));

  // test push: queues a real notification on the agent; the mock also emits it over SSE like the real agent would
  await page.click('#push-test');
  await page.waitForFunction(() => /last test push-test-1 queued/.test(document.getElementById('push-delivery')?.textContent ?? ''), null, { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty) .text')].some((e) => e.textContent.includes('Test push 1')), null, { timeout: 6000 });
  const testRow = await page.$eval('#agent-notifications li:not(.empty)', (li) => ({ text: li.querySelector('.text')?.textContent, acked: li.classList.contains('acked'), meta: li.textContent }));
  check('Send test push: POST /api/agent/push/test once; the test answer arrives as a row via SSE and is NOT auto-acked (no push marker without a push event)', (await qaLog()).filter((l) => l.path === '/api/agent/push/test').length === 1 && testRow.text.includes('Test push 1') && !testRow.acked && !/push \d\d:/.test(testRow.meta), JSON.stringify(testRow).slice(0, 200));
  check('push status text never assumes delivery: "sent" = push service accepted, not OS display; iPhone test still required', /not that the device showed it/.test(await page.textContent('#push-status')) && /not proof the OS displayed it; background receipt needs a real iPhone test/.test(await page.textContent('#push-delivery')), '');

  // ---- Web Push: real service worker handlers via CDP push injection ----
  const cdp = await context.newCDPSession(page);
  const registrations = new Map();
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { for (const r of e.registrations) registrations.set(r.registrationId, r); });
  await cdp.send('ServiceWorker.enable');
  for (let i = 0; i < 40 && ![...registrations.values()].some((r) => r.scopeURL === `${base}/`); i += 1) await sleep(100);
  const registration = [...registrations.values()].find((r) => r.scopeURL === `${base}/`);
  check('CDP sees the registered service worker', Boolean(registration), registration ? registration.scopeURL : 'none');
  const deliver = (payload) => cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: registration.registrationId, data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const ackCountFor = async (id) => (await qaLog()).filter((l) => l.path === `/api/agent/notifications/${id}/ack`).length;
  const n2AcksBefore = await ackCountFor('n2');
  await deliver({ id: 'n2', title: 'KAWK', body: 'Still looking; I will check the latest photo.', url: '/' });
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty)')].some((li) => li.textContent.includes('Still looking') && /push \d\d:\d\d:\d\d/.test(li.textContent)), null, { timeout: 6000 });
  let shown = await waitShown((l) => l.some((n) => n.tag === 'kawk-notification:n2'));
  check('push event → ONE system notification with tag kawk-notification:n2 and same-origin data.url', shown.length === 1 && shown[0].tag === 'kawk-notification:n2' && shown[0].body.includes('Still looking') && shown[0].data.url === `${base}/`, JSON.stringify(shown));
  const focusState = await page.evaluate(() => ({ visible: document.visibilityState, focus: document.hasFocus() }));
  await sleep(500);
  const n2Row = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((li) => li.textContent).find((t) => t.includes('Still looking')));
  const n2Acked = (await ackCountFor('n2')) > n2AcksBefore;
  check(`push delivered while the page is visible+focused (${JSON.stringify(focusState)}) → row shows the push marker; foreground display acknowledges it`, /push \d\d:/.test(n2Row) && n2Acked && /acked \(displayed in the foreground via push\)/.test(n2Row), `${n2Row?.slice(0, 220)} | acks=${await ackCountFor('n2')}`);
  await deliver({ id: 'n2', title: 'KAWK', body: 'Still looking; I will check the latest photo.', url: '/' });
  await sleep(700);
  shown = await notificationsShown();
  check('same notification id pushed again → showNotification ran again but replaced the banner (same tag, renotify:false): still one notification, no second ack', shown.length === 1 && shown[0].tag === 'kawk-notification:n2' && (await ackCountFor('n2')) === n2AcksBefore + 1, `shown=${JSON.stringify(shown.map((n) => n.tag))}`);
  await deliver('this is not json');
  shown = await waitShown((l) => l.some((n) => n.tag === 'kawk-notification:unreadable'));
  check('unreadable push payload → honest generic banner (tag …:unreadable), no invented content', shown.some((n) => n.tag === 'kawk-notification:unreadable' && /not readable/.test(n.body)), JSON.stringify(shown.map((n) => n.tag)));
  await deliver({ id: 'evil', title: 'x', body: 'y', url: 'https://evil.example/steal' });
  shown = await waitShown((l) => l.some((n) => n.tag === 'kawk-notification:evil'));
  const evil = shown.find((n) => n.tag === 'kawk-notification:evil');
  check('cross-origin url in a push payload is replaced by our root', Boolean(evil) && evil.data.url === `${base}/`, JSON.stringify(evil?.data));
  const pushRows = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((e) => e.querySelector('.text')?.textContent));
  check('a push for an id not yet seen over SSE renders once as a row; no duplicate rows overall', pushRows.filter((t) => t === 'y').length === 1 && new Set(pushRows).size === pushRows.length, JSON.stringify(pushRows));
  const cachedAfterPush = await page.evaluate(async () => { const names = await caches.keys(); const out = []; for (const n of names) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname); return out; });
  check('push endpoints never entered the cache', cachedAfterPush.every((p) => !p.startsWith('/api/')), JSON.stringify(cachedAfterPush));

  // ---- opened from a notification: ?notification=<id> acks + highlights; existing browser subscription re-syncs on load ----
  const n1AcksBefore = await ackCountFor('n1');
  const subPostsBefore = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length;
  await page.goto(`${base}/?notification=n1`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#agent-notifications li.opened') !== null, null, { timeout: 8000 });
  await page.waitForFunction(() => /notifications: subscribed/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  const openedRow = await page.$eval('#agent-notifications li.opened', (li) => li.textContent);
  check('?notification=n1 → row highlighted, acked with reason "opened from notification", URL stripped', openedRow.includes('keys were last seen') && /opened from notification/.test(openedRow) && /acked \(opened from notification\)/.test(openedRow) && (await ackCountFor('n1')) === n1AcksBefore + 1 && !page.url().includes('notification='), `${openedRow.slice(0, 160)} url=${page.url()}`);
  const subPostsAfter = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length;
  check('reload with an existing browser subscription re-syncs it to the agent (no permission prompt, no new subscribe)', subPostsAfter === subPostsBefore + 1 && /re-synced/.test(await page.textContent('#push-status')) && (await page.evaluate(() => window.__qaSubscribed || 0)) === 0, (await page.textContent('#push-status')).trim().slice(0, 160));

  // ---- disable ----
  await page.click('#push-disable');
  await page.waitForFunction(() => /notifications: ready/.test(document.getElementById('push-status')?.textContent ?? '') && /disabled on this device/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 6000 });
  pushState = await qaPush();
  const del = (await qaLog()).filter((l) => l.method === 'DELETE' && l.path === '/api/agent/push/subscriptions');
  check('Disable: browser unsubscribed, DELETE {endpoint} sent, mock agent has 0 subscriptions, Enable visible again', del.length === 1 && typeof del[0].body.endpoint === 'string' && pushState.subscriptions.length === 0 && (await page.evaluate(() => window.__qaUnsubscribed || 0)) === 1 && (await page.isVisible('#push-enable')) && (await page.isHidden('#push-disable')), `del=${JSON.stringify(del.map((l) => l.body))} subs=${pushState.subscriptions.length}`);
  await page.click('#push-clear');
  check('Clear status resets the line without touching subscription/preparation state', /notifications: ready · permission granted · ready: press Enable notifications/.test(await page.textContent('#push-status')) && !(await page.isDisabled('#push-enable')), (await page.textContent('#push-status')).trim());

  // ---- permission not granted (separate context, no grant) and agent without push (503) ----
  const deniedCtx = await browser.newContext({ serviceWorkers: 'allow' });
  await deniedCtx.addInitScript(FAKE_PUSH_MANAGER);
  const deniedPage = await deniedCtx.newPage();
  await deniedPage.goto(`${base}/`, { waitUntil: 'load' });
  await deniedPage.waitForFunction(() => /notifications: (ready|denied)/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 6000 });
  const deniedBefore = await deniedPage.evaluate(() => Notification.permission);
  if (!(await deniedPage.isDisabled('#push-enable'))) await deniedPage.click('#push-enable');
  await deniedPage.waitForFunction(() => !/working/.test(document.getElementById('push-status')?.textContent ?? '') && !/checking/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  const deniedStatus = await deniedPage.textContent('#push-status');
  const deniedGuidance = await deniedPage.textContent('#push-guidance');
  const deniedSubs = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length;
  check(`permission not granted (browser permission was "${deniedBefore}") → subscribe() was the prompt, rejected → denied/not-granted state with settings guidance; nothing recorded on the agent`, /permission (denied|default)/.test(deniedStatus) && /(denied|not granted)/.test(deniedStatus) && deniedSubs === subPostsAfter && (await deniedPage.evaluate(() => window.__qaSubscribed || 0)) === 0 && (/blocked/.test(deniedGuidance) || /permission/.test(deniedGuidance)), `${deniedStatus.trim().slice(0, 140)} | ${deniedGuidance.trim().slice(0, 100)}`);
  await deniedCtx.close();
  const mock2 = createMockServer({ pushConfigured: false });
  const port2 = await mock2.listen();
  const base2 = `http://127.0.0.1:${port2}`;
  const noPushCtx = await browser.newContext({ serviceWorkers: 'allow' });
  await noPushCtx.grantPermissions(['notifications'], { origin: base2 });
  await noPushCtx.addInitScript(FAKE_PUSH_MANAGER);
  const noPushPage = await noPushCtx.newPage();
  await noPushPage.goto(`${base2}/`, { waitUntil: 'load' });
  await noPushPage.waitForFunction(() => /notifications: not-ready/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  check('agent without push (503 on key) → setup fails visibly ("not configured on the agent"), Enable disabled, Retry push setup offered, browser never subscribed', /not configured on the agent/.test(await noPushPage.textContent('#push-status')) && (await noPushPage.isDisabled('#push-enable')) && (await noPushPage.isVisible('#push-prepare')) && (await noPushPage.evaluate(() => (window.__qaSubscribed || 0) + (window.__qaSubscribeCalledSync || 0))) === 0, (await noPushPage.textContent('#push-status')).trim().slice(0, 160));
  await noPushPage.click('#push-prepare');
  await noPushPage.waitForFunction(() => !/preparing/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  check('Retry push setup re-runs prepare (second key GET) and stays honest while the agent still answers 503', (await (await fetch(`${base2}/__qa/log`)).json()).log.filter((l) => l.path === '/api/agent/push/key').length === 2 && /not configured on the agent/.test(await noPushPage.textContent('#push-status')), '');
  await noPushCtx.close(); await mock2.close();

  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => /notifications: (ready|subscribed)/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 6000 });

  await page.screenshot({ path: `${outDir}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  await page.screenshot({ path: `${outDir}/mobile.png`, fullPage: true });
  check('screenshots written', true, outDir);
  check('no console/page errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
} catch (e) {
  check('QA driver completed', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await browser.close();
  await mock.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
