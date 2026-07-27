// The two phone shots on the landing page, taken from the real app rather than drawn by hand.
//
// The scenario is chosen, not arbitrary. At 3400 m over the Écrins the three pinned picks are all
// A-rated airfields needing L/D 11–17, while the rows below include a C at 6.6 and a D at 9.0 —
// better raw numbers, ranked lower. That is the app's whole argument in one screen, and the shot
// it replaced said the opposite: three C fields at the top.
//
// Terrain routing is on, so the list carries its mountain marks and the detail sheet draws the
// glide-over-ground profile.
//
//   node scripts/shoot_landing_screens.mjs <packDir> [outDir]
//
// packDir needs packs.json and packs/<id>/{manifest,fields}.json; terrain comes from
// data/packs/_terrain. Writes screen-list.jpg and screen-detail.jpg at 750×1500.
//
// MTC_LANG picks the app's language and the file names: the default 'en' writes screen-list.jpg,
// anything else writes screen-list.<lang>.jpg beside it. The landing page is translated, so the
// shots on it should be too — a French reader looking at an English screenshot learns the page
// was translated and the app was not, which is the opposite of true.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const packSrc = process.argv[2];
const outDir = process.argv[3] || path.join(repo, 'site', 'public');
const terrainDir = path.join(repo, 'data', 'packs', '_terrain');

if (!packSrc || !existsSync(path.join(packSrc, 'packs.json'))) {
  console.error('usage: node scripts/shoot_landing_screens.mjs <packDir with packs.json> [outDir]');
  process.exit(2);
}
if (!existsSync(path.join(terrainDir, 'index.json'))) {
  console.error(`No terrain at ${terrainDir} — the shots need it.`);
  process.exit(2);
}

// High over the Haute-Maurienne. Chosen against alternatives on four counts: the three pinned
// picks are all A airfields with real codes (no raw OpenAIP ids in the subtitles), their ratios
// ascend so the ordering reads naturally, more than half the list comes back terrain-routed, and
// the route out of here is pinched at a col the data can name — Col du Fréjus — which says more
// about what the app knows than "tightest over ground at 1701 m" ever could.
// Overridable (MTC_SCENE="lat,lon,alt", MTC_DETAIL=<name>) to try a replacement.
const [sLat, sLon, sAlt] = (process.env.MTC_SCENE || '45.05,6.6,3700').split(',').map(Number);
const SCENE = {
  latitude: sLat, longitude: sLon, altitudeM: sAlt,
  // The field to open for the detail shot: routed, so the sheet draws a profile.
  detailMatch: new RegExp(process.env.MTC_DETAIL || 'Sollieres', 'i'),
};
const VIEWPORT = { width: 750, height: 1500 };

// The app's language, and the suffix the shots are written under. Locale is set to match so any
// Intl-formatted figure (dates, decimals) reads the way it would for that pilot.
const LANG = (process.env.MTC_LANG || 'en').toLowerCase();
const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE' };
if (!LOCALES[LANG]) {
  console.error(`MTC_LANG=${LANG} is not one of ${Object.keys(LOCALES).join(', ')}`);
  process.exit(2);
}
const suffix = LANG === 'en' ? '' : `.${LANG}`;
const shotName = base => `screen-${base}${suffix}.jpg`;

const ROOT = path.join(tmpdir(), `mtc-shots-${process.pid}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json', '.terr': 'application/octet-stream' };

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
for (const f of ['index.html', 'styles.css', 'service-worker.js', 'manifest.webmanifest',
  'release-notes.json', 'config.js']) await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f));
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await cp(packSrc, path.join(ROOT, 'packs'), { recursive: true });
await cp(terrainDir, path.join(ROOT, 'packs', '_terrain'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));

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

const packIds = JSON.parse(await readFile(path.join(packSrc, 'packs.json'), 'utf8'))
  .packs.filter(p => !p.hidden).map(p => p.id);

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ locale: LOCALES[LANG], viewport: VIEWPORT,
  deviceScaleFactor: 1, permissions: ['geolocation'] });
// The "updated to x" strip appears whenever the stored version differs from the running one. It
// is chrome about this rig, not about the app, so the current version is recorded up front.
const appVersion = /APP_VERSION = '([^']+)'/
  .exec(await readFile(path.join(repo, 'src', 'app.js'), 'utf8'))[1];

await context.addInitScript(([ids, scene, version, language]) => {
  localStorage.setItem('mtc-last-seen-version', version);
  localStorage.setItem('mtc-settings-v2', JSON.stringify({
    packIds: ids, language, safetyMarginM: 250, showC: true, showD: true,
    testMode: false,
    terrainRouting: true, terrainAcknowledged: true, terrainClearanceM: 200,
  }));

  // A real GPS fix rather than the app's test mode. Test mode is honest in the cockpit — it paints
  // a red "this is not your real position" banner across the top — but that banner is the app
  // shouting a caveat about the screenshot rig, not about the app, and it would be the loudest
  // thing on the landing page. Playwright's own geolocation carries no altitude, and altitude is
  // the whole input here, so the fix is supplied directly.
  const fix = {
    coords: {
      latitude: scene.latitude, longitude: scene.longitude, altitude: scene.altitudeM,
      accuracy: 8, altitudeAccuracy: 12, heading: null, speed: null,
    },
    timestamp: Date.now(),
  };
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: ok => ok(fix),
      watchPosition: ok => { ok(fix); return 1; },
      clearWatch: () => {},
    },
  });
}, [packIds, SCENE, appVersion, LANG]);

const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(String(e)));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(base);
await page.waitForSelector('.field-row', { timeout: 20000 });
// Wait for the wavefront: the shot is worthless without the routed marks it exists to show.
await page.waitForFunction(() => document.querySelectorAll('.field-glide.routed').length >= 3,
  null, { timeout: 60000 });
await page.waitForTimeout(1200);

// Walk the list in document order so the divider's position — i.e. how many picks are pinned —
// is visible rather than inferred.
const summary = await page.evaluate(() => {
  const out = [];
  const list = document.querySelector('.field-row')?.parentElement;
  for (const el of list ? [...list.children] : []) {
    if (el.classList.contains('top-picks-divider')) { out.push({ divider: true }); continue; }
    if (!el.classList.contains('field-row')) continue;
    out.push({
      name: el.querySelector('.field-name')?.textContent?.trim(),
      diff: el.querySelector('.badge')?.textContent?.trim(),
      glide: el.querySelector('.field-glide')?.textContent?.trim(),
      routed: el.querySelector('.field-glide')?.classList.contains('routed') || false,
    });
  }
  return out.slice(0, 11);
});
const pinned = summary.findIndex(r => r.divider);

console.log('\nlist shot — list in order:');
for (const r of summary) {
  if (r.divider) { console.log('  ── pinned picks above ─────────────'); continue; }
  console.log(`  ${(r.diff || '?').padEnd(2)} ${r.name?.padEnd(26)} L/D ${String(r.glide).padStart(4)}${r.routed ? '  ⛰' : ''}`);
}
console.log(`  pinned picks: ${pinned === -1 ? 'NONE — the shot loses its point' : pinned}`);
const rowCount = await page.$$eval('.field-row', n => n.length);
const routedCount = await page.$$eval('.field-glide.routed', n => n.length);
// A raw OpenAIP id in the subtitle (IT_MERLO_ROMANO_44P834_7P364) is machine noise on a hero shot.
// Checked across every row, not just the pinned ones: the shot this replaced was approved on its
// top 6 and shipped with three of them at rows 15-17, in frame the whole time.
const rawIds = await page.$$eval('.field-row', rows => rows
  .map(r => ({ name: r.querySelector('.field-name')?.textContent?.trim(),
               sub: r.querySelector('.field-sub')?.textContent || '' }))
  .filter(r => /\d+P\d+/.test(r.sub)));
console.log(`  routed ${routedCount}/${rowCount} rows · raw-id codes anywhere in the list: ${rawIds.length}`);
for (const r of rawIds) problems.push(`raw OpenAIP id on screen: ${r.name} — ${r.sub.trim()}`);

await page.screenshot({ path: path.join(outDir, shotName('list')), quality: 88, type: 'jpeg' });

// --- detail sheet, with the glide-over-terrain profile ------------------------------------------
let opened = '';
for (const row of await page.$$('.field-row')) {
  const name = await row.$eval('.field-name', n => n.textContent.trim()).catch(() => '');
  const routed = await row.$eval('.field-glide', n => n.classList.contains('routed')).catch(() => false);
  if (routed && SCENE.detailMatch.test(name)) { opened = name; await row.click(); break; }
}
if (!opened) {
  // Any routed field beats none: the profile is the thing the shot has to show.
  for (const row of await page.$$('.field-row')) {
    const routed = await row.$eval('.field-glide', n => n.classList.contains('routed')).catch(() => false);
    if (routed) { opened = await row.$eval('.field-name', n => n.textContent.trim()); await row.click(); break; }
  }
}
await page.waitForSelector('.detail', { timeout: 10000 });
await page.waitForSelector('.route-profile', { timeout: 10000 });
await page.waitForTimeout(900);
console.log(`\ndetail shot — ${opened}`);
console.log('  route text: ' + (await page.$eval('.route-summary', el => el.innerText)).split('\n').join(' / '));
await page.screenshot({ path: path.join(outDir, shotName('detail')), quality: 88, type: 'jpeg' });

await browser.close();
server.close();
if (problems.length) {
  console.log('\npage problems:'); for (const p of problems.slice(0, 8)) console.log('  ' + p);
}
console.log(`\nwrote ${shotName('list')} and ${shotName('detail')} to ${outDir} (language: ${LANG})`);
