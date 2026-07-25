// Render the app icons from icons/icon.svg, in production colours and in the channel colour.
//
// The manifest used to ship the SVG alone. Safari's support for SVG manifest icons is patchy, so
// an installed home-screen icon could come from anywhere — which matters now that the production
// app and the experimental build are installed side by side and have to be told apart at a glance.
// PNGs remove the guesswork.
//
// Committed output, not a CI step: icons change roughly never, and this needs a browser.
//
//   node scripts/render_icons.mjs
//
// Chromium comes from Playwright; set CHROMIUM_PATH if it is not on the default path.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const icons = path.join(here, '..', 'icons');

// The production icon's background, and the eyes and mouth drawn in it. One token, so a variant
// is a single substitution and the design stays coherent instead of orange-on-navy.
export const BASE_COLOUR = '#111827';

// Deliberately not another dark shade: at home-screen size two dark tiles are the same tile.
// Amber reads as "not the real one" at a glance and keeps white legible on it.
const VARIANTS = [
  { dir: icons, colour: BASE_COLOUR },
  { dir: path.join(icons, 'next'), colour: '#b45309' },
];
const SIZES = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  // iOS uses this one for Add to Home Screen; 180 is what it asks for.
  ['apple-touch-icon.png', 180],
];

const source = await readFile(path.join(icons, 'icon.svg'), 'utf8');
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

for (const { dir, colour } of VARIANTS) {
  await mkdir(dir, { recursive: true });
  const svg = source.split(BASE_COLOUR).join(colour);
  if (dir !== icons) await writeFile(path.join(dir, 'icon.svg'), svg);

  for (const [name, size] of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      { waitUntil: 'load' });
    await page.screenshot({ path: path.join(dir, name), omitBackground: true });
    await page.close();
    console.log(`${path.relative(path.join(here, '..'), path.join(dir, name))}  ${size}x${size}`);
  }
}

await browser.close();
