// Read-only check of the merged page against a REAL running memory server (default http://localhost:8082).
// Every non-GET request the page attempts is aborted and reported, so nothing here can start capture, acknowledge a real
// pending update, send a task, subscribe to push or mutate memory. Nothing is clicked except the view tabs, category chips
// and card expanders. Prints a JSON summary and writes screenshots to /tmp/kawk-merged-ui-qa/live-*.png. Exit 1 if any
// write was attempted or the Memory view failed to load.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const agentDir = resolve(fileURLToPath(new URL('../../../agent/', import.meta.url)));
const { chromium } = require(require.resolve('playwright', { paths: [agentDir] }));
const base = (process.argv[2] ?? 'http://localhost:8082').replace(/\/$/, '');
const outDir = '/tmp/kawk-merged-ui-qa';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' }); // no SW: the shell must come from the network
const page = await context.newPage();
const blockedWrites = []; const requests = [];
await page.route('**/*', (route) => {
  const r = route.request();
  requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  if (r.method() !== 'GET' && r.method() !== 'HEAD') { blockedWrites.push(`${r.method()} ${new URL(r.url()).pathname}`); return route.abort(); }
  return route.continue();
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const summary = { base, blockedWrites, errors, memory: null, live: null, cards: null, sample: null, tasks: null };
try {
  await page.goto(`${base}/#memory`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => { const t = document.getElementById('browse-note')?.textContent ?? ''; return !/loading/.test(t) && t !== 'open this view to load memory'; }, null, { timeout: 30000 });
  summary.memory = { note: await page.textContent('#browse-note'), chips: await page.$$eval('#browse-kinds label', (els) => els.map((e) => `${e.querySelector('input').value}=${e.querySelector('.count').textContent}`)) };
  const cards = await page.$$eval('#browse-list li.card', (els) => els.map((e) => ({ kind: e.querySelector('.kind')?.textContent, title: (e.querySelector('.title')?.textContent ?? '').slice(0, 60), status: e.querySelector('.status')?.textContent ?? '', textLen: (e.querySelector('.text')?.textContent ?? '').length, preview: Boolean(e.querySelector('.trunc')), when: (e.querySelector('.when')?.textContent ?? '').slice(0, 60) })));
  summary.cards = { count: cards.length, byKind: cards.reduce((a, c) => { a[c.kind] = (a[c.kind] ?? 0) + 1; return a; }, {}), previews: cards.filter((c) => c.preview).length, statuses: [...new Set(cards.map((c) => c.status))] };
  summary.sample = cards.slice(0, 6);
  // expand the first agent fact (readable graph label in text, structured content in data) and the first observation
  for (const kind of ['Agent fact', 'Observation', 'Speech', 'Photo']) {
    const detail = await page.evaluate(async (k) => { const li = [...document.querySelectorAll('#browse-list li.card')].find((x) => x.querySelector('.kind')?.textContent === k); if (!li) return null; li.querySelector('details > summary').click(); await new Promise((r) => setTimeout(r, 150)); const d = li.querySelector('.detail'); return { title: li.querySelector('.title')?.textContent, text: (li.querySelector('.text')?.textContent ?? '').slice(0, 160), headings: [...d.querySelectorAll('h4')].map((h) => h.textContent), facts: [...d.querySelectorAll('dt')].map((t) => t.textContent).slice(0, 14), rawOpen: d.querySelector('details.raw')?.open ?? null, hasPhoto: Boolean(d.querySelector('img.photo')) }; }, kind);
    summary[`detail:${kind}`] = detail;
  }
  await page.screenshot({ path: `${outDir}/live-backend-memory.png`, fullPage: false });
  await page.click('#nav-live');
  await page.waitForTimeout(1500);
  summary.live = { badge: await page.textContent('#live-badge'), now: (await page.textContent('#live-summary')).replace(/\s+/g, ' ').slice(0, 400), agentStatus: await page.textContent('#agent-status'), updates: await page.$$eval('#agent-notifications li:not(.empty)', (els) => els.length), howTo: (await page.textContent('#how-to')).slice(0, 120) };
  await page.click('#view-live .agent-tasks-details > summary');
  summary.tasks = { summary: await page.textContent('#agent-tasks-summary'), visible: (await page.$eval('#agent-tasks', (e) => e.innerText)).replace(/\s+/g, ' ').slice(0, 400), hasRawJsonVisible: /"confidence"|"refs"/.test(await page.$eval('#agent-tasks', (e) => e.innerText)), diagCount: await page.$$eval('#agent-tasks details.diag', (els) => els.length) };
  await page.screenshot({ path: `${outDir}/live-backend-live.png`, fullPage: true });
} catch (e) { summary.errors.push(`driver: ${e instanceof Error ? e.message : String(e)}`); }
finally { await browser.close(); }
console.log(JSON.stringify(summary, null, 2));
process.exit(blockedWrites.length || !summary.memory || summary.errors.length ? 1 : 0);
