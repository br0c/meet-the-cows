#!/usr/bin/env python3
"""Build the terrain tiles the app routes glides over, from the Copernicus DEM.

Why terrain at all: a straight-line glide ratio is wrong in the mountains in both directions.
It calls a field unreachable when a valley leads there below the ridge line (Cervinia to Aosta
is the case that started this), and it calls one reachable when a ridge stands in the way. The
app walks a real path across this grid instead.

What comes out: 1° x 1° tiles of int16 metres at 3 arc-seconds (~92 m of latitude), written to
<out>/_terrain/<KEY>.terr plus an index.json listing them. Format and coordinate convention live
in scripts/terrain_format.py; src/terrain.js decodes the same bytes in the browser.

Downsampling takes the MAXIMUM of each source block, never the mean. A cell therefore reports
the highest ground within it, so a summit is never averaged away into a col that does not exist,
and the routing error is on the side of refusing a glide rather than granting one. That bias is
the whole reason to prefer GLO-30 pooled 3x3 over GLO-90 read straight through, even though the
two land on the same grid — GLO-90's own resampling is not conservative.

The Copernicus DEM is a Digital Surface Model: it includes trees and buildings. For terrain
clearance that is again the safe direction.

Source: Copernicus DEM, ESA / Sinergise, distributed by AWS Open Data.
  https://registry.opendata.aws/copernicus-dem/

Examples:
  # The Alps, the same box scripts/packs.py geofences
  python scripts/build_terrain_tiles.py --bbox 43 5 49 17 --out data/packs
  # One tile, from the lighter 90 m product, for a quick local try
  python scripts/build_terrain_tiles.py --bbox 45 6 46 7 --dem glo90 --out data/packs
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from terrain_format import NODATA, Tile, encode, tile_key  # noqa: E402

# 3 arc-seconds: 1200 samples across a 1° tile, ~92 m of latitude and ~65 m of longitude in the
# Alps. A whole divisor of both 3600 and the source grids, so pooling is exact with no resampling
# artefacts. The app routes on a coarser multiple of this (see ROUTE_DECIMATE in src/terrain.js).
SAMPLES_PER_DEGREE = 1200
TILE_SPAN_DEG = 1

DEM_PRODUCTS = {
    # name: (bucket host, COG level tag, arc-seconds per source sample)
    "glo30": ("copernicus-dem-30m.s3.amazonaws.com", "10", 1),
    "glo90": ("copernicus-dem-90m.s3.amazonaws.com", "30", 3),
}
ATTRIBUTION = "Copernicus DEM — ESA, Sinergise; produced using Copernicus WorldDEM-30"


def dem_url(product: str, lat0: int, lon0: int) -> str:
    host, level, _ = DEM_PRODUCTS[product]
    ns = "N" if lat0 >= 0 else "S"
    ew = "E" if lon0 >= 0 else "W"
    stem = f"Copernicus_DSM_COG_{level}_{ns}{abs(lat0):02d}_00_{ew}{abs(lon0):03d}_00_DEM"
    return f"https://{host}/{stem}/{stem}.tif"


def download(url: str, dest: Path, *, timeout: int = 300) -> bool:
    """Fetch url to dest. Returns False for a missing tile (ocean), raises for anything else."""
    request = urllib.request.Request(url, headers={"User-Agent": "meet-the-cows terrain builder"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, dest.open("wb") as handle:
            shutil.copyfileobj(response, handle)
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return False  # no such tile — open sea, or outside the product's coverage
        raise
    return True


def usable_extent(length: int, samples: int) -> int:
    """How many source rows/columns of a 1° tile to pool, for a source of this length.

    Copernicus ships two shapes and which one you get depends on the product and the latitude
    band: n*k samples spanning the degree, or n*k + 1 where the far edge is repeated. Guessing
    wrong shifts every sample by a third of a cell, so detect it from the length — the Aosta
    tile arrives as 3600, not the 3601 the pixel-is-point description would suggest.
    """
    if length % samples == 0:
        return length
    if (length - 1) % samples == 0:
        return length - 1
    raise ValueError(f"source side {length} is not a whole multiple of {samples} (± the shared edge)")


def pool_max(source, samples: int):
    """Max-pool a source grid to samples x samples, taking the highest ground in each output cell."""
    rows = usable_extent(source.shape[0], samples)
    cols = usable_extent(source.shape[1], samples)
    factor_r, factor_c = rows // samples, cols // samples
    trimmed = source[:rows, :cols]
    return trimmed.reshape(samples, factor_r, samples, factor_c).max(axis=(1, 3))


def read_dem(path: Path, lat0: int, lon0: int, samples: int):
    """Read a Copernicus COG and return a samples x samples int16 grid, north-to-south.

    The tile's geographic extent is checked against the raster's own transform rather than
    trusted: a silently misplaced tile would put cliffs where the app expects valleys.
    """
    import numpy as np
    import rasterio

    with rasterio.open(path) as src:
        # Validate on the first sample's centre, not on src.bounds: these rasters are pixel-is-point
        # and rasterio reports bounds half a pixel outside the degree, which looks like a
        # misplaced tile when it is nothing of the sort.
        first_lon, first_lat = src.xy(0, 0)
        step_lon, step_lat = src.transform.a, -src.transform.e
        width, height = src.width, src.height
        declared = src.nodata
        band = src.read(1, masked=True).astype("float32").filled(np.nan)

    for label, got, want in (
        ("north-west sample longitude", first_lon, lon0),
        ("north-west sample latitude", first_lat, lat0 + TILE_SPAN_DEG),
        ("longitude span", step_lon * usable_extent(width, samples), TILE_SPAN_DEG),
        ("latitude span", step_lat * usable_extent(height, samples), TILE_SPAN_DEG),
    ):
        if abs(got - want) > 1e-6:
            raise ValueError(f"{tile_key(lat0, lon0)}: {label} is {got}, expected {want}")

    missing = np.isnan(band)
    if declared is not None and not math.isnan(float(declared)):
        missing |= band == float(declared)
    # A missing sample must never win a max, and must never be mistaken for sea level: park it
    # far below any real terrain and restore the sentinel afterwards for cells that are all-missing.
    band = np.where(missing, -1e6, band)

    pooled = pool_max(band, samples)
    out = np.rint(pooled).astype(np.int32)
    out = np.where(pooled <= -1e5, NODATA, out)
    # Copernicus reaches below sea level around the Dead Sea; clamp only to what int16 can hold.
    return np.clip(out, NODATA + 1, 32767).astype("<i2")


def build_tile(product: str, lat0: int, lon0: int, out_dir: Path, *, force: bool) -> dict | None:
    key = tile_key(lat0, lon0)
    target = out_dir / f"{key}.terr"
    if target.exists() and not force:
        blob = target.read_bytes()
        return tile_entry(key, lat0, lon0, blob)

    url = dem_url(product, lat0, lon0)
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "dem.tif"
        if not download(url, raw):
            print(f"{key}: no source tile (sea or out of coverage)", file=sys.stderr)
            return None
        grid = read_dem(raw, lat0, lon0, SAMPLES_PER_DEGREE)

    tile = Tile(
        lat0=lat0, lon0=lon0, span=TILE_SPAN_DEG,
        samples=SAMPLES_PER_DEGREE, nodata=NODATA,
        elevations=grid.tobytes(order="C"),
    )
    blob = encode(tile)
    target.write_bytes(blob)
    print(f"{key}: {len(blob):,} bytes", file=sys.stderr)
    return tile_entry(key, lat0, lon0, blob)


def tile_entry(key: str, lat0: int, lon0: int, blob: bytes) -> dict:
    return {
        "key": key,
        "lat0": lat0,
        "lon0": lon0,
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"),
                        default=[43, 5, 49, 17],
                        help="Bounding box in degrees, south west north east. Default: the Alps.")
    parser.add_argument("--dem", choices=sorted(DEM_PRODUCTS), default=os.environ.get("TERRAIN_DEM", "glo30"),
                        help="Copernicus product. glo30 is pooled 3x3 and conservative; glo90 is "
                             "~8x lighter to download but already resampled by someone else.")
    parser.add_argument("--out", default="data/packs",
                        help="Packs root; tiles are written to <out>/_terrain/")
    parser.add_argument("--jobs", type=int, default=4, help="Parallel tile downloads")
    parser.add_argument("--force", action="store_true", help="Rebuild tiles that already exist")
    args = parser.parse_args()

    south, west, north, east = args.bbox
    if north <= south or east <= west:
        print("bbox must be south west north east with north > south and east > west", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out) / "_terrain"
    out_dir.mkdir(parents=True, exist_ok=True)

    wanted = [
        (lat0, lon0)
        for lat0 in range(math.floor(south), math.ceil(north))
        for lon0 in range(math.floor(west), math.ceil(east))
    ]
    print(f"{len(wanted)} tiles from {args.dem} for bbox {south},{west} .. {north},{east}", file=sys.stderr)

    entries: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {
            pool.submit(build_tile, args.dem, lat0, lon0, out_dir, force=args.force): (lat0, lon0)
            for lat0, lon0 in wanted
        }
        for future in concurrent.futures.as_completed(futures):
            lat0, lon0 = futures[future]
            try:
                entry = future.result()
            except Exception as error:  # one bad tile must not lose the rest of the build
                print(f"{tile_key(lat0, lon0)}: FAILED — {error}", file=sys.stderr)
                continue
            if entry:
                entries.append(entry)

    entries.sort(key=lambda e: e["key"])
    index = {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "source": f"Copernicus DEM {args.dem.upper()}",
        "attribution": ATTRIBUTION,
        "resolutionArcSec": 3,
        "spanDeg": TILE_SPAN_DEG,
        "samples": SAMPLES_PER_DEGREE,
        "nodata": NODATA,
        "tileCount": len(entries),
        "totalBytes": sum(e["bytes"] for e in entries),
        "tiles": entries,
    }
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(entries)} tiles, {index['totalBytes']:,} bytes total, to {out_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
