const APP_VERSION = '0.8.6-beta';
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

// How long a fresh answer gets to beat the cached one. The number serves the cockpit case: on a
// marginal connection a fetch does not fail, it HANGS — tens of seconds per file with one
// flickering bar — and every load below used to await it with no limit, so the app could take a
// minute to open in the air it is built for. Offline proper is unaffected (fetch rejects at
// once, the cache answers immediately, as before); this only caps how long "maybe" may stall a
// pilot who already has a working copy on the phone. The losing fetch is not cancelled — it
// finishes in the background and refreshes the cache for the next load.
const FRESH_RACE_MS = 3500;

// Names minted by scripts/hash_assets.py: a 10-hex content hash before the extension. The bytes
// cannot change under such a URL, so revalidating one is a round trip that can only confirm what
// the name already guarantees — these are answered from the cache outright.
const HASHED_ASSET_RE = /\.[0-9a-f]{10}\.(?:js|css)$/;

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const packData = isUnderPacksBase(requestUrl);
  if (!packData && !isSameScope(requestUrl)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(SHELL_CACHE, event.request, u('index.html'),
      { revalidate: true, raceMs: FRESH_RACE_MS, event }));
    return;
  }

  const key = requestUrl.toString();
  if (APP_SHELL_SET.has(key)) {
    if (HASHED_ASSET_RE.test(requestUrl.pathname)) {
      event.respondWith(cacheOnlyFirst(SHELL_CACHE, event.request, true));
      return;
    }
    // The unhashed shell (index, manifest, release notes, icon): never answered from a stale
    // HTTP cache entry whatever max-age the host decided — but never allowed to stall a pilot
    // who has a copy, either. Usually a conditional request and a 304.
    event.respondWith(networkFirst(SHELL_CACHE, event.request, '',
      { revalidate: true, raceMs: FRESH_RACE_MS, event }));
    return;
  }
  if (!packData) return;

  if (isPackCoreJson(requestUrl)) {
    // The same cap as the shell, for the same reason: the field list IS this data, and a pilot
    // opening the app in the air must get yesterday's packs.json in seconds, not this morning's
    // after a minute of stalling.
    event.respondWith(networkFirst(DATA_CACHE, event.request, '',
      { raceMs: FRESH_RACE_MS, event }));
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

const RACE_LOST = Symbol('race-lost');

async function networkFirst(cacheName, request, fallbackUrl = '', { revalidate = false, raceMs = 0, event = null } = {}) {
  const cache = await caches.open(cacheName);
  // 'no-cache' means "ask the server, but a 304 is fine" — not "download it again". Offline
  // this still rejects and the cached copy below answers, exactly as before.
  //
  // Rebuilt from the URL, not from the request: constructing a Request from one whose mode is
  // 'navigate' throws, so the old `new Request(request, …)` spelling silently made every
  // navigation cache-only — the throw landed in the catch below and the cached shell answered.
  // Nothing looked wrong, because the worker's own install refreshes the shell on every version
  // bump; but "revalidate" was a word this code said, not a thing it did. For a same-origin GET
  // the URL is the whole request, so this loses nothing.
  const network = (async () => {
    const response = await fetch(revalidate ? new Request(request.url, { cache: 'no-cache' }) : request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  })();

  if (raceMs) {
    const cached = await cache.match(request)
      || (fallbackUrl ? await cache.match(fallbackUrl) : null);
    if (cached) {
      // A rejected fetch (offline) resolves to null and loses instantly; only an actual response
      // inside the window wins. When the cache answers, the network fetch is deliberately left
      // running — event.waitUntil keeps the worker alive to finish it, so the cache is fresh for
      // the next load even though this one did not wait.
      const winner = await Promise.race([
        network.catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(RACE_LOST), raceMs)),
      ]);
      if (winner && winner !== RACE_LOST) return winner;
      const settle = network.catch(() => {});
      if (event) event.waitUntil(settle);
      return cached;
    }
  }

  try {
    return await network;
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

async function cacheOnlyFirst(cacheName, request, storeOnMiss = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // For hashed shell assets a miss means the install-time precache was lost (evicted, or a
  // failed partial install) — refill it so the next load is a hit again. Media keeps the old
  // behaviour: what lands in that cache is the download flow's decision, not a side effect.
  if (storeOnMiss && isCacheable(response)) await cache.put(request, response.clone());
  return response;
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
