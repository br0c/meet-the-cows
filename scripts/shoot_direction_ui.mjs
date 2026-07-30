// Screenshots of the compass-point indicator, taken from the real app.
//
// The fixture puts one field at each of four bearings from a fixed position, so the shot proves
// the arithmetic as well as the layout: a field due north must read N, one at 247° must read WSW
// in English and OSO in French. Language is a real difference here, not a translation — French
// counts from Ouest and German from Ost, so the same field is WSW, OSO and WSW respectively.
//
//   node scripts/shoot_direction_ui.mjs [outDir]
//
// Writes direction-list.<lang>.png and direction-detail.<lang>.png for en, fr and de.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const outDir = process.argv[2] || path.join(tmpdir(), 'mtc-direction-shots');
const ROOT = path.join(tmpdir(), `mtc-dir-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

const LAT = 44.5, LON = 6.0, ALT = 3000;

// Fields placed by bearing and distance, so what the row says can be checked against what was
// asked for. Elevations descend with distance so the required glide stays sane and the list
// keeps a believable order.
const PLACED = [
  { id: 'n',   name: 'Due North',  brg: 0,   km: 12, elevationM: 900,  difficulty: 'A' },
  { id: 'ne',  name: 'North East', brg: 45,  km: 19, elevationM: 800,  difficulty: 'B' },
  { id: 's',   name: 'Due South',  brg: 180, km: 24, elevationM: 700,  difficulty: 'C' },
  { id: 'wsw', name: 'West By South', brg: 247, km: 31, elevationM: 500, difficulty: 'D' },
];

const R = 6371;
const FIELDS = PLACED.map(f => {
  const d = f.km / R, b = f.brg * Math.PI / 180, la = LAT * Math.PI / 180, lo = LON * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lon2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la),
    Math.cos(d) - Math.sin(la) * Math.sin(lat2));
  return { id: f.id, name: f.name, kind: 'outlanding', code: '', difficulty: f.difficulty,
    rawDifficulty: f.difficulty, latitude: Number((lat2 * 180 / Math.PI).toFixed(6)),
    longitude: Number((lon2 * 180 / Math.PI).toFixed(6)), elevationM: f.elevationM,
    lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
    source: { name: 'fixture' } };
});

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
await mkdir(path.join(ROOT, 'packs', 'fixture'), { recursive: true });
await mkdir(outDir, { recursive: true });
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

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// What each language must show for the four bearings above.
const WANT = {
  en: ['N', 'NE', 'S', 'WSW'],
  fr: ['N', 'NE', 'S', 'OSO'],
  de: ['N', 'NO', 'S', 'WSW'],
};

let failures = 0;
for (const lang of ['en', 'fr', 'de']) {
  const context = await browser.newContext({
    locale: lang, viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 });
  await context.addInitScript(settings =>
    localStorage.setItem('mtc-settings-v2', JSON.stringify(settings)), {
      packIds: ['fixture'], language: lang, safetyMarginM: 250, testMode: true,
      // C and D are hidden by default; this fixture is about direction, and the
      // badges are worth showing in their four colours.
      showC: true, showD: true,
      testLatitude: LAT, testLongitude: LON, testAltitudeM: ALT, testLabel: 'Fixture',
    });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('.field-row', { timeout: 15000 });

  const seen = await page.$$eval('.field-row', rows => rows.map(r => ({
    name: r.querySelector('.field-name')?.textContent?.trim(),
    dir: r.querySelector('.field-dir')?.textContent?.trim() || '',
  })));
  const byName = Object.fromEntries(seen.map(r => [r.name, r.dir]));
  const got = ['Due North', 'North East', 'Due South', 'West By South'].map(n => byName[n]);
  const ok = JSON.stringify(got) === JSON.stringify(WANT[lang]);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${lang}: ${got.join(' ')}  (want ${WANT[lang].join(' ')})`);
  if (!ok) failures += 1;

  await page.screenshot({ path: path.join(outDir, `direction-list.${lang}.png`) });

  // The detail sheet for the 247° field, where the cardinal and the degrees sit together.
  const target = await page.$$eval('.field-row', rows =>
    rows.findIndex(r => r.querySelector('.field-name')?.textContent?.trim() === 'West By South'));
  await page.locator('.field-row').nth(target).click();
  await page.waitForSelector('.detail-card', { timeout: 10000 });
  await page.screenshot({ path: path.join(outDir, `direction-detail.${lang}.png`) });
  await context.close();
}

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });
console.log(`\nshots in ${outDir}`);
process.exit(failures ? 1 : 0);
