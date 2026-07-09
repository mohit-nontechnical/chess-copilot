// Chess Copilot service worker — offline shell, always-fresh data.
const CACHE = 'cc-shell-v1';
const SHELL = ['/', '/index.html', '/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API / auth — always live.
  if (url.pathname.startsWith('/api/')) return;
  // Navigations: network-first so UI updates ship, fall back to cached shell offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  // Static assets: cache-first.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
