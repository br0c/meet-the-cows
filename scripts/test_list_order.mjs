// The nearest list has one order, and it is the one that answers the question.
//
// A "nearest distance" sort used to sit beside "best glide ratio" in Settings. It was retired:
// proximity ranks a field 3 km away that you cannot reach above one 45 km away that you can,
// which is the wrong end of the list to be reading when it matters. Distance keeps its own
// column on every row — nothing is hidden, it just stops deciding the order.
//
// The fixture is built so the two orders disagree completely: sorted by distance it reads
// exactly backwards. Standing at 3000 m with a 250 m margin:
//
//   Hopeless Near   3 km   2900 m   below the margin -> no answer
//   Steep Near      6 km   2500 m   reachable, but only just
//   Middle         20 km   1000 m   the best of them
//   Easy Far       45 km    400 m   further, and still easier than Steep Near
//   Hopeless Far   50 km   2900 m   below the margin -> no answer
//
//   node scripts/test_list_order.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-order-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

const LAT = 45.9356, LON = 7.6304, ALT = 3000;      // Cervinia, 3000 m
const KM = 1 / 111.32;                               // degrees of latitude per km, due south

// All difficulty A, so the C/D filter cannot influence what is on screen.
const FIELDS = [
  { id: 'hn', name: 'Hopeless Near', km: 3,  elevationM: 2900 },
  { id: 'sn', name: 'Steep Near',    km: 6,  elevationM: 2500 },
  { id: 'mi', name: 'Middle',        km: 20, elevationM: 1000 },
  { id: 'ef', name: 'Easy Far',      km: 45, elevationM: 400 },
  { id: 'hf', name: 'Hopeless Far',  km: 50, elevationM: 2900 },
].map(f => ({ ...f, kind: 'outlanding', code: '', difficulty: 'A', rawDifficulty: 'A',
  latitude: Number((LAT - f.km * KM).toFixed(6)), longitude: LON,
  lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '', media: [],
  source: { name: 'fixture' } }));

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

async function open(extra = {}) {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(settings =>
    localStorage.setItem('mtc-settings-v2', JSON.stringify(settings)), {
      packIds: ['fixture'], language: 'en', safetyMarginM: 250, testMode: true,
      testLatitude: LAT, testLongitude: LON, testAltitudeM: ALT, testLabel: 'Cervinia',
      ...extra,
    });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('.field-row', { timeout: 15000 });
  return { context, page };
}
const rows = page => page.$$eval('.field-row', list => list.map(r => ({
  name: r.querySelector('.field-name')?.textContent?.trim(),
  dist: r.querySelector('.field-km')?.textContent?.trim(),
  glide: r.querySelector('.field-glide')?.textContent?.trim(),
})));

// --- 1. the order is by required glide, and distance disagrees with it ---------------------------
console.log('\n1 — reachability decides the order, not proximity');
{
  const { context, page } = await open();
  const list = await rows(page);
  console.log('  as listed:');
  for (const r of list) console.log(`    ${r.name.padEnd(16)} ${r.dist.padStart(7)}  L/D ${r.glide.padStart(4)}`);

  const order = list.map(r => r.name);
  check('the best glide leads', order[0] === 'Middle', order.join(' < '));
  check('a far field you can make outranks a near one you can barely make',
    order.indexOf('Easy Far') < order.indexOf('Steep Near'), order.join(' < '));
  check('fields with no answer sit at the bottom',
    order.slice(-2).sort().join(',') === 'Hopeless Far,Hopeless Near', order.join(' < '));
  check('and among those, the nearer one comes first',
    order.indexOf('Hopeless Near') < order.indexOf('Hopeless Far'), order.join(' < '));

  // The whole point: sorting by distance would have read backwards.
  const byDistance = [...list].sort((a, b) => parseFloat(a.dist) - parseFloat(b.dist)).map(r => r.name);
  check('this is genuinely not distance order', byDistance.join() !== order.join(),
    `distance would be: ${byDistance.join(' < ')}`);
  check('distance is still shown on every row', list.every(r => /\d/.test(r.dist)));
  await context.close();
}

// --- 2. the control is gone, and a stored preference for it cannot bring it back -----------------
console.log('\n2 — Settings offers no sort control, and the retired preference is inert');
{
  const { context, page } = await open({ sortMode: 'distance' });
  const order = (await rows(page)).map(r => r.name);
  check('a stored sortMode:distance no longer reorders anything', order[0] === 'Middle',
    order.join(' < '));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mtc-settings-v2')));
  check('and it is not written back', !('sortMode' in stored),
    Object.keys(stored).filter(k => /sort/i.test(k)).join(','));

  await page.click('#settingsToggle');
  await page.waitForSelector('.settings-card', { timeout: 8000 });
  check('no sort control exists', (await page.$('#sortMode')) === null);
  const text = await page.$eval('.settings-card:has(#showC)', el => el.innerText);
  check('the nearest-list card no longer offers a sort', !/\bsort\b/i.test(text),
    text.replace(/\n/g, ' | ').slice(0, 120));
  check('the rest of that card is intact', /margin/i.test(text) && /Show C fields/.test(text),
    text.replace(/\n/g, ' | ').slice(0, 120));
  await context.close();
}

// --- 3. with no altitude there is nothing to rank by, and the list falls back to distance --------
console.log('\n3 — with no altitude, the order falls back to distance on its own');
{
  // This is what the retired mode degenerated to anyway, which is why removing it cost nothing.
  const { context, page } = await open({ testAltitudeM: null });
  const list = await rows(page);
  const order = list.map(r => r.name);
  check('no field can be scored', list.every(r => !/^\d/.test(r.glide)),
    list.map(r => r.glide).join(','));
  check('so the list is simply nearest first',
    order.join() === 'Hopeless Near,Steep Near,Middle,Easy Far,Hopeless Far', order.join(' < '));
  await context.close();
}

// --- 4. the pinned shortlist's cut-off ------------------------------------------------------------
console.log('\n4 — what qualifies for the pinned picks');
{
  // The gate is bracketed rather than restated: a test that asserts the constant equals the
  // constant catches nothing. Steep Near is the probe — its required glide moves with altitude,
  // so the same field can be walked across the boundary from either side.
  //
  //   3000 m -> Steep Near needs 24.0, and must be pinned. At the old cut-off of 20 it was not,
  //             which is the change this locks in.
  //   2980 m -> the same field needs 26.1, is still perfectly reachable, and must NOT be pinned
  //             while only two others qualify — so the cut-off is a real limit, not slice(0, 3)
  //             quietly doing the work.
  const listing = page => page.evaluate(() => {
    const out = [];
    const list = document.querySelector('.field-row')?.parentElement;
    for (const el of list ? [...list.children] : []) {
      if (el.classList.contains('top-picks-divider')) { out.push('--divider--'); continue; }
      if (el.classList.contains('field-row')) out.push(el.querySelector('.field-name')?.textContent?.trim());
    }
    return out;
  });
  const pinnedIn = shown => {
    const at = shown.indexOf('--divider--');
    return at === -1 ? [] : shown.slice(0, at);
  };

  {
    const { context, page } = await open();                       // 3000 m
    const shown = await listing(page);
    const pinned = pinnedIn(shown);
    console.log(`  at 3000 m pinned: ${pinned.join(', ') || '(none)'}`);
    check('a field needing 24 is pinned', pinned.includes('Steep Near'), pinned.join(', '));
    check('and it is the third pick, behind the two easier ones', pinned.length === 3,
      `${pinned.length} pinned`);
    await context.close();
  }
  {
    const { context, page } = await open({ testAltitudeM: 2980 }); // same field, now needing 26.1
    const shown = await listing(page);
    const pinned = pinnedIn(shown);
    const listed = shown.filter(n => n !== '--divider--');
    console.log(`  at 2980 m pinned: ${pinned.join(', ') || '(none)'}`);
    check('the same field needing 26 is not pinned', !pinned.includes('Steep Near'),
      pinned.join(', '));
    check('though it is still offered below the divider', listed.includes('Steep Near'));
    check('so the shortlist is short rather than padded', pinned.length === 2,
      `${pinned.length} pinned`);
    await context.close();
  }
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
