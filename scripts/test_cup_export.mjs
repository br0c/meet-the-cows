// CUP export: one file per selected pack, zipped when there is more than one.
//
// The export used to be a single CUP holding every loaded field, which meant a pilot flying with
// three packs got one undifferentiated waypoint list. It now emits one CUP per pack. Two things
// are worth pinning: a field that two packs share must appear in exactly ONE file (the packs
// overlap by design — the Alps halves share their corridor, and country packs re-list the same
// aerodromes), and the ZIP has to be a real ZIP. The archive is written by hand here (no
// third-party script is allowed by the CSP), so the test unpacks it with a different
// implementation than the one that wrote it.
//
//   node scripts/test_cup_export.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-cup-${process.pid}`);
const OUT = path.join(ROOT, '_downloads');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

const field = (id, name, lat, lon, extra = {}) => ({
  id, name, latitude: lat, longitude: lon, kind: 'outlanding', difficulty: 'A',
  rawDifficulty: 'A', code: '', elevationM: 500, lengthM: 800, widthM: 60,
  runwayDirectionDeg: 90, notes: '', media: [], source: { name: 'fixture' }, ...extra,
});

// SHARED is deliberately present in both packs under the same id: that is what the app dedupes.
const SHARED = field('shared1', 'Shared Field', 45.90, 7.60);
const PACKS = {
  west: [SHARED, field('w1', 'West One', 45.91, 7.61), field('w2', 'West Two', 45.92, 7.62)],
  east: [SHARED, field('e1', 'East One', 46.10, 8.40)],
};
// A range pack and a country pack that both carry the same aerodrome — the real case: a field
// in both the Pyrenees and the Spain pack belongs to the range, whatever order the pilot's
// stored selection is in. `range` is listed first in packs.json below, so it must win.
const BORDER = field('border1', 'Border Field', 42.60, 0.90);
PACKS.range = [BORDER, field('r1', 'Range One', 42.61, 0.91)];
PACKS.country = [BORDER, field('c1', 'Country One', 42.30, 0.50)];

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
await mkdir(OUT, { recursive: true });
for (const f of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
  'release-notes.json', 'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));

for (const [id, fields] of Object.entries(PACKS)) {
  await mkdir(path.join(ROOT, 'packs', id), { recursive: true });
  const json = JSON.stringify(fields);
  await writeFile(path.join(ROOT, 'packs', id, 'fields.json'), json);
  await writeFile(path.join(ROOT, 'packs', id, 'manifest.json'), JSON.stringify({
    id, name: id, names: { en: id }, hidden: false, version: 'v1', generatedAt: 'x',
    isSample: false, fieldsUrl: 'fields.json', fieldsCount: fields.length, mediaCount: 0,
    mediaFiles: 0, fieldsBytes: json.length, sizeBytes: json.length, selector: 't',
    sources: [], notices: [] }));
}
await writeFile(path.join(ROOT, 'packs', 'packs.json'), JSON.stringify({
  schemaVersion: 2, updatedAt: 'x',
  packs: Object.entries(PACKS).map(([id, fields]) => ({
    id, name: id, names: { en: id }, hidden: false,
    manifestUrl: `packs/${id}/manifest.json`, sizeBytes: 100, fieldsCount: fields.length })) }));

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
const rowCount = text => text.trim().split(/\r\n/).length - 1;  // minus the header
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function exportWith(packIds) {
  const context = await browser.newContext({ locale: 'en-GB', acceptDownloads: true });
  await context.addInitScript(([ids]) => {
    localStorage.setItem('mtc-settings-v2', JSON.stringify({
      packIds: ids, language: 'en', testMode: true,
      testLatitude: 45.90, testLongitude: 7.60, testAltitudeM: 3000, testLabel: 'T',
    }));
    // navigator.share would open a native sheet Playwright cannot dismiss; force the
    // download path, which is the branch desktop pilots get anyway.
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  }, [packIds]);
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('.field-row', { timeout: 20000 });
  await page.click('#settingsToggle');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('#exportCup'),
  ]);
  const saved = path.join(OUT, `${packIds.join('-')}-${download.suggestedFilename()}`);
  await download.saveAs(saved);
  await context.close();
  return { filename: download.suggestedFilename(), saved };
}

console.log('\n1. Two packs selected -> a ZIP of one CUP per pack');
const multi = await exportWith(['west', 'east']);
check('download is a .zip', multi.filename.endsWith('.zip'), multi.filename);

// Unpack with Python's zipfile: an independent implementation of the format, so a ZIP this
// app wrote incorrectly cannot pass by agreeing with itself.
const listing = execFileSync('python3', ['-c', `
import json, zipfile
with zipfile.ZipFile(${JSON.stringify(multi.saved)}) as z:
    bad = z.testzip()
    print(json.dumps({"bad": bad, "names": sorted(z.namelist()),
                      "texts": {n: z.read(n).decode("utf-8") for n in z.namelist()}}))
`], { encoding: 'utf8' });
const zip = JSON.parse(listing);
check('archive passes a CRC check', zip.bad === null, String(zip.bad));
check('one CUP per selected pack', zip.names.length === 2, zip.names.join(', '));
check('files are named per pack', zip.names.some(n => n.includes('-west-')) &&
  zip.names.some(n => n.includes('-east-')), zip.names.join(', '));

const westText = zip.texts[zip.names.find(n => n.includes('-west-'))];
const eastText = zip.texts[zip.names.find(n => n.includes('-east-'))];
check('each CUP carries the standard header',
  westText.startsWith('name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc'),
  westText.slice(0, 40));
check('west CUP holds only west fields',
  westText.includes('West One') && westText.includes('West Two') && !westText.includes('East One'));
check('east CUP holds only east fields',
  eastText.includes('East One') && !eastText.includes('West One'));

const sharedIn = [westText, eastText].filter(text => text.includes('Shared Field')).length;
check('a field both packs carry is written exactly once', sharedIn === 1,
  `appears in ${sharedIn} files`);

check('no field is lost between the two files', rowCount(westText) + rowCount(eastText) === 4,
  `${rowCount(westText)} + ${rowCount(eastText)}`);

console.log('\n2. Precedence: the range pack keeps the shared field, whatever order it is stored in');
// Stored deliberately country-first — the order an older settings blob, or the Alps-split
// migration branch (which appends), can leave behind. Load order must follow packs.json anyway.
const border = await exportWith(['country', 'range']);
const borderZip = JSON.parse(execFileSync('python3', ['-c', `
import json, zipfile
with zipfile.ZipFile(${JSON.stringify(border.saved)}) as z:
    print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))
`], { encoding: 'utf8' }));
const rangeText = borderZip[Object.keys(borderZip).find(n => n.includes('-range-'))];
const countryText = borderZip[Object.keys(borderZip).find(n => n.includes('-country-'))];
check('the range pack carries the shared aerodrome', rangeText.includes('Border Field'));
check('the country pack leaves it out', !countryText.includes('Border Field'));
check('the country pack keeps its own fields', countryText.includes('Country One'));

console.log('\n3. A country pack on its own is complete — nothing is withheld for an absent range pack');
// The precedence rule must be a tie-break BETWEEN SELECTED PACKS, never a property stamped on
// the pack itself. A pilot who flies France without the Alps pack has to get every French field,
// including the ones the Alps pack would have claimed had it been selected too.
const countryAlone = await exportWith(['country']);
check('a single country pack exports a plain .cup', countryAlone.filename.endsWith('.cup'),
  countryAlone.filename);
const countryAloneText = await readFile(countryAlone.saved, 'utf8');
check('it carries the shared aerodrome the range pack would otherwise own',
  countryAloneText.includes('Border Field'));
check('it carries its own fields too', countryAloneText.includes('Country One'));
check('nothing is missing from it', rowCount(countryAloneText) === 2,
  `${rowCount(countryAloneText)} rows`);

// And the same in the other direction, with three packs where two would claim the same field.
const trio = await exportWith(['country', 'range', 'west']);
const trioZip = JSON.parse(execFileSync('python3', ['-c', `
import json, zipfile
with zipfile.ZipFile(${JSON.stringify(trio.saved)}) as z:
    print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))
`], { encoding: 'utf8' }));
const trioTexts = Object.values(trioZip);
const totalRows = trioTexts.reduce((sum, text) => sum + rowCount(text), 0);
check('three packs -> three CUPs', Object.keys(trioZip).length === 3,
  Object.keys(trioZip).join(', '));
check('every distinct field appears exactly once across them', totalRows === 6,
  `${totalRows} rows over ${Object.keys(trioZip).length} files`);

console.log('\n4. One pack selected -> a plain .cup, not a zip of one');
const single = await exportWith(['west']);
check('download is a .cup', single.filename.endsWith('.cup'), single.filename);
check('filename names the pack', single.filename.includes('-west-'), single.filename);
const singleText = await readFile(single.saved, 'utf8');
check('contains that pack\'s fields',
  singleText.includes('West One') && singleText.includes('Shared Field')
  && !singleText.includes('East One'));

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll CUP export checks passed');
process.exit(failures ? 1 : 0);
