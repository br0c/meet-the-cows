// Render the app icons from icons/icon.svg, in production colours and in the channel colour —
// and the two social cards (og:image), which share the icon's palette and are the only place
// an address is spelled out in pixels. The previous card was drawn by hand and still said
// br0c.github.io years after the move; generated here, the address is one constant below.
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

// --- social cards --------------------------------------------------------------------------------
// 1200×630, the og:image size everything renders well. One per origin, because the card's whole
// job is to say where the link goes: the app's card carries the app address, the landing site's
// its own. The drawing is the icon itself rather than an emoji glyph — the icon is the brand,
// and a headless renderer's emoji fonts are nobody's to rely on.
const CARDS = [
  { file: path.join(icons, 'og-image.png'),
    title: 'Meet the Cows', sub: 'Outlanding field viewer for glider pilots',
    url: 'app.meetthecows.org' },
  { file: path.join(here, '..', 'site', 'public', 'og-image.png'),
    title: 'Meet the Cows', sub: 'Outlanding fields for glider pilots — free, offline, no account',
    url: 'meetthecows.org' },
];
const ACCENT = '#38bdf8';
const MUTED = '#94a3b8';

for (const card of CARDS) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(`<style>
    html, body { margin: 0; width: 1200px; height: 630px; background: ${BASE_COLOUR}; }
    body { display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 26px; font-family: system-ui, sans-serif; text-align: center; }
    .mark { width: 148px; height: 148px; }
    .mark svg { width: 100%; height: 100%; display: block; }
    h1 { margin: 0; color: ${LIGHT}; font-size: 88px; font-weight: 800; letter-spacing: -0.02em; }
    .bar { width: 240px; height: 7px; border-radius: 4px; background: ${ACCENT}; margin: -6px 0 2px; }
    p { margin: 0; color: ${MUTED}; font-size: 34px; max-width: 1020px; }
    .url { color: ${ACCENT}; font-size: 36px; font-weight: 700; }
  </style>
  <div class="mark">${source}</div>
  <h1>${card.title}</h1>
  <div class="bar"></div>
  <p>${card.sub}</p>
  <div class="url">${card.url}</div>`, { waitUntil: 'load' });
  await page.screenshot({ path: card.file });
  await page.close();
  console.log(`${path.relative(path.join(here, '..'), card.file)}  1200x630`);
}

await browser.close();
