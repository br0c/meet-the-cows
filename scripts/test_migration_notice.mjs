// The retired-deployment notice, checked under real origins.
//
// Whether this appears at all is decided by comparing the page's own origin against the constant
// CANONICAL_APP_URL in src/app.js, so it cannot be exercised from localhost — a local checkout is
// deliberately exempt, and 127.0.0.1 would test the exemption rather than the rule. Chromium is
// therefore given the app's bytes under whatever origin the case needs, by fulfilling the
// requests itself.
//
// Two failures this exists to catch, both bad in their own direction:
//   - the notice appearing on app.meetthecows.org, telling everyone the app has moved away from
//     the place they are already using;
//   - Settings losing the way back to the move instructions, so dismissing the banner strands a
//     pilot who meant "not right now" until the reminder next fires.
//
//   node scripts/test_migration_notice.mjs

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

const RETIRED = 'https://br0c.github.io/meet-the-cows/';
const CANONICAL = 'https://app.meetthecows.org/';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const PACKS = {
  'packs/packs.json': JSON.stringify({ schemaVersion: 2, updatedAt: 'x', packs: [
    { id: 'p', name: 'Test', names: { en: 'Test' }, hidden: false,
      manifestUrl: 'packs/p/manifest.json', sizeBytes: 10, fieldsCount: 1 }] }),
  'packs/p/manifest.json': JSON.stringify({ id: 'p', name: 'Test', names: { en: 'Test' },
    hidden: false, version: 'v1', generatedAt: 'x', isSample: false, fieldsUrl: 'fields.json',
    fieldsCount: 1, mediaCount: 0, mediaFiles: 0, fieldsBytes: 10, sizeBytes: 10,
    selector: 't', sources: [], notices: [] }),
  'packs/p/fields.json': JSON.stringify([{ id: 'f', kind: 'airfield', name: 'Test field',
    code: 'TST', latitude: 45.5, longitude: 7.5, elevationM: 500, difficulty: 'A',
    rawDifficulty: 'A', lengthM: 800, widthM: 60, runwayDirectionDeg: 90, notes: '',
    media: [], source: { name: 'fixture' } }]),
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** Serve the working tree's app under `origin`, so MIGRATION sees the origin we want to test. */
async function open(origin) {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(() => localStorage.setItem('mtc-settings-v2', JSON.stringify({
    packIds: ['p'], language: 'en', terrainRouting: false,
  })));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!route.request().url().startsWith(origin)) return route.abort();
    let rel = url.pathname.replace(new URL(origin).pathname, '').replace(/^\/+/, '') || 'index.html';
    if (PACKS[rel]) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: PACKS[rel] });
    }
    try {
      const body = await readFile(path.join(repo, rel));
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(rel)] || 'application/octet-stream', body });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(origin);
  await page.waitForSelector('#settingsToggle', { timeout: 15000 });
  return { context, page, errors };
}

// --- the retired origin --------------------------------------------------------------------

{
  const { context, page, errors } = await open(RETIRED);

  check('the retired origin shows the migration banner',
    (await page.$('.migration-banner')) !== null);

  await page.click('#settingsToggle');
  await page.waitForSelector('.settings-page');
  check('Settings carries a permanent way back to the instructions',
    (await page.$('#migrationSettingsBtn')) !== null);

  await page.click('#migrationSettingsBtn');
  await page.waitForSelector('#migrationBackdrop', { timeout: 3000 });
  const sheet = await page.$eval('#migrationBackdrop', el => el.innerText);
  check('it opens the same move instructions the banner opens',
    /app\.meetthecows\.org/.test(sheet), sheet.split('\n').slice(0, 2).join(' / '));
  await page.click('#closeMigration');
  await page.waitForTimeout(200);

  // Snoozing is what used to close the only door. It must silence the banner and nothing else.
  await page.evaluate(() => localStorage.setItem('mtc-migration-snoozed-until', String(Date.now() + 864e5)));
  await page.reload();
  await page.waitForSelector('#settingsToggle', { timeout: 15000 });
  check('snoozing hides the banner', (await page.$('.migration-banner')) === null);
  await page.click('#settingsToggle');
  await page.waitForSelector('.settings-page');
  check('snoozing does NOT hide the Settings entry',
    (await page.$('#migrationSettingsBtn')) !== null);
  await page.click('#migrationSettingsBtn');
  await page.waitForSelector('#migrationBackdrop', { timeout: 3000 });
  check('the instructions are still reachable while snoozed',
    (await page.$('#migrationBackdrop')) !== null);

  check('no page errors on the retired origin', errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// --- the canonical origin ------------------------------------------------------------------

{
  const { context, page, errors } = await open(CANONICAL);
  check('the canonical origin shows no banner', (await page.$('.migration-banner')) === null);
  await page.click('#settingsToggle');
  await page.waitForSelector('.settings-page');
  check('the canonical origin has no migration entry in Settings',
    (await page.$('#migrationSettingsBtn')) === null);
  const text = await page.$eval('.settings-page', el => el.innerText);
  check('and says nothing about moving anywhere', !/has moved|is moving/i.test(text));
  check('no page errors on the canonical origin', errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
