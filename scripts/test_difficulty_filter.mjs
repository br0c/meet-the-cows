// The C/D difficulty switches: their default, their warning gate, and their migration.
//
// They used to read "Hide C fields" / "Hide D fields" and ship ON — the only switches in
// Settings phrased as a negative and the only ones enabled by default. They now read "Show C
// fields" / "Show D fields" and ship OFF: identical behaviour, said the way every other switch
// says itself.
//
// The migration is the part worth a test. loadSettings keeps only keys that exist in
// DEFAULT_SETTINGS, so an unmigrated hideC would simply vanish — and a pilot who had
// deliberately accepted the warning and revealed those fields would quietly stop being shown
// them, with nothing on screen to say so. That is a safety regression disguised as a rename.
//
//   node scripts/test_difficulty_filter.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-difficulty-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

// One field per grade, all close by, so what is on screen is purely the filter's doing.
const FIELDS = [
  { id: 'a1', name: 'Alpha', difficulty: 'A', latitude: 45.90, longitude: 7.60 },
  { id: 'b1', name: 'Bravo', difficulty: 'B', latitude: 45.89, longitude: 7.61 },
  { id: 'c1', name: 'Charlie', difficulty: 'C', latitude: 45.88, longitude: 7.62 },
  { id: 'd1', name: 'Delta', difficulty: 'D', latitude: 45.87, longitude: 7.63 },
].map(f => ({ ...f, kind: 'outlanding', code: '', rawDifficulty: f.difficulty, elevationM: 500,
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

/** Open the app with `stored` as its saved settings (null = a first-ever visit). */
async function open(stored) {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(saved => {
    if (saved) localStorage.setItem('mtc-settings-v2', JSON.stringify(saved));
    else localStorage.removeItem('mtc-settings-v2');
  }, stored);
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('.field-row', { timeout: 15000 });
  return { context, page };
}
const names = page => page.$$eval('.field-name', n => n.map(x => x.textContent.trim()).sort());
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('mtc-settings-v2')));

// A pack selection is needed for fields to appear at all; everything else is left at its default
// so the defaults are what the first scenario actually measures.
const BASE_SETTINGS = {
  packIds: ['fixture'], language: 'en', testMode: true,
  testLatitude: 45.9356, testLongitude: 7.6304, testAltitudeM: 3000, testLabel: 'Cervinia',
};

// --- 1. defaults ---------------------------------------------------------------------------------
console.log('\n1 — out of the box, C and D are hidden and both switches read as off');
{
  const { context, page } = await open(BASE_SETTINGS);
  check('only A and B are listed', (await names(page)).join(',') === 'Alpha,Bravo',
    (await names(page)).join(','));

  await page.click('#settingsToggle');
  await page.waitForSelector('#showC');
  const labels = await page.$$eval('.set-row', rows => rows
    .map(r => r.innerText.split('\n')[0].trim())
    .filter(t => /fields/i.test(t)));
  check('the switches are phrased as "Show …"', labels.includes('Show C fields')
    && labels.includes('Show D fields'), labels.join(' | '));
  check('neither is on', (await page.$eval('#showC', el => el.checked)) === false
    && (await page.$eval('#showD', el => el.checked)) === false);
  check('no switch is left phrased as "Hide …"', !labels.some(t => /^Hide/i.test(t)),
    labels.join(' | '));
  await context.close();
}

// --- 2. the warning gate -------------------------------------------------------------------------
console.log('\n2 — switching one ON asks first, and declining leaves it off');
{
  const { context, page } = await open(BASE_SETTINGS);
  await page.click('#settingsToggle');
  await page.waitForSelector('#showC');

  let asked = '';
  page.once('dialog', dialog => { asked = dialog.message(); dialog.dismiss(); });
  await page.click('#showC');
  await page.waitForTimeout(400);
  check('turning it on asks for an acknowledgement', /difficult/i.test(asked), asked.slice(0, 90));
  check('the warning names the grade', /\bC\b/.test(asked), asked.slice(0, 90));
  check('declining leaves the switch off', (await page.$eval('#showC', el => el.checked)) === false);
  check('declining leaves the setting off', (await saved(page)).showC === false);

  page.once('dialog', dialog => dialog.accept());
  await page.click('#showC');
  await page.waitForTimeout(600);
  check('accepting turns it on', (await page.$eval('#showC', el => el.checked)) === true);
  check('accepting saves it', (await saved(page)).showC === true);

  await page.click('#settingsToggle');
  await page.waitForSelector('.field-row');
  check('C now appears, D still does not', (await names(page)).join(',') === 'Alpha,Bravo,Charlie',
    (await names(page)).join(','));
  await context.close();
}

// --- 3. migration from the old stored keys -------------------------------------------------------
console.log('\n3 — the old hideC/hideD settings carry over with their meaning intact');
{
  // The pilot who accepted the warning and revealed C, but left D hidden.
  const { context, page } = await open({ ...BASE_SETTINGS, hideC: false, hideD: true });
  check('C is still shown after the rename', (await names(page)).includes('Charlie'),
    (await names(page)).join(','));
  check('D is still hidden after the rename', !(await names(page)).includes('Delta'),
    (await names(page)).join(','));

  await page.click('#settingsToggle');
  await page.waitForSelector('#showC');
  check('the C switch reads on', (await page.$eval('#showC', el => el.checked)) === true);
  check('the D switch reads off', (await page.$eval('#showD', el => el.checked)) === false);

  const stored = await saved(page);
  check('the migrated setting is stored under the new key', stored.showC === true && stored.showD === false,
    JSON.stringify({ showC: stored.showC, showD: stored.showD }));
  check('the retired keys are not written back', !('hideC' in stored) && !('hideD' in stored),
    Object.keys(stored).filter(k => k.startsWith('hide')).join(','));
  await context.close();
}

// --- 4. the other direction, and the conservative default for a stranger --------------------------
console.log('\n4 — a pilot who had hidden both keeps them hidden; a first visit hides them too');
{
  const { context, page } = await open({ ...BASE_SETTINGS, hideC: true, hideD: true });
  check('both stay hidden', (await names(page)).join(',') === 'Alpha,Bravo',
    (await names(page)).join(','));
  await context.close();

  // Settings written by a build that never had these keys at all: the default must apply, and
  // the default is the cautious one.
  const fresh = await open(BASE_SETTINGS);
  check('settings with neither key fall back to hidden',
    (await names(fresh.page)).join(',') === 'Alpha,Bravo', (await names(fresh.page)).join(','));
  await fresh.context.close();

  // And a pilot who had revealed BOTH keeps both — the case where losing the setting would be
  // least visible, because the list simply gets shorter.
  const both = await open({ ...BASE_SETTINGS, hideC: false, hideD: false });
  check('a pilot who had revealed both keeps both',
    (await names(both.page)).join(',') === 'Alpha,Bravo,Charlie,Delta',
    (await names(both.page)).join(','));
  await both.context.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
