// End-to-end check of terrain routing in a real browser.
//
// Builds a throwaway site from the working tree (app shell + a three-field test pack + whatever
// terrain tiles you point it at), serves it, drives Chromium standing at Cervinia, and asserts
// that the glide numbers, the route summary and the settings card all behave.
//
// The case it exists for: Aosta from Cervinia at 3000 m. The naive straight-line glide is 14,
// which flies through a 3000 m ridge; the routed answer is 17 down the Valtournenche. A
// regression that quietly reverts to straight lines would put 14 back on the screen, and 14 is
// the number that gets someone hurt.
//
//   python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out /tmp/t
//   node scripts/test_terrain_e2e.mjs /tmp/t/_terrain
//
// Needs playwright and a Chromium build; set CHROMIUM_PATH if it is not on the default path.

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
if (!existsSync(path.join(terrainDir, 'index.json'))) {
  console.error(`No terrain index at ${terrainDir}. Build tiles first:\n` +
    '  python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out /tmp/t');
  process.exit(2);
}

const ROOT = path.join(tmpdir(), `mtc-terrain-e2e-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.terr': 'application/octet-stream' };

// Real places inside the N45E007 tile, so the routing has genuine mountains to deal with.
const FIELDS = [
  { id: 'aosta', kind: 'airfield', name: 'Aosta', code: 'LIMW',
    latitude: 45.7383, longitude: 7.3686, elevationM: 545, difficulty: 'A' },
  { id: 'valtournenche', kind: 'outlanding', name: 'Valtournenche', code: '',
    latitude: 45.8770, longitude: 7.6220, elevationM: 1524, difficulty: 'C' },
  { id: 'ceresole', kind: 'outlanding', name: 'Ceresole Reale', code: '',
    latitude: 45.4300, longitude: 7.2400, elevationM: 1580, difficulty: 'B' },
].map(field => ({ ...field, rawDifficulty: field.difficulty, lengthM: 800, widthM: 60,
  runwayDirectionDeg: 90, notes: '', media: [], source: { name: 'test fixture' } }));

async function buildFixture() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(path.join(ROOT, 'src'), { recursive: true });
  await mkdir(path.join(ROOT, 'packs', 'alps-test'), { recursive: true });
  for (const file of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
    'release-notes.json', 'config.js']) {
    await cp(path.join(repo, file), path.join(ROOT, file));
  }
  for (const file of ['app.js', 'terrain.js', 'glide-worker.js']) {
    await cp(path.join(repo, 'src', file), path.join(ROOT, 'src', file));
  }
  await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
  await cp(terrainDir, path.join(ROOT, 'packs', '_terrain'), { recursive: true });
  // The browser asks for this unprompted; without it the page-error check reports a phantom 404.
  await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));

  const fieldsJson = JSON.stringify(FIELDS, null, 2);
  await writeFile(path.join(ROOT, 'packs', 'alps-test', 'fields.json'), fieldsJson);
  const manifest = {
    id: 'alps-test', name: 'Alps test', names: { en: 'Alps test' }, hidden: false,
    version: 'test-1', generatedAt: '2026-07-25T00:00:00Z', isSample: false,
    fieldsUrl: 'fields.json', fieldsCount: FIELDS.length, mediaCount: 0, mediaFiles: 0,
    fieldsBytes: fieldsJson.length, sizeBytes: fieldsJson.length,
    selector: 'test', sources: [], notices: [],
  };
  await writeFile(path.join(ROOT, 'packs', 'alps-test', 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
    schemaVersion: 2, updatedAt: '2026-07-25T00:00:00Z',
    packs: [{ id: 'alps-test', name: 'Alps test', names: { en: 'Alps test' }, hidden: false,
      manifestUrl: 'packs/alps-test/manifest.json', sizeBytes: manifest.sizeBytes,
      fieldsCount: FIELDS.length }],
  }, null, 2));
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await buildFixture();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// No geolocation permission at all: the simulated position replaces it, which is both the point
// of that mode and the only way to get an altitude — Playwright's geolocation carries none.
const context = await browser.newContext({ locale: 'en-GB' });
// Terrain starts OFF so the straight-line baseline can be read without racing the solver: with a
// cached tile the first wavefront lands in a few milliseconds, easily before the first assertion.
await context.addInitScript(altitude => {
  localStorage.setItem('mtc-settings-v2', JSON.stringify({
    packIds: ['alps-test'], language: 'en', safetyMarginM: 250,
    hideC: false, hideD: false, sortMode: 'glide',
    testMode: true, testLatitude: 45.9360, testLongitude: 7.6310,   // Cervinia
    testAltitudeM: altitude, testLabel: 'Cervinia (test)',
    terrainRouting: false, terrainClearanceM: 200,
  }));
}, 3000);

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 15000 });

const readRows = () => page.$$eval('.field-row', rows => rows.map(row => ({
  name: row.querySelector('.field-name')?.textContent?.trim() || '',
  glide: row.querySelector('.field-glide')?.textContent?.trim() || '',
  routed: row.querySelector('.field-glide')?.classList.contains('routed') || false,
})));

const straight = await readRows();
check('terrain starts off, so the baseline is the straight line',
  straight.every(row => !row.routed));

await page.click('#settingsToggle');
await page.waitForSelector('#terrainRouting');
await page.check('#terrainRouting');
await page.click('#settingsToggle');
await page.waitForSelector('.field-row');
await page.waitForFunction(() => document.querySelector('.field-glide.routed') !== null,
  null, { timeout: 20000 }).catch(() => {});
const routed = await readRows();

console.log('\nCervinia, 3000 m       straight  routed');
for (const after of routed) {
  const before = straight.find(row => row.name === after.name);
  console.log(`  ${after.name.padEnd(18)} ${(before?.glide || '').padStart(6)}  ${after.glide.padStart(6)}` +
    `${after.routed ? '  (terrain-routed)' : ''}`);
}

const before = straight.find(row => row.name.startsWith('Aosta'));
const after = routed.find(row => row.name.startsWith('Aosta'));
check('Aosta appears in the list', Boolean(after));
check('Aosta is terrain-routed', after?.routed === true, `glide ${after?.glide}`);
check('routing corrects the straight-line answer upwards',
  Number(after?.glide) > Number(before?.glide), `${before?.glide} -> ${after?.glide}`);
check('the routed glide is a plausible valley run',
  Number(after?.glide) > 4 && Number(after?.glide) < 25, after?.glide);

for (const row of await page.$$('.field-row')) {
  const name = await row.$eval('.field-name', node => node.textContent.trim()).catch(() => '');
  if (name.startsWith('Aosta')) { await row.click(); break; }
}
await page.waitForSelector('.detail', { timeout: 5000 });
const routeText = await page.$eval('.route-summary', el => el.innerText).catch(() => '');
console.log('\nroute block:\n  ' + routeText.split('\n').join('\n  '));
check('the detail sheet shows a route block', routeText.length > 0);
check('the route reports going around terrain', /Around terrain/.test(routeText));
check('the route names the ground that limits the glide', /Tightest/.test(routeText));
check('the route prose uses the col name', /Col de Saint-Pantal/.test(routeText), routeText.slice(0, 70));

// How tight it is, in the two numbers a ratio alone hides. The height standing between the pilot
// and the pinch point is the one that moves; what the glide leaves over it is the clearance by
// construction, and pinning that here is what would catch the geometry drifting away from the
// setting it is supposed to honour.
const crossing = /([\d,]+) m below you now; the glide clears it by ([\d,]+) m/.exec(routeText);
check('the route says how far below you the pinch point sits', crossing !== null, routeText);
if (crossing) {
  const [, below, clears] = crossing.map(v => Number(String(v).replace(/,/g, '')));
  check('the height over the pinch point is a real figure, not the clearance echoed back',
    below > 400, `${below} m`);
  check('the glide crosses the pinch point on exactly the clearance in force',
    Math.abs(clears - 200) <= 1, `${clears} m against a 200 m setting`);
}

// The consequence of a col setting the ratio: the glide sized for the col overflies the field.
// The pilot who cannot see that surplus has no way to tell this field from one that arrives on
// the margin exactly.
const arrivalCard = await page.$$eval('.detail-card', cards => cards
  .map(c => c.innerText.replace(/\n/g, ' '))
  .find(text => /^ARRIVAL/i.test(text)) || '');
const arrivalM = Number((/([+-]?[\d,]+) m/.exec(arrivalCard)?.[1] || '').replace(/,/g, ''));
check('the detail grid states the height the glide arrives with', arrivalCard.length > 0, arrivalCard);
check('a terrain-limited glide arrives well above the safety margin',
  arrivalM > 250, `${arrivalCard} against a 250 m margin`);

// The mockup's three list/detail additions.
const profile = await page.$('.route-profile');
check('the detail sheet draws a route profile', profile !== null);
if (profile) {
  const parts = await page.$eval('.route-profile', svg => ({
    ground: !!svg.querySelector('.rp-ground'),
    envelope: !!svg.querySelector('.rp-envelope'),
    glide: !!svg.querySelector('.rp-glide'),
    marker: !!svg.querySelector('.rp-dot'),
  }));
  check('the profile shows ground, clearance, glide and the deciding point',
    parts.ground && parts.envelope && parts.glide && parts.marker, JSON.stringify(parts));
}
const routeCard = await page.$$eval('.detail-card', cards => cards
  .map(c => c.innerText.replace(/\n/g, ' '))
  .find(text => /^ROUTE/i.test(text)) || '');
check('the detail grid carries the route length beside the direct distance',
  /km/.test(routeCard), routeCard);

await page.click('#closeDetail');
await page.waitForSelector('.field-row');
const chip = await page.$eval('.field-via', el => el.innerText).catch(() => '');
// Named rather than geometric: cols load on a different path from the tiles, and the naming has
// already been lost once to a guard that only ran on first look. This is that regression.
check('the chip names the col when one is close enough', /Col de Saint-Pantal/.test(chip), chip);
check('the list row carries a via chip for a real detour', chip.length > 0, chip);
check('the chip leads with the route distance so truncation cannot eat it',
  /^▲\s*\d/.test(chip), chip);

// With no name for the pinch point the chip must say only that the glide goes around terrain.
// It used to offer the compass point the route headed for, which reads as an instruction to fly
// that way — this app reports what a glide costs and never tells anyone where to point the nose.
await page.evaluate(() => {
  for (const route of window.__mtcState.terrain.routes.values()) delete route.critical?.colName;
  window.__mtcScheduleRenderProbe();
});
// scheduleRender debounces by a second, so this has to outwait it rather than the usual tick.
await page.waitForFunction(() => !/Col de/.test(document.querySelector('.field-via')?.innerText || 'Col de'),
  null, { timeout: 5000 }).catch(() => {});
const unnamedChip = await page.$eval('.field-via', el => el.innerText).catch(() => '');
check('an unnamed pinch point falls back to plain "around terrain"',
  /around terrain/i.test(unnamedChip), unnamedChip);
check('the fallback never points a direction', !/of track|\bN[EW]?\b|\bS[EW]?\b|\bW\b|\bE\b/.test(
  unnamedChip.replace(/^▲\s*[\d.]+\s*km\s*/, '')), unnamedChip);

await page.click('#settingsToggle');
await page.waitForSelector('#terrainRouting');
const card = await page.$eval('.settings-card:has(#terrainRouting)', el => el.innerText);
check('settings states the terrain download size', /tiles ·/.test(card));
check('settings states the clearance in force', /at least 200 m above the ground/.test(card));

// The clearance control is a slider: dragging must update the readout live without re-rendering,
// and releasing must actually change the routing.
const slider = await page.$('#terrainClearanceM');
const attrs = await page.$eval('#terrainClearanceM', el => ({
  type: el.type, min: el.min, max: el.max, step: el.step, value: el.value,
}));
check('clearance is a slider over the intended range',
  attrs.type === 'range' && attrs.min === '100' && attrs.max === '500' && attrs.step === '50',
  JSON.stringify(attrs));

await page.$eval('#terrainClearanceM', el => {
  el.value = '400';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const liveReadout = await page.$eval('#terrainClearanceValue', el => el.textContent);
const liveNote = await page.$eval('#terrainClearanceNote', el => el.textContent);
check('dragging updates the readout in place', liveReadout.trim() === '400 m', liveReadout);
check('dragging updates the note in place', /at least 400 m/.test(liveNote), liveNote.slice(0, 50));
check('dragging alone does not re-render the slider away',
  (await page.$('#terrainClearanceM')) !== null && slider !== null);

await page.$eval('#terrainClearanceM', el => el.dispatchEvent(new Event('change', { bubbles: true })));
await page.waitForTimeout(1200);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mtc-settings-v2')).terrainClearanceM);
check('releasing the slider saves the new clearance', stored === 400, String(stored));

await page.uncheck('#terrainRouting');
await page.click('#settingsToggle');
await page.waitForSelector('.field-row');
const off = await readRows();
check('turning terrain off restores the straight-line glide',
  off.find(row => row.name.startsWith('Aosta'))?.glide === before?.glide,
  `${off.find(row => row.name.startsWith('Aosta'))?.glide} vs ${before?.glide}`);
check('turning terrain off removes the routed marker', off.every(row => !row.routed));

check('the simulated-position banner stays visible throughout', (await page.$('.test-banner')) !== null);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
