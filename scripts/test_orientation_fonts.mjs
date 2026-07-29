// Rotating the phone must not change the text size, and rotating back must not leave it changed.
//
// Mobile WebKit/Blink apply "text autosizing": when the layout width changes they inflate font
// sizes on their own. Rotating to landscape made everything bigger, and because the engine caches
// the multiplier on the render objects, rotating back left the text big until a re-render
// replaced them — so the app looked fixed only once you opened another screen. `text-size-adjust:
// 100%` on <html> tells the engine to use the authored sizes.
//
// A headless desktop Chromium does not run the autosizing heuristic, so this test cannot
// reproduce the engine behaviour itself. What it CAN pin, and what would silently rot otherwise:
// the declaration is present and applies to the document, and no CSS or script of ours changes
// text size across a rotation or fails to restore it afterwards. Verify the engine behaviour on a
// real phone.
//
//   node scripts/test_orientation_fonts.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-orient-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

const FIELDS = Array.from({ length: 6 }, (_, i) => ({
  id: `f${i}`, name: `Field ${i}`, latitude: 45.90 + i * 0.01, longitude: 7.60 + i * 0.01,
  kind: 'outlanding', difficulty: 'A', rawDifficulty: 'A', code: '', elevationM: 500,
  lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
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
  mediaCount: 0, mediaFiles: 0, fieldsBytes: fieldsJson.length, sizeBytes: fieldsJson.length,
  selector: 't', sources: [], notices: [] }));
await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
  schemaVersion: 2, updatedAt: 'x', packs: [{ id: 'fixture', name: 'Fixture',
    names: { en: 'Fixture' }, hidden: false, manifestUrl: 'packs/fixture/manifest.json',
    sizeBytes: 100, fieldsCount: FIELDS.length }] }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  locale: 'en-GB', viewport: PORTRAIT, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await context.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
  packIds: ['fixture'], language: 'en', testMode: true,
  testLatitude: 45.90, testLongitude: 7.60, testAltitudeM: 4000, testLabel: 'T',
})));
const page = await context.newPage();
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 20000 });

const adjust = await page.evaluate(() => {
  const style = getComputedStyle(document.documentElement);
  return style.webkitTextSizeAdjust || style.textSizeAdjust || '';
});
check('text-size-adjust is pinned on <html>', adjust === '100%', `computed ${adjust || '(unset)'}`);

// Body text, not the responsive .field-name: that one legitimately steps 13px -> 14px above the
// 390px breakpoint, and asserting on it would just re-state the media query.
const bodyFontSizes = async () => page.evaluate(() => {
  const pick = selector => {
    const el = document.querySelector(selector);
    return el ? getComputedStyle(el).fontSize : null;
  };
  return { body: getComputedStyle(document.body).fontSize, status: pick('#statusArea') };
});

const before = await bodyFontSizes();
await page.setViewportSize(LANDSCAPE);
await page.waitForTimeout(250);
const landscape = await bodyFontSizes();
await page.setViewportSize(PORTRAIT);
await page.waitForTimeout(250);
const after = await bodyFontSizes();

console.log(`\n  portrait ${JSON.stringify(before)}\n  landscape ${JSON.stringify(landscape)}\n  back ${JSON.stringify(after)}`);
check('body text size is unchanged in landscape', before.body === landscape.body,
  `${before.body} -> ${landscape.body}`);
check('body text size is restored in portrait', before.body === after.body,
  `${before.body} -> ${after.body}`);
check('status strip size is unchanged in landscape', before.status === landscape.status,
  `${before.status} -> ${landscape.status}`);
check('status strip size is restored in portrait', before.status === after.status,
  `${before.status} -> ${after.status}`);

// The responsive step is intentional, so prove it is the media query doing it and that it
// reverses cleanly — a sticky value here would be the reported bug in CSS form.
const nameSize = async () => page.evaluate(() =>
  getComputedStyle(document.querySelector('.field-name')).fontSize);
const namePortrait = await nameSize();
await page.setViewportSize(LANDSCAPE);
await page.waitForTimeout(250);
const nameLandscape = await nameSize();
await page.setViewportSize(PORTRAIT);
await page.waitForTimeout(250);
check('the responsive field-name step reverses on rotating back',
  await nameSize() === namePortrait, `${namePortrait} -> ${nameLandscape} -> ${await nameSize()}`);

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll orientation font checks passed');
process.exit(failures ? 1 : 0);
