// Does terrain recover when the data it needs shows up late?
//
// The reported symptom: update the app, switch terrain routing on, download the tiles — and the
// list still reads as though terrain were off, until the app is closed and reopened. Switching it
// on happened BEFORE the download, which is the ordering these scenarios exercise.
//
// The cause was three negative results the app cached permanently: TerrainStore.index = false
// when the index fetch failed, state.terrain.available = false once that had happened, and
// TerrainStore.missing per tile key — which fetchTile consulted BEFORE the Cache API, so
// downloading a tile afterwards could not undo it. A restart cleared all three, which is exactly
// the shape of the report. Each is now retried when the pilot does something that could plausibly
// have fixed it, and the settings page re-asks on a timer while its controls are greyed out.
//
//   node scripts/test_terrain_recovery.mjs [terrainDir]

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

const ROOT = path.join(tmpdir(), `mtc-recovery-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.terr': 'application/octet-stream' };

const FIELDS = [
  { id: 'aosta', kind: 'airfield', name: 'Aosta', code: 'LIMW',
    latitude: 45.7383, longitude: 7.3686, elevationM: 545, difficulty: 'A' },
].map(f => ({ ...f, rawDifficulty: f.difficulty, lengthM: 800, widthM: 60,
  runwayDirectionDeg: 90, notes: '', media: [], source: { name: 'fixture' } }));

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
  const ip = path.join(ROOT, 'packs', '_terrain', 'index.json');
  const index = JSON.parse(await readFile(ip, 'utf8'));
  const present = new Set((await readdir(path.join(ROOT, 'packs', '_terrain')))
    .filter(n => n.endsWith('.terr')).map(n => n.replace(/\.terr$/, '')));
  index.tiles = index.tiles.filter(t => present.has(t.key));
  index.tileCount = index.tiles.length;
  await writeFile(ip, JSON.stringify(index));
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

// The network, as flaky as we care to make it. `indexDelayMs` models the case the bug report
// implies: the index is still in flight when the pilot reaches for the switch, so the switch is
// live (available === null) rather than greyed out.
let failIndex = false;
let failTiles = false;
let indexDelayMs = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('/_terrain/index.json')) {
    if (indexDelayMs) await sleep(indexDelayMs);
    if (failIndex) { res.writeHead(503); return res.end('down'); }
  }
  if (failTiles && url.pathname.endsWith('.terr')) { res.writeHead(503); return res.end('down'); }
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

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** Enable terrain through the consent gate, exactly as a pilot does. */
async function enableTerrain(page) {
  await page.click('#settingsToggle');
  await page.waitForSelector('#terrainRouting:not([disabled])', { timeout: 5000 });
  await page.click('#terrainRouting');
  await page.waitForSelector('#terrainConsentAccept', { timeout: 3000 });
  await page.click('#terrainConsentAccept');
  await page.waitForTimeout(300);
}

async function closeSettings(page) {
  await page.click('#settingsToggle').catch(() => {});
  await page.waitForSelector('.field-row');
}

/** Press "Download terrain" if it is offered, and wait for the progress bar to clear. */
async function download(page) {
  await page.waitForSelector('#downloadTerrain:not([disabled])', { timeout: 5000 }).catch(() => {});
  const btn = await page.$('#downloadTerrain:not([disabled])');
  if (!btn) return false;
  await btn.click();
  await page.waitForTimeout(5000);
  return true;
}

const routed = page => page.$$eval('.field-glide',
  n => n.filter(x => x.classList.contains('routed')).length);
const switchOn = page => page.$eval('#terrainRouting', el => el.checked).catch(() => null);

async function open() {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
    packIds: ['alps-test'], language: 'en', safetyMarginM: 250, showC: true, showD: true,
    testMode: true, testLatitude: 45.9356, testLongitude: 7.6304,
    testAltitudeM: 2800, testLabel: 'Cervinia', terrainRouting: false,
    terrainAcknowledged: false, terrainClearanceM: 200,
  })));
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('.field-row', { timeout: 15000 });
  return { context, page };
}

// --- Scenario 1: the index is still in flight when terrain is switched on, and then fails --------
console.log('\nScenario 1 — index fails while terrain is being switched on, then the host recovers');
{
  failIndex = true; failTiles = false; indexDelayMs = 1500;
  const { context, page } = await open();
  await enableTerrain(page);          // switch is live: `available` is still null
  await page.waitForTimeout(2500);    // the index request now fails
  await closeSettings(page);
  await page.waitForTimeout(1500);
  check('with no index, nothing is routed (expected)', (await routed(page)) === 0);

  failIndex = false; indexDelayMs = 0;      // the data host comes back
  await page.click('#settingsToggle');      // opening Settings re-runs refreshTerrainStatus
  // Without leaving the page: the settings view re-asks on a timer, so the controls should come
  // back to life on their own. Allow two rounds of that timer.
  const enabled = await page.waitForSelector('#terrainRouting:not([disabled])', { timeout: 15000 })
    .then(() => true, () => false);
  check('the terrain switch comes back to life on its own, without leaving Settings', enabled);
  const got = await download(page);
  await closeSettings(page);
  await page.waitForTimeout(3000);
  check('once the index is reachable again, the glide routes without a restart',
    (await routed(page)) > 0,
    `routed rows: ${await routed(page)}, download offered: ${got}`);
  await context.close();
}

// --- Scenario 2: the index is fine but tiles fail, then the download succeeds --------------------
console.log('\nScenario 2 — tiles unreachable at the moment terrain is enabled, then downloaded');
{
  failIndex = false; failTiles = true; indexDelayMs = 0;
  const { context, page } = await open();
  await enableTerrain(page);
  await closeSettings(page);
  await page.waitForTimeout(2500);          // solve runs, every tile fetch 503s
  check('with no tiles, nothing is routed (expected)', (await routed(page)) === 0);

  failTiles = false;                        // tiles become fetchable; pilot hits Download terrain
  await page.click('#settingsToggle');
  const got = await download(page);
  await closeSettings(page);
  await page.waitForTimeout(3000);
  check('after downloading the tiles, the glide routes without a restart',
    (await routed(page)) > 0, `routed rows: ${await routed(page)}, download offered: ${got}`);
  await context.close();
}

// --- Control: everything reachable throughout ---------------------------------------------------
console.log('\nControl — a fresh page with everything reachable');
{
  failIndex = false; failTiles = false; indexDelayMs = 0;
  const { context, page } = await open();
  await enableTerrain(page);
  await closeSettings(page);
  await page.waitForFunction(() => document.querySelector('.field-glide.routed') !== null,
    null, { timeout: 25000 }).catch(() => {});
  check('with everything available from the start, the glide routes', (await routed(page)) > 0);
  check('the switch stays on', (await switchOn(page)) !== false);
  await context.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
