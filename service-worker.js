const APP_VERSION = '0.9.0-beta';
// Shell cache is versioned and replaced on app update. Data cache is stable so downloaded
// media/docs survive app updates (an app update must never wipe a pilot's offline pack).
const SHELL_CACHE = `mtc-shell-${APP_VERSION}`;
const DATA_CACHE = 'mtc-data';
const SCOPE = self.registration.scope;
const u = path => new URL(path, SCOPE).toString();

// Deployment config, shared verbatim with the app (see config.js). A deployment that predates
// the file, or any failure to load it, must not break the worker — fall back to the built-in
// single-origin behaviour.
try {
  importScripts(u('config.js'));
} catch {
  self.MTC_CONFIG = self.MTC_CONFIG || {};
}
const CONFIG = self.MTC_CONFIG || {};

// Base that pack paths ("packs/…") resolve against: the app itself by default, or an R2
// domain whose layout mirrors the site. Kept as a URL so cross-origin pack requests are
// matched by prefix rather than by service-worker scope.
const DATA_BASE = new URL(withTrailingSlash(CONFIG.packsBase) || './', SCOPE);
const PACKS_BASE = new URL('packs/', DATA_BASE);

const APP_SHELL = [
  u('.'),
  u('index.html'),
  u('styles.css'),
  u('config.js'),
  u('src/app.js'),
  u('src/terrain.js'),
  // The glide solver is a Worker script: it is never imported by the shell, so nothing else
  // would ever pull it into the cache, and without it a downloaded pack loses terrain routing
  // exactly when there is no radio to fetch it.
  u('src/glide-worker.js'),
  u('manifest.webmanifest'),
  u('release-notes.json'),
  u('icons/icon.svg'),
];
// Just the pack index is precached; each selected pack's core JSON is cached network-first on
// first fetch (see isPackCoreJson), so any combination of packs works offline without hardcoding.
const PACK_CORE = [
  new URL('packs.json', PACKS_BASE).toString(),
];
const APP_SHELL_SET = new Set(APP_SHELL);
const SCOPE_URL = new URL(SCOPE);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // NOT cache.addAll: its fetches go through the browser's HTTP cache, so a host serving the
    // shell with a long max-age lets a brand-new worker fill its brand-new versioned cache with
    // the OLD build. That is not hypothetical — Cloudflare Pages serves these files with
    // max-age=14400, and 0.8.1 installed itself and then cached 0.8.0 for four hours.
    // 'reload' bypasses the HTTP cache on the way out and refreshes it on the way back.
    await Promise.all(APP_SHELL.map(async url => {
      const response = await fetch(url, { cache: 'reload' });
      if (!isCacheable(response)) throw new Error(`shell fetch failed: ${url} (${response.status})`);
      await shell.put(url, response);
    }));
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
  const packData = isUnderPacksBase(requestUrl);
  if (!packData && !isSameScope(requestUrl)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(SHELL_CACHE, event.request, u('index.html'), true));
    return;
  }

  const key = requestUrl.toString();
  if (APP_SHELL_SET.has(key)) {
    // revalidate: the shell must never be answered from a stale HTTP cache entry, whatever
    // max-age the host decided to put on it. Costs a conditional request and usually a 304.
    event.respondWith(networkFirst(SHELL_CACHE, event.request, '', true));
    return;
  }
  if (!packData) return;

  if (isPackCoreJson(requestUrl)) {
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
      if (isCacheable(response)) await cache.put(url, response.clone());
    } catch {
      // Local development may not have generated pack files yet.
    }
  }
}

async function networkFirst(cacheName, request, fallbackUrl = '', revalidate = false) {
  const cache = await caches.open(cacheName);
  try {
    // 'no-cache' means "ask the server, but a 304 is fine" — not "download it again". Offline
    // this still throws and falls through to the cached copy below, exactly as before.
    const response = await fetch(revalidate ? new Request(request, { cache: 'no-cache' }) : request);
    if (isCacheable(response)) await cache.put(request, response.clone());
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

// An opaque response (a no-cors <img>/<iframe> load of a cross-origin pack file) reports
// status 0, so response.ok is false even though the bytes are fine and replayable from the
// cache. Store those too, otherwise cross-origin media would never be available offline.
function isCacheable(response) {
  return !!response && (response.ok || response.type === 'opaque');
}

function withTrailingSlash(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.endsWith('/') ? text : `${text}/`;
}

function isSameScope(url) {
  return url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname);
}

function isUnderPacksBase(url) {
  return url.origin === PACKS_BASE.origin && url.pathname.startsWith(PACKS_BASE.pathname);
}

function packRelativePath(url) {
  return url.pathname.slice(PACKS_BASE.pathname.length);
}

// Any pack JSON (packs.json, or a pack's manifest/fields/media-manifest/state/translation-cache):
// cached network-first so the selected packs' data is available offline, whichever they are.
function isPackCoreJson(url) {
  const relativePath = packRelativePath(url);
  return relativePath.endsWith('.json')
    && !relativePath.includes('/media/') && !relativePath.includes('/docs/');
}

function isPackMediaOrDoc(url) {
  const relativePath = packRelativePath(url);
  return relativePath.includes('/media/') || relativePath.includes('/docs/');
}
