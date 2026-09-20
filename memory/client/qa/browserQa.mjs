// Headless browser QA of the merged page against the isolated mock server (random port). Uses the
// Playwright already installed under ../agent/node_modules (read-only). No camera/mic: Start is never
// pressed; camera paths are covered by the Node tests. Prints a PASS/FAIL table and writes screenshots to
// /tmp/kawk-merged-ui-qa/. Exit code 1 on any failure.
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
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
const page = await context.newPage();
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
  await page.reload({ waitUntil: 'load' }); // now under SW control
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  const before = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => l.path === '/api/agent/status').length;
  await page.evaluate(() => fetch('/api/agent/status').then((r) => r.json()));
  const after = (await (await fetch(`${base}/__qa/log`)).json()).log.filter((l) => l.path === '/api/agent/status').length;
  check('under SW control, /api requests still reach the network (not cached)', controlled && after > before, `controlled=${controlled} before=${before} after=${after}`);
  const cacheKeys = await page.evaluate(async () => { const names = await caches.keys(); const out = []; for (const n of names) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname); return out; });
  check('cache holds only shell paths', cacheKeys.length > 0 && cacheKeys.every((p) => ['/', '/index.html', '/styles.css', '/client.js', '/manifest.webmanifest', '/icons/icon.svg'].includes(p)), JSON.stringify(cacheKeys));

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
