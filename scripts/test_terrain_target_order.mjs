// The terrain solver answers the fields the list puts first.
//
// The solver covers TERRAIN_MAX_TARGETS fields; the list shows more. So the two have to agree on
// WHICH fields matter, and they did not: the list orders by required glide, and the solve took
// the nearest by distance. A far field with an excellent glide therefore sat near the top of the
// list carrying a straight-line number — the optimistic one, since it ignores whatever ridge is
// in the way — next to routed rows, looking identical to them.
//
// The fixture makes the two orders disagree completely. Near fields sit high, so they need a
// poor glide and rank last; far fields sit low, so they need a good one and rank first. With 170
// fields and a solver that takes 80, the nearest 80 and the list's top 80 share no field at all,
// so picking by the wrong one cannot pass by luck.
//
// What is checked is the SELECTION, against the list as it stood when the solve launched. It is
// not the list as it ends up: computeRows sorts on the routed glide, so a field that came back
// with a long detour legitimately sinks below one that was never checked. That reordering is the
// routing working, not the ordering failing, and the pre-solve glide each row keeps in
// directGlideRatio is what the choice was actually made on.
//
//   python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out /tmp/t
//   node scripts/test_terrain_target_order.mjs [/tmp/t/_terrain]

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
const ROOT = path.join(tmpdir(), `mtc-target-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.terr': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };

if (!existsSync(path.join(terrainDir, 'index.json'))) {
  console.error(`No terrain index at ${terrainDir}. Build tiles first:\n` +
    '  python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out /tmp/t');
  process.exit(2);
}

const LAT = 45.55, LON = 7.45, ALT = 4000;   // over the Alps, high enough to reach a long way
const MARGIN_M = 250;                        // the safety margin the fixture runs with
const MAX_TARGETS = 80;                      // must match TERRAIN_MAX_TARGETS in app.js
const COUNT = 170;                           // over twice the solver's budget, so the two
                                             // candidate sets can be fully disjoint

// 170 fields on a spiral, close in and climbing. Distance grows slowly (4 → 24 km) while the
// ground drops fast (3400 → 340 m), so the height available wins: required glide falls
// monotonically as distance rises, and the list comes out in exactly reverse distance order.
// The nearest field is the one you can least afford to go to.
const FIELDS = Array.from({ length: COUNT }, (_, i) => {
  const km = 4 + i * 0.12;
  const ang = i * 2.399;                     // golden angle, so they never line up
  const dLat = (km * Math.cos(ang)) / 111.32;
  const dLon = (km * Math.sin(ang)) / (111.32 * Math.cos(LAT * Math.PI / 180));
  return {
    id: `f${String(i).padStart(3, '0')}`,
    name: `Field ${String(i).padStart(3, '0')}`,
    kind: 'outlanding', code: '', difficulty: 'A', rawDifficulty: 'A',
    latitude: Number((LAT + dLat).toFixed(6)), longitude: Number((LON + dLon).toFixed(6)),
    elevationM: 3400 - i * 18,               // near = high = poor glide; far = low = good glide
    lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
    source: { name: 'fixture' },
  };
});

// The same two orders, worked out here rather than read back from the app, so the expectation is
// independent of the thing it is testing.
const groundDistM = f => {
  const dLat = (f.latitude - LAT) * 111320;
  const dLon = (f.longitude - LON) * 111320 * Math.cos(LAT * Math.PI / 180);
  return Math.hypot(dLat, dLon);
};
const directGlide = f => groundDistM(f) / (ALT - f.elevationM - MARGIN_M);
const topByGlide = [...FIELDS].sort((a, b) => directGlide(a) - directGlide(b))
  .slice(0, MAX_TARGETS).map(f => f.id);
const nearestByDistance = [...FIELDS].sort((a, b) => groundDistM(a) - groundDistM(b))
  .slice(0, MAX_TARGETS).map(f => f.id);

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
await context.addInitScript(settings =>
  localStorage.setItem('mtc-settings-v2', JSON.stringify(settings)), {
    packIds: ['fixture'], language: 'en', safetyMarginM: MARGIN_M, testMode: true,
    testLatitude: LAT, testLongitude: LON, testAltitudeM: ALT, testLabel: 'Fixture',
    terrainRouting: true, terrainClearanceM: 200,
  });
const page = await context.newPage();
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 20000 });
await page.waitForFunction(
  () => window.__mtcState?.terrain?.status === 'ready', null, { timeout: 60000 });
// The solve is asynchronous; wait until it has actually answered something.
await page.waitForFunction(
  () => (window.__mtcState?.terrain?.solvedIds?.size || 0) > 0, null, { timeout: 60000 });

const shape = await page.evaluate(() => {
  const rows = window.__mtcState.computedRows;
  const solved = window.__mtcState.terrain.solvedIds;
  return {
    total: rows.length,
    solvedIds: [...solved],
    // A row keeps its pre-route glide in directGlideRatio once routing has touched it; a row
    // routing never reached still carries its straight-line one in requiredGlideRatio. Together
    // that is the list the solve chose from.
    preSolveOrder: rows
      .map(r => ({ id: r.field.id, glide: r.directGlideRatio ?? r.requiredGlideRatio }))
      .filter(r => Number.isFinite(r.glide))
      .sort((a, b) => a.glide - b.glide)
      .map(r => r.id),
    firstRowsShown: rows.slice(0, 8).map(r => ({
      km: Math.round(r.distanceM / 1000), state: r.terrainState })),
  };
});

const solved = new Set(shape.solvedIds);
const overlap = (a, b) => a.filter(id => b.includes(id)).length;

console.log(`\n  ${shape.total} fields listed, ${solved.size} solved`);
console.log(`  list starts: ${shape.firstRowsShown.map(r => `${r.km}km/${r.state}`).join(' ')}`);

// The fixture only works if the two orders really do disagree.
check('the fixture lists more fields than the solver takes', shape.total > MAX_TARGETS,
  `${shape.total} listed`);
check('the glide order and the distance order share no field in the solver\'s budget',
  overlap(topByGlide, nearestByDistance) === 0,
  `${overlap(topByGlide, nearestByDistance)} fields in both`);
check('the app orders the list the way the fixture predicts',
  shape.preSolveOrder.slice(0, MAX_TARGETS).every(id => topByGlide.includes(id)),
  `top of list: ${shape.preSolveOrder.slice(0, 3).join(', ')}`);

// The point of the change: the solve took the fields the list puts first.
check('the solve took exactly the top of the list by required glide',
  solved.size === MAX_TARGETS && topByGlide.every(id => solved.has(id)),
  `${overlap(topByGlide, [...solved])}/${MAX_TARGETS} of the list's top were solved`);
// And the guard against the behaviour this replaced.
check('the solve did NOT take the nearest fields by distance',
  overlap(nearestByDistance, [...solved]) === 0,
  `${overlap(nearestByDistance, [...solved])} of the nearest ${MAX_TARGETS} were solved`);

// What the pilot ends up looking at: the rows carrying an unchecked straight-line number are the
// ones the list already ranked worst, not ones scattered up among the answers.
const worstRankChecked = shape.preSolveOrder.findIndex(id => !solved.has(id));
check('no unchecked field outranks a checked one in the list the solve chose from',
  worstRankChecked === MAX_TARGETS,
  `first unchecked field sits at #${worstRankChecked + 1}`);

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
