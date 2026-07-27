// Does the app open promptly when the network is there in name only?
//
// The cockpit failure mode is not "offline" — airplane mode fails fetches instantly and the
// cache answers at once. It is one flickering bar: fetches HANG. An app that asks the radio
// first therefore opens SLOWER with a bad connection than with none at all, which is exactly
// backwards for something used in the air.
//
// So anything already cached is served from the cache without waiting on the network at all,
// and the copy is refreshed behind the render. Two packs, because that is the default selection
// and the pack loads are sequential — one pack would understate the old cost by a third.
//
// The old behaviour, for the record: six sequential network attempts (navigation, packs.json,
// then a manifest and a fields.json per pack) at up to 3.5 s each = 21.5 s measured, with every
// one of those files already in the cache.
//
// The fixture is hashed with the real scripts/hash_assets.py, because that is what production
// serves and what the cache-first rule keys on.
//
//   node scripts/test_sw_coldstart.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-coldstart-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

const PACKS = ['alps-west', 'alps-east'];

const fieldsFor = id => [1, 2].map(n => ({
  id: `${id}-${n}`, kind: 'outlanding', name: `${id} ${n}`, code: '', difficulty: 'A',
  rawDifficulty: 'A', latitude: 45.90 - n * 0.01, longitude: 7.60, elevationM: 600,
  lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
  source: { name: 'fixture' },
}));

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
for (const id of PACKS) await mkdir(path.join(ROOT, 'packs', id), { recursive: true });
for (const f of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
  'release-notes.json', 'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));
for (const id of PACKS) {
  const fieldsJson = JSON.stringify(fieldsFor(id));
  await writeFile(path.join(ROOT, 'packs', id, 'fields.json'), fieldsJson);
  await writeFile(path.join(ROOT, 'packs', id, 'manifest.json'), JSON.stringify({
    id, name: id, names: { en: id }, hidden: false, version: 'v1',
    generatedAt: 'x', isSample: false, fieldsUrl: 'fields.json', fieldsCount: 2,
    mediaCount: 0, mediaFiles: 0, fieldsBytes: fieldsJson.length, sizeBytes: fieldsJson.length,
    selector: 't', sources: [], notices: [] }));
}
await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
  schemaVersion: 2, updatedAt: 'x', packs: PACKS.map(id => ({
    id, name: id, names: { en: id }, hidden: false,
    manifestUrl: `packs/${id}/manifest.json`, sizeBytes: 100, fieldsCount: 2 })) }));

// The real pipeline step, so the fixture serves what production serves.
execFileSync('python3', [path.join(repo, 'scripts', 'hash_assets.py'), '--dir', ROOT],
  { stdio: 'inherit' });

// stall=true models the flickering bar: the socket opens, then nothing arrives. Requests are
// answered after STALL_MS so sockets do not leak, far beyond any budget the app should need.
const STALL_MS = 45000;
let stall = false;
const asked = [];
const pending = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  asked.push(url.pathname);
  if (stall) {
    const timer = setTimeout(() => { res.writeHead(504); res.end('late'); }, STALL_MS);
    pending.push(timer);
    return;
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
// Every open socket, so "airplane mode" can be the real thing: a closed server refuses
// connections at once, which is exactly how offline fails in the field — no emulation layer
// between the worker and the refusal. (Playwright's setOffline does not reliably reach fetches
// made from inside a service worker.)
const sockets = new Set();
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ locale: 'en-GB' });
await context.addInitScript(packs => localStorage.setItem('mtc-settings-v2', JSON.stringify({
  packIds: packs, language: 'en', safetyMarginM: 250, showC: true, showD: true,
  testMode: true, testLatitude: 45.9356, testLongitude: 7.6304,
  testAltitudeM: 2800, testLabel: 'Cervinia', terrainRouting: false,
  terrainAcknowledged: false, terrainClearanceM: 200,
})), PACKS);
const page = await context.newPage();

// --- 1. a healthy first visit installs the worker and fills the shell cache ---------------------
console.log('\n1 — first visit, good network: the worker installs and precaches the shell');
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 15000 });
await page.waitForFunction(async () => {
  const registration = await navigator.serviceWorker.ready;
  return !!registration.active && !!navigator.serviceWorker.controller;
}, null, { timeout: 15000 }).catch(() => {});
// The shell precache runs in the install event; give it a beat, then prove it happened.
await page.waitForFunction(async () => {
  const names = await caches.keys();
  const shellName = names.find(n => n.startsWith('mtc-shell-'));
  if (!shellName) return false;
  return (await (await caches.open(shellName)).keys()).length >= 8;
}, null, { timeout: 15000 });
check('the worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
check('the shell cache holds the app', await page.evaluate(async () => {
  const names = await caches.keys();
  const shellName = names.find(n => n.startsWith('mtc-shell-'));
  return (await (await caches.open(shellName)).keys()).length;
}) >= 8);

// A second healthy session, because the first cannot fill the data cache: its pack fetches run
// while the worker is still installing, so they never pass through it. Every later session does
// — which is also why the race below is entitled to assume a cached copy exists on any device
// that has used the app before. (A genuinely first-ever visit on a dead connection has nothing
// to fall back to, and no timeout would change that.)
await page.reload({ timeout: 30000 });
await page.waitForSelector('.field-row', { timeout: 15000 });
await page.waitForFunction(async () => {
  const cache = await caches.open('mtc-data');
  const paths = (await cache.keys()).map(r => new URL(r.url).pathname);
  return paths.filter(p => p.endsWith('manifest.json')).length >= 2
    && paths.filter(p => p.endsWith('fields.json')).length >= 2;
}, null, { timeout: 15000 });
const cachedData = await page.evaluate(async () =>
  (await (await caches.open('mtc-data')).keys()).map(r => new URL(r.url).pathname).sort());
check('every pack file both packs need is cached', cachedData.length >= 5, cachedData.join(' '));

// --- 2. reload with the network stalled: cached means fast, not merely bounded -------------------
console.log('\n2 — reload while every request hangs: nothing cached is waited on');
{
  stall = true;
  const mark = asked.length;
  const started = Date.now();
  await page.reload({ waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('.field-row', { timeout: 40000 });
  const elapsed = (Date.now() - started) / 1000;
  // The bar to clear is not "bounded" — a 21 s app is bounded. It is that a stalled network costs
  // roughly what no network costs, because every file needed to render is already on the phone
  // and none of them is waited on. 3 s leaves room for a slow CI box without leaving room for
  // even one 3.5 s race window.
  check(`the field list is up in ${elapsed.toFixed(1)} s — a stalled network costs nothing`
    + ' (this was 21.5 s)', elapsed < 3, `${elapsed.toFixed(1)} s`);
  const hashedAsked = asked.slice(mark).filter(p => /\.[0-9a-f]{10}\.(js|css)$/.test(p));
  check('no content-hashed asset touched the network', hashedAsked.length === 0,
    hashedAsked.join(' '));
  // The requests are still made — the cache has to be refreshed for next time — they are simply
  // not on anyone's critical path. Their absence would mean the app had gone cache-only.
  await page.waitForTimeout(1500);
  const tried = asked.slice(mark);
  check('the refresh was still attempted in the background',
    tried.some(p => p.endsWith('packs.json')), tried.join(' '));
  stall = false;
  for (const timer of pending) clearTimeout(timer);
}

// --- 3. reload fully offline: instant, as it always was ------------------------------------------
console.log('\n3 — reload with the server gone: refusal is instant and the cache answers at once');
{
  // Destroy first, close second: close() waits for open connections, and the stalled ones from
  // scenario 2 would keep it waiting for exactly as long as this test exists to prevent.
  for (const socket of sockets) socket.destroy();
  await new Promise(r => server.close(r));
  const started = Date.now();
  await page.reload({ waitUntil: 'commit', timeout: 30000 });
  await page.waitForSelector('.field-row', { timeout: 20000 });
  const elapsed = (Date.now() - started) / 1000;
  check(`the field list is up in ${elapsed.toFixed(1)} s offline`, elapsed < 8,
    `${elapsed.toFixed(1)} s`);
  await new Promise(r => server.listen(port, r));
}

// --- 4. and with the network healthy again, fresh bytes still win the race -----------------------
console.log('\n4 — healthy network again: the fresh copy wins, nothing regressed to cache-only');
{
  const mark = asked.length;
  await page.reload({ waitUntil: 'commit', timeout: 30000 });
  await page.waitForSelector('.field-row', { timeout: 15000 });
  await page.waitForTimeout(1500); // background revalidations land after the cache answers
  const navigations = asked.slice(mark).filter(p => p === '/');
  check('the navigation still asks the server', navigations.length >= 1);
  const packAsks = asked.slice(mark).filter(p => p.endsWith('packs.json'));
  check('pack data still asks the server', packAsks.length >= 1);
}

// --- 5. serving from cache must not mean serving yesterday for ever ------------------------------
console.log('\n5 — when the published data actually moves, the app notices without being reloaded');
{
  // Cache-first buys its speed by rendering data that might be stale. That is only honest if a
  // background refresh which finds real change reaches the pilot, so this republishes a pack the
  // way a rebuild does — new manifest version, new field — and waits for the OPEN page to catch up.
  const target = PACKS[0];
  const fresh = [...fieldsFor(target), {
    id: `${target}-new`, kind: 'outlanding', name: 'Newly Published', code: '', difficulty: 'A',
    rawDifficulty: 'A', latitude: 45.88, longitude: 7.60, elevationM: 600, lengthM: 800,
    widthM: 60, runwayDirectionDeg: 90, notes: '', media: [], source: { name: 'fixture' },
  }];
  const freshJson = JSON.stringify(fresh);
  await writeFile(path.join(ROOT, 'packs', target, 'fields.json'), freshJson);
  await writeFile(path.join(ROOT, 'packs', target, 'manifest.json'), JSON.stringify({
    id: target, name: target, names: { en: target }, hidden: false, version: 'v2',
    generatedAt: 'y', isSample: false, fieldsUrl: 'fields.json', fieldsCount: fresh.length,
    mediaCount: 0, mediaFiles: 0, fieldsBytes: freshJson.length, sizeBytes: freshJson.length,
    selector: 't', sources: [], notices: [] }));

  await page.reload({ waitUntil: 'commit', timeout: 30000 });
  await page.waitForSelector('.field-row', { timeout: 15000 });
  const immediate = await page.$$eval('.field-name', n => n.map(x => x.textContent.trim()));
  check('the first render is the cached data, as designed',
    !immediate.includes('Newly Published'), immediate.join(','));

  const arrived = await page.waitForFunction(
    () => [...document.querySelectorAll('.field-name')].some(n => n.textContent.trim() === 'Newly Published'),
    null, { timeout: 15000 }).then(() => true, () => false);
  check('the new field arrives on its own, with no reload and no pilot action', arrived);
}

await context.close();
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
