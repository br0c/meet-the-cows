// Every media item credits its publisher on the card the pilot actually looks at.
//
// The credit used to be swallowed: renderMediaItem computed `caption = item.caption ||
// item.source`, so anything WITH a caption — which every chart has ("VAC LESU") — never showed
// its source at all. The attribution lived only in the pack manifest and the pack notices, i.e.
// nowhere a pilot opening a chart would see it. Several of these sources licence their material
// on condition it is attributed wherever it appears.
//
// This covers every chart publisher the packs ship plus a photo source and a contributed photo,
// so a future refactor cannot quietly drop one provider's credit.
//
//   node scripts/test_media_credit.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-credit-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json' };

// One field per publisher, each carrying the source string the builder really emits.
const PUBLISHERS = [
  ['sia', 'VAC LFNE', 'Service de l’Information Aéronautique (SIA)', 'pdf'],
  ['enaire_aip', 'VAC LESU', 'ENAIRE (AIP España) — © ENAIRE, all IP rights reserved', 'pdf'],
  ['enaire_guia', 'VAC LECI', 'ENAIRE (Guía VFR) — © ENAIRE, all IP rights reserved', 'pdf'],
  ['enav', 'VAC LIPB', 'ENAV S.p.A. (AIP Italia)', 'pdf'],
  ['dfs', 'VAC EDMK', '© DFS Deutsche Flugsicherung GmbH', 'pdf'],
  ['austro', 'VAC LOAN', 'Austro Control GmbH (AIP Austria)', 'pdf'],
  ['apvv', 'Le champ vu du sud', 'APVV — Guide des champs pyrénéens', 'image'],
  ['contrib', 'Pilot photo 2026-07-02', 'Contributed by a pilot', 'image'],
];

const FIELDS = PUBLISHERS.map(([id, caption, source, type], i) => ({
  id, name: `Field ${id}`, latitude: 45.90 + i * 0.01, longitude: 7.60 + i * 0.01,
  kind: 'outlanding', difficulty: 'A', rawDifficulty: 'A', code: '', elevationM: 500,
  lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '',
  media: [{ type, url: type === 'pdf' ? 'doc.pdf' : 'photo.jpg', caption, source }],
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
await writeFile(path.join(ROOT, 'packs', 'fixture', 'doc.pdf'), '%PDF-1.4\n%%EOF\n');
await writeFile(path.join(ROOT, 'packs', 'fixture', 'photo.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

const fieldsJson = JSON.stringify(FIELDS);
await writeFile(path.join(ROOT, 'packs', 'fixture', 'fields.json'), fieldsJson);
await writeFile(path.join(ROOT, 'packs', 'fixture', 'manifest.json'), JSON.stringify({
  id: 'fixture', name: 'Fixture', names: { en: 'Fixture' }, hidden: false, version: 'v1',
  generatedAt: 'x', isSample: false, fieldsUrl: 'fields.json', fieldsCount: FIELDS.length,
  mediaCount: FIELDS.length, mediaFiles: 2, fieldsBytes: fieldsJson.length,
  sizeBytes: fieldsJson.length, selector: 't', sources: [], notices: [] }));
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
const context = await browser.newContext({ locale: 'en-GB' });
await context.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
  packIds: ['fixture'], language: 'en', testMode: true, showC: true, showD: true,
  testLatitude: 45.90, testLongitude: 7.60, testAltitudeM: 4000, testLabel: 'T',
})));
const page = await context.newPage();
await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 20000 });

console.log('\nEvery publisher is credited on the media card');
for (const [id, caption, source] of PUBLISHERS) {
  const row = page.locator('.field-row', { hasText: `Field ${id}` }).first();
  await row.click();
  await page.waitForSelector('.media-card', { timeout: 10000 });
  const credits = await page.locator('.media-card .media-credit').allInnerTexts();
  const captions = await page.locator('.media-card .caption').allInnerTexts();
  check(`${id}: credit shown`, credits.some(c => c.trim() === source),
    `saw ${JSON.stringify(credits)}`);
  check(`${id}: caption still shown`, captions.some(c => c.includes(caption)),
    `saw ${JSON.stringify(captions)}`);
  await page.click('#closeDetail');  // it is a modal; the row underneath is not clickable
  await page.waitForSelector('.detail-backdrop', { state: 'detached', timeout: 10000 });
}

console.log('\nA caption that IS the source is not printed twice');
await page.evaluate(() => {
  const field = window.__mtcState.fields[0];
  field.media = [{ type: 'image', url: 'photo.jpg', source: 'Sole Credit',
                   caption: 'Sole Credit' }];
});
const first = page.locator('.field-row', { hasText: 'Field sia' }).first();
await first.click();
await page.waitForSelector('.media-card', { timeout: 10000 });
const dupCredits = await page.locator('.media-card .media-credit').allInnerTexts();
check('no duplicated credit line', dupCredits.every(c => c.trim() !== 'Sole Credit'),
  JSON.stringify(dupCredits));

await browser.close();
server.close();
await rm(ROOT, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll media credit checks passed');
process.exit(failures ? 1 : 0);
