// The floating download bar must never cover a sheet's buttons.
//
// Found on a phone: with every pack downloading, a bottom-anchored dialog opened and the fixed
// offline bar sat exactly on top of its button row (bar z-index 30 vs sheet backdrop 10). The
// dialog that surfaced it — the terrain consent sheet — has since been removed outright, but
// the layering rule it exposed holds for every remaining sheet (field detail, contribution
// form): a passive status bar renders BELOW anything that needs pressing. The C/D reveal is
// also exercised: it uses the browser's native confirm(), which no page element can cover.
//
//   node scripts/test_ui_layering.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-layering-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg' };

// Enough slow media that the download bar reliably outlives every interaction below.
const MEDIA_COUNT = 40;
const MEDIA_DELAY_MS = 600;

const FIELDS = Array.from({ length: MEDIA_COUNT }, (_, i) => ({
  id: `f${i}`, name: `Field ${i}`, difficulty: 'A', kind: 'outlanding', code: '',
  rawDifficulty: 'A', latitude: 45.9 - i * 0.001, longitude: 7.6, elevationM: 500,
  lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '',
  media: [{ type: 'image', url: `media/f${i}/p.jpg`, bytes: 4000 }],
  source: { name: 'fixture' },
}));

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
await mkdir(path.join(ROOT, 'packs', 'fixture'), { recursive: true });
for (const f of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
  'release-notes.json', 'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));
const fieldsJson = JSON.stringify(FIELDS);
await writeFile(path.join(ROOT, 'packs', 'fixture', 'fields.json'), fieldsJson);
await writeFile(path.join(ROOT, 'packs', 'fixture', 'manifest.json'), JSON.stringify({
  id: 'fixture', name: 'Fixture', names: { en: 'Fixture' }, hidden: false, version: 'v1',
  generatedAt: 'x', isSample: false, fieldsUrl: 'fields.json', fieldsCount: FIELDS.length,
  mediaCount: MEDIA_COUNT, mediaFiles: MEDIA_COUNT, fieldsBytes: fieldsJson.length,
  sizeBytes: fieldsJson.length, selector: 't', sources: [], notices: [] }));
await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
  schemaVersion: 2, updatedAt: 'x', packs: [{ id: 'fixture', name: 'Fixture',
    names: { en: 'Fixture' }, hidden: false, manifestUrl: 'packs/fixture/manifest.json',
    sizeBytes: 100, fieldsCount: FIELDS.length }] }));
// Tiny valid JPEG, served slowly for media paths so the download stays in flight.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAAC//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.includes('/media/')) {
    await new Promise(resolve => setTimeout(resolve, MEDIA_DELAY_MS));
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) });
    res.end(JPEG);
    return;
  }
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
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  locale: 'en-GB', viewport: { width: 390, height: 700 } });  // phone-shaped: sheets anchor low
await context.addInitScript(saved => {
  localStorage.setItem('mtc-settings-v2', JSON.stringify(saved));
}, { packIds: ['fixture'], language: 'en', testMode: true,
  testLatitude: 45.9, testLongitude: 7.6, testAltitudeM: 2000, testLabel: 'Fixture' });
const page = await context.newPage();
const dialogs = [];
page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 15000 });

// Start the long download and confirm the bar is up.
await page.click('#settingsToggle');
await page.click('#downloadPack');
await page.waitForSelector('.offline-bar', { timeout: 10000 });
check('download bar is visible', await page.isVisible('.offline-bar'));

// 1 — the C reveal is a native confirm(): no page element can cover it, and it must still
// fire mid-download. Settings is already open from starting the download.
// click, not check(): dismissing the confirm makes the app revert the box to unchecked,
// which is the assertion two lines down — check() would demand the opposite.
await page.click('#showC');
await page.waitForTimeout(300);
check('C reveal used the native confirm dialog', dialogs.length === 1 && /difficulty c/i.test(dialogs[0]));
check('dismissing the warning left C hidden', await page.evaluate(
  () => JSON.parse(localStorage.getItem('mtc-settings-v2')).showC !== true));
// 2 — a bottom sheet (the field detail) opens over the bar, and the bar's screen area belongs
// to the sheet while it is up. elementFromPoint is the direct witness: the point at the middle
// of the bar must resolve into the sheet's subtree, not the bar.
await page.click('#closeSettings');
await page.waitForSelector('.field-row', { timeout: 5000 });
check('bar owns its pixels with no sheet open', await page.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 20);
  return !!el?.closest('.offline-bar');
}));
await page.click('.field-row');
await page.waitForSelector('.detail-backdrop', { timeout: 5000 });
check('sheet owns the bar pixels while open', await page.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 20);
  return !!el?.closest('.detail-backdrop') && !el?.closest('.offline-bar');
}));
check('the bar survived the sheet (still in the DOM underneath)',
  await page.$('.offline-bar') !== null);
// The end-to-end form of the same fact: a button low in the sheet can be pressed. Playwright
// refuses a click whose target point another element covers.
let clicked = true;
let detail = '';
try {
  const bottomButton = (await page.$('#contribute')) || (await page.$('.detail .button-row button'));
  check('the detail sheet has a bottom button to press', !!bottomButton);
  if (bottomButton) await bottomButton.click({ timeout: 4000 });
} catch (error) {
  clicked = false;
  detail = String(error).split('\n')[0];
}
check('sheet buttons are clickable during a download', clicked, detail);

await context.close();
await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
