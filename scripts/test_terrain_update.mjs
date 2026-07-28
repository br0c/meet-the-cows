// Can a rebuilt terrain tile ever reach a phone that already holds the old one?
//
// Tile URLs carry the index's content hash (?v=…), so new bytes mean a new address and every
// cache in the chain — CDN, HTTP, Cache API — misses honestly instead of serving the old tile
// forever. This drives the three moments that matter:
//
//   1. a fresh download files tiles under versioned URLs only
//   2. tiles downloaded BEFORE versioning (bare URLs) are adopted in place when their bytes
//      match the index — no re-download of megabytes a pilot already paid for
//   3. a rebuilt tile (same key, new hash) is detected, fetched alone, and its predecessor swept
//
// Plus the pilot's way out: "Remove terrain" leaves no tile bytes behind.
//
//   node scripts/test_terrain_update.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const terrainDir = process.argv[2] || path.join(repo, 'data', 'packs', '_terrain');
if (!existsSync(path.join(terrainDir, 'index.json'))) {
  console.error(`No terrain index at ${terrainDir}.`);
  process.exit(2);
}

const ROOT = path.join(tmpdir(), `mtc-update-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.terr': 'application/octet-stream' };

// Two fields so the download target spans two tiles (N45E007, N46E007) — a one-field bbox is a
// point, and a one-tile download set cannot tell "fetched the rebuilt tile" from "fetched all".
const FIELDS = [
  { id: 'aosta', kind: 'airfield', name: 'Aosta', code: 'LIMW',
    latitude: 45.7383, longitude: 7.3686, elevationM: 545, difficulty: 'A' },
  { id: 'taesch', kind: 'outlanding', name: 'Täsch', code: '901',
    latitude: 46.02, longitude: 7.75, elevationM: 1450, difficulty: 'B' },
].map(f => ({ ...f, rawDifficulty: f.difficulty, lengthM: 800, widthM: 60,
  runwayDirectionDeg: 90, notes: '', media: [], source: { name: 'fixture' } }));

let indexJson = null; // served live, so a test step can "rebuild" a tile by editing it

async function buildFixture() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(path.join(ROOT, 'src'), { recursive: true });
  await mkdir(path.join(ROOT, 'packs', 'alps-test'), { recursive: true });
  for (const f of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
    'release-notes.json', 'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
  for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
    await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
  await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
  await cp(terrainDir, path.join(ROOT, 'packs', '_terrain'), { recursive: true });
  const index = JSON.parse(await readFile(path.join(ROOT, 'packs', '_terrain', 'index.json'), 'utf8'));
  const present = new Set((await readdir(path.join(ROOT, 'packs', '_terrain')))
    .filter(n => n.endsWith('.terr')).map(n => n.replace(/\.terr$/, '')));
  index.tiles = index.tiles.filter(t => present.has(t.key));
  index.tileCount = index.tiles.length;
  indexJson = index;
  await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));
  const fieldsJson = JSON.stringify(FIELDS);
  await writeFile(path.join(ROOT, 'packs', 'alps-test', 'fields.json'), fieldsJson);
  await writeFile(path.join(ROOT, 'packs', 'alps-test', 'manifest.json'), JSON.stringify({
    id: 'alps-test', name: 'Alps test', names: { en: 'Alps test' }, hidden: false, version: 'v1',
    generatedAt: 'x', isSample: false, fieldsUrl: 'fields.json', fieldsCount: FIELDS.length,
    mediaCount: 0, mediaFiles: 0, fieldsBytes: fieldsJson.length, sizeBytes: fieldsJson.length,
    selector: 't', sources: [], notices: [] }));
  await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
    schemaVersion: 2, updatedAt: 'x', packs: [{ id: 'alps-test', name: 'Alps test',
      names: { en: 'Alps test' }, hidden: false, manifestUrl: 'packs/alps-test/manifest.json',
      sizeBytes: 100, fieldsCount: FIELDS.length }] }));
}

const asked = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  asked.push(url.pathname + url.search);
  if (url.pathname.endsWith('/_terrain/index.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(indexJson));
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await buildFixture();
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const tileRequestsSince = mark => asked.slice(mark).filter(p => p.includes('.terr'));

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ locale: 'en-GB' });
// Seed once, not on every navigation: phase 4 turns the terrain switch OFF and reloads —
// a reseed would silently flip it back on and the automatic sync would then re-download
// everything the phase just cleared, which is exactly the bug shape the phase forbids.
await context.addInitScript(() => localStorage.getItem('mtc-settings-v2') || localStorage.setItem('mtc-settings-v2', JSON.stringify({
  packIds: ['alps-test'], language: 'en', safetyMarginM: 250, showC: true, showD: true,
  testMode: true, testLatitude: 45.9356, testLongitude: 7.6304,
  testAltitudeM: 2800, testLabel: 'Cervinia', terrainRouting: true,
  terrainAcknowledged: true, terrainClearanceM: 200,
})));
const page = await context.newPage();
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 15000 });

/** The .terr entries currently in the app's data cache, as pathname?query strings. */
const cachedTiles = () => page.evaluate(async () => {
  const cache = await caches.open('mtc-data');
  return (await cache.keys()).map(r => { const u = new URL(r.url); return u.pathname + u.search; })
    .filter(p => p.includes('.terr')).sort();
});

/** Tiles download themselves on open; the card shows no counts any more, so completeness is
 *  read where it lives: every tile the index names, cached at its versioned URL. */
async function waitForTerrainSynced() {
  await page.click('#settingsToggle');
  await page.waitForFunction(async expected => {
    const cache = await caches.open('mtc-data');
    const tiles = (await cache.keys()).filter(r => r.url.includes('.terr'));
    return tiles.length === expected && tiles.every(r => /\?v=[0-9a-f]{10}$/.test(r.url));
  }, indexJson.tiles.length, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
}
const closeSettings = async () => { await page.click('#settingsToggle').catch(() => {});
  await page.waitForSelector('.field-row'); };

// --- 1. fresh download: versioned URLs only ------------------------------------------------------
console.log('\n1 — the automatic sync files every tile under its versioned address');
{
  await waitForTerrainSynced();
  const tiles = await cachedTiles();
  check('every cached tile URL carries ?v=', tiles.length > 0 && tiles.every(p => /\?v=[0-9a-f]{10}$/.test(p)),
    tiles.slice(0, 3).join(' '));
  check('the versions are the index hashes', tiles.every(p => {
    const key = p.split('/').pop().split('.terr')[0];
    const entry = indexJson.tiles.find(t => t.key === key);
    return entry && p.endsWith(`?v=${entry.sha256.slice(0, 10)}`);
  }));
  check('the cache holds the full index set', tiles.length === indexJson.tiles.length);
}

// --- 2. legacy adoption: pre-versioning downloads are re-filed, not re-fetched -------------------
console.log('\n2 — tiles downloaded before versioning are adopted in place, free of charge');
{
  // Rewind the cache to the legacy layout: same bytes, bare URLs.
  await page.evaluate(async () => {
    const cache = await caches.open('mtc-data');
    for (const request of await cache.keys()) {
      const u = new URL(request.url);
      if (!u.pathname.endsWith('.terr') || !u.search) continue;
      const response = await cache.match(request);
      const bytes = await response.arrayBuffer();
      await cache.put(u.origin + u.pathname, new Response(bytes,
        { headers: { 'content-type': 'application/octet-stream' } }));
      await cache.delete(request);
    }
  });
  const before = await cachedTiles();
  check('setup: every entry is back on its bare URL', before.length > 0 && before.every(p => !p.includes('?')));

  const mark = asked.length;
  // Opening Settings runs the status check, which is where adoption lives.
  await closeSettings();
  await page.click('#settingsToggle');
  await page.waitForSelector('#terrainRouting', { timeout: 8000 });
  await page.waitForFunction(async () => {
    const cache = await caches.open('mtc-data');
    return (await cache.keys()).filter(r => r.url.includes('.terr'))
      .every(r => r.url.includes('?v='));
  }, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const after = await cachedTiles();
  check('every tile is re-filed under its versioned URL', after.length === before.length
    && after.every(p => /\?v=[0-9a-f]{10}$/.test(p)), after.slice(0, 3).join(' '));
  check('no bare entries survive', after.every(p => p.includes('?v=')));
  check('not one tile crossed the network for it', tileRequestsSince(mark).length === 0,
    tileRequestsSince(mark).join(' '));
}

// --- 3. a rebuilt tile: reaches the next solve, predecessor swept --------------------------------
console.log('\n3 — a rebuilt tile: stale serves free until the pilot downloads, then nothing lingers');
{
  const victim = indexJson.tiles.find(t => t.key === 'N45E007');
  const oldVersion = victim.sha256.slice(0, 10);
  await closeSettings();

  // Put the CURRENT index into DATA_CACHE under service-worker control first. This is the state
  // every real launch after the first is in — and the state this phase silently depended on NOT
  // having: an uncontrolled first-load fetch usually left the cache empty, the rebuilt index
  // arrived fresh, and the phase passed without ever exercising the stale path. When the
  // first-load race went the other way (about one run in ten), the app served the old index all
  // session and four checks failed. Forcing the ordering makes the phase test the mechanism
  // that actually protects pilots: the worker's changed-index report.
  await page.reload();
  await page.waitForSelector('.field-row', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // "Rebuild" the tile: the index now claims different bytes. (The served bytes stay the same —
  // what is under test is the addressing, not the decoder.)
  victim.sha256 = 'b'.repeat(64);

  const mark = asked.length;
  // On reload the worker serves the CACHED (pre-rebuild) index — cache-first is the point — and
  // its background refresh finds the change and reports it; the app must pick the rebuild up in
  // THIS session, not the next one. The solve must SERVE the superseded tile rather than fetch
  // the new one — spending a pilot's bytes is the download button's explicit doing, never a
  // solve's — and it must keep routing: yesterday's ground beats no ground.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.field-glide.routed') !== null,
    null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1000);
  check('the glide still routes, on the superseded tile',
    (await page.$('.field-glide.routed')) !== null);
  // The automatic sync may already have fetched the REBUILT tile at its new address by now —
  // that is its job. What the solve must never do is spend bytes itself: no old-address
  // fetch, no other tile, ever.
  const duringSolve = tileRequestsSince(mark);
  check('nothing but the rebuilt tile at its new address ever crossed the network',
    duringSolve.every(pth => pth.includes('N45E007.terr?v=bbbbbbbbbb')), duringSolve.join(' '));

  // The worker's report is what updates the app: assert the app's own index moved to the new
  // version without a further reload.
  await page.waitForFunction(() =>
    window.__mtcState?.terrain?.store?.tileVersions?.get('N45E007') === 'bbbbbbbbbb',
    null, { timeout: 10000 }).catch(() => {});
  check('the changed-index report reaches the app in this session',
    (await page.evaluate(() => window.__mtcState?.terrain?.store?.tileVersions?.get('N45E007'))) === 'bbbbbbbbbb');

  // The report also triggers the automatic sync: the rebuilt tile downloads itself, in this
  // session, with nobody pressing anything — that is the whole point of shipping terrain by
  // default. Wait for the cache to hold the new bytes, then account for the network exactly.
  await page.waitForFunction(async () => {
    const cache = await caches.open('mtc-data');
    return (await cache.keys()).some(r => r.url.includes('N45E007.terr?v=bbbbbbbbbb'));
  }, null, { timeout: 15000 }).catch(() => {});
  const fetched = tileRequestsSince(mark);
  check('the sync fetched exactly the rebuilt tile, at its new address, once',
    fetched.length === 1 && fetched[0].includes(`${victim.key}.terr?v=bbbbbbbbbb`), fetched.join(' '));
  await page.click('#settingsToggle');
  await page.waitForTimeout(500);

  const tiles = await cachedTiles();
  const victimEntries = tiles.filter(p => p.includes(`${victim.key}.terr`));
  check('the cache holds the new version of that tile, and only it',
    victimEntries.length === 1 && victimEntries[0].endsWith('?v=bbbbbbbbbb'), victimEntries.join(' '));
  check('no entry still carries the superseded version', !tiles.some(p => p.endsWith(`?v=${oldVersion}`)));
}

// --- 3b. the AGL reference lives and dies with the downloaded tiles ------------------------------
console.log('\n3b — AGL: available over downloaded terrain, gone when the tiles go');
{
  // Tiles for Cervinia are on the phone, so the ground under the simulated place is known.
  await page.waitForSelector('#altUnitAgl:not([disabled])', { timeout: 5000 });
  check('AGL becomes available once terrain covers the place', true);
  await page.click('#altUnitAgl');
  await page.waitForTimeout(400);
  check('the note translates between the references',
    /(Ground here|Sol ici|Boden hier)/.test(await page.$eval('#testAltitudeNote', el => el.textContent)),
    await page.$eval('#testAltitudeNote', el => el.textContent));
  check('the readout says which zero it counts from',
    /AGL$/.test(await page.$eval('#testAltitudeValue', el => el.textContent.trim())),
    await page.$eval('#testAltitudeValue', el => el.textContent));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mtc-settings-v2')));
  check('the absolute altitude follows ground + AGL', stored.testAltitudeMode === 'agl'
    && Math.abs(stored.testAltitudeM - (stored.testAglM + 2005)) < 40,
    `${stored.testAltitudeM} m stored for ${stored.testAglM} m AGL`);
  // The AMSL track must start at the ground, not at the sea: underground is not a position a
  // glide can be computed from, and every field coming back unreachable with no visible reason
  // is the worst way to learn that.
  await page.click('#altUnitAmsl');
  await page.waitForTimeout(300);
  const track = await page.$eval('#testAltitudeM', el => ({ min: Number(el.min), value: Number(el.value) }));
  check('the AMSL slider starts at the ground, not at 0', track.min === 2100,
    `min ${track.min} m (Cervinia ground 2010 m, rounded up to the 100 m step)`);
  check('and the floor is a round number, so round altitudes stay selectable',
    track.min % 100 === 0, `min ${track.min}`);
  check('and the handle cannot already be below it', track.value >= track.min,
    `value ${track.value} vs min ${track.min}`);
  // Driving it under the floor by hand must not stick.
  await page.$eval('#testAltitudeM', el => {
    el.value = 500;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const stored500 = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mtc-settings-v2')))).testAltitudeM;
  check('an altitude forced below the ground is lifted back to the floor', stored500 === 2100,
    `${stored500} m stored`);

  // Back to the altitude the remaining phases were written for.
  await page.click('#altUnitAmsl');
  await page.waitForTimeout(200);
  // The floor is rounded to the step, so round altitudes are on the track and 2800 is reachable
  // exactly. Still asserted against the handle as well as the literal: the two agreeing is the
  // property worth holding if the step or the rounding ever moves.
  await page.$eval('#testAltitudeM', el => {
    el.value = 2800;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const handle = await page.$eval('#testAltitudeM', el => Number(el.value));
  const storedAlt = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mtc-settings-v2')))).testAltitudeM;
  check('back on AMSL, and a round altitude is reachable exactly',
    storedAlt === handle && storedAlt === 2800, `${storedAlt} m / handle ${handle}`);
}

// --- 4. routing off means off ---------------------------------------------------------------------
console.log('\n4 — with routing off, cleared tiles stay gone: the automatic sync respects the switch');
{
  // There is no remove button any more — terrain manages itself — so clear the cache the way
  // an eviction or a fresh device would. With the switch OFF the automatic sync must not
  // spend a byte bringing any of it back.
  await page.uncheck('#terrainRouting');
  await page.waitForTimeout(500);
  // The switch is policy, the cache is data, and they are deliberately disconnected: turning
  // the feature off must not cost a pilot their downloaded tiles (or the re-download).
  check('switching terrain off leaves every cached tile alone',
    (await cachedTiles()).length === 2);
  await page.evaluate(async () => {
    const cache = await caches.open('mtc-data');
    for (const request of await cache.keys()) {
      if (new URL(request.url).pathname.endsWith('.terr')) await cache.delete(request);
    }
  });
  // A fresh open is the moment the sync would run if it were going to: reload with the
  // switch off and give it every chance to misbehave.
  await page.reload();
  await page.waitForSelector('.field-row', { timeout: 20000 });
  await page.waitForTimeout(3000);
  const tiles = await cachedTiles();
  check('the cache holds no tiles at all', tiles.length === 0, tiles.slice(0, 3).join(' '));
  await page.click('#settingsToggle');
  await page.waitForTimeout(1000);
  check('and nothing trickles back with routing off', (await cachedTiles()).length === 0);
  // The ground under the simulated place is unknown again — AGL must grey out and the altitude
  // must be read against sea level, not against ground that is no longer there.
  check('AGL greys out with the tiles gone', await page.$eval('#altUnitAgl', el => el.disabled));
  check('the reference falls back to AMSL', await page.$eval('#altUnitAmsl', el => el.classList.contains('active')));
}

await context.close();
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
