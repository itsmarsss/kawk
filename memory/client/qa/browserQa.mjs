// Headless browser QA of the merged page against the isolated mock server (random port). Uses the Playwright already
// installed under ../agent/node_modules (read-only). Prints a PASS/FAIL table, writes screenshots to
// /tmp/kawk-merged-ui-qa/ and exits 1 on any failure. Nothing here touches the live service, its data or the gallery.
//
// Coverage: Live / Memory / Debug navigation (with a REAL Start on Chromium's fake camera + microphone: the Run keeps
// posting captures while other views are shown), the memory browser (browse-all default, per-category paging past the
// old recent-30/recent-100 limits, literal text / date / category / entity-kind filters, history toggle, stale
// responses, per-category errors + Retry, empty state, source drilldown, escaping), the manual agent form under Debug,
// agent feed dedupe/ack/tasks, indexed search, PWA shell + icons, and Web Push (fake PushManager + CDP-injected push
// events into the real service worker). None of this proves phone hardware, Continuity Camera or OS banners.
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
const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chromium', args: MEDIA_ARGS }); }
catch (e) { console.log(`note: full Chromium channel unavailable (${e.message.split('\n')[0]}); using the headless shell — push permission checks may report denied`); browser = await chromium.launch({ headless: true, args: MEDIA_ARGS }); }
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow', permissions: ['camera', 'microphone'] });
await context.grantPermissions(['notifications', 'camera', 'microphone'], { origin: base });
const FAKE_PUSH_MANAGER = `(() => {
  const store = () => JSON.parse(localStorage.getItem('qa-push-sub') || 'null');
  const save = (v) => localStorage.setItem('qa-push-sub', JSON.stringify(v));
  const mk = (rec) => ({ endpoint: rec.endpoint, options: { applicationServerKey: Uint8Array.from(rec.key).buffer },
    toJSON: () => ({ endpoint: rec.endpoint, keys: { p256dh: 'BFakeP256dhKey_' + 'x'.repeat(24), auth: 'fakeAuth12345678' } }),
    unsubscribe: async () => { save(null); window.__qaUnsubscribed = (window.__qaUnsubscribed || 0) + 1; return true; } });
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
const browseLog = async () => (await (await fetch(`${base}/__qa/browse-log`)).json()).browseLog;
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const notificationsShown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ tag: n.tag, title: n.title, body: n.body, data: n.data })));
const waitShown = async (pred, ms = 4000) => { let list = []; for (let t = 0; t < ms; t += 200) { list = await notificationsShown(); if (pred(list)) return list; await sleep(200); } return list; };
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const viewState = () => page.evaluate(() => ({
  live: { hidden: document.getElementById('view-live').hidden, offstage: document.getElementById('view-live').classList.contains('offstage'), inert: document.getElementById('view-live').hasAttribute('inert') },
  memory: { hidden: document.getElementById('view-memory').hidden }, debug: { hidden: document.getElementById('view-debug').hidden },
  selected: [...document.querySelectorAll('.nav [role=tab]')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.id), hash: location.hash,
  videoDisplay: getComputedStyle(document.getElementById('video')).display,
}));
const cards = () => page.$$eval('#browse-list li.card', (els) => els.map((e) => ({ kind: e.querySelector('.kind')?.textContent, title: e.querySelector('.title')?.textContent, text: e.querySelector('.text')?.textContent ?? '', status: e.querySelector('.status')?.textContent ?? '', superseded: e.classList.contains('superseded'), when: e.querySelector('.when')?.textContent ?? '' })));
const browseNote = () => page.textContent('#browse-note');
const waitBrowseIdle = () => page.waitForFunction(() => { const t = document.getElementById('browse-note')?.textContent ?? ''; return !/loading/.test(t) && t !== 'open this view to load memory'; }, null, { timeout: 10000 });
const localInput = (ms) => { const d = new Date(ms); const two = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`; };
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

try {
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => { const t = document.getElementById('agent-status')?.textContent ?? ''; return t.includes('connected') && t.includes('live updates on'); }, null, { timeout: 8000 });

  // ---- shell: Live is the landing view; nothing recorded on load ----
  let vs = await viewState();
  check('landing view is Live (Memory/Debug hidden, Live shown, hash untouched)', !vs.live.hidden && !vs.live.offstage && vs.memory.hidden && vs.debug.hidden && vs.selected.join() === 'nav-live', JSON.stringify(vs));
  const howTo = await page.textContent('#how-to');
  check('how-to: three timestamped streams are saved, no wake word, nothing to send, Jev decides when assistance is useful; no “worth remembering” gating', /Start/.test(howTo) && /three timestamped streams are saved/.test(howTo) && /no wake word/.test(howTo) && /nothing to send/.test(howTo) && /assistance is useful/.test(howTo) && !/worth remembering/.test(howTo) && /Memory/.test(howTo) && howTo.length < 560, howTo.trim().slice(0, 160));
  check('no Send button or manual form inside Live', (await page.$$('#view-live #agent-form, #view-live #agent-send')).length === 0 && (await page.$('#view-debug #agent-form')) !== null, '');
  const badge = await page.textContent('#live-badge');
  check('header badge says not recording before Start', /not recording/.test(badge), badge);
  const summaryText = (await page.textContent('#live-summary')).replace(/\s+/g, ' ');
  check('Now block: recording off, memory age from the dashboard, agent connection, last update', /off — press Start/.test(summaryText) && /newest memory 95\.0 s old/.test(summaryText) && /2 failed \(retained; retry needed\)/.test(summaryText) && !/retried later/.test(summaryText) && /connected/.test(summaryText) && /keys were last seen/.test(summaryText), summaryText.slice(0, 260));
  const sessionsOnLoad = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/sessions').length;
  check('page load created no session and posted nothing but agent reads', sessionsOnLoad === 0 && (await qaLog()).every((l) => l.method === 'GET' || l.path === '/api/agent/push/subscriptions'), '');

  // ---- agent feed in Live: GET + SSE dedupe, reconnect, ack, tasks (unchanged behaviour) ----
  await page.waitForFunction(() => document.querySelectorAll('#agent-notifications li:not(.empty)').length >= 2, null, { timeout: 5000 });
  await sleep(300);
  let rows = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((e) => e.querySelector('.text')?.textContent));
  check('updates: initial GET + SSE deduped (n1 once, n2 once)', rows.length === 2 && rows.some((t) => t.includes('keys were last seen')) && rows.some((t) => t.includes('Still looking')), JSON.stringify(rows));
  const links = await page.$$eval('#agent-notifications li .refs a', (as) => as.map((a) => a.getAttribute('href')));
  const plain = await page.$$eval('#agent-notifications li .refs span', (ss) => ss.map((s) => s.textContent.trim()));
  check('artifact/capture refs are same-origin links; external ref is text', links.includes('/v1/artifacts/a1') && links.includes('/api/frames/cap_demo') && plain.some((t) => t.includes('example.invalid')) && plain.some((t) => t.includes('evidence event evt-1 r0')), `links=${JSON.stringify(links)}`);
  await post('/__qa/drop-sse');
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty) .text')].some((e) => e.textContent.includes('After reconnect')), null, { timeout: 8000 });
  await sleep(500);
  rows = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((e) => e.querySelector('.text')?.textContent));
  const qa = await (await fetch(`${base}/__qa/log`)).json();
  check('SSE reconnect: no repeated updates, new one shown once', rows.length === 3 && new Set(rows).size === 3 && qa.sseConnections >= 2, `rows=${rows.length} sseConnections=${qa.sseConnections}`);
  check('duplicate deliveries counted, not rendered', /duplicate deliveries ignored [1-9]/.test(await page.textContent('#agent-status')), '');
  await page.locator('#agent-notifications li:not(.empty)').first().locator('button:has-text("Ack")').click();
  await page.waitForFunction(() => document.querySelector('#agent-notifications li.acked') !== null, null, { timeout: 4000 });
  check('ack posts once and marks the row acked', (await qaLog()).filter((l) => /\/ack$/.test(l.path)).length === 1, '');
  check('tasks summary counts active tasks; the Tasks list is collapsed by default so completed work does not dominate Live', /Tasks \(2, 1 active\)/.test(await page.textContent('#agent-tasks-summary')) && !(await page.$eval('#view-live .agent-tasks-details', (d) => d.open)), '');
  await page.click('#view-live .agent-tasks-details > summary');
  const taskView = await page.evaluate(() => { const li = [...document.querySelectorAll('#agent-tasks li')].find((x) => x.textContent.includes('summarize the morning')); const diag = li?.querySelector('details.diag'); return { visible: li?.innerText ?? '', diagOpen: diag?.open ?? null, diagText: diag?.querySelector('pre')?.textContent ?? '' }; });
  check('JSON-encoded task result: Live shows the answer text only; refs/confidence stay behind a closed diagnostic expansion', /Two meetings, coffee with Sam\./.test(taskView.visible) && !/0\.92|evt-7|reviewRejected|\{/.test(taskView.visible) && taskView.diagOpen === false && /"confidence": 0.92/.test(taskView.diagText) && /evt-7/.test(taskView.diagText), taskView.visible.replace(/\s+/g, ' ').slice(0, 160));
  const cancelButtons = await page.$$('#agent-tasks button:has-text("Cancel")');
  check('only the active task has a Cancel button', cancelButtons.length === 1, `${cancelButtons.length}`);
  await cancelButtons[0].click();
  await page.waitForFunction(() => document.getElementById('agent-tasks-summary')?.textContent?.includes('0 active'), null, { timeout: 6000 });
  check('cancel posts to /api/agent/tasks/:id/cancel and the list refreshes', (await qaLog()).filter((l) => /\/cancel$/.test(l.path)).map((l) => l.path).join() === '/api/agent/tasks/t1/cancel', '');
  check('terminal task answer text is shown', (await page.textContent('#agent-tasks')).includes('Two meetings, coffee with Sam.'), '');

  // ---- Debug view: manual form (camera stopped → no sessionId), status rows, selectors preserved ----
  await page.click('#nav-debug');
  vs = await viewState();
  check('Debug view: Live goes off-stage (painted, inert, never display:none); hash #debug', vs.live.offstage && !vs.live.hidden && vs.live.inert && vs.videoDisplay !== 'none' && !vs.debug.hidden && vs.memory.hidden && vs.hash === '#debug', JSON.stringify(vs));
  check('manual form is labelled as debug-only manual operation', /Manual operation/.test(await page.textContent('#view-debug h2')) && /Debug only/.test(await page.textContent('#view-debug')), '');
  await page.fill('#agent-input', 'where are my keys');
  await page.click('#agent-send');
  await page.waitForFunction(() => document.getElementById('agent-note')?.textContent?.includes('accepted as event'), null, { timeout: 5000 });
  const askLog = (await qaLog()).filter((l) => l.path === '/api/agent/ask');
  check('manual ask works with the camera stopped and omits sessionId', askLog.length === 1 && askLog[0].body.text === 'where are my keys' && !('sessionId' in askLog[0].body) && (await page.inputValue('#agent-input')) === '', JSON.stringify(askLog.map((l) => l.body)));
  const statusText = await page.textContent('#status');
  check('component status rows present under Debug (Agent capture idle text)', /Agent capture/.test(statusText) && /polls GET \/api\/agent\/commands every 400 ms while running/.test(statusText), '');
  const pipelineText = await page.textContent('#pipeline');
  check('server pipeline shows outcome counters and derived-memory age', /failed 2 \(old failures persist until repaired; raw photos\/transcripts stay saved\) · committed 40 · accepted 43 · derived memory source 95\.0 s old/.test(pipelineText) && (await page.$eval('#pipeline', (e) => e.classList.contains('bad'))), pipelineText.slice(0, 120));
  check('camera / microphone / speech selectors preserved in Live; speech default local', (await page.$$eval('#view-live #camera, #view-live #mic, #view-live #speech-backend', (els) => els.map((e) => e.id))).join(',') === 'camera,mic,speech-backend' && (await page.inputValue('#speech-backend')) === 'local', '');
  check('no token/key inputs in the page', (await page.$$('input[type=password], input[name*=token i], input[name*=key i]')).length === 0, '');

  // ---- a REAL Start on the fake camera/microphone, then navigate: the Run must keep capturing ----
  await page.click('#nav-live');
  await page.evaluate(() => { window.__qaVideo = document.getElementById('video'); window.__qaLoadMarker = 1; });
  await page.click('#start');
  let started = false;
  try { await page.waitForFunction(() => /recording since/.test(document.getElementById('live-badge')?.textContent ?? ''), null, { timeout: 15000 }); started = true; } catch { /* fake devices unavailable in this Chromium */ }
  const startStatus = (await page.textContent('#status')).replace(/\s+/g, ' ');
  check('Start reaches running on the fake camera (session created, photos begin)', started && (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/sessions').length === 1, started ? '' : startStatus.slice(0, 300));
  if (started) {
    await page.waitForFunction(() => /Recording[\s\S]*running/.test(document.getElementById('live-summary')?.textContent ?? ''), null, { timeout: 5000 });
    const capturesBefore = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/captures').length;
    await page.click('#nav-memory');
    await waitBrowseIdle();
    await sleep(6500); // more than one 5 s tick while Memory is shown
    await page.click('#nav-debug');
    await sleep(5500); // and one more while Debug is shown
    const capturesAfter = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/captures').length;
    const still = await page.evaluate(() => ({ badge: document.getElementById('live-badge')?.textContent, sameVideo: window.__qaVideo === document.getElementById('video') && Boolean(document.getElementById('video').srcObject), marker: window.__qaLoadMarker, sessions: null }));
    const sessions = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/sessions').length;
    check(`capture keeps running while Memory and Debug are shown (captures ${capturesBefore} → ${capturesAfter}, one session, same video element, no reload)`, capturesAfter >= capturesBefore + 2 && /recording since/.test(still.badge) && still.sameVideo && still.marker === 1 && sessions === 1, JSON.stringify(still));
    const dims = await page.evaluate(() => { const v = document.getElementById('video'); return { w: v.videoWidth, h: v.videoHeight, paused: v.paused }; });
    check('off-stage video still has frames (videoWidth > 0, not paused)', dims.w > 0 && !dims.paused, JSON.stringify(dims));
    const captureBodies = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/captures').map((l) => l.body);
    check('posted captures carry the session id, a sequence and an image', captureBodies.every((b) => typeof b.sessionId === 'string' && typeof b.sequence === 'number' && typeof b.capturedAt === 'number') && captureBodies.length >= 2, `${captureBodies.length} bodies; keys=${Object.keys(captureBodies[0] ?? {}).join(',')}`);
    await page.click('#nav-live');
    const badgeRunning = await page.textContent('#live-badge');
    await page.click('#stop');
    await page.waitForFunction(() => /not recording|stopped/.test(document.getElementById('live-badge')?.textContent ?? ''), null, { timeout: 15000 });
    check('Stop from Live ends the Run (badge no longer recording; Start enabled again)', /recording since/.test(badgeRunning) && !(await page.isDisabled('#start')), await page.textContent('#live-badge'));
    await page.screenshot({ path: `${outDir}/live-after-run.png`, fullPage: true });
  }

  // ---- Memory view: browse-all by default, paging past 40, filters, history, stale, errors, empty, drilldown ----
  await page.click('#nav-memory');
  await waitBrowseIdle();
  vs = await viewState();
  check('Memory view shown (hash #memory, Live off-stage)', !vs.memory.hidden && vs.live.offstage && vs.hash === '#memory', JSON.stringify(vs));
  let requests = (await browseLog()).map((l) => `${l.path.includes('agent') ? 'agent' : 'memory'}:${l.query.kind}:${l.query.history}:${l.query.query ?? ''}`);
  const firstSeven = requests.slice(0, 7);
  check('browse-all default: 7 parallel first pages (5 memory kinds, 2 agent kinds), history=false, no query', new Set(firstSeven).size === 7 && firstSeven.every((r) => /:false:$/.test(r)) && firstSeven.filter((r) => r.startsWith('agent:')).length === 2, JSON.stringify(firstSeven));
  let list = await cards();
  let note = await browseNote();
  check('browse-all renders every first page merged (169 cards) with per-category totals and “more available”', list.length === 169 && /169 shown of 247 · more available/.test(note) && /observation 40\/88\+/.test(note) && /reminder 3\/3/.test(note), note.slice(0, 200));
  check('merged list is newest source time first across kinds', list[0].title.includes('html') && list.slice(0, 5).map((c) => c.kind).includes('Photo'), list.slice(0, 4).map((c) => `${c.kind}:${c.title}`).join(' | '));
  const chipCounts = await page.$$eval('#browse-kinds label', (els) => els.map((e) => `${e.querySelector('input').value}=${e.querySelector('.count').textContent}`));
  check('category chips carry server totals', chipCounts.join(',') === 'all=,observations=88,captures=60,transcripts=50,entities=5,state=1,facts=40,reminders=3', chipCounts.join(','));
  const xss = await page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('#browse-list li.card:first-child img').length, scripts: document.querySelectorAll('#browse-list script').length, title: document.querySelector('#browse-list li.card:first-child .title')?.textContent, text: document.querySelector('#browse-list li.card:first-child .text')?.textContent }));
  check('server text is escaped: HTML in title/text renders literally, no element or script created', xss.xss === undefined && xss.imgs === 0 && xss.scripts === 0 && xss.title === 'html <b>not bold</b>' && /<script>window\.__xss=2<\/script> literal text/.test(xss.text), JSON.stringify(xss).slice(0, 200));
  check('no raw JSON open by default; every card has a closed “Evidence & details”', (await page.$$('#browse-list details[open]')).length === 0 && (await page.$$('#browse-list li.card details.raw[open]')).length === 0, '');
  const superByDefault = list.filter((c) => c.superseded).length;
  check('history off: no superseded observations/state/transcript revisions rendered', superByDefault === 0 && !list.some((c) => /superseded/.test(c.status)), `${superByDefault}`);
  check('photo cards use lazy-loaded thumbnails', (await page.$$eval('#browse-list li.kind-captures img.thumb', (imgs) => imgs.map((i) => `${i.getAttribute('loading')}/${i.getAttribute('decoding')}`))).every((s) => s === 'lazy/async') && (await page.$$('#browse-list li.kind-captures img.thumb')).length === 40, '');
  check('source times are labelled (“source time …”) and agent items say “recorded”', list.filter((c) => c.kind === 'Observation').every((c) => /source time 2026-09-20/.test(c.when)) && list.filter((c) => c.kind === 'Agent fact').every((c) => /^recorded /.test(c.when)), list.find((c) => c.kind === 'Agent fact')?.when);
  check('status labels are honest per item (queued / failed photos, pending / fired / cancelled reminders)', list.some((c) => c.kind === 'Photo' && c.status === 'queued') && list.some((c) => c.kind === 'Photo' && c.status === 'failed') && ['pending', 'fired', 'cancelled'].every((s) => list.some((c) => c.kind === 'Reminder' && c.status === s)), '');
  check('hidden/deleted person never appears in browse-all', !list.some((c) => /Deleted person/.test(c.title)), '');

  // Load more (all): kinds with a cursor only
  await page.click('#browse-more');
  await waitBrowseIdle();
  const moreReqs = (await browseLog()).slice(requests.length).map((l) => `${l.query.kind}${l.query.cursor ? '+cursor' : ''}`);
  list = await cards();
  check('Load more extends only categories with a cursor (observations, photos, speech; facts fit one page) and merges without duplicates', moreReqs.sort().join(',') === 'captures+cursor,observations+cursor,transcripts+cursor' && list.length === 239 && new Set(list.map((c) => `${c.kind}:${c.title}:${c.when}`)).size === 239, `${moreReqs.join(',')} cards=${list.length}`);
  await page.click('#browse-more'); await waitBrowseIdle();
  list = await cards(); note = await browseNote();
  check('third page reaches the end of results: 247 cards, Load more hidden', list.length === 247 && /247 shown of 247 · end of results/.test(note) && (await page.isHidden('#browse-more')), note.slice(0, 120));

  // Category: Observations (paging beyond the old recent-30 limit)
  await page.click('#browse-kinds label:has(input[value="observations"])');
  await waitBrowseIdle();
  let before = (await browseLog()).length;
  list = await cards();
  check('Observations category: one request, 40 newest observations, entity-kind selector hidden', list.length === 40 && list.every((c) => c.kind === 'Observation') && (await page.isHidden('#browse-entity-kind-label')), `${list.length}`);
  await page.click('#browse-more'); await waitBrowseIdle();
  await page.click('#browse-more'); await waitBrowseIdle();
  list = await cards();
  const obsReqs = (await browseLog()).slice(before).map((l) => l.query.cursor ? 'cursor' : 'first');
  check('Observations paging: 40 → 80 → 88 through opaque cursors (well past recent-30)', list.length === 88 && obsReqs.join(',') === 'cursor,cursor' && (await page.isHidden('#browse-more')), `${list.length} ${obsReqs.join(',')}`);

  // Literal text filter + history
  await page.fill('#browse-query', 'keys');
  await page.click('#browse-form button[type=submit]');
  await waitBrowseIdle();
  list = await cards();
  let lastReq = (await browseLog()).at(-1).query;
  check('literal text filter: query=keys sent verbatim; 12 current matches, all containing “keys”', lastReq.query === 'keys' && lastReq.kind === 'observations' && list.length === 12 && list.every((c) => /keys/i.test(`${c.title} ${c.text}`)), `${list.length} ${JSON.stringify(lastReq)}`);
  await page.check('#browse-history');
  await waitBrowseIdle();
  list = await cards(); lastReq = (await browseLog()).at(-1).query;
  check('history on: history=true sent; superseded observations appear struck-through with an honest label', lastReq.history === 'true' && list.length === 14 && list.filter((c) => c.superseded).length === 2 && list.filter((c) => c.superseded).every((c) => /superseded/.test(c.status)) && /history on/.test(await browseNote()), `${list.length} superseded=${list.filter((c) => c.superseded).length}`);
  await page.uncheck('#browse-history'); await waitBrowseIdle();

  // Date filter (local datetime-local inputs → epoch ms on the wire)
  await page.fill('#browse-query', '');
  await page.fill('#browse-from', localInput(T0 - 10 * 60_000));
  await page.fill('#browse-to', localInput(T0));
  await page.click('#browse-form button[type=submit]');
  await waitBrowseIdle();
  list = await cards(); lastReq = (await browseLog()).at(-1).query;
  const fromOk = Math.abs(Number(lastReq.from) - (T0 - 10 * 60_000)) < 60_000 && Math.abs(Number(lastReq.to) - T0) < 60_000;
  check('date filter: from/to sent as epoch ms; only observations inside the window (11 current)', fromOk && list.length === 11 && /date range on/.test(await browseNote()), `${list.length} from=${lastReq.from} to=${lastReq.to}`);
  await page.click('#browse-reset'); await waitBrowseIdle();
  check('Reset returns to browse-all with empty filters', (await page.inputValue('#browse-from')) === '' && (await page.$eval('#browse-kinds input[value="all"]', (i) => i.checked)) && (await cards()).length === 169, '');

  // Entities + entity kind
  await page.click('#browse-kinds label:has(input[value="entities"])');
  await waitBrowseIdle();
  check('Entities category shows the entity-kind selector and all 5 active entities', !(await page.isHidden('#browse-entity-kind-label')) && (await cards()).length === 5, '');
  await page.selectOption('#browse-entity-kind', 'person');
  await waitBrowseIdle();
  list = await cards(); lastReq = (await browseLog()).at(-1).query;
  check('entityKind=person: one request with entityKind, only Sam; deleted person stays hidden', lastReq.entityKind === 'person' && list.length === 1 && list[0].title === 'Sam', JSON.stringify(list.map((c) => c.title)));
  // drilldown: entity history via /api/entities/:id
  await page.click('#browse-list li.card details > summary');
  await page.click('#browse-list li.card button:has-text("Load entity history")');
  await page.waitForFunction(() => /Observations \(\d+\)/.test(document.querySelector('#browse-list li.card .detail')?.textContent ?? ''), null, { timeout: 5000 });
  const entDetail = (await page.textContent('#browse-list li.card .detail')).replace(/\s+/g, ' ');
  check('entity drilldown: readable facts (entity kind, gallery id) then history from GET /api/entities/e3 incl. candidate label', /entity kind\s*person/.test(entDetail) && /gallery id\s*p_sam/.test(entDetail) && /Observations \(\d+\)/.test(entDetail) && /Possible match — identity unconfirmed/.test(entDetail) && (await qaLog()).some((l) => l.path === '/api/entities/e3'), entDetail.slice(0, 200));
  await page.selectOption('#browse-entity-kind', '');

  // drilldown: observation → source photo (lazy) + packet
  await page.click('#browse-kinds label:has(input[value="observations"])');
  await waitBrowseIdle();
  await page.click('#browse-list li.card:nth-child(2) details > summary'); // o2 (o-html has no photo)
  await page.waitForSelector('#browse-list li.card:nth-child(2) dl');
  const obsDetail = await page.evaluate(() => { const li = document.querySelector('#browse-list li.card:nth-child(2)'); const img = li.querySelector('img.photo'); return { text: li.querySelector('.detail').textContent.replace(/\s+/g, ' '), img: img ? `${img.getAttribute('loading')} ${img.getAttribute('src')}` : null, rawOpen: li.querySelector('details.raw').open, pre: Boolean(li.querySelector('details.raw pre')) }; });
  check('observation drilldown: labelled facts, lazy source photo, raw JSON behind a closed toggle', /packet\s*cap_2/.test(obsDetail.text) && /confidence\s*high/.test(obsDetail.text) && obsDetail.img === 'lazy /api/frames/cap_2' && obsDetail.rawOpen === false && obsDetail.pre, obsDetail.text.slice(0, 160));
  await page.click('#browse-list li.card:nth-child(2) button:has-text("Load interpreted packet")');
  await page.waitForFunction(() => /Packet v1/.test(document.querySelector('#browse-list li.card:nth-child(2) .detail')?.textContent ?? ''), null, { timeout: 5000 });
  check('packet drilldown loads GET /api/packets/cap_2 (+history) and renders vision/faces/audio', /Packet v1/.test(await page.textContent('#browse-list li.card:nth-child(2) .detail')) && /1 packet version/.test(await page.textContent('#browse-list li.card:nth-child(2) .detail')) && (await qaLog()).some((l) => l.path === '/api/packets/cap_2/history'), '');
  // queued photo → honest 404 text
  await page.click('#browse-kinds label:has(input[value="captures"])');
  await waitBrowseIdle();
  const queuedIdx = await page.$$eval('#browse-list li.card', (els) => els.findIndex((e) => e.querySelector('.status')?.textContent === 'queued'));
  await page.click(`#browse-list li.card:nth-child(${queuedIdx + 1}) details > summary`);
  await page.click(`#browse-list li.card:nth-child(${queuedIdx + 1}) button:has-text("Load interpreted packet")`);
  await page.waitForFunction((n) => /no interpreted packet yet/.test(document.querySelector(`#browse-list li.card:nth-child(${n}) .detail`)?.textContent ?? ''), queuedIdx + 1, { timeout: 5000 });
  check('a queued frame without a packet says so (retained, still queued/pending) instead of failing silently', true, '');

  // Long text: explicit preview with ellipsis on the card, full text labelled in the details
  await page.click('#browse-kinds label:has(input[value="observations"])');
  await waitBrowseIdle();
  const longCard = await page.evaluate(async () => { const li = [...document.querySelectorAll('#browse-list li.card')].find((x) => x.querySelector('.title')?.textContent === 'long lecture summary'); if (!li) return null; li.querySelector('details > summary').click(); await new Promise((r) => setTimeout(r, 100)); return { preview: li.querySelector('.text').textContent, trunc: li.querySelector('.trunc')?.textContent ?? '', full: li.querySelector('.detail .full')?.textContent ?? '', heading: li.querySelector('.detail h4')?.textContent ?? '', noteFact: [...li.querySelectorAll('.detail dd')].map((d) => d.textContent).find((t) => /truncated/.test(t)) ?? '' }; });
  check('long text: card shows a 400-char preview ending in …, labelled as a preview; details carry the labelled full text and mark truncated data values', Boolean(longCard) && longCard.preview.length === 401 && longCard.preview.endsWith('…') && /^preview of 1\d{3} characters · full text under Evidence & details$/.test(longCard.trunc) && /^Full text \(1\d{3} characters\)$/.test(longCard.heading) && longCard.full.endsWith('end of notes.') && longCard.full.length > 1000 && /truncated: 700 characters; full value in raw data/.test(longCard.noteFact), JSON.stringify({ trunc: longCard?.trunc, heading: longCard?.heading, fullLen: longCard?.full.length }));

  // Stale async: a slow older request must not overwrite a newer filter
  await page.click('#browse-kinds label:has(input[value="observations"])');
  await waitBrowseIdle();
  await post('/__qa/browse-delay', { kind: 'observations', ms: 1500 });
  await page.fill('#browse-query', 'bowl');
  await page.click('#browse-form button[type=submit]'); // this one is delayed 1.5 s
  await sleep(150);
  await page.fill('#browse-query', 'keys');
  await page.click('#browse-form button[type=submit]');
  await waitBrowseIdle();
  await sleep(1800); // let the delayed "bowl" answer arrive
  list = await cards(); note = await browseNote();
  check('stale response dropped: late “bowl” page never replaces the “keys” list', list.length === 12 && list.every((c) => /keys/i.test(`${c.title} ${c.text}`)) && !list.some((c) => /bowl/i.test(c.text)) && /text “keys”/.test(note), `${list.length} ${note.slice(0, 100)}`);
  await page.fill('#browse-query', '');

  // Errors per category + Retry; empty state
  await post('/__qa/browse-fail', { kinds: ['facts'] });
  await page.click('#browse-kinds label:has(input[value="all"])');
  await waitBrowseIdle();
  note = await browseNote();
  check('a failing category is reported (red note, facts ✗ chip, Retry offered) while the others render', /1 category error\(s\): facts: .*HTTP 500/.test(note) && (await page.$eval('#browse-note', (e) => e.classList.contains('bad'))) && !(await page.isHidden('#browse-retry')) && (await cards()).length === 129 && (await page.$$eval('#browse-kinds label', (els) => els.map((e) => e.querySelector('.count').textContent))).includes('✗'), note.slice(0, 160));
  await post('/__qa/browse-fail', { kinds: [] });
  await page.click('#browse-retry');
  await waitBrowseIdle();
  check('Retry re-requests only the failed category and clears the error', !/category error/.test(await browseNote()) && (await cards()).length === 169 && (await browseLog()).at(-1).query.kind === 'facts', await browseNote());
  await post('/__qa/browse-fail', { kinds: ['observations', 'captures', 'transcripts', 'entities', 'state', 'facts', 'reminders'] });
  await page.click('#browse-refresh'); await waitBrowseIdle();
  check('everything failing: empty list explains itself and offers Retry', /nothing could be loaded/.test(await page.textContent('#browse-list .empty')) && !(await page.isHidden('#browse-retry')), await page.textContent('#browse-list .empty'));
  await post('/__qa/browse-fail', { kinds: [] });
  await page.fill('#browse-query', 'zzzz-not-anywhere');
  await page.click('#browse-form button[type=submit]'); await waitBrowseIdle();
  check('empty result: “nothing matches this filter”, no error tone', /nothing matches this filter/.test(await browseNote()) && /nothing matches this filter/.test(await page.textContent('#browse-list .empty')) && !(await page.$eval('#browse-note', (e) => e.classList.contains('bad'))), await browseNote());
  await page.click('#browse-reset'); await waitBrowseIdle();
  const writes = (await qaLog()).filter((l) => l.method !== 'GET' && (l.path.startsWith('/api/memory') || l.path.startsWith('/api/entities') || l.path.startsWith('/api/packets') || l.path.startsWith('/api/people') || l.path.startsWith('/api/search')));
  check('memory browsing issued no writes (no POST/DELETE to memory, entities, packets, people, search)', writes.length === 0, JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));

  // People + indexed search live under Memory (behaviour unchanged)
  check('People & recognition and indexed search are reachable in Memory (Reset people present, disabled with no people)', (await page.$('#view-memory #people-details #people-reset')) !== null && (await page.isDisabled('#people-reset')), '');
  await page.click('#search-details > summary');
  check('search mode selector defaults to keyword', (await page.inputValue('#search-mode')) === 'keyword', '');
  await page.fill('#search-query', 'keys');
  await page.click('#search-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('search-note')?.textContent?.includes('keyword mode'), null, { timeout: 5000 });
  let searchRows = await page.$$eval('#search-results li', (els) => els.map((e) => e.textContent));
  check('keyword search renders results with source image cite and candidate label', searchRows.length === 1 && /keyword match/.test(searchRows[0]) && /source image/.test(searchRows[0]) && /possible \(unconfirmed\)/.test(searchRows[0]), searchRows[0]?.slice(0, 120));
  await page.selectOption('#search-mode', 'semantic');
  await page.click('#search-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('search-note')?.textContent?.includes('semantic mode'), null, { timeout: 5000 });
  searchRows = await page.$$eval('#search-results li', (els) => els.map((e) => e.textContent));
  const searchLog = (await qaLog()).filter((l) => l.path === '/api/search').map((l) => l.body);
  check('search bodies carry mode (keyword then semantic); semantic rows show distance', searchLog.length === 2 && searchLog[0].mode === 'keyword' && searchLog[1].mode === 'semantic' && /distance 0\.123/.test(searchRows[0] ?? ''), JSON.stringify(searchLog));

  // ---- PWA shell + icons ----
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  const manifestJson = await manifest.json();
  check('manifest served with manifest MIME and PNG icons (192, 512, maskable) + SVG', /manifest\+json/.test(manifest.headers.get('content-type')) && manifestJson.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png') && manifestJson.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), JSON.stringify(manifestJson.icons.map((i) => i.src)));
  const iconHeads = await Promise.all(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'].map(async (p) => { const r = await fetch(`${base}${p}`); return `${r.status}:${r.headers.get('content-type')}`; }));
  check('raster icons are served as image/png', iconHeads.every((h) => h === '200:image/png'), iconHeads.join(','));
  const swState = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return { scope: reg.scope, active: Boolean(reg.active) }; });
  check('service worker registered and active', swState.active && swState.scope.endsWith('/'), JSON.stringify(swState));
  await page.click('#nav-live');
  const installStatus = await page.textContent('#install-status');
  const installSteps = await page.textContent('#install-steps');
  const pwaNote = await page.textContent('#pwa-note');
  check('install block: browser-tab status with install steps; note is honest (API/media never cached; push/iOS not verified; install ≠ push)', /browser tab/.test(installStatus) && /Install KAWK/.test(installSteps) && /never cached/.test(pwaNote) && /not verified/.test(pwaNote) && /does not by itself prove background notifications/.test(pwaNote), `${installStatus} | ${pwaNote.slice(0, 120)}`);
  const reloadAt = Date.now();
  await page.reload({ waitUntil: 'load' });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  const beforeN = (await qaLog()).filter((l) => l.path === '/api/agent/status').length;
  await page.evaluate(() => fetch('/api/agent/status').then((r) => r.json()));
  const afterN = (await qaLog()).filter((l) => l.path === '/api/agent/status').length;
  check('under SW control, /api requests still reach the network (not cached)', controlled && afterN > beforeN, `controlled=${controlled}`);
  const cacheKeys = await page.evaluate(async () => { const names = await caches.keys(); const out = []; for (const n of names) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname); return out; });
  const SHELL = ['/', '/index.html', '/styles.css', '/client.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
  check('cache holds only shell paths (incl. icons), never /api', cacheKeys.length > 0 && cacheKeys.every((p) => SHELL.includes(p)), JSON.stringify(cacheKeys));
  check('reload lands on the view in the hash (#live after the last click)', (await viewState()).selected.join() === 'nav-live', '');

  // ---- Web Push: page flow with the fake PushManager (Live view) ----
  await page.waitForFunction(() => /notifications: ready/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 5000 });
  const pushIdle = await page.textContent('#push-status');
  const loadPushCalls = (await qaLog()).filter((l) => l.at >= reloadAt && l.path.startsWith('/api/agent/push/')).map((l) => `${l.method} ${l.path}`);
  check('load: prepare fetched the key once; Enable enabled; no subscribe/POST/prompt on load', /notifications: ready · permission granted/.test(pushIdle) && !(await page.isDisabled('#push-enable')) && loadPushCalls.join(',') === 'GET /api/agent/push/key' && (await page.evaluate(() => window.__qaSubscribeCalledSync || 0)) === 0, `${pushIdle.trim()} calls=${JSON.stringify(loadPushCalls)}`);
  check('push guidance explains the click requirement and that no token is needed', /No token is needed/.test(await page.textContent('#push-guidance')), '');
  const syncResult = await page.evaluate(() => { window.__qaSubscribeCalledSync = 0; document.getElementById('push-enable').click(); return { calledDuringClick: window.__qaSubscribeCalledSync }; });
  check('Enable click → pushManager.subscribe() called synchronously inside the click handler', syncResult.calledDuringClick === 1, JSON.stringify(syncResult));
  await page.waitForFunction(() => /notifications: subscribed/.test(document.getElementById('push-status')?.textContent ?? '') && !/working/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  let pushState = await qaPush();
  const pushCalls = (await qaLog()).filter((l) => l.at >= reloadAt && l.path.startsWith('/api/agent/push/')).map((l) => `${l.method} ${l.path}`);
  check('Enable: browser subscribe → POST subscription recorded by the mock agent → status', pushCalls.join(',') === 'GET /api/agent/push/key,POST /api/agent/push/subscriptions,GET /api/agent/push/status' && pushState.subscriptions.length === 1 && pushState.subscriptions[0].endpoint.startsWith('https://push.qa.invalid/'), `${JSON.stringify(pushCalls)}`);
  check('after Enable: Disable + Send test push visible, Enable hidden, delivery counters shown', (await page.isHidden('#push-enable')) && (await page.isVisible('#push-disable')) && (await page.isVisible('#push-test')) && /1 device\(s\)/.test(await page.textContent('#push-delivery')), '');
  await page.click('#push-test');
  await page.waitForFunction(() => /last test push-test-1 queued/.test(document.getElementById('push-delivery')?.textContent ?? ''), null, { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty) .text')].some((e) => e.textContent.includes('Test push 1')), null, { timeout: 6000 });
  const testRow = await page.$eval('#agent-notifications li:not(.empty)', (li) => ({ text: li.querySelector('.text')?.textContent, acked: li.classList.contains('acked'), meta: li.textContent }));
  check('Send test push: POST once; the test answer arrives as a row via SSE and is NOT auto-acked', (await qaLog()).filter((l) => l.path === '/api/agent/push/test').length === 1 && testRow.text.includes('Test push 1') && !testRow.acked && !/push \d\d:/.test(testRow.meta), JSON.stringify(testRow).slice(0, 160));
  check('push status text never assumes delivery', /not that the device showed it/.test(await page.textContent('#push-status')) && /not proof the OS displayed it; background receipt needs a real iPhone test/.test(await page.textContent('#push-delivery')), '');

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
  await page.click('#nav-memory'); // a push arriving while Memory is shown: the Live row is off-stage, so it is unseen and must NOT be acknowledged
  await deliver({ id: 'n2', title: 'KAWK', body: 'Still looking; I will check the latest photo.', url: '/' });
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty)')].some((li) => li.textContent.includes('Still looking') && /push \d\d:\d\d:\d\d/.test(li.textContent)), null, { timeout: 6000 });
  let shown = await waitShown((l) => l.some((n) => n.tag === 'kawk-notification:n2'));
  check('push event → ONE system notification with tag kawk-notification:n2, PNG icon and same-origin data.url', shown.length === 1 && shown[0].tag === 'kawk-notification:n2' && shown[0].data.url === `${base}/`, JSON.stringify(shown));
  await sleep(700);
  let n2Row = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((li) => li.textContent).find((t) => t.includes('Still looking')));
  check('push while Memory is shown (page visible+focused) → row marked with the push time but NOT acknowledged; view unchanged', /push \d\d:/.test(n2Row) && (await ackCountFor('n2')) === n2AcksBefore && !/acked/.test(n2Row) && (await viewState()).selected.join() === 'nav-memory', `${n2Row?.slice(0, 160)} acks=${await ackCountFor('n2')}`);
  await page.click('#nav-live'); await sleep(500);
  n2Row = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((li) => li.textContent).find((t) => t.includes('Still looking')));
  check('switching to Live afterwards does not retroactively acknowledge the unseen update', (await ackCountFor('n2')) === n2AcksBefore && !/acked/.test(n2Row), `acks=${await ackCountFor('n2')}`);
  await deliver({ id: 'n2', title: 'KAWK', body: 'Still looking; I will check the latest photo.', url: '/' }); // now Live is shown and focused
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty)')].some((li) => li.textContent.includes('Still looking') && /acked \(displayed in the foreground via push\)/.test(li.textContent)), null, { timeout: 6000 });
  shown = await notificationsShown();
  check('push while Live is shown, visible and focused → displayed banner → acknowledged with the foreground reason; same tag replaced the banner (still one notification)', shown.filter((n) => n.tag === 'kawk-notification:n2').length === 1 && (await ackCountFor('n2')) === n2AcksBefore + 1, JSON.stringify(shown.map((n) => n.tag)));
  await deliver({ id: 'n2', title: 'KAWK', body: 'Still looking; I will check the latest photo.', url: '/' });
  await sleep(700);
  shown = await notificationsShown();
  check('same id pushed again → showNotification ran again but replaced the banner (same tag, renotify:false); no second ack', shown.filter((n) => n.tag === 'kawk-notification:n2').length === 1 && (await ackCountFor('n2')) === n2AcksBefore + 1, JSON.stringify(shown.map((n) => n.tag)));
  // Debug view: same rule as Memory
  await page.click('#nav-debug');
  await deliver({ id: 'push-test-1', title: 'KAWK', body: 'Test push 1 from the agent.', url: '/' });
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty)')].some((li) => li.textContent.includes('Test push 1') && /push \d\d:/.test(li.textContent)), null, { timeout: 6000 });
  await sleep(500);
  check('push while Debug is shown → marked, not acknowledged', (await ackCountFor('push-test-1')) === 0 && !/acked/.test(await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((li) => li.textContent).find((t) => t.includes('Test push 1')))), `acks=${await ackCountFor('push-test-1')}`);
  // Failed display: the worker reports displayed:false (synthetic worker→page message; CDP cannot make showNotification fail). Never acknowledged, error listed.
  await page.click('#nav-live');
  const errorsBefore = await page.textContent('#errors-summary');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'kawk-push', id: 'nfail', title: 'KAWK', body: 'Banner could not be displayed.', url: '/', foreground: true, duplicate: false, displayed: false } })));
  await page.waitForFunction(() => [...document.querySelectorAll('#agent-notifications li:not(.empty)')].some((li) => li.textContent.includes('Banner could not be displayed')), null, { timeout: 4000 });
  await sleep(500);
  const failRow = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((li) => li.textContent).find((t) => t.includes('Banner could not be displayed')));
  await page.click('#nav-debug');
  const errorsAfter = await page.textContent('#errors-summary');
  const errorsList = await page.textContent('#errors-list');
  check('failed display (displayed:false) while Live is focused → row shown, NEVER acknowledged, error recorded in Debug → Errors', (await ackCountFor('nfail')) === 0 && !/acked/.test(failRow) && errorsBefore !== errorsAfter && /nfail.*could not display/.test(errorsList), `${errorsBefore} → ${errorsAfter}`);
  // Notification click while Memory is shown: the worker's open message → Live, row highlighted, acknowledged, no reload
  await page.click('#nav-memory');
  await page.evaluate(() => { window.__qaClickMarker = 1; navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'kawk-notification-open', id: 'push-test-1', url: '/?notification=push-test-1' } })); });
  await page.waitForFunction(() => document.querySelector('#agent-notifications li.opened') !== null, null, { timeout: 4000 });
  await sleep(300);
  const clicked = await page.evaluate(() => ({ marker: window.__qaClickMarker, opened: document.querySelector('#agent-notifications li.opened')?.textContent ?? '' }));
  check('notification click (worker open message) while Memory is shown → switches to Live, highlights the row, acknowledges it (“opened from notification click”), no reload', (await viewState()).selected.join() === 'nav-live' && clicked.marker === 1 && /Test push 1/.test(clicked.opened) && /acked \(opened from notification click\)/.test(clicked.opened) && (await ackCountFor('push-test-1')) === 1, clicked.opened.slice(0, 160));
  await deliver('this is not json');
  shown = await waitShown((l) => l.some((n) => n.tag === 'kawk-notification:unreadable'));
  check('unreadable push payload → honest generic banner, no invented content', shown.some((n) => n.tag === 'kawk-notification:unreadable' && /not readable/.test(n.body)), '');
  await page.click('#nav-memory');
  await deliver({ id: 'evil', title: 'x', body: 'y', url: 'https://evil.example/steal' });
  shown = await waitShown((l) => l.some((n) => n.tag === 'kawk-notification:evil'));
  const evil = shown.find((n) => n.tag === 'kawk-notification:evil');
  check('cross-origin url in a push payload is replaced by our root', Boolean(evil) && evil.data.url === `${base}/`, JSON.stringify(evil?.data));
  const pushRows = await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.map((e) => e.querySelector('.text')?.textContent));
  check('a push for an id not yet seen over SSE renders once as a row (unacked: Memory was shown); no duplicate rows overall', pushRows.filter((t) => t === 'y').length === 1 && new Set(pushRows).size === pushRows.length && (await ackCountFor('evil')) === 0, '');
  await page.click('#nav-live');
  const cachedAfterPush = await page.evaluate(async () => { const names = await caches.keys(); const out = []; for (const n of names) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname); return out; });
  check('push endpoints never entered the cache', cachedAfterPush.every((p) => !p.startsWith('/api/')), '');

  // ---- opened from a notification: ?notification=<id> acks, highlights and switches to Live; existing subscription re-syncs ----
  const n1AcksBefore = await ackCountFor('n1');
  const subPostsBefore = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length;
  await page.goto(`${base}/?notification=n1#memory`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#agent-notifications li.opened') !== null, null, { timeout: 8000 });
  await page.waitForFunction(() => /notifications: subscribed/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  const openedRow = await page.$eval('#agent-notifications li.opened', (li) => li.textContent);
  check('?notification=n1 → Live view, row highlighted + acked “opened from notification”, URL param stripped', openedRow.includes('keys were last seen') && /acked \(opened from notification\)/.test(openedRow) && (await ackCountFor('n1')) === n1AcksBefore + 1 && !page.url().includes('notification=') && (await viewState()).selected.join() === 'nav-live', `${openedRow.slice(0, 100)} url=${page.url()}`);
  check('reload with an existing browser subscription re-syncs it (no prompt, no new subscribe)', (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length === subPostsBefore + 1 && /re-synced/.test(await page.textContent('#push-status')) && (await page.evaluate(() => window.__qaSubscribed || 0)) === 0, '');
  await page.click('#push-disable');
  await page.waitForFunction(() => /notifications: ready/.test(document.getElementById('push-status')?.textContent ?? '') && /disabled on this device/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 6000 });
  pushState = await qaPush();
  const del = (await qaLog()).filter((l) => l.method === 'DELETE' && l.path === '/api/agent/push/subscriptions');
  check('Disable: browser unsubscribed, DELETE {endpoint} sent, 0 subscriptions, Enable visible again', del.length === 1 && typeof del[0].body.endpoint === 'string' && pushState.subscriptions.length === 0 && (await page.isVisible('#push-enable')) && (await page.isHidden('#push-disable')), '');
  await page.click('#push-clear');
  check('Clear status resets the line without touching subscription/preparation state', /notifications: ready · permission granted · ready: press Enable notifications/.test(await page.textContent('#push-status')) && !(await page.isDisabled('#push-enable')), '');

  // ---- permission not granted; agent without push (503) ----
  const deniedCtx = await browser.newContext({ serviceWorkers: 'allow' });
  await deniedCtx.addInitScript(FAKE_PUSH_MANAGER);
  const deniedPage = await deniedCtx.newPage();
  await deniedPage.goto(`${base}/`, { waitUntil: 'load' });
  await deniedPage.waitForFunction(() => /notifications: (ready|denied)/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 6000 });
  const subPostsNow = (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length;
  if (!(await deniedPage.isDisabled('#push-enable'))) await deniedPage.click('#push-enable');
  await deniedPage.waitForFunction(() => !/working/.test(document.getElementById('push-status')?.textContent ?? '') && !/checking/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 8000 });
  const deniedStatus = await deniedPage.textContent('#push-status');
  check('permission not granted → subscribe() rejected → denied/not-granted state with guidance; nothing recorded on the agent', /permission (denied|default)/.test(deniedStatus) && /(denied|not granted)/.test(deniedStatus) && (await qaLog()).filter((l) => l.method === 'POST' && l.path === '/api/agent/push/subscriptions').length === subPostsNow && (await deniedPage.evaluate(() => window.__qaSubscribed || 0)) === 0, deniedStatus.trim().slice(0, 120));
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
  check('agent without push (503) → visible “not configured on the agent”, Enable disabled, Retry offered, never subscribed', /not configured on the agent/.test(await noPushPage.textContent('#push-status')) && (await noPushPage.isDisabled('#push-enable')) && (await noPushPage.isVisible('#push-prepare')) && (await noPushPage.evaluate(() => (window.__qaSubscribed || 0) + (window.__qaSubscribeCalledSync || 0))) === 0, '');
  await noPushCtx.close(); await mock2.close();

  // ---- screenshots: desktop + mobile for each view; mobile layout sanity ----
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => /notifications: (ready|subscribed)/.test(document.getElementById('push-status')?.textContent ?? ''), null, { timeout: 6000 });
  await page.screenshot({ path: `${outDir}/desktop-live.png`, fullPage: true });
  await page.click('#nav-memory'); await waitBrowseIdle();
  await page.screenshot({ path: `${outDir}/desktop-memory.png`, fullPage: false });
  await page.click('#nav-debug');
  await page.screenshot({ path: `${outDir}/desktop-debug.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#nav-live'); await sleep(300);
  const mobile = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, navVisible: document.querySelector('.nav').getBoundingClientRect().width > 0, cols: getComputedStyle(document.querySelector('.live-grid')).gridTemplateColumns.split(' ').length }));
  check('mobile (390 px): no horizontal overflow, single column, nav visible', mobile.scrollW <= mobile.innerW + 1 && mobile.cols === 1 && mobile.navVisible, JSON.stringify(mobile));
  await page.screenshot({ path: `${outDir}/mobile-live.png`, fullPage: true });
  await page.click('#nav-memory'); await sleep(300);
  const mobileMem = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, chips: document.querySelectorAll('#browse-kinds label').length }));
  check('mobile Memory: chips wrap without overflow', mobileMem.scrollW <= mobileMem.innerW + 1 && mobileMem.chips === 8, JSON.stringify(mobileMem));
  await page.screenshot({ path: `${outDir}/mobile-memory.png`, fullPage: false });
  await page.click('#nav-debug'); await sleep(200);
  await page.screenshot({ path: `${outDir}/mobile-debug.png`, fullPage: true });
  check('screenshots written', true, outDir);
  // The mock has no WebSocket server, so the fake-device Start logs handshake 404s for /ws/faces and /ws/speech; those are
  // expected here (the Run reports them in its status rows) and are the only tolerated console errors.
  // Likewise the error-path checks above deliberately fetch a queued frame's missing packet (404) and injected 500s.
  const expectedWs = consoleErrors.filter((e) => /WebSocket connection to '.*\/ws\/(faces|speech)/.test(e));
  const expectedHttp = consoleErrors.filter((e) => /Failed to load resource: the server responded with a status of (404|500)/.test(e));
  const unexpected = consoleErrors.filter((e) => !expectedWs.includes(e) && !expectedHttp.includes(e));
  check(`no unexpected console/page errors (${expectedWs.length} expected WebSocket handshake errors from the socket-less mock, ${expectedHttp.length} deliberate 404/500 error-path fetches)`, unexpected.length === 0, unexpected.join(' | ').slice(0, 300));
} catch (e) {
  check('QA driver completed', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await browser.close();
  await mock.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
