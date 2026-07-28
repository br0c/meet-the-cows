// Gated charts, end to end in a real browser: token minting, the iframe, the offline
// download, cache keying, and — the part that has actually shipped broken before — the CSP.
//
// Two origins, like production: the app on one port, a stub chart Worker on another with the
// same token semantics as worker/src/index.js (mint at /charts/token, 403 without a valid
// token). The document is served with the REAL deploy/app-csp.txt; __PACKS_ORIGIN__ is
// substituted with the stub's origin, standing in for the data host the deployed policy names.
//
//   node scripts/test_chart_worker_app.mjs
//
// Needs playwright and a Chromium build; set CHROMIUM_PATH if it is not on the default path.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-charts-${process.pid}`);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? '  ok  ' : 'FAIL  '}${label}`); if (!cond) failures += 1; };

// --- textual CSP guard -------------------------------------------------------------------------
// The functional run below substitutes the stub origin, so it cannot prove the DEPLOYED policy
// names the chart Worker. That is a string property of the policy file; assert it as one.
const cspRaw = await readFile(path.join(repo, 'deploy', 'app-csp.txt'), 'utf8');
const policyLine = cspRaw.split('\n').filter(l => !l.startsWith('#')).join(' ');
for (const directive of ['frame-src', 'connect-src']) {
  const value = policyLine.split(';').find(part => part.trim().startsWith(directive)) || '';
  check(`deployed CSP: ${directive} allows api.meetthecows.org`, value.includes('https://api.meetthecows.org'));
}

// --- fixture site ------------------------------------------------------------------------------
await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
await mkdir(path.join(ROOT, 'packs', 'pyr-test'), { recursive: true });
for (const f of ['index.html','styles.css','service-worker.js','manifest.webmanifest','release-notes.json'])
  await cp(path.join(repo, f), path.join(ROOT, f));
for (const f of ['app.js', 'terrain.js', 'glide-worker.js'])
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f)).catch(() => {});
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0,0,1,0,0,0]));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n');

// One airfield whose chart is gated (chartKey) and one plain photo-less outlanding, so the
// list renders both kinds.
const FIELDS = [
  { id: 'es_leci', kind: 'airfield', name: 'Santa Cilia', code: 'LECI', latitude: 45.74,
    longitude: 7.37, elevationM: 670, difficulty: 'A', rawDifficulty: 'aerodrome', lengthM: 950,
    widthM: 25, runwayDirectionDeg: 90, notes: '', source: { name: 'fixture' },
    media: [{ type: 'pdf', url: '../_shared/docs/vac/LECI.pdf', chartKey: 'vac/LECI.pdf',
      caption: 'VAC LECI', source: 'fixture', bytes: PDF.length }],
    docs: { vac: '../_shared/docs/vac/LECI.pdf', vacKey: 'vac/LECI.pdf' } },
  { id: 'es_e13', kind: 'outlanding', name: 'Graus', code: 'E13', latitude: 45.75,
    longitude: 7.38, elevationM: 450, difficulty: 'A', rawDifficulty: 'facile', lengthM: 400,
    notes: '', media: [], source: { name: 'fixture' } },
];
await writeFile(path.join(ROOT,'packs','pyr-test','fields.json'), JSON.stringify(FIELDS));
await writeFile(path.join(ROOT,'packs','pyr-test','manifest.json'), JSON.stringify({
  id:'pyr-test', name:'Pyr test', names:{en:'Pyr test'}, hidden:false, version:'t1',
  generatedAt:'2026-07-28T00:00:00Z', isSample:false, fieldsUrl:'fields.json', fieldsCount:2,
  mediaCount:1, mediaFiles:1, fieldsBytes:100, sizeBytes:100, selector:'test', sources:[], notices:[] }));
await writeFile(path.join(ROOT,'packs','packs.json'), JSON.stringify({ schemaVersion:2, updatedAt:'x',
  packs:[{ id:'pyr-test', name:'Pyr test', names:{en:'Pyr test'}, hidden:false,
    manifestUrl:'packs/pyr-test/manifest.json', sizeBytes:100, fieldsCount:2 }] }));

// --- stub chart Worker -------------------------------------------------------------------------
// Same contract as worker/src/index.js, small enough to read: opaque token with an embedded
// expiry, minted at /charts/token, required (and checked) on /charts/<key>.
const stats = { minted: 0, served: 0, denied: 0, tokenTtlS: 3600 };
const validTokens = new Set();
const chartSrv = http.createServer((rq, rs) => {
  const url = new URL(rq.url, 'http://x');
  const headers = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/charts/token') {
    stats.minted += 1;
    const token = `${Math.floor(Date.now() / 1000) + stats.tokenTtlS}.stub${stats.minted}`;
    validTokens.add(token);
    rs.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify({ token, expiresIn: stats.tokenTtlS }));
    return;
  }
  if (url.pathname === '/charts/vac/LECI.pdf') {
    const token = url.searchParams.get('t') || '';
    const [expiry] = token.split('.');
    if (!validTokens.has(token) || Number(expiry) < Date.now() / 1000) {
      stats.denied += 1;
      rs.writeHead(403, headers); rs.end('Forbidden');
      return;
    }
    stats.served += 1;
    rs.writeHead(200, { ...headers, 'Content-Type': 'application/pdf',
      'Content-Length': String(PDF.length), 'Cache-Control': 'private, max-age=31536000, immutable' });
    rs.end(PDF);
    return;
  }
  rs.writeHead(404, headers); rs.end('Not found');
});
await new Promise(resolve => chartSrv.listen(0, '127.0.0.1', resolve));
const CHARTS_ORIGIN = `http://127.0.0.1:${chartSrv.address().port}`;

await writeFile(path.join(ROOT, 'config.js'),
  `self.MTC_CONFIG = { packsBase: '', chartsBase: '${CHARTS_ORIGIN}/', channel: 'test' };\n`);

// --- app origin, serving the real CSP ---------------------------------------------------------
const CSP = policyLine.replaceAll('__PACKS_ORIGIN__', CHARTS_ORIGIN).replace(/ +/g, ' ').trim();
const TYPES = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const appSrv = http.createServer(async (rq, rs) => {
  const pathname = new URL(rq.url, 'http://x').pathname;
  const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  try {
    const body = await readFile(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
    if (type === 'text/html') headers['Content-Security-Policy'] = CSP;
    rs.writeHead(200, headers); rs.end(body);
  } catch { rs.writeHead(404); rs.end('nope'); }
});
await new Promise(resolve => appSrv.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${appSrv.address().port}`;

// --- the run -----------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message); failures += 1; });

// Simulated position beside the fixture fields (no geolocation in a headless test), stored
// before first load the same way the other suites do it. The fixture pack is the only pack in
// packs.json, so the app selects it by itself.
await page.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
  language: 'en', testMode: true,
  testLatitude: 45.7395, testLongitude: 7.3705, testAltitudeM: 2500, testLabel: 'Fixture',
})));
await page.goto(APP, { waitUntil: 'networkidle' });
await page.evaluate(() => new Promise(res => navigator.serviceWorker?.ready.then(res) || res()));
await page.waitForSelector('[data-field-id]');

// Phase 1: opening the airfield mints a token and the chart iframe carries it.
await page.click('[data-field-id="es_leci"]');
await page.waitForSelector('.media-card iframe');
await page.waitForFunction(origin =>
  document.querySelector('.media-card iframe')?.src.includes('/charts/vac/LECI.pdf?t='), CHARTS_ORIGIN);
const iframeSrc = await page.getAttribute('.media-card iframe', 'src');
check('chart iframe points at the Worker, with a token', iframeSrc.startsWith(`${CHARTS_ORIGIN}/charts/vac/LECI.pdf?t=`));
check('a token was minted for the detail view', stats.minted >= 1);
const openHref = await page.getAttribute('.media-card .caption a', 'href');
check('"Open PDF" link carries the same gated URL', openHref?.startsWith(`${CHARTS_ORIGIN}/charts/vac/LECI.pdf?t=`));
await page.click('#closeDetail');

// Phase 2: the offline download fetches the chart through the gate and stores it token-free.
await page.click('#settingsToggle');
await page.waitForSelector('#downloadPack');
await page.click('#downloadPack');
await page.waitForFunction(() => window.__mtcState === undefined || true, null); // yield
const deadline = Date.now() + 30000;
while (stats.served < 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
await page.waitForTimeout(500);
check('the Worker served the chart during the download', stats.served >= 1);
const cacheState = await page.evaluate(async origin => {
  const cache = await caches.open('mtc-data');
  const keys = (await cache.keys()).map(r => r.url).filter(u => u.startsWith(origin));
  return { keys, tokenFree: keys.some(u => u === `${origin}/charts/vac/LECI.pdf`) };
}, CHARTS_ORIGIN);
check('chart cached under its token-free URL', cacheState.tokenFree);
check('no tokened URL leaked into the cache', cacheState.keys.every(u => !u.includes('?t=')));
check('the token endpoint itself is never cached', cacheState.keys.every(u => !u.endsWith('/charts/token')));

// Phase 3: with the Worker unreachable and every token dead, the cached chart still answers a
// TOKENED request — the in-the-air case: iframe src carries an expired token, no network.
validTokens.clear();
await new Promise(resolve => chartSrv.close(resolve));
const offline = await page.evaluate(async origin => {
  try {
    const res = await fetch(`${origin}/charts/vac/LECI.pdf?t=9999999999.long-dead-token`);
    return { ok: res.ok, bytes: (await res.arrayBuffer()).byteLength };
  } catch (e) { return { ok: false, error: String(e) }; }
}, CHARTS_ORIGIN);
check('cached chart answers a dead-token request with the Worker down', offline.ok && offline.bytes === PDF.length);

check('nothing was ever served without a valid token', stats.denied === 0);

await browser.close();
appSrv.close();
await rm(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll chart app-side checks passed');
process.exit(failures ? 1 : 0);
