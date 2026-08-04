// Probe: where do the terrain-checked rows actually sit in the list the pilot sees?
//
// Not a test — a measurement, to decide how long the list should be. The solve picks its targets
// from the list BEFORE routing, and computeRows re-sorts AFTER it, so a field that came back with
// a long detour sinks and an unchecked one can float above it. This reports how far that drift
// goes on a real pack.
//
//   node scripts/probe_list_vs_solved.mjs <fields.json> [terrainDir]

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const fieldsPath = process.argv[2];
const terrainDir = process.argv[3] || path.join(repo, 'data', 'packs', '_terrain');
const ROOT = path.join(tmpdir(), `mtc-probe-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.terr': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };

const LAT = Number(process.env.LAT || 45.5), LON = Number(process.env.LON || 7.0);
const ALT = Number(process.env.ALT || 3500);
// Both read off app.js rather than typed in, so this cannot quietly measure the wrong list after
// either number is tuned — which is the whole reason anyone runs it.
const appSrc = await readFile(path.join(repo, 'src', 'app.js'), 'utf8');
const constant = (name, fallback) => {
  const m = appSrc.match(new RegExp(`const ${name} = (\\d+)`));
  return m ? Number(m[1]) : fallback;
};
const SOLVED = constant('TERRAIN_MAX_TARGETS', 80);
const restCap = Number(appSrc.match(/filter\(row => !pickIds\.has\(row\.field\.id\)\)\.slice\(0, (\d+)\)/)?.[1] || 120);
const SHOWN = restCap + 3;   // the rest of the list, plus up to three top picks above the divider

const all = JSON.parse(await readFile(fieldsPath, 'utf8'));
// Only fields the tiles on hand actually cover, so "unchecked" means "not chosen" rather than
// "no ground data". A published deployment carries the whole box; a working copy rarely does,
// and mixing the two makes the drift look far worse than it is. Read off the index rather than
// hardcoded, so this still measures the right thing against a different tile set.
const index = JSON.parse(await readFile(path.join(terrainDir, 'index.json'), 'utf8'));
const covered = new Set(index.tiles.map(t => `${t.lat0}/${t.lon0}`));
const FIELDS = all.filter(f =>
  covered.has(`${Math.floor(f.latitude)}/${Math.floor(f.longitude)}`));
console.log(`${FIELDS.length} of ${all.length} fields sit on the ${index.tileCount} tiles ` +
  `on hand; glider at ${LAT},${LON} @${ALT}m`);
if (!FIELDS.length) {
  console.error('No field falls on a tile you have — build tiles over the pack, or pass LAT/LON.');
  process.exit(2);
}

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

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ locale: 'en-GB' });
await context.addInitScript(settings =>
  localStorage.setItem('mtc-settings-v2', JSON.stringify(settings)), {
    packIds: ['fixture'], language: 'en', safetyMarginM: 250, testMode: true,
    showC: true, showD: true,
    testLatitude: LAT, testLongitude: LON, testAltitudeM: ALT, testLabel: 'Probe',
    terrainRouting: true, terrainClearanceM: 200,
  });
const page = await context.newPage();
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 20000 });
await page.waitForFunction(
  () => window.__mtcState?.terrain?.status === 'ready', null, { timeout: 90000 });
await page.waitForFunction(
  () => (window.__mtcState?.terrain?.solvedIds?.size || 0) > 0, null, { timeout: 90000 });
await page.waitForTimeout(1500);   // let the post-solve re-sort and render settle

const out = await page.evaluate(() => {
  const rows = window.__mtcState.computedRows;
  const solved = window.__mtcState.terrain.solvedIds;
  const t = window.__mtcState.terrain;
  return {
    total: rows.length,
    solvedCount: solved.size,
    coverage: t.coverage,
    trusted: t.trusted,
    routeCount: t.routes.size,
    states: rows.map(r => r.terrainState),
    solvedFlags: rows.map(r => solved.has(r.field.id)),
    glides: rows.map(r => r.requiredGlideRatio),
  };
});

console.log(`\nterrain coverage ${(out.coverage * 100).toFixed(1)}%, trusted=${out.trusted}, ` +
  `${out.routeCount} routes returned for ${out.solvedCount} targets`);
if (!out.trusted) {
  console.log('  !! coverage below the trust threshold: a solved field with no route renders as');
  console.log('     "unchecked" rather than "blocked", so the strip below overstates the drift.');
}

const tally = arr => arr.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
console.log(`\n${out.total} listed, ${out.solvedCount} solved`);
console.log('states over the whole list:', tally(out.states));

const shown = Math.min(SHOWN, out.total);
console.log(`\n--- the ${shown} rows actually rendered ---`);
console.log('states:', tally(out.states.slice(0, shown)));

const top = out.solvedFlags.slice(0, Math.min(SOLVED, out.total));
const uncheckedInTop = top.filter(v => !v).length;
const solvedBelow = out.solvedFlags.slice(SOLVED).filter(Boolean).length;
const firstUnchecked = out.states.findIndex(s => s === 'unchecked');

console.log(`\nfirst 'unchecked' row is #${firstUnchecked < 0 ? '—' : firstUnchecked + 1}`);
console.log(`in the top ${SOLVED}: ${uncheckedInTop} rows were NOT solved`);
console.log(`below row ${SOLVED}: ${solvedBelow} solved rows sank out of the top`);
// The only drift that matters is a row the solve never LOOKED at sitting above one it did.
// A solved field that came back unroutable is a real answer ("you can't get there"), whatever
// glyph a partial tile set makes it render as.
const neverLookedInTop = out.solvedFlags.slice(0, Math.min(SOLVED, out.total))
  .map((wasSolved, i) => (!wasSolved && out.states[i] === 'unchecked' ? i : -1))
  .filter(i => i >= 0);
console.log(`\nof those, ${neverLookedInTop.length} are rows the solve never looked at` +
  (neverLookedInTop.length ? ` (first at #${neverLookedInTop[0] + 1})` : ''));
console.log(`=> cutting the list at ${SOLVED} would still show ${neverLookedInTop.length} ` +
  `never-looked-at row(s), and would hide ${solvedBelow} row(s) that were solved.`);

// Where the checked/unchecked boundary really is, as a strip.
console.log('\nrow states 1..%d (d=direct r=routed b=blocked .=unchecked p=pending):', shown);
const glyph = { direct: 'd', routed: 'r', blocked: 'b', unchecked: '.', pending: 'p' };
for (let i = 0; i < shown; i += 60) {
  console.log(`  ${String(i + 1).padStart(3)}: ` +
    out.states.slice(i, i + 60).map(s => glyph[s] || '?').join(''));
}

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });
