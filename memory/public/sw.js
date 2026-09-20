// KAWK memory+agent service worker: network-first app shell only.
// Never intercepts or caches API, sockets, media, proxied lab resources or any response that could carry
// private data: /api/*, /ws/*, /v1/*, /static/*. Offline shows the cached shell; it never fakes an upload
// or an agent answer. No push handling here: phone push/hardware delivery is not verified for this page.
const VERSION = 'kawk-memory-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/client.js', '/manifest.webmanifest', '/icons/icon.svg'];

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
  if (p.startsWith('/api/') || p.startsWith('/ws/') || p.startsWith('/v1/') || p.startsWith('/static/')) return; // never touched
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
