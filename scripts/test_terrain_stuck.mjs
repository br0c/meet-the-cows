// How terrain routing gets stuck, and which refreshes recover it.
//
// Written after a dev app came back with no terrain calculation at all and a restart fixed it.
// The suspicion: refreshTerrainRoutes sets terrain.status = 'solving' and then guards its own
// entry on `terrain.status === 'solving'`, with nothing anywhere that times that out. If a solve
// is ever started and never answered, every later refresh returns at that guard and routing is
// dead for the life of the page.
//
// The scenarios below drive the REAL GPS path — navigator.geolocation.watchPosition, which
// app.js calls refreshTerrainRoutes from directly with no invalidate — because the simulated-
// position path calls invalidateTerrainRoutes first and so papers over exactly the bug in
// question. Positions carry an altitude, which Playwright's own setGeolocation cannot express.
//
// The worker is killed with terminate(): silent, no 'error' event, no reply. That is what an OS
// does to a backgrounded PWA's worker, and it is the case the app has no answer for.
//
//   node scripts/test_terrain_stuck.mjs [terrainDir]

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const terrainDir = process.argv[2] || path.join(repo, 'data', 'packs', '_terrain');
const ROOT = path.join(tmpdir(), `mtc-stuck-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.terr': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };

if (!existsSync(path.join(terrainDir, 'index.json'))) {
  console.error(`No terrain index at ${terrainDir}. Build tiles first:\n` +
    '  python scripts/build_terrain_tiles.py --bbox 44 6 47 9 --out data/packs');
  process.exit(2);
}

const LAT = 45.5, LON = 7.0, ALT = 3500;
const WATCHDOG_MS = 30000;   // must match TERRAIN_SOLVE_TIMEOUT_MS in app.js

// A modest ring of fields around the start, low enough to be reachable from 3500 m.
const FIELDS = Array.from({ length: 40 }, (_, i) => {
  const km = 5 + (i % 8) * 2.5;
  const ang = i * 2.399;
  return {
    id: `f${String(i).padStart(3, '0')}`,
    name: `Field ${String(i).padStart(3, '0')}`,
    kind: 'outlanding', code: '', difficulty: 'A', rawDifficulty: 'A',
    latitude: Number((LAT + (km * Math.cos(ang)) / 111.32).toFixed(6)),
    longitude: Number((LON + (km * Math.sin(ang)) / (111.32 * Math.cos(LAT * Math.PI / 180))).toFixed(6)),
    elevationM: 600 + (i % 5) * 80,
    lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
    source: { name: 'fixture' },
  };
});

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
await mkdir(path.join(ROOT, 'packs', 'fixture'), { recursive: true });
for (const f of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
  'release-notes.json', 'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await cp(terrainDir, path.join(ROOT, 'packs', '_terrain'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));
const fieldsJson = JSON.stringify(FIELDS);
await writeFile(path.join(ROOT, 'packs', 'fixture', 'fields.json'), fieldsJson);
await writeFile(path.join(ROOT, 'packs', 'fixture', 'manifest.json'), JSON.stringify({
  id: 'fixture', name: 'Fixture', names: { en: 'Fixture' }, hidden: false, version: 'v1',
  generatedAt: 'x', isSample: false, fieldsUrl: 'fields.json', fieldsCount: FIELDS.length,
  mediaCount: 0, mediaFiles: 0, fieldsBytes: fieldsJson.length, sizeBytes: fieldsJson.length,
  selector: 't', sources: [], notices: [] }));
await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
  schemaVersion: 2, updatedAt: 'x', packs: [{ id: 'fixture', name: 'Fixture',
    names: { en: 'Fixture' }, hidden: false, manifestUrl: 'packs/fixture/manifest.json',
    sizeBytes: 100, fieldsCount: FIELDS.length }] }));

// Lets a scenario make tile reads fail on demand, to stand in for a flaky cache or storage.
let breakTiles = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (breakTiles && url.pathname.endsWith('.terr')) { res.writeHead(503); res.end('nope'); return; }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// Replaces geolocation with something we can step, and makes every Worker killable on demand.
const INIT = () => {
  window.__workers = [];
  const Real = window.Worker;
  window.Worker = class extends Real {
    constructor(...args) { super(...args); window.__workers.push(this); }
  };
  // terminate(): the worker stops, silently. No 'error' event, no reply — the app is never told.
  window.__killWorkers = () => { window.__workers.forEach(w => w.terminate()); return window.__workers.length; };

  let cb = null;
  window.__pushPosition = (latitude, longitude, altitudeM) => {
    if (!cb) return false;
    cb({ coords: { latitude, longitude, altitude: altitudeM, accuracy: 8, altitudeAccuracy: 8 },
      timestamp: Date.now() });
    return true;
  };
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: (success) => { cb = success; return 1; },
      clearWatch: () => { cb = null; },
      getCurrentPosition: (success) => cb && success,
    },
  });
};

async function newPage() {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(INIT);
  await context.addInitScript(settings =>
    localStorage.setItem('mtc-settings-v2', JSON.stringify(settings)), {
      packIds: ['fixture'], language: 'en', safetyMarginM: 250,
      testMode: false,                       // the real GPS path, not the simulated one
      terrainRouting: true, terrainClearanceM: 200,
    });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof window.__mtcState === 'object', null, { timeout: 20000 });
  // The pack has to be in before a fix means anything: refreshTerrainRoutes returns early on
  // an empty field list, so a position pushed too early looks like a stuck solve but is not.
  await page.waitForFunction(() => (window.__mtcState.fields?.length || 0) > 0,
    null, { timeout: 30000 });
  return { context, page };
}

const status = page => page.evaluate(() => window.__mtcState.terrain.status);
const solvedCount = page => page.evaluate(() => window.__mtcState.terrain.solvedIds.size || 0);
const routeCount = page => page.evaluate(() => window.__mtcState.terrain.routes.size || 0);
const workerCount = page => page.evaluate(() => window.__workers.length);

/** Feed one GPS fix and let the app react. */
async function move(page, dLatKm = 0, dLonKm = 0, alt = ALT) {
  await page.evaluate(([la, lo, a]) => window.__pushPosition(la, lo, a), [
    LAT + dLatKm / 111.32, LON + dLonKm / (111.32 * Math.cos(LAT * Math.PI / 180)), alt]);
  await page.waitForTimeout(400);
}

/** Wait for a solve to land, or report what it got stuck as. */
async function settle(page, ms = 45000) {
  try {
    await page.waitForFunction(() => window.__mtcState.terrain.status === 'ready',
      null, { timeout: ms });
    return 'ready';
  } catch { return await status(page); }
}

console.log('\n=== 1. baseline: a normal flight, fix after fix ===');
{
  const { context, page } = await newPage();
  await move(page);
  const first = await settle(page);
  check('the first solve completes', first === 'ready', `status ${first}`);
  const r1 = await routeCount(page);

  // Fly on, far enough each time to beat the resolve throttle.
  for (const km of [3, 6, 9]) await move(page, km, 0);
  const after = await settle(page);
  check('routing still works after several fixes', after === 'ready', `status ${after}`);
  check('routes are present', (await routeCount(page)) > 0, `${r1} then ${await routeCount(page)}`);
  await context.close();
}

console.log('\n=== 2. the worker is killed mid-solve (backgrounded PWA) ===');
{
  const { context, page } = await newPage();
  await move(page);
  const first = await settle(page);
  check('a solve completes before the kill', first === 'ready', `status ${first}`);

  const before = await workerCount(page);
  const killed = await page.evaluate(() => window.__killWorkers());
  console.log(`   killed ${killed} worker(s) — as an OS does to a backgrounded PWA`);
  await page.waitForTimeout(500);

  // A fix here starts a solve that goes to the dead worker and can never be answered.
  await move(page, 12, 0);
  const whileHanging = await status(page);
  console.log(`   status with the solve outstanding: ${whileHanging}`);

  // Wait out the watchdog, then fly on. Before the fix there was no watchdog and this stayed
  // 'solving' for the life of the page, however far the glider went.
  await page.waitForTimeout(WATCHDOG_MS + 4000);
  console.log(`   status once the watchdog has run: ${await status(page)}`);

  for (const km of [16, 20]) await move(page, km, 0);
  const afterFlying = await settle(page, 45000);
  console.log(`   status after flying on: ${afterFlying}`);
  console.log(`   workers ever created: ${before} before, ${await workerCount(page)} after`);

  check('routing recovers by itself while flying on', afterFlying === 'ready',
    `status ${afterFlying}`);
  check('a replacement worker is built once the old one is dead',
    (await workerCount(page)) > before,
    `${before} worker(s) before, ${await workerCount(page)} after`);
  await context.close();
}

console.log('\n=== 3. a reload also puts it right ===');
{
  const { context, page } = await newPage();
  await move(page);
  await settle(page);
  await page.evaluate(() => window.__killWorkers());
  for (const km of [8, 14]) await move(page, km, 0);
  await page.waitForTimeout(2000);
  console.log(`   status with the solve outstanding: ${await status(page)}`);

  // What the pilot actually did. Reload, wait for the pack, then fly.
  await page.reload();
  await page.waitForFunction(() => typeof window.__mtcState === 'object', null, { timeout: 20000 });
  await page.waitForFunction(() => (window.__mtcState.fields?.length || 0) > 0,
    null, { timeout: 30000 });
  await move(page);
  const afterReload = await settle(page);
  check('a reload restores routing', afterReload === 'ready', `status ${afterReload}`);
  await context.close();
}

console.log('\n=== 4. tiles fail mid-flight, then come back ===');
{
  const { context, page } = await newPage();
  await move(page);
  check('solves while tiles are served', (await settle(page)) === 'ready');

  breakTiles = true;
  for (const km of [8, 14]) await move(page, km, 0);
  await page.waitForTimeout(2500);
  console.log(`   status with tiles failing: ${await status(page)}`);

  breakTiles = false;
  for (const km of [20, 26]) await move(page, km, 0);
  const recovered = await settle(page, 25000);
  check('routing recovers once tiles are served again', recovered === 'ready',
    `status ${recovered}`);
  await context.close();
}

console.log('\n=== 5. fixes arriving faster than the solve ===');
{
  const { context, page } = await newPage();
  await move(page);
  await settle(page);
  // Hammer position updates with no pause, the way a 1 Hz GPS does over a fast glider.
  for (let i = 0; i < 12; i += 1) {
    await page.evaluate(([la, lo, a]) => window.__pushPosition(la, lo, a),
      [LAT + (5 + i * 2) / 111.32, LON, ALT - i * 20]);
  }
  const after = await settle(page, 30000);
  check('a burst of fixes still ends in a solved state', after === 'ready', `status ${after}`);
  check('solved ids survive the burst', (await solvedCount(page)) > 0);
  await context.close();
}

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
