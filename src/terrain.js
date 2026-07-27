// Terrain tiles: fetching, decoding, offline caching, and cutting a routing grid out of them.
//
// The tiles are built by scripts/build_terrain_tiles.py; scripts/terrain_format.py is the
// authority on the container and the coordinate convention, and decodeTile below is its inverse.
// Nothing here knows about glides — it hands a plain elevation grid to src/glide-worker.js.

const SAMPLES_PER_DEGREE = 1200;   // 3 arc-seconds, ~92 m of latitude
const TILE_SPAN_DEG = 1;
const MAGIC = 0x5443544d;          // "MTCT" read as a little-endian uint32
const FLAG_DEFLATE = 0x01;
const FLAG_GRADIENT = 0x02;
export const NODATA = -32768;

// Routing runs on a coarser multiple of the tile grid: 3 rows is ~278 m of latitude, and the
// column decimation is chosen per latitude so cells come out roughly square on the ground.
// Coarser than this and a 300 m-wide valley floor stops existing; finer and the wavefront over a
// 100 km radius stops fitting in a phone's patience.
const ROUTE_LAT_DECIMATE = 3;

const METRES_PER_DEGREE_LAT = 111320;

// How long a failed index fetch is taken at its word before it is worth asking again. Long enough
// that a re-rendering settings page cannot turn one dead host into a request storm, short enough
// that a pilot who walks back into signal does not have to restart the app.
const INDEX_RETRY_MS = 5000;

export const terrainPaths = {
  dir: 'packs/_terrain/',
  index: 'packs/_terrain/index.json',
  cols: 'packs/_terrain/cols.json',
  tile: key => `packs/_terrain/${key}.terr`,
};

/** Whether this browser can inflate a tile at all. Safari gained DecompressionStream in 16.4. */
export function terrainSupported() {
  return typeof DecompressionStream === 'function';
}

// --- tile addressing -------------------------------------------------------------------------
//
// A cell's latitude interval is closed at the top and open at the bottom (the source rows are),
// so a position exactly on a whole degree belongs to the tile BELOW it. Longitude is the other
// way round. See the header of scripts/terrain_format.py.

export function tileLat0(lat) { return Math.ceil(lat) - 1; }
export function tileLon0(lon) { return Math.floor(lon); }

export function tileKey(lat0, lon0) {
  const ns = lat0 >= 0 ? 'N' : 'S';
  const ew = lon0 >= 0 ? 'E' : 'W';
  return `${ns}${String(Math.abs(lat0)).padStart(2, '0')}${ew}${String(Math.abs(lon0)).padStart(3, '0')}`;
}

export function tileKeyFor(lat, lon) {
  return tileKey(tileLat0(lat), tileLon0(lon));
}

/** Every tile key touching a lat/lon box, in a stable order. */
export function tileKeysForBounds({ south, west, north, east }) {
  const keys = [];
  for (let lat0 = tileLat0(south); lat0 <= tileLat0(north); lat0 += TILE_SPAN_DEG) {
    for (let lon0 = tileLon0(west); lon0 <= tileLon0(east); lon0 += TILE_SPAN_DEG) {
      keys.push(tileKey(lat0, lon0));
    }
  }
  return keys;
}

// Global 3-arc-second lattice, shared by every tile so pooling blocks never straddle a seam.
const globalRow = lat => Math.floor((90 - lat) * SAMPLES_PER_DEGREE);
const globalCol = lon => Math.floor((lon + 180) * SAMPLES_PER_DEGREE);
const latOfRowTop = row => 90 - row / SAMPLES_PER_DEGREE;
const lonOfColLeft = col => col / SAMPLES_PER_DEGREE - 180;

// --- decoding --------------------------------------------------------------------------------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Undo the gradient filter: rejoin the two byte planes, then sum down the columns and across
 *  the rows. Both sums are mod 2**16, matching _gradient_filter in scripts/terrain_format.py. */
function unfilterGradient(planes, samples) {
  const count = samples * samples;
  const values = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) values[i] = planes[i] | (planes[count + i] << 8);
  for (let r = 1; r < samples; r += 1) {
    const row = r * samples;
    const above = row - samples;
    for (let c = 0; c < samples; c += 1) values[row + c] += values[above + c];
  }
  for (let r = 0; r < samples; r += 1) {
    const row = r * samples;
    for (let c = 1; c < samples; c += 1) values[row + c] += values[row + c - 1];
  }
  // Uint16Array wraps on overflow, which is the mod-2**16 arithmetic the filter assumed; the
  // same bytes reinterpreted as int16 are the elevations.
  return new Int16Array(values.buffer);
}

export async function decodeTile(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 16 || view.getUint32(0, true) !== MAGIC) throw new Error('not a .terr tile');
  const version = view.getUint8(4);
  if (version !== 1) throw new Error(`unsupported .terr version ${version}`);
  const flags = view.getUint8(5);
  const tile = {
    lat0: view.getInt16(6, true),
    lon0: view.getInt16(8, true),
    span: view.getUint8(10),
    samples: view.getUint16(11, true),
    nodata: view.getInt16(13, true),
  };
  let payload = new Uint8Array(buffer, 16);
  if (flags & FLAG_DEFLATE) payload = await inflateRaw(payload);
  const expected = tile.samples * tile.samples * 2;
  if (payload.byteLength !== expected) {
    throw new Error(`tile payload is ${payload.byteLength} bytes, expected ${expected}`);
  }
  tile.elevations = (flags & FLAG_GRADIENT)
    ? unfilterGradient(payload, tile.samples)
    // byteOffset may be non-zero and Int16Array demands 2-byte alignment, so copy rather than view.
    : new Int16Array(payload.slice().buffer);
  return tile;
}

// --- store -----------------------------------------------------------------------------------

/**
 * Holds decoded tiles in memory, backed by the app's own Cache Storage so a downloaded region
 * keeps working with the radio off. Deliberately not a global: the app owns one instance and
 * hands it the current data origin, which can move between deployments.
 */
export class TerrainStore {
  constructor({ baseUrl, cacheName, maxTilesInMemory = 12 }) {
    this.baseUrl = baseUrl;
    this.cacheName = cacheName;
    this.maxTilesInMemory = maxTilesInMemory;
    this.tiles = new Map();       // key -> decoded tile (insertion order doubles as LRU)
    this.pending = new Map();     // key -> in-flight promise, so a burst asks the network once
    this.absent = new Set();      // keys the server says it does not have; never asked for twice
    this.unreachable = new Set(); // keys a flaky network lost; retried when the pilot acts
    this.index = null;
    this.indexPending = null;     // in-flight index fetch, so concurrent callers share one request
    this.indexRetryAt = 0;        // a failed index is retried, but not on every render
    this.tileVersions = new Map();// key -> short content hash from the index, '' when unpublished
    this.cols = undefined;        // undefined = not asked yet, null = asked and absent
  }

  url(path) { return new URL(path, this.baseUrl).toString(); }

  /**
   * The address a tile is fetched and cached under. Carries the index's content hash as ?v=,
   * because the bare key is a lie the caches believe forever: N45E007.terr keeps its name when a
   * rebuild changes its bytes, the CDN serves it for a year, and fetchTile answers cache-first —
   * so without this, a regenerated tile could never reach a phone that already held the old one.
   * With it, new bytes mean a new URL, and every cache in the chain misses honestly. An index
   * that predates the hashes yields the bare URL, which is exactly the old behaviour.
   */
  tileUrl(key) {
    const version = this.tileVersions.get(key) || '';
    const url = this.url(terrainPaths.tile(key));
    return version ? `${url}?v=${version}` : url;
  }

  /**
   * The published tile list, or null when this deployment ships no terrain at all.
   *
   * A success is cached forever — the index does not change under a deployment. A failure is not:
   * a pilot who switches terrain on with one bar of signal, or before the data host has woken up,
   * would otherwise be stuck with "no terrain" until they killed the app. It is retried on the
   * next ask, floored at INDEX_RETRY_MS so a render loop cannot turn recovery into a flood.
   */
  async loadIndex() {
    if (this.index) return this.index;
    if (this.indexPending) return this.indexPending;
    if (Date.now() < this.indexRetryAt) return null;

    this.indexPending = (async () => {
      try {
        const response = await fetch(this.url(terrainPaths.index), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.index = await response.json();
        this.tileVersions = new Map((this.index.tiles || [])
          .map(entry => [entry.key, String(entry.sha256 || '').slice(0, 10)]));
        this.indexRetryAt = 0;
      } catch (error) {
        console.info('No terrain index available', error);
        this.index = false;
        this.indexRetryAt = Date.now() + INDEX_RETRY_MS;
      } finally {
        this.indexPending = null;
      }
      return this.index || null;
    })();
    return this.indexPending;
  }

  /**
   * Forget every failure that a change in circumstances could have undone: tiles the network lost
   * and an index that could not be fetched. Called when the pilot does something that plausibly
   * fixes it — switching terrain on, or finishing a download — so recovery never needs a restart.
   * Tiles the server positively denies having are left alone; nothing the pilot does creates them.
   */
  retryFailures() {
    this.unreachable.clear();
    this.indexRetryAt = 0;
  }

  /**
   * Forget every decoded tile held in memory, so the next ask re-reads the cache (or network).
   * Needed whenever the bytes behind a key may have changed or gone: after a download refreshes
   * tiles, and after the pilot removes the offline set — fetchTile answers from memory first,
   * and would otherwise keep serving ground that no longer exists anywhere else.
   */
  dropDecodedTiles() {
    this.tiles.clear();
  }

  /**
   * Named cols and passes, for describing where a route is pinched. Optional: a deployment
   * without them falls back to a geometric description, so this must never be a hard failure.
   */
  async loadCols() {
    if (this.cols !== undefined) return this.cols;
    try {
      const response = await fetch(this.url(terrainPaths.cols), { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.cols = Array.isArray(data?.cols) ? data.cols : null;
      this.colsAttribution = data?.attribution || '';
    } catch (error) {
      console.info('No col names available', error);
      this.cols = null;
    }
    return this.cols;
  }

  /**
   * The named col nearest a point, within maxMetres. Linear scan with a cheap bounding-box
   * reject first: a few thousand entries, run once per solve, is not worth an index.
   */
  nearestCol(latitude, longitude, maxMetres = 1500) {
    if (!this.cols || !this.cols.length) return null;
    const latPad = maxMetres / METRES_PER_DEGREE_LAT;
    const lonPad = latPad / Math.max(0.2, Math.cos(latitude * Math.PI / 180));
    let best = null;
    let bestMetres = maxMetres;
    for (const col of this.cols) {
      if (Math.abs(col.lat - latitude) > latPad || Math.abs(col.lon - longitude) > lonPad) continue;
      const metres = haversineMetres(latitude, longitude, col.lat, col.lon);
      if (metres < bestMetres) { bestMetres = metres; best = col; }
    }
    return best ? { ...best, distanceM: bestMetres } : null;
  }

  /** Tile keys the index actually offers, so callers never queue a download that 404s. */
  /**
   * Forget the held index so the next loadIndex asks again. For when the service worker reports
   * the published index has moved: its background refresh has already put the new copy in the
   * cache, so the re-read this provokes is answered locally — no round trip, nothing to stall.
   */
  dropIndex() {
    this.index = null;
    this.tileVersions = new Map();
    this.indexRetryAt = 0;
  }

  async availableKeys() {
    const index = await this.loadIndex();
    return new Set((index?.tiles || []).map(entry => entry.key));
  }

  async fetchTile(key) {
    if (this.tiles.has(key)) return this.tiles.get(key);
    if (this.absent.has(key)) return null;
    if (this.pending.has(key)) return this.pending.get(key);

    const task = (async () => {
      const url = this.tileUrl(key);
      try {
        // Cache first: in the air there is no network, and a tile's bytes never change under its
        // versioned URL. A miss falls through to the network and is stored for next time.
        //
        // This lookup comes before the `unreachable` check on purpose. A pilot who enables terrain
        // on a bad connection and then downloads the region has put the tile in this cache; a
        // negative result remembered from before the download must not be what answers them.
        //
        // The second match is the past: tiles cached before URLs carried a version (bare key) or
        // under a superseded version. They still answer — yesterday's ground beats no ground, and
        // in the air it is all there is — but nothing here refreshes them behind the pilot's
        // back: the settings card counts them as out of date, and replacing them is the next
        // download's (or the next online solve's) explicit doing. A 70 MB surprise re-fetch on a
        // phone plan is not this function's decision to make.
        let response = null;
        if ('caches' in self) {
          const cache = await caches.open(this.cacheName);
          response = await cache.match(url)
            || await cache.match(this.url(terrainPaths.tile(key)), { ignoreSearch: true });
        }
        if (!response) {
          if (this.unreachable.has(key)) return null;
          response = await fetch(url);
          // A 404 is the server saying the tile does not exist, which no amount of retrying or
          // downloading will change. Anything else is the network, and gets another chance.
          if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`),
            { absent: response.status === 404 });
          if ('caches' in self) {
            await (await caches.open(this.cacheName)).put(url, response.clone());
          }
        }
        const tile = await decodeTile(await response.arrayBuffer());
        this.tiles.set(key, tile);
        this.unreachable.delete(key);
        // Each tile is ~2.9 MB decoded, so hold a working set and drop the oldest beyond it.
        while (this.tiles.size > this.maxTilesInMemory) {
          this.tiles.delete(this.tiles.keys().next().value);
        }
        return tile;
      } catch (error) {
        if (error?.absent) this.absent.add(key); else this.unreachable.add(key);
        console.info('Terrain tile unavailable', key, error);
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, task);
    return task;
  }

  /** Load every tile covering a box. Returns the ones that exist; absent tiles are simply absent. */
  async loadBounds(bounds) {
    // Ask the index first. At the edge of a covered region most of the surrounding tiles do not
    // exist, and requesting them anyway spends a round trip each to be told so — on a phone with
    // one bar that is the difference between a solve and a stall.
    const published = await this.availableKeys();
    const keys = tileKeysForBounds(bounds)
      .filter(key => published.size === 0 || published.has(key));
    const tiles = await Promise.all(keys.map(key => this.fetchTile(key)));
    const found = new Map();
    keys.forEach((key, i) => { if (tiles[i]) found.set(key, tiles[i]); });
    return found;
  }

  /**
   * Cut a routing grid out of the loaded tiles: a rectangle of cells around a centre, each
   * holding the highest ground within it. Cells not covered by any tile are NODATA, and the
   * caller decides what an uncovered route is worth.
   *
   * Returns null when nothing at all is covered, which is the signal to fall back to straight
   * lines rather than to invent terrain.
   */
  async routingGrid({ latitude, longitude, radiusM }) {
    const latPad = radiusM / METRES_PER_DEGREE_LAT;
    const cosLat = Math.max(0.2, Math.cos(latitude * Math.PI / 180));
    const lonPad = latPad / cosLat;
    const bounds = {
      south: latitude - latPad, north: latitude + latPad,
      west: longitude - lonPad, east: longitude + lonPad,
    };
    const tiles = await this.loadBounds(bounds);
    if (!tiles.size) return null;

    // Square-ish cells: the same number of metres across as down, at this latitude.
    const lonDecimate = Math.max(1, Math.round(ROUTE_LAT_DECIMATE / cosLat));
    // Snap the window to the global lattice so a pooling block is always the same set of source
    // cells regardless of where the glider happens to be standing.
    const rowStart = Math.floor(globalRow(bounds.north) / ROUTE_LAT_DECIMATE) * ROUTE_LAT_DECIMATE;
    const rowEnd = Math.ceil((globalRow(bounds.south) + 1) / ROUTE_LAT_DECIMATE) * ROUTE_LAT_DECIMATE;
    const colStart = Math.floor(globalCol(bounds.west) / lonDecimate) * lonDecimate;
    const colEnd = Math.ceil((globalCol(bounds.east) + 1) / lonDecimate) * lonDecimate;

    const rows = (rowEnd - rowStart) / ROUTE_LAT_DECIMATE;
    const cols = (colEnd - colStart) / lonDecimate;
    const elevations = new Int16Array(rows * cols).fill(NODATA);
    let covered = 0;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        let best = NODATA;
        for (let sr = 0; sr < ROUTE_LAT_DECIMATE; sr += 1) {
          const gr = rowStart + r * ROUTE_LAT_DECIMATE + sr;
          const tileRowIndex = Math.floor(gr / SAMPLES_PER_DEGREE);
          const lat0 = 89 - tileRowIndex;
          const localRow = gr - tileRowIndex * SAMPLES_PER_DEGREE;
          for (let sc = 0; sc < lonDecimate; sc += 1) {
            const gc = colStart + c * lonDecimate + sc;
            const tileColIndex = Math.floor(gc / SAMPLES_PER_DEGREE);
            const tile = tiles.get(tileKey(lat0, tileColIndex - 180));
            if (!tile) continue;
            const value = tile.elevations[localRow * SAMPLES_PER_DEGREE + (gc - tileColIndex * SAMPLES_PER_DEGREE)];
            if (value !== NODATA && value > best) best = value;
          }
        }
        if (best !== NODATA) covered += 1;
        elevations[r * cols + c] = best;
      }
    }
    if (!covered) return null;

    const latStepDeg = ROUTE_LAT_DECIMATE / SAMPLES_PER_DEGREE;
    const lonStepDeg = lonDecimate / SAMPLES_PER_DEGREE;
    return {
      rows, cols, elevations, nodata: NODATA,
      north: latOfRowTop(rowStart),
      west: lonOfColLeft(colStart),
      latStepDeg,
      lonStepDeg,
      // Cell size on the ground, taken at the centre latitude. The grid spans at most ~2°, over
      // which the longitude scale moves a couple of per cent — well inside the grid's own
      // resolution, and the error is symmetric rather than one-sided.
      cellNorthM: latStepDeg * METRES_PER_DEGREE_LAT,
      cellEastM: lonStepDeg * METRES_PER_DEGREE_LAT * cosLat,
      coveredCells: covered,
      coverage: covered / (rows * cols),
    };
  }
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/** Row/column of the cell holding a position within a routing grid, or null if outside it. */
export function gridIndexFor(grid, latitude, longitude) {
  const row = Math.floor((grid.north - latitude) / grid.latStepDeg);
  const col = Math.floor((longitude - grid.west) / grid.lonStepDeg);
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return null;
  return { row, col };
}

/** Centre of a routing cell, for describing a point on a route back to the pilot. */
export function gridLatLon(grid, row, col) {
  return {
    latitude: grid.north - (row + 0.5) * grid.latStepDeg,
    longitude: grid.west + (col + 0.5) * grid.lonStepDeg,
  };
}
