// Cross-language check on the terrain pipeline: the JavaScript decoder must reproduce, byte for
// byte, what the Python builder wrote, and the solver must get the mountains right.
//
// Run against tiles built by scripts/build_terrain_tiles.py:
//   python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out /tmp/t   # Cervinia cases
//   python scripts/build_terrain_tiles.py --bbox 44 6 45 7 --out /tmp/t   # Seyne + Barles cases
//   python scripts/build_terrain_tiles.py --bbox 46 7 47 8 --out /tmp/t   # Valais enclosure
//   node scripts/test_terrain_js.mjs /tmp/t/_terrain
//
// The routing cases are the ones that motivated the feature, plus the field-verified edge cases
// from the 2026-07 ridge assessment. Cervinia sits in a bowl under the Matterhorn with the Aosta
// valley reachable down-valley but a 3000 m ridge on the direct line, so a straight-line glide
// computation refuses a glide that is in fact comfortable. The Seyne, Barles and Zermatt blocks
// pin the behaviours measured against a native-resolution reference: routed around below a
// crest and never through it, honestly unreachable below a gorge floor, and a main chain that
// stays closed until the physical crossing altitude while same-side fields stay listed.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const terrainDir = process.argv[2] || path.join(here, '..', 'data', 'packs', '_terrain');

const { decodeTile, tileKey, tileKeyFor, NODATA } = await import(path.join(here, '..', 'src', 'terrain.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// --- tiles -------------------------------------------------------------------------------------

// Every tile the cases below need. Missing any is a setup problem, not a failure — the message
// says which build produces it.
const REQUIRED_TILES = {
  N45E007: 'python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out <dir>',
  N44E006: 'python scripts/build_terrain_tiles.py --bbox 44 6 45 7 --out <dir>',
  N46E007: 'python scripts/build_terrain_tiles.py --bbox 46 7 47 8 --out <dir>',
};
const missing = Object.keys(REQUIRED_TILES).filter(k => !existsSync(path.join(terrainDir, `${k}.terr`)));
if (missing.length) {
  console.error(`Missing tiles in ${terrainDir}:`);
  for (const k of missing) console.error(`  ${k}.terr — build with: ${REQUIRED_TILES[k]}`);
  process.exit(2);
}
const tiles = new Map();
for (const k of Object.keys(REQUIRED_TILES)) {
  const raw = readFileSync(path.join(terrainDir, `${k}.terr`));
  tiles.set(k, await decodeTile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
}

// --- decode ------------------------------------------------------------------------------------

const key = tileKeyFor(45.9, 7.6);
const tile = tiles.get(key);
check('tile key for 45.9N 7.6E', key === 'N45E007', key);
check('tile geometry', tile.lat0 === 45 && tile.lon0 === 7 && tile.samples === 1200,
  `lat0=${tile.lat0} lon0=${tile.lon0} samples=${tile.samples}`);

const elevationAt = (lat, lon) => {
  const row = Math.floor((tile.lat0 + tile.span - lat) * tile.samples / tile.span);
  const col = Math.floor((lon - tile.lon0) * tile.samples / tile.span);
  return tile.elevations[row * tile.samples + col];
};

// Surveyed elevations. The DEM max-pools, so it reads at or just above the survey on flat ground
// and below it on a sharp summit that is smaller than a cell.
const spot = [
  ['Aosta aerodrome', 45.738, 7.369, 545, 25],
  ['Cervinia', 45.936, 7.631, 2005, 60],
  ['Gran Paradiso', 45.5175, 7.2675, 4061, 120],
];
for (const [name, lat, lon, expected, tolerance] of spot) {
  const got = elevationAt(lat, lon);
  check(`elevation ${name}`, Math.abs(got - expected) <= tolerance, `${got} m vs ${expected} m`);
}

// --- routing grid ------------------------------------------------------------------------------

const SAMPLES = 1200;
const LAT_DECIMATE = 3;
const METRES_PER_DEGREE_LAT = 111320;

/** Stand-in for TerrainStore.routingGrid over the loaded tiles (NODATA outside them). */
function routingGrid(centreLat, centreLon, radiusM) {
  const cosLat = Math.cos(centreLat * Math.PI / 180);
  const latPad = radiusM / METRES_PER_DEGREE_LAT;
  const lonPad = latPad / cosLat;
  const lonDecimate = Math.max(1, Math.round(LAT_DECIMATE / cosLat));
  const globalRow = lat => Math.floor((90 - lat) * SAMPLES);
  const globalCol = lon => Math.floor((lon + 180) * SAMPLES);

  const rowStart = Math.floor(globalRow(centreLat + latPad) / LAT_DECIMATE) * LAT_DECIMATE;
  const rowEnd = Math.ceil((globalRow(centreLat - latPad) + 1) / LAT_DECIMATE) * LAT_DECIMATE;
  const colStart = Math.floor(globalCol(centreLon - lonPad) / lonDecimate) * lonDecimate;
  const colEnd = Math.ceil((globalCol(centreLon + lonPad) + 1) / lonDecimate) * lonDecimate;
  const rows = (rowEnd - rowStart) / LAT_DECIMATE;
  const cols = (colEnd - colStart) / lonDecimate;

  const elevations = new Int16Array(rows * cols).fill(NODATA);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let best = NODATA;
      for (let sr = 0; sr < LAT_DECIMATE; sr += 1) {
        const gr = rowStart + r * LAT_DECIMATE + sr;
        const tileRowIndex = Math.floor(gr / SAMPLES);
        const lat0 = 89 - tileRowIndex;
        const localRow = gr - tileRowIndex * SAMPLES;
        for (let sc = 0; sc < lonDecimate; sc += 1) {
          const gc = colStart + c * lonDecimate + sc;
          const tileColIndex = Math.floor(gc / SAMPLES);
          const source = tiles.get(tileKey(lat0, tileColIndex - 180));
          if (!source) continue;
          const value = source.elevations[localRow * SAMPLES + (gc - tileColIndex * SAMPLES)];
          if (value !== NODATA && value > best) best = value;
        }
      }
      elevations[r * cols + c] = best;
    }
  }
  const latStepDeg = LAT_DECIMATE / SAMPLES;
  const lonStepDeg = lonDecimate / SAMPLES;
  return {
    rows, cols, elevations: elevations.buffer,
    north: 90 - rowStart / SAMPLES,
    west: colStart / SAMPLES - 180,
    latStepDeg, lonStepDeg,
    cellNorthM: latStepDeg * METRES_PER_DEGREE_LAT,
    cellEastM: lonStepDeg * METRES_PER_DEGREE_LAT * cosLat,
  };
}

// --- solver ------------------------------------------------------------------------------------

const workerSource = readFileSync(path.join(here, '..', 'src', 'glide-worker.js'), 'utf8');
const sandbox = { onmessage: null, postMessage: null };
new Function('self', workerSource)(sandbox);

function solve(request) {
  let answer = null;
  sandbox.postMessage = message => { answer = message; };
  sandbox.onmessage({ data: { type: 'solve', id: 1, ...request } });
  if (!answer || answer.type !== 'solved') throw new Error(answer?.message || 'solver produced nothing');
  return answer.results;
}

const CERVINIA = { latitude: 45.9360, longitude: 7.6310 };
const AOSTA = { id: 'aosta', latitude: 45.7383, longitude: 7.3686, elevationM: 545 };

const grid = routingGrid(45.85, 7.52, 32000);
check('routing grid built', grid.rows > 50 && grid.cols > 50, `${grid.rows}x${grid.cols} cells`);
check('routing cells are near square',
  Math.abs(grid.cellNorthM - grid.cellEastM) / grid.cellNorthM < 0.15,
  `${grid.cellNorthM.toFixed(0)} m N/S vs ${grid.cellEastM.toFixed(0)} m E/W`);

const started = Date.now();
const results = solve({
  grid,
  latitude: CERVINIA.latitude,
  longitude: CERVINIA.longitude,
  altitudeM: 3000,
  clearanceM: 200,
  safetyMarginM: 250,
  targets: [AOSTA],
});
const elapsed = Date.now() - started;

const aosta = results.aosta;
console.log('\nCervinia 3000 m -> Aosta 545 m');
console.log(`  solver took ${elapsed} ms`);
if (aosta) {
  console.log(`  required glide ratio   ${aosta.requiredGlideRatio.toFixed(1)}`);
  console.log(`  path length            ${(aosta.pathLengthM / 1000).toFixed(1)} km over ${aosta.legs} leg(s)`);
  if (aosta.directGlideRatio) console.log(`  straight-line ratio    ${aosta.directGlideRatio.toFixed(1)}`);
  if (aosta.critical) {
    console.log(`  limited at             ${aosta.critical.elevationM} m ` +
      `(${aosta.critical.latitude.toFixed(4)}, ${aosta.critical.longitude.toFixed(4)})`);
  }
  console.log(`  route type             ${aosta.direct ? 'straight line' : 'terrain-routed'}`);
} else {
  console.log('  UNREACHABLE');
}

check('Aosta is reachable from Cervinia at 3000 m', Boolean(aosta));
check('required glide ratio is plausible for a valley run',
  aosta && aosta.requiredGlideRatio > 4 && aosta.requiredGlideRatio < 20,
  aosta ? aosta.requiredGlideRatio.toFixed(1) : 'n/a');
check('solver finishes fast enough for a live list', elapsed < 4000, `${elapsed} ms`);

// --- hugging the ridge, which is where gliders actually are -------------------------------------
//
// A pilot working lift beside a face is metres from rock by choice. Routing cells max-pool ~278 m
// of hillside, so the ground recorded all around them is the top of that rock; subtract the
// clearance margin from it and every neighbouring cell reports negative headroom, the wavefront
// cannot take a first step in any direction, and every field goes unreachable. Reported from the
// air over Cervinia: 143 m above the ground, Valtournenche 5.8 km away needing a glide of under
// 5, and an empty list. The margin was not shaping these routes, it was deleting them.
{
  const RIDGE = { latitude: 45.91, longitude: 7.68, altitudeM: 3000 };
  const VALTOURNENCHE = { id: 'valtournenche', latitude: 45.8770, longitude: 7.6220, elevationM: 1524 };
  const ridgeGrid = routingGrid(RIDGE.latitude, RIDGE.longitude, 45000);
  const cells = new Int16Array(ridgeGrid.elevations);
  const cell = cells[Math.floor((ridgeGrid.north - RIDGE.latitude) / ridgeGrid.latStepDeg) * ridgeGrid.cols
    + Math.floor((RIDGE.longitude - ridgeGrid.west) / ridgeGrid.lonStepDeg)];
  const above = RIDGE.altitudeM - cell;
  console.log(`\nRidge-hugging: ${RIDGE.altitudeM} m over a cell that max-pools ${cell} m (${above} m above it)`);
  check('the test position really is inside a 200 m clearance of the ground',
    above > 0 && above < 200, `${above} m above the cell`);

  const hugging = solve({
    grid: ridgeGrid, latitude: RIDGE.latitude, longitude: RIDGE.longitude,
    altitudeM: RIDGE.altitudeM, clearanceM: 200, safetyMarginM: 250, targets: [VALTOURNENCHE],
  }).valtournenche;
  console.log(`  Valtournenche: ${hugging ? 'L/D ' + hugging.requiredGlideRatio.toFixed(1) : 'UNREACHABLE'}`);
  check('a field 6 km down the valley is still offered while hugging the ridge', Boolean(hugging));
  check('and at a glide a pilot would recognise, not an invented one',
    hugging && hugging.requiredGlideRatio > 3 && hugging.requiredGlideRatio < 20,
    hugging ? hugging.requiredGlideRatio.toFixed(1) : 'n/a');

  // The margin must still be worth having: it may not block the pilot's own position, but it must
  // still make the reported number stricter than bare physics would.
  const bare = solve({
    grid: ridgeGrid, latitude: RIDGE.latitude, longitude: RIDGE.longitude,
    altitudeM: RIDGE.altitudeM, clearanceM: 0, safetyMarginM: 250, targets: [VALTOURNENCHE],
  }).valtournenche;
  check('the clearance still costs something in the answer',
    bare && hugging && hugging.requiredGlideRatio >= bare.requiredGlideRatio,
    `${bare ? bare.requiredGlideRatio.toFixed(1) : 'n/a'} with no margin -> ` +
    `${hugging ? hugging.requiredGlideRatio.toFixed(1) : 'n/a'} with 200 m`);
}

// The point of the feature: a ridge on the direct line must make the straight-line number worse
// than the routed one, or at minimum must not be better.
if (aosta && aosta.directGlideRatio) {
  check('routing never loses to the straight line',
    aosta.requiredGlideRatio <= aosta.directGlideRatio + 1e-9,
    `routed ${aosta.requiredGlideRatio.toFixed(1)} vs direct ${aosta.directGlideRatio.toFixed(1)}`);
}

// Too low to clear anything: the answer must be "no", not an optimistic number.
const hopeless = solve({
  grid,
  latitude: CERVINIA.latitude,
  longitude: CERVINIA.longitude,
  altitudeM: 2100,
  clearanceM: 200,
  safetyMarginM: 250,
  targets: [AOSTA],
});
check('a glider on the deck is not promised a 25 km valley', !hopeless.aosta,
  hopeless.aosta ? `claimed ${hopeless.aosta.requiredGlideRatio.toFixed(1)}` : 'unreachable, correct');

// Flat-country sanity: a target with nothing in the way must return the straight-line answer, so
// the grid's staircase never inflates an easy glide.
const flatGrid = routingGrid(45.75, 7.40, 12000);
const flat = solve({
  grid: flatGrid,
  latitude: 45.7383, longitude: 7.3686,
  altitudeM: 3000, clearanceM: 200, safetyMarginM: 250,
  targets: [{ id: 'self', latitude: 45.7383, longitude: 7.3686, elevationM: 545 }],
});
check('a field underfoot needs no glide at all',
  flat.self && flat.self.requiredGlideRatio < 0.5,
  flat.self ? flat.self.requiredGlideRatio.toFixed(2) : 'unreachable');

// --- the ridge, from the field assessment (Seyne-les-Alpes <-> Barcelonnette) ------------------
//
// A pilot riding the NE flank of the dividing ridge below its 2386 m crest cannot cross to
// Seyne; the honest answer is the ~23 km route around the west end of the massif, and the
// same-side valley stays cheap. High above the crest the direct line must win. Verified against
// a native-93 m reference: the routed answers agree within the ladder bracket, so a change that
// moves them outside these bands is a solver change, not tile noise.
{
  console.log('\nSeyne ridge: below the crest is routed around, never through');
  const SEYNE = { id: 'seyne', latitude: 44.3435, longitude: 6.3706, elevationM: 1186 };
  const LFMR = { id: 'barcelo', latitude: 44.3883, longitude: 6.6097, elevationM: 1131 };
  const ridgeHug = { latitude: 44.3567, longitude: 6.4407 };   // 600 m out on the NE flank
  const seyneGrid = routingGrid(44.40, 6.49, 30000);

  const below = solve({
    grid: seyneGrid, ...ridgeHug, altitudeM: 2257,   // 150 m over the slope, 129 m below the crest
    clearanceM: 200, safetyMarginM: 250, targets: [SEYNE, LFMR],
  });
  check('the far side of the ridge is still offered', Boolean(below.seyne));
  check('but around, never through the crest', below.seyne && !below.seyne.direct
    && below.seyne.pathLengthM > 15000,
    below.seyne ? `${(below.seyne.pathLengthM / 1000).toFixed(1)} km vs 5.8 km straight` : 'n/a');
  check('at a price in the measured band', below.seyne
    && below.seyne.requiredGlideRatio > 24 && below.seyne.requiredGlideRatio < 42,
    below.seyne ? below.seyne.requiredGlideRatio.toFixed(1) : 'n/a');
  check('the same-side valley stays sanely priced', below.barcelo
    && below.barcelo.requiredGlideRatio > 12 && below.barcelo.requiredGlideRatio < 26,
    below.barcelo ? below.barcelo.requiredGlideRatio.toFixed(1) : 'n/a');

  const above = solve({
    grid: seyneGrid, ...ridgeHug, altitudeM: 2786,   // crest + 400 m
    clearanceM: 200, safetyMarginM: 250, targets: [SEYNE],
  });
  check('well above the crest the straight line wins', Boolean(above.seyne) && above.seyne.direct
    && above.seyne.requiredGlideRatio < 8,
    above.seyne ? `${above.seyne.requiredGlideRatio.toFixed(1)} ${above.seyne.direct ? 'direct' : 'routed'}` : 'n/a');
}

// --- the gorge (Barles -> La Javie through the Clues de Barles) --------------------------------
//
// The clues are far narrower than a routing cell, so the corridor floor the grid records is the
// pooled 1136 m, not the 1040 m the native data carries — and neither can certify a slot canyon
// anyway. Low over Barles the only honest answer is no answer; higher, the shoulder route
// appears at a price a pilot reads correctly.
{
  console.log('\nBarles gorge: unreachable below the corridor floor, honest above it');
  const JAVIE = { id: 'javie', latitude: 44.1708, longitude: 6.3350, elevationM: 800 };
  const overBarles = { latitude: 44.2740, longitude: 6.2680 };
  const gorgeGrid = routingGrid(44.22, 6.32, 25000);

  const low = solve({
    grid: gorgeGrid, ...overBarles, altitudeM: 1400,
    clearanceM: 200, safetyMarginM: 250, targets: [JAVIE],
  });
  check('344 m over the basin, the gorge promises nothing', !low.javie,
    low.javie ? `claimed ${low.javie.requiredGlideRatio.toFixed(1)}` : 'unreachable, correct');

  const high = solve({
    grid: gorgeGrid, ...overBarles, altitudeM: 1800,
    clearanceM: 200, safetyMarginM: 250, targets: [JAVIE],
  });
  check('744 m over the basin, the way out is offered', Boolean(high.javie) && !high.javie.direct);
  check('at a price in the measured band', high.javie
    && high.javie.requiredGlideRatio > 20 && high.javie.requiredGlideRatio < 40,
    high.javie ? high.javie.requiredGlideRatio.toFixed(1) : 'n/a');
}

// --- the main-chain enclosure (Zermatt: Chamois behind Theodul, Rhône side open) ---------------
//
// Coming back from the Rhône east of the Matterhorn there is no cheap way round: the Theodul
// saddle is 3295 m, and within this window nothing lower crosses the chain. Below the crossing
// altitude the Italian side must show nothing at all — while the pilot's own valley stays
// listed, which is the difference between an honest enclosure and the empty-list bug.
{
  console.log('\nValais enclosure: Italy dark below the crossing altitude, the Rhône side never');
  const CHAMOIS = { id: 'chamois', latitude: 45.8336, longitude: 7.6175, elevationM: 1740 };
  const ST_NIKLAUS = { id: 'stn', latitude: 46.1760, longitude: 7.8040, elevationM: 1105 };
  const overZermatt = { latitude: 46.0170, longitude: 7.7480 };
  const valaisGrid = routingGrid(overZermatt.latitude, overZermatt.longitude, 22000);

  const low = solve({
    grid: valaisGrid, ...overZermatt, altitudeM: 3000,
    clearanceM: 200, safetyMarginM: 250, targets: [CHAMOIS, ST_NIKLAUS],
  });
  check('at 3000 m the far side of Theodul shows nothing', !low.chamois,
    low.chamois ? `claimed ${low.chamois.requiredGlideRatio.toFixed(1)}` : 'unreachable, correct');
  check('while the pilot\'s own valley stays listed', Boolean(low.stn)
    && low.stn.requiredGlideRatio > 4 && low.stn.requiredGlideRatio < 18,
    low.stn ? low.stn.requiredGlideRatio.toFixed(1) : 'n/a');

  const high = solve({
    grid: valaisGrid, ...overZermatt, altitudeM: 3900,   // Theodul 3295 + clearance + bracket
    clearanceM: 200, safetyMarginM: 250, targets: [CHAMOIS],
  });
  check('at 3900 m the crossing is open', Boolean(high.chamois)
    && high.chamois.requiredGlideRatio > 12 && high.chamois.requiredGlideRatio < 30,
    high.chamois ? high.chamois.requiredGlideRatio.toFixed(1) : 'n/a');
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
