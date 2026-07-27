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
await context.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
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

async function pressDownload() {
  await page.click('#settingsToggle');
  await page.waitForSelector('#downloadTerrain:not([disabled])', { timeout: 8000 });
  await page.click('#downloadTerrain');
  await page.waitForFunction(() => {
    const dl = document.querySelector('#downloadTerrain');
    return dl && /of|sur|von/.test(document.body.textContent || '');
  }, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(4000);
}
const closeSettings = async () => { await page.click('#settingsToggle').catch(() => {});
  await page.waitForSelector('.field-row'); };

// --- 1. fresh download: versioned URLs only ------------------------------------------------------
console.log('\n1 — a fresh download files every tile under its versioned address');
{
  await pressDownload();
  const tiles = await cachedTiles();
  check('every cached tile URL carries ?v=', tiles.length > 0 && tiles.every(p => /\?v=[0-9a-f]{10}$/.test(p)),
    tiles.slice(0, 3).join(' '));
  check('the versions are the index hashes', tiles.every(p => {
    const key = p.split('/').pop().split('.terr')[0];
    const entry = indexJson.tiles.find(t => t.key === key);
    return entry && p.endsWith(`?v=${entry.sha256.slice(0, 10)}`);
  }));
  const offline = await page.$eval('.settings-card:has(#downloadTerrain)', el => el.innerText);
  check('settings reports the full set offline', /(\d+) (of|sur|von) \1/.test(offline),
    (offline.match(/\d+ (?:of|sur|von) \d+[^\n]*/) || [''])[0]);
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
  await page.waitForSelector('#downloadTerrain', { timeout: 8000 });
  await page.waitForFunction(() => /\d+ (of|sur|von) \d+/.test(
    document.querySelector('.settings-card:has(#downloadTerrain)')?.innerText || ''),
    null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const after = await cachedTiles();
  check('every tile is re-filed under its versioned URL', after.length === before.length
    && after.every(p => /\?v=[0-9a-f]{10}$/.test(p)), after.slice(0, 3).join(' '));
  check('no bare entries survive', after.every(p => p.includes('?v=')));
  check('not one tile crossed the network for it', tileRequestsSince(mark).length === 0,
    tileRequestsSince(mark).join(' '));
  const offline = await page.$eval('.settings-card:has(#downloadTerrain)', el => el.innerText);
  check('settings counts the adopted set as offline', /(\d+) (of|sur|von) \1/.test(offline),
    (offline.match(/\d+ (?:of|sur|von) \d+[^\n]*/) || [''])[0]);
}

// --- 3. a rebuilt tile: reaches the next solve, predecessor swept --------------------------------
console.log('\n3 — a rebuilt tile: stale serves free until the pilot downloads, then nothing lingers');
{
  const victim = indexJson.tiles.find(t => t.key === 'N45E007');
  const oldVersion = victim.sha256.slice(0, 10);
  // "Rebuild" the tile: the index now claims different bytes. (The served bytes stay the same —
  // what is under test is the addressing, not the decoder.)
  victim.sha256 = 'b'.repeat(64);

  await closeSettings();
  const mark = asked.length;
  // The index is fetched no-cache on load, so a reload is the moment a real pilot picks the
  // rebuild up. The solve that follows must SERVE the superseded tile rather than fetch the new
  // one — spending a pilot's bytes is the download button's explicit doing, never a solve's —
  // and it must keep routing: yesterday's ground beats no ground.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.field-glide.routed') !== null,
    null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1000);
  check('the glide still routes, on the superseded tile',
    (await page.$('.field-glide.routed')) !== null);
  check('and the solve paid nothing over the network for it', tileRequestsSince(mark).length === 0,
    tileRequestsSince(mark).join(' '));

  await page.click('#settingsToggle');
  await page.waitForFunction(() => /\d+ (of|sur|von) \d+/.test(
    document.querySelector('.settings-card:has(#downloadTerrain)')?.innerText || ''),
    null, { timeout: 8000 }).catch(() => {});
  const before = await page.$eval('.settings-card:has(#downloadTerrain)', el => el.innerText);
  check('settings counts the rebuilt tile as out of date', /1 (of|sur|von) 2/.test(before),
    (before.match(/\d+ (?:of|sur|von) \d+[^\n]*/) || [''])[0]);

  const downloadMark = asked.length;
  await page.click('#downloadTerrain');
  await page.waitForTimeout(4000);
  const fetched = tileRequestsSince(downloadMark);
  check('the download fetched exactly the rebuilt tile, at its new address',
    fetched.length === 1 && fetched[0].includes(`${victim.key}.terr?v=bbbbbbbbbb`), fetched.join(' '));

  const tiles = await cachedTiles();
  const victimEntries = tiles.filter(p => p.includes(`${victim.key}.terr`));
  check('the cache holds the new version of that tile, and only it',
    victimEntries.length === 1 && victimEntries[0].endsWith('?v=bbbbbbbbbb'), victimEntries.join(' '));
  check('no entry still carries the superseded version', !tiles.some(p => p.endsWith(`?v=${oldVersion}`)));
  const offline = await page.$eval('.settings-card:has(#downloadTerrain)', el => el.innerText);
  check('settings counts the set current again', /2 (of|sur|von) 2/.test(offline),
    (offline.match(/\d+ (?:of|sur|von) \d+[^\n]*/) || [''])[0]);
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
  check('the AMSL slider starts at the ground, not at 0', track.min > 1900 && track.min < 2100,
    `min ${track.min} m (Cervinia ground ~2010 m)`);
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
  check('an altitude forced below the ground is lifted back to it', stored500 >= 1900,
    `${stored500} m stored`);

  // Back to the altitude the remaining phases were written for.
  await page.click('#altUnitAmsl');
  await page.waitForTimeout(200);
  // Note the slider now steps FROM the ground, so the reachable values are ground + n*100 rather
  // than round hundreds — asking for 2800 over 2010 m of ground lands on 2810. Assert the stored
  // altitude agrees with the handle, which is the property that matters, not a literal.
  await page.$eval('#testAltitudeM', el => {
    el.value = 2800;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const handle = await page.$eval('#testAltitudeM', el => Number(el.value));
  const storedAlt = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mtc-settings-v2')))).testAltitudeM;
  check('back on AMSL, and the stored altitude matches the handle',
    storedAlt === handle && storedAlt >= 2800 && storedAlt < 2900, `${storedAlt} m / handle ${handle}`);
}

// --- 4. remove terrain ---------------------------------------------------------------------------
console.log('\n4 — with routing off, "Remove terrain" leaves no tile bytes behind');
{
  // Routing off first: with it on, the next online solve would legitimately re-fetch what it
  // needs, which is the documented behaviour — the durable "give me my storage back" flow is
  // switch off, then remove.
  await page.uncheck('#terrainRouting');
  await page.waitForSelector('#removeTerrain', { timeout: 5000 });
  await page.click('#removeTerrain');
  await page.waitForTimeout(2000);
  const tiles = await cachedTiles();
  check('the cache holds no tiles at all', tiles.length === 0, tiles.slice(0, 3).join(' '));
  check('the remove button withdraws once there is nothing to remove',
    (await page.$('#removeTerrain')) === null);
  const offline = await page.$eval('.settings-card:has(#downloadTerrain)', el => el.innerText)
    .catch(() => '');
  check('settings reports nothing offline', /0 (of|sur|von) \d+/.test(offline),
    (offline.match(/\d+ (?:of|sur|von) \d+[^\n]*/) || [''])[0]);
  await page.waitForTimeout(2000);
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
