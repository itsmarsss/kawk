// KAWK memory+agent service worker: network-first app shell + Web Push display.
// Caching: shell files only. Never intercepts or caches API, sockets, media, proxied lab resources or anything
// that could carry private data: /api/*, /ws/*, /v1/*, /static/*, /sw.js. Offline shows the cached shell; it
// never fakes an upload or an agent answer.
// Push: payloads are validated ({id,title,body,url}); every push shows a notification (WebKit rule), one notification
// identity per id (same tag, renotify:false → a repeat replaces, never alerts twice); clicks focus an existing KAWK window (no reload, so a running
// capture keeps going) or open the root with ?notification=<id>; navigation is same-origin only. Push arrival is
// also posted to open windows so the page can mark delivery — the page itself never shows system notifications.
// Displaying a notification here is not proof of OS/Apple background delivery.
const VERSION = 'kawk-memory-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/client.js', '/manifest.webmanifest', '/icons/icon.svg'];
const TAG_PREFIX = 'kawk-notification:';
const MAX_ID = 200, MAX_TITLE = 120, MAX_BODY = 2000, MAX_RECENT = 200;
const recentIds = new Map(); // id → shown-at, informational only (tells the page a repeat was a duplicate); never used to skip display

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL).catch(() => undefined)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/ws/') || p.startsWith('/v1/') || p.startsWith('/static/') || p === '/sw.js') return; // never touched
  if (!SHELL.includes(p)) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined); }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') { const shell = await caches.match('/index.html'); if (shell) return shell; }
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }));
});

// ---- push ---------------------------------------------------------------------------------------------------
/** Resolve `u` against our origin; anything that lands on another origin (or is unparsable) becomes null. */
function sameOriginHref(u) {
  if (typeof u !== 'string' || !u) return null;
  try { const target = new URL(u, self.location.origin); return target.origin === self.location.origin ? target.href : null; } catch { return null; }
}
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
/** {id,title,body,url} → validated payload, or {ok:false, reason}. */
function parsePushPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'payload is not an object' };
  const id = clean(raw.id, MAX_ID);
  if (!id) return { ok: false, reason: 'payload has no id' };
  const title = clean(raw.title, MAX_TITLE) || 'KAWK';
  const body = clean(raw.body, MAX_BODY);
  const url = sameOriginHref(raw.url) || `${self.location.origin}/`;
  return { ok: true, id, title, body, url };
}
function rememberId(id) {
  recentIds.set(id, Date.now());
  while (recentIds.size > MAX_RECENT) { const first = recentIds.keys().next().value; if (first === undefined) break; recentIds.delete(first); }
}
async function sameOriginWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((c) => { try { return new URL(c.url).origin === self.location.origin; } catch { return false; } });
}
async function handlePush(event) {
  let raw = null; let unreadable = null;
  if (event.data) { try { raw = event.data.json(); } catch (e) { unreadable = e instanceof Error ? e.message : String(e); } }
  const p = parsePushPayload(raw);
  if (!p.ok) {
    // Something was pushed to this device but not in the agent's shape: say so, without inventing content.
    await self.registration.showNotification('KAWK', { body: `Update received but not readable (${unreadable || p.reason}).`, tag: `${TAG_PREFIX}unreadable`, renotify: false, icon: '/icons/icon.svg', data: { url: `${self.location.origin}/`, unreadable: true } });
    return;
  }
  const tag = `${TAG_PREFIX}${p.id}`;
  const shown = await self.registration.getNotifications({ tag }).catch(() => []);
  const duplicate = shown.length > 0 || recentIds.has(p.id);
  // WebKit requires every push event to show a notification (silent handling risks permission revocation). A repeat of
  // the same id therefore still calls showNotification, but with the SAME tag and renotify:false: the existing banner
  // is replaced in place — one notification identity per id, no second alert. Nothing is suppressed client-side.
  let displayError = null;
  try { await self.registration.showNotification(p.title, { body: p.body, tag, renotify: false, icon: '/icons/icon.svg', badge: '/icons/icon.svg', data: { id: p.id, url: p.url } }); rememberId(p.id); } // remembered only after a successful display
  catch (e) { displayError = e; }
  // Tell open windows AFTER the display settled, so a page reacting to the push (marking, acknowledging) never races the banner.
  const windows = await sameOriginWindows();
  const foreground = windows.some((c) => c.visibilityState === 'visible' && c.focused === true);
  for (const c of windows) c.postMessage({ type: 'kawk-push', id: p.id, title: p.title, body: p.body, url: p.url, foreground, duplicate, displayed: displayError === null });
  if (displayError) throw displayError; // surfaces in the worker's console/waitUntil instead of being swallowed
}
self.addEventListener('push', (event) => { event.waitUntil(handlePush(event)); });

async function handleClick(event) {
  const data = (event.notification && event.notification.data) || {};
  const id = typeof data.id === 'string' && data.id ? data.id.slice(0, MAX_ID) : null;
  const target = new URL(sameOriginHref(data.url) || `${self.location.origin}/`);
  if (id) target.searchParams.set('notification', id);
  const windows = await sameOriginWindows();
  const pick = windows.find((c) => c.visibilityState === 'visible' && c.focused) || windows.find((c) => c.visibilityState === 'visible') || windows[0];
  if (pick) {
    if ('focus' in pick) { try { await pick.focus(); } catch { /* focus can be refused; the message still lands */ } }
    pick.postMessage({ type: 'kawk-notification-open', id, url: `${target.pathname}${target.search}` }); // no navigate(): a running capture must not be reloaded away
    return;
  }
  if (self.clients.openWindow) { try { await self.clients.openWindow(target.href); } catch { /* opening can be refused by the OS */ } }
}
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(handleClick(event)); });
