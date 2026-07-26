// A minted OpenAIP join key must never reach a pilot as though it were an identifier.
//
// Records with no published ICAO or alternate code get a key built from name and position —
// FR_PLATEAU_DE_L_ALP_44P351_6P724 — so runways and frequencies have something to join on. The
// pack build no longer publishes those, but a pilot carrying an already-downloaded region keeps
// them until it is fetched again, so the app filters them on the way to the screen as well. This
// exercises that filter against a pack that still contains them, which is what pilots have today.
//
// Checks the list subtitle, both detail headers, and the CUP export — the last of which matters
// most, because those rows end up in a flight computer's waypoint list.
//
//   node scripts/test_minted_codes.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-codes-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

// One of each: a minted key, a real ICAO, a numeric guide code, and the eleven-character real code
// that rules out any "long codes are machine codes" shortcut.
const FIELDS = [
  { id: 'it_andrea_bozzo_44p8640_7p4070', name: 'ANDREA BOZZO',
    code: 'IT_ANDREA_BOZZO_44P864_7P407', latitude: 45.90, longitude: 7.60, elevationM: 400 },
  { id: 'fr_plateau_de_l_alp', name: 'Plateau de l Alp',
    code: 'FR_PLATEAU_DE_L_ALP_44P351_6P724', latitude: 45.88, longitude: 7.62, elevationM: 500 },
  { id: 'fr_west', name: 'West of Greenwich', code: 'FR_WEST_44P351_M1P500',
    latitude: 45.87, longitude: 7.63, elevationM: 520 },
  { id: 'it_limw_aosta', name: 'Aosta', code: 'LIMW',
    latitude: 45.7383, longitude: 7.3686, elevationM: 545 },
  { id: 'fr_411_le_casset', name: 'Le Casset', code: '411',
    latitude: 45.80, longitude: 7.50, elevationM: 600 },
  { id: 'fr_ste_jalle', name: 'Ste-Jalle', code: 'Ste-Jalle_2',
    latitude: 45.82, longitude: 7.55, elevationM: 620 },
].map(f => ({ ...f, kind: 'airfield', difficulty: 'A', rawDifficulty: 'aerodrome',
  lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
  source: { name: 'fixture' } }));

const MINTED = FIELDS.filter(f => /_M?\d+P\d+_M?\d+P\d+$/.test(f.code));
const REAL = FIELDS.filter(f => !MINTED.includes(f));

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
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ locale: 'en-GB' });
await context.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
  packIds: ['fixture'], language: 'en', safetyMarginM: 250, showC: true, showD: true,
  sortMode: 'glide', testMode: true, testLatitude: 45.9356, testLongitude: 7.6304,
  testAltitudeM: 3000, testLabel: 'Cervinia', terrainRouting: false,
  terrainAcknowledged: false, terrainClearanceM: 200,
})));
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 15000 });

// --- the list ----------------------------------------------------------------------------------
const subs = await page.$$eval('.field-sub', n => n.map(x => x.textContent.trim()));
console.log('\nlist subtitles:');
for (const s of subs) console.log(`   ${s}`);
check('no minted key appears under any field name',
  !subs.some(s => /_\d+P\d+/.test(s)), subs.filter(s => /_\d+P\d+/.test(s)).join(', '));
check('a field whose only code was minted reads as just "Airfield"',
  subs.filter(s => s === 'Airfield').length === MINTED.length,
  `${subs.filter(s => s === 'Airfield').length} of ${MINTED.length}`);
for (const f of REAL) {
  check(`the real code ${f.code} is still shown`, subs.some(s => s.startsWith(`${f.code} ·`)),
    subs.join(' / '));
}

// --- the detail sheet ---------------------------------------------------------------------------
for (const row of await page.$$('.field-row')) {
  const name = await row.$eval('.field-name', n => n.textContent.trim()).catch(() => '');
  if (name.startsWith('ANDREA')) { await row.click(); break; }
}
await page.waitForSelector('.detail', { timeout: 5000 });
const meta = await page.$$eval('.detail-meta', n => n.map(x => x.textContent.trim()));
console.log('\ndetail meta lines:', JSON.stringify(meta));
check('no minted key in the detail sheet', !meta.some(m => /_\d+P\d+/.test(m)), meta.join(' / '));
await page.click('#closeDetail');
await page.waitForSelector('.field-row');

// --- the CUP export, which lands in a flight computer --------------------------------------------
const cup = await page.evaluate(() => window.__mtcGenerateCupProbe?.());
if (typeof cup !== 'string') {
  check('the CUP export is reachable for testing', false,
    'window.__mtcGenerateCupProbe is missing');
} else {
  console.log('\nCUP rows:');
  for (const line of cup.split('\n').slice(0, 8)) console.log(`   ${line}`);
  check('no minted key reaches the waypoint file', !/_\d+P\d+/.test(cup),
    (cup.match(/[^,\n]*_\d+P\d+[^,\n]*/g) || []).join(', '));
  for (const f of REAL) {
    check(`the CUP file keeps the real code ${f.code}`, cup.includes(`"${f.code}"`));
  }
  check('a field with only a minted code still exports, with an empty code',
    cup.split('\n').filter(Boolean).length === FIELDS.length + 1,
    `${cup.split('\n').filter(Boolean).length} lines for ${FIELDS.length} fields + header`);
}

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
