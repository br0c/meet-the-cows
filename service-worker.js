const CACHE_NAME = 'meet-the-cows-0.3.16-beta';
const SCOPE = self.registration.scope;
const u = path => new URL(path, SCOPE).toString();
const APP_SHELL = [
  u('.'),
  u('index.html'),
  u('styles.css'),
  u('src/app.js'),
  u('manifest.webmanifest'),
  u('icons/icon.svg'),
];
const PACK_CORE = [
  u('packs/packs.json'),
  u('packs/fr-alps/manifest.json'),
  u('packs/fr-alps/fields.json'),
];
const PRECACHE_URLS = [...APP_SHELL, ...PACK_CORE];
const PRECACHE_URL_SET = new Set(PRECACHE_URLS);
const SCOPE_URL = new URL(SCOPE);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await cacheOptional(cache, PACK_CORE);
    await self.skipWaiting();
  })());
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

  const requestUrl = new URL(event.request.url);
  if (!isSameScope(requestUrl)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, u('index.html')));
    return;
  }

  if (PRECACHE_URL_SET.has(requestUrl.toString())) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (isPackMediaOrDoc(requestUrl)) {
    event.respondWith(cacheOnlyFirst(event.request));
  }
});

async function cacheOptional(cache, urls) {
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response.clone());
    } catch {
      // Local development may not have generated pack files yet.
    }
  }
}

async function networkFirst(request, fallbackUrl = '') {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function cacheOnlyFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  return fetch(request);
}

function isSameScope(url) {
  return url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname);
}

function isPackMediaOrDoc(url) {
  const relativePath = url.pathname.slice(SCOPE_URL.pathname.length);
  return relativePath.startsWith('packs/')
    && (relativePath.includes('/media/') || relativePath.includes('/docs/'));
}
