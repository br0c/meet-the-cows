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

// The production ink, swapped with the ground for the channel variant.
const LIGHT = '#f8fafc';
const CHANNEL = '#b45309';

// The channel icon is INVERTED, not merely a different colour, and that is forced by iOS.
// In its Dark home-screen mode iOS recolours any web-clip icon — it cannot be opted out of, the
// media attribute on apple-touch-icon is ignored — and that treatment keeps white while crushing
// everything mid-luminance to black. An amber ground therefore rendered identically to the navy
// one, which is the whole problem. A LIGHT ground survives the treatment, so the two builds stay
// apart in both modes: production is a dark tile with a white cow, the channel a light tile with
// an amber one.
const VARIANTS = [
  { dir: icons, ground: BASE_COLOUR, ink: LIGHT },
  { dir: path.join(icons, 'next'), ground: LIGHT, ink: CHANNEL },
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

for (const { dir, ground, ink } of VARIANTS) {
  await mkdir(dir, { recursive: true });
  // Two-way swap, so it goes via a placeholder rather than clobbering itself.
  const svg = source
    .split(BASE_COLOUR).join('__GROUND__')
    .split(LIGHT).join('__INK__')
    .split('__GROUND__').join(ground)
    .split('__INK__').join(ink);
  if (dir !== icons) await writeFile(path.join(dir, 'icon.svg'), svg);

  for (const [name, size] of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    // Fully opaque, edge to edge. iOS does not support alpha in a home-screen icon: it
    // composites the transparent area over a background of its choosing, and its squircle mask
    // is wider than this icon's own rounded corners — so transparent corners get filled with
    // something that is not the icon's colour, right where the colour reads. Painting the page
    // in the icon colour makes the corners the same colour instead of absent; nothing else about
    // the design changes, because the rounded rect sits on a ground of its own colour.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:${ground}}` +
      `svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      { waitUntil: 'load' });
    await page.screenshot({ path: path.join(dir, name) });
    await page.close();
    console.log(`${path.relative(path.join(here, '..'), path.join(dir, name))}  ${size}x${size}`);
  }
}

await browser.close();
