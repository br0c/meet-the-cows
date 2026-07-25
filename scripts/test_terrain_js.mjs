// Cross-language check on the terrain pipeline: the JavaScript decoder must reproduce, byte for
// byte, what the Python builder wrote, and the solver must get the mountains right.
//
// Run against a tile built by scripts/build_terrain_tiles.py:
//   python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out /tmp/t
//   node scripts/test_terrain_js.mjs /tmp/t/_terrain
//
// The routing cases are the ones that motivated the feature. Cervinia sits in a bowl under the
// Matterhorn with the Aosta valley reachable down-valley but a 3000 m ridge on the direct line,
// so a straight-line glide computation refuses a glide that is in fact comfortable.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const terrainDir = process.argv[2] || path.join(here, '..', 'data', 'packs', '_terrain');

const { decodeTile, tileKeyFor, NODATA } = await import(path.join(here, '..', 'src', 'terrain.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// --- decode ------------------------------------------------------------------------------------

const key = tileKeyFor(45.9, 7.6);
const tilePath = path.join(terrainDir, `${key}.terr`);
if (!existsSync(tilePath)) {
  console.error(`No tile at ${tilePath}. Build one first:\n` +
    `  python scripts/build_terrain_tiles.py --bbox 45 7 46 8 --out <dir>`);
  process.exit(2);
}

const bytes = readFileSync(tilePath);
const tile = await decodeTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
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

/** Stand-in for TerrainStore.routingGrid over a single already-decoded tile. */
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
        if (89 - tileRowIndex !== tile.lat0) continue;
        const localRow = gr - tileRowIndex * SAMPLES;
        for (let sc = 0; sc < lonDecimate; sc += 1) {
          const gc = colStart + c * lonDecimate + sc;
          const tileColIndex = Math.floor(gc / SAMPLES);
          if (tileColIndex - 180 !== tile.lon0) continue;
          const value = tile.elevations[localRow * SAMPLES + (gc - tileColIndex * SAMPLES)];
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

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
