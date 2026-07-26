// The simulated-position testing mode, end to end in a real browser.
//
// Runs with NO geolocation permission at all: the point of this mode is to work where GPS cannot,
// and a test that leans on a real fix would not prove that. The geocoder is stubbed so the suite
// does not depend on a third party being up, and so it cannot quietly start making live requests
// on every run.
//
//   node scripts/test_simulated_position.mjs
//
// Needs playwright and a Chromium build; set CHROMIUM_PATH if it is not on the default path.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ROOT = path.join(tmpdir(), `mtc-testmode-${process.pid}`);

// Assemble a throwaway site from the working tree: shell plus a one-field pack near the case
// this mode exists to exercise.
await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, 'src'), { recursive: true });
await mkdir(path.join(ROOT, 'packs', 'alps-test'), { recursive: true });
for (const f of ['index.html','styles.css','service-worker.js','manifest.webmanifest','release-notes.json','config.js'])
  await cp(path.join(repo, f), path.join(ROOT, f));
// Every module the shell imports, not just app.js — on branches where app.js imports the
// terrain store, a fixture missing it fails to load and renders nothing at all.
for (const f of ['app.js', 'terrain.js', 'glide-worker.js']) {
  await cp(path.join(repo, 'src', f), path.join(ROOT, 'src', f)).catch(() => {});
}
await cp(path.join(repo, 'icons'), path.join(ROOT, 'icons'), { recursive: true });
await writeFile(path.join(ROOT, 'favicon.ico'), Buffer.from([0,0,1,0,0,0]));
const FIELD = { id:'aosta', kind:'airfield', name:'Aosta', code:'LIMW', latitude:45.7383,
  longitude:7.3686, elevationM:545, difficulty:'A', rawDifficulty:'A', lengthM:800, widthM:60,
  runwayDirectionDeg:90, notes:'', media:[], source:{name:'fixture'} };
await writeFile(path.join(ROOT,'packs','alps-test','fields.json'), JSON.stringify([FIELD]));
await writeFile(path.join(ROOT,'packs','alps-test','manifest.json'), JSON.stringify({
  id:'alps-test', name:'Alps test', names:{en:'Alps test'}, hidden:false, version:'t1',
  generatedAt:'2026-07-25T00:00:00Z', isSample:false, fieldsUrl:'fields.json', fieldsCount:1,
  mediaCount:0, mediaFiles:0, fieldsBytes:100, sizeBytes:100, selector:'test', sources:[], notices:[] }));
await writeFile(path.join(ROOT,'packs','packs.json'), JSON.stringify({ schemaVersion:2, updatedAt:'x',
  packs:[{ id:'alps-test', name:'Alps test', names:{en:'Alps test'}, hidden:false,
    manifestUrl:'packs/alps-test/manifest.json', sizeBytes:100, fieldsCount:1 }] }));
const T={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv=http.createServer(async(rq,rs)=>{
  const f=path.join(ROOT,new URL(rq.url,'http://x').pathname==='/'?'index.html':new URL(rq.url,'http://x').pathname);
  try{const b=await readFile(f);rs.writeHead(200,{'content-type':T[path.extname(f)]||'application/octet-stream'});rs.end(b);}
  catch{rs.writeHead(404);rs.end('nf');}});
await new Promise(r=>srv.listen(0,r));
const base=`http://127.0.0.1:${srv.address().port}/`;
let fail=0; const check=(l,ok,d='')=>{console.log(`${ok?'ok  ':'FAIL'}  ${l}${d?`  — ${d}`:''}`); if(!ok)fail++;};
const browser=await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx=await browser.newContext({locale:'en-GB'});
// No geolocation permission at all: test mode must work with no GPS whatsoever.
await ctx.addInitScript(()=>localStorage.setItem('mtc-settings-v2',JSON.stringify({
  packIds:['alps-test'],language:'en',safetyMarginM:250,showC:true,showD:true,
  testMode:false,testLatitude:null,testLongitude:null,testAltitudeM:2500,testLabel:'',
})));
// Stub the geocoder so the test does not depend on a third party being up.
await ctx.route('https://photon.komoot.io/**', route => route.fulfill({
  status:200, contentType:'application/json',
  body: JSON.stringify({features:[
    {geometry:{coordinates:[7.6304,45.9356]},properties:{name:'Breuil-Cervinia',city:'Valtournenche',state:"Valle d'Aosta",country:'Italia',osm_value:'village'}},
    {geometry:{coordinates:[2.5556,48.5376]},properties:{name:'Cervinia',city:'Seine-Port',country:'France',osm_value:'yes'}},
  ]}),
}));
const page=await ctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
// This fixture publishes no terrain, so the store's probe for packs/_terrain/index.json 404s by
// design — that is the "no terrain data" path, not a fault. Anything else is.
page.on('console',m=>{
  if(m.type()!=='error') return;
  if(/404/.test(m.text()) && /_terrain/.test(m.location()?.url || '')) return;
  errors.push(m.text());
});
page.on('response',r=>{
  if(r.status()>=400 && !/_terrain/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`);
});
await page.goto(base);
await page.waitForTimeout(800);

check('no manual-altitude control remains', await page.$('#useManualAltitude') === null && await page.$('#manualAltitudeM') === null);
await page.click('#settingsToggle');
await page.waitForSelector('#toggleTesting');
check('testing section is collapsed by default', await page.$('#testPlace') === null);
await page.click('#toggleTesting');
await page.waitForSelector('#testPlace');
check('testing section expands', true);

// Type-ahead: no submit button, results appear from typing alone.
check('there is no submit button to click', await page.$('#testSearch') === null);
await page.click('#testPlace');
await page.type('#testPlace','Ce',{delay:40});
await page.waitForTimeout(500);
check('under three characters asks nothing', await page.$('.test-result') === null);
await page.type('#testPlace','rvinia',{delay:40});
await page.waitForSelector('.test-result');
check('results appear from typing alone', true);
check('the input keeps focus while results arrive',
  await page.evaluate(() => document.activeElement?.id) === 'testPlace');
check('what was typed is still there',
  await page.inputValue('#testPlace') === 'Cervinia', await page.inputValue('#testPlace'));

// The bug that started this: a scheduled render landing mid-typing used to rebuild Settings and
// wipe the box. It must now leave a focused place input alone.
await page.evaluate(() => window.__mtcScheduleRenderProbe && window.__mtcScheduleRenderProbe());
await page.waitForTimeout(1400);
check('a scheduled render does not wipe the box',
  await page.inputValue('#testPlace') === 'Cervinia' && await page.$('.test-result') !== null,
  await page.inputValue('#testPlace'));
const results=await page.$$eval('.test-result',rs=>rs.map(r=>r.innerText.replace(/\n/g,' | ')));
console.log('  results:'); results.forEach(r=>console.log('    '+r));
check('search returns places', results.length===2);
check('result shows coordinates', /45\.9356, 7\.6304/.test(results[0]), results[0]);

await page.$$eval('.test-result',rs=>rs[0].click());
await page.waitForTimeout(1200);
check('simulated position banner appears', await page.$('.test-banner') !== null);
const banner=await page.$eval('.test-banner',e=>e.innerText.replace(/\n/g,' '));
check('banner names the place and says it is not real', /Breuil-Cervinia/.test(banner) && /Not your real position/.test(banner), banner.slice(0,80));

await page.click('#settingsToggle');
await page.waitForTimeout(300);
const row=await page.$('.field-row');
check('the field list computes from the simulated position', row !== null);
if(row){
  const cells=await page.$eval('.field-row',r=>({
    name:r.querySelector('.field-name').textContent.trim(),
    dist:r.querySelector('.field-distance').textContent.trim(),
    glide:r.querySelector('.field-glide').textContent.trim(),
  }));
  console.log(`    ${cells.name}  ${cells.dist}  glide ${cells.glide}`);
  // Cervinia 2500 m -> Aosta 545 m, 250 m margin: 30 km / 1705 m = 17.6
  check('glide is computed from the simulated position', Number(cells.glide) > 15 && Number(cells.glide) < 20, cells.glide);
  check('distance is computed from the simulated position', /^3[01] km$/.test(cells.dist), cells.dist);
}
const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('mtc-settings-v2')));
check('position persisted for the next launch', stored.testMode===true && Math.abs(stored.testLatitude-45.9356)<1e-4);

await page.click('#testBannerStop');
await page.waitForTimeout(600);
check('stopping clears the banner', await page.$('.test-banner') === null);
check('stopping clears the stored flag', (await page.evaluate(()=>JSON.parse(localStorage.getItem('mtc-settings-v2')).testMode))===false);
check('no page errors', errors.length===0, errors.slice(0,2).join(' | '));
await browser.close(); srv.close();
await rm(ROOT, { recursive: true, force: true });
console.log(fail?`\n${fail} FAILED`:'\nall checks passed');
process.exit(fail?1:0);
