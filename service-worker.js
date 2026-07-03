const CACHE_NAME = 'meet-the-cows-0.3.11-beta';
const SCOPE = self.registration.scope;
const u = path => new URL(path, SCOPE).toString();
const APP_SHELL = [
  u('.'),
  u('index.html'),
  u('styles.css'),
  u('src/app.js'),
  u('manifest.webmanifest'),
  u('icons/icon.svg'),
  u('data/packs/index.json'),
  u('data/packs/fr-alps/manifest.json'),
  u('data/packs/fr-alps/fields.json'),
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      if (event.request.mode === 'navigate') return cache.match(u('index.html'));
      throw error;
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_URLS') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    let ok = true;
    for (const url of event.data.urls || []) {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response.clone());
        else ok = false;
      } catch {
        ok = false;
      }
    }
    event.ports?.[0]?.postMessage({ ok });
  })());
});
