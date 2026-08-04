const APP_VERSION = '0.8.12-beta';
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

// Aerodrome charts come from a Worker rather than the pack tree (private bucket — most charts
// carry no redistribution right), and each request carries a short-lived token in the query.
// The token is deliberately NOT part of the cache key: a chart cached an hour ago must still
// answer a request made with this hour's token, offline, with no way to mint a new one.
const CHARTS_BASE = CONFIG.chartsBase ? new URL(withTrailingSlash(CONFIG.chartsBase)) : null;
const CHARTS_PREFIX = CHARTS_BASE ? new URL('charts/', CHARTS_BASE) : null;
const CHART_TOKEN_PATH = CHARTS_PREFIX ? `${CHARTS_PREFIX.pathname}token` : '';

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

// Told to the page when a background refresh finds the published pack data has moved. Kept in
// step with the listener in src/app.js.
const PACK_CHANGED = 'mtc-pack-changed';
// Same idea for the release notes. Cache-first means the copy this page read is the one from
// before the deploy; without this the app would only show the new notes on the NEXT launch, and
// an installed PWA that resumes rather than relaunches may not have a next launch for days.
const NOTES_CHANGED = 'mtc-notes-changed';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // NOT cache.addAll: its fetches go through the browser's HTTP cache, so a host serving the
    // shell with a long max-age lets a brand-new worker fill its brand-new versioned cache with
    // the OLD build. That is not hypothetical: on a host that served these files with
    // max-age=14400, 0.8.1 installed itself and then cached 0.8.0 for four hours.
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

// How long to wait for the network when there is NOTHING cached to fall back on. On a marginal
// connection a fetch does not fail, it hangs, so a first-ever visit with one flickering bar would
// otherwise sit on a blank page indefinitely. Anything already cached never waits this long — it
// never waits at all; see cacheFirst.
const FRESH_RACE_MS = 3500;

// Names minted by scripts/hash_assets.py: a 10-hex content hash before the extension. The bytes
// cannot change under such a URL, so revalidating one is a round trip that can only confirm what
// the name already guarantees — these are answered from the cache outright.
const HASHED_ASSET_RE = /\.[0-9a-f]{10}\.(?:js|css)$/;

// Files whose CONTENT decides whether the pilot is offered new field data. A background
// revalidation that finds one of these changed is worth telling the app about; a changed
// fields.json is not, because its pack's manifest version moves with it.
const VERSION_BEARING_RE = /\/(?:packs\.json|manifest\.json)$/;

// The shell file whose content the app displays rather than merely uses, so a background
// refresh that changes it is worth reporting.
const NOTES_BEARING_RE = /\/release-notes\.json$/;

// The terrain index is version-bearing too: it names which tile bytes are current, and it is
// the one such file this list originally missed. Without the report, the app ran every session
// on the PREVIOUS session's index — cache-first served the old copy, the background refresh
// quietly updated the cache, and Settings counted rebuilt tiles as still current until the next
// launch. Same contract as PACK_CHANGED: the worker only says it moved; re-reading is the app's
// decision, and the re-read is answered from the cache this refresh just wrote.
const TERRAIN_INDEX_RE = /\/_terrain\/index\.json$/;
const TERRAIN_CHANGED = 'mtc-terrain-index-changed';

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  // Charts before anything else: they are neither in scope nor under the packs base, and the
  // token endpoint must always reach the network — a cached token is a token that has expired.
  if (isChartRequest(requestUrl)) {
    if (requestUrl.pathname !== CHART_TOKEN_PATH) event.respondWith(chartCacheFirst(event.request));
    return;
  }
  const packData = isUnderPacksBase(requestUrl);
  if (!packData && !isSameScope(requestUrl)) return;

  // Everything below is cache-first when a copy exists, and refreshes that copy in the
  // background. The reason is the whole point of the app: a pilot opening it in the air has
  // already downloaded what they need, and asking the radio first meant a stalled connection —
  // strictly worse than no connection — held a fully-working app behind six sequential timeouts.
  // What the network can still do is update the cache for next time, and say when the published
  // field data has moved so the app can offer it. Neither needs anyone to wait.
  if (event.request.mode === 'navigate') {
    event.respondWith(cacheFirst(SHELL_CACHE, event.request,
      { fallbackUrl: u('index.html'), revalidate: true, event }));
    return;
  }

  const key = requestUrl.toString();
  if (APP_SHELL_SET.has(key)) {
    // A hashed asset cannot change under its name, so it is not even revalidated.
    if (HASHED_ASSET_RE.test(requestUrl.pathname)) {
      event.respondWith(cacheOnlyFirst(SHELL_CACHE, event.request, true));
      return;
    }
    event.respondWith(cacheFirst(SHELL_CACHE, event.request, {
      revalidate: true,
      notify: NOTES_BEARING_RE.test(requestUrl.pathname) ? NOTES_CHANGED : '',
      event,
    }));
    return;
  }
  if (!packData) return;

  if (isPackCoreJson(requestUrl)) {
    const notify = VERSION_BEARING_RE.test(requestUrl.pathname) ? PACK_CHANGED
      : TERRAIN_INDEX_RE.test(requestUrl.pathname) ? TERRAIN_CHANGED : '';
    event.respondWith(cacheFirst(DATA_CACHE, event.request, { notify, event }));
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

/**
 * Answer from the cache when there is a copy, and refresh that copy in the background.
 *
 * The cached branch never touches the network before responding, which is the difference
 * between an app that opens in the air and one that does not: the request may still be made,
 * but nobody waits on it. event.waitUntil keeps the worker alive long enough to finish it.
 *
 * `notify` is the message type to post when a background refresh actually changed something, so
 * the app can offer the pilot the new data rather than swapping the list out from under them.
 *
 * With no cached copy there is nothing to serve and the network has to be awaited — bounded by
 * FRESH_RACE_MS, because a hanging fetch on a first visit is a blank page for as long as it hangs.
 */
async function cacheFirst(cacheName, request, { fallbackUrl = '', revalidate = false, notify = '', event = null } = {}) {
  const cache = await caches.open(cacheName);

  // 'no-cache' means "ask the server, but a 304 is fine" — not "download it again". Rebuilt from
  // the URL, not the request: constructing a Request from one whose mode is 'navigate' throws.
  const refresh = async previous => {
    const response = await fetch(revalidate ? new Request(request.url, { cache: 'no-cache' }) : request);
    if (!isCacheable(response)) return response;
    if (notify && previous && await bodiesDiffer(previous, response.clone())) {
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) client.postMessage({ type: notify, url: request.url });
    }
    await cache.put(request, response.clone());
    return response;
  };

  const cached = await cache.match(request)
    || (fallbackUrl ? await cache.match(fallbackUrl) : null);
  if (cached) {
    // Snapshot before returning: the page consumes `cached`, and the comparison runs later.
    const previous = cached.clone();
    if (event) event.waitUntil(refresh(previous).catch(() => {}));
    else refresh(previous).catch(() => {});
    return cached;
  }

  const network = refresh(null);
  const winner = await Promise.race([
    network.catch(() => RACE_LOST),
    new Promise(resolve => setTimeout(() => resolve(RACE_LOST), FRESH_RACE_MS)),
  ]);
  if (winner !== RACE_LOST) return winner;
  if (event) event.waitUntil(network.catch(() => {}));
  // Nothing cached and nothing arrived: let the failure be the failure. Awaiting the fetch is
  // what surfaces the real network error to the page rather than inventing one.
  return network;
}

/** Did a background refresh actually change anything? ETag when the host offers one, else bytes. */
async function bodiesDiffer(previous, fresh) {
  const before = previous.headers.get('etag');
  const after = fresh.headers.get('etag');
  if (before && after) return before !== after;
  try {
    return (await previous.text()) !== (await fresh.text());
  } catch {
    return false;
  }
}

function isChartRequest(url) {
  return !!CHARTS_PREFIX && url.origin === CHARTS_PREFIX.origin
    && url.pathname.startsWith(CHARTS_PREFIX.pathname);
}

/**
 * A chart: answered from the cache whatever token the request carries, and stored without one.
 *
 * Both halves matter. Matching with ignoreSearch is what lets a downloaded chart open in the
 * air, where the token has long expired and no request for a new one can succeed. Storing
 * under the token-free URL is what keeps the app's own bookkeeping — the download targets,
 * the "N of M cached" count, the stale-media eviction — able to recognise its own files.
 */
async function chartCacheFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const canonical = new URL(request.url);
    canonical.search = '';
    await cache.put(canonical.toString(), response.clone());
  }
  return response;
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
