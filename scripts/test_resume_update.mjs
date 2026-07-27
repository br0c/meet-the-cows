// Does a RESUMED app notice that it has been superseded?
//
// An installed PWA is rarely reloaded. iOS keeps it suspended in the app switcher and hands the
// same document back, so init() runs once and may not run again for days. Everything the app
// does about updates used to live in init(): the release notes were fetched once, and the worker
// was never asked to re-check. A pilot who never fully quits the app therefore kept running the
// build they installed — which is fine for changelog text and not fine for a fix.
//
// Two things must happen when the app comes back to the foreground:
//   1. the release notes are re-read, and land in the SAME session (no relaunch)
//   2. a new build that installs behind us is announced rather than swapped in silently
//
// Both run against a real worker over real HTTP, with the fixture hashed by the real
// scripts/hash_assets.py, because the cache-first rule keys on those names.
//
//   node scripts/test_resume_update.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, writeFile, mkdir, cp, rm, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-resume-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };
const PACKS = ['alps-west'];

const NOTES_BEFORE = [{ version: '9.9.9-test', date: '2026-01-01',
  en: ['first note', 'second note'], fr: ['un', 'deux'], de: ['eins', 'zwei'] }];
const NOTES_AFTER = [{ version: '9.9.9-test', date: '2026-01-01',
  en: ['REWRITTEN note'], fr: ['REECRIT'], de: ['NEU'] }];

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
  'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));
await writeFile(path.join(ROOT, 'release-notes.json'), JSON.stringify(NOTES_BEFORE));
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

execFileSync('python3', [path.join(repo, 'scripts', 'hash_assets.py'), '--dir', ROOT],
  { stdio: 'inherit' });

let notesRequests = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('/release-notes.json')) notesRequests += 1;
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
const sockets = new Set();
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

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

const settle = (page, ms = 1500) => page.waitForTimeout(ms);
const notesIn = page => page.evaluate(() => {
  const n = window.__mtcState?.releaseNotes;
  return Array.isArray(n) && n[0] ? n[0].en : null;
});
const readyForWorker = async page => {
  await page.waitForSelector('.field-row', { timeout: 20000 });
  await page.waitForFunction(async () => {
    const names = await caches.keys();
    const shell = names.find(n => n.startsWith('mtc-shell-'));
    return shell && (await (await caches.open(shell)).keys()).length >= 8;
  }, null, { timeout: 20000 });
};

// --- 1. the notes are re-read on resume, in the same document ----------------------------------
console.log('\n1 — the app is resumed after the notes were rewritten');
const page = await context.newPage();
await page.goto(base);
await readyForWorker(page);
check('the worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
check('the notes loaded at launch are the old ones',
  JSON.stringify(await notesIn(page)) === JSON.stringify(NOTES_BEFORE[0].en));

// The deploy happens while the app sits in the background.
await writeFile(path.join(ROOT, 'release-notes.json'), JSON.stringify(NOTES_AFTER));

const navigationsBefore = page.url();
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
// One beat for the cache-first read, one for the worker's background revalidation to report back.
await page.waitForFunction(
  after => JSON.stringify(window.__mtcState?.releaseNotes?.[0]?.en) === after,
  JSON.stringify(NOTES_AFTER[0].en), { timeout: 15000 },
).catch(() => {});
check('resuming re-reads the notes without a relaunch',
  JSON.stringify(await notesIn(page)) === JSON.stringify(NOTES_AFTER[0].en),
  JSON.stringify(await notesIn(page)));
check('the document was never navigated', page.url() === navigationsBefore);

// --- 2. resuming again immediately does not re-ask the network ---------------------------------
console.log('\n2 — the check is throttled, so app-switching is not a request per switch');
const askedAfterFirstResume = notesRequests;
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await settle(page, 1200);
check('a second resume inside the window is skipped', notesRequests === askedAfterFirstResume,
  `${notesRequests - askedAfterFirstResume} extra request(s)`);
await page.close();

// --- 3. a new build installing behind the app is announced, not swapped in ---------------------
console.log('\n3 — a new build is deployed while the app is running');
const page2 = await context.newPage();
await page2.goto(base);
await readyForWorker(page2);
check('this document started already controlled',
  await page2.evaluate(() => !!navigator.serviceWorker.controller));
check('no reload banner before anything changes',
  await page2.evaluate(() => !window.__mtcState?.updateReadyOnReload));

await appendFile(path.join(ROOT, 'service-worker.js'), '\n// new build\n');
await page2.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page2.waitForFunction(() => window.__mtcState?.updateReadyOnReload === true, null,
  { timeout: 20000 }).catch(() => {});
check('the new build is announced',
  await page2.evaluate(() => window.__mtcState?.updateReadyOnReload === true));
check('the pilot is offered the reload rather than being reloaded',
  await page2.locator('#reloadAppBtn').count() === 1);
check('the app was not reloaded from under them', page2.url() === base);

await browser.close();
for (const s of sockets) s.destroy();
await new Promise(r => server.close(r));
await rm(ROOT, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
