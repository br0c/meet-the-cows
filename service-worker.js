const APP_VERSION = '0.4.3-beta';
// Shell cache is versioned and replaced on app update. Data cache is stable so downloaded
// media/docs survive app updates (an app update must never wipe a pilot's offline pack).
const SHELL_CACHE = `mtc-shell-${APP_VERSION}`;
const DATA_CACHE = 'mtc-data';
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
  u('packs/fr-alps/media-manifest.json'),
];
const APP_SHELL_SET = new Set(APP_SHELL);
const PACK_CORE_SET = new Set(PACK_CORE);
const SCOPE_URL = new URL(SCOPE);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(APP_SHELL);
    const data = await caches.open(DATA_CACHE);
    await cacheOptional(data, PACK_CORE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Drop old shell caches; keep the current shell and the (unversioned) data cache.
    await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (!isSameScope(requestUrl)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(SHELL_CACHE, event.request, u('index.html')));
    return;
  }

  const key = requestUrl.toString();
  if (APP_SHELL_SET.has(key)) {
    event.respondWith(networkFirst(SHELL_CACHE, event.request));
    return;
  }
  if (PACK_CORE_SET.has(key)) {
    event.respondWith(networkFirst(DATA_CACHE, event.request));
    return;
  }
  if (isPackMediaOrDoc(requestUrl)) {
    event.respondWith(cacheOnlyFirst(DATA_CACHE, event.request));
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

async function networkFirst(cacheName, request, fallbackUrl = '') {
  const cache = await caches.open(cacheName);
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

async function cacheOnlyFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
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
