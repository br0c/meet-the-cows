#!/usr/bin/env python3
"""Tests for the .terr container and the tile geometry it promises.

The JavaScript decoder in src/terrain.js is a transcription of scripts/terrain_format.py, and
scripts/test_terrain_js.mjs checks the two agree on a real tile. This file covers the parts that
do not need a 1.2 MB download: the filter round-trip, the header, and the addressing rules that
decide which tile and which cell a position belongs to.

  python scripts/test_terrain_format.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from terrain_format import (  # noqa: E402
    FLAG_DEFLATE,
    FLAG_GRADIENT,
    HEADER_SIZE,
    NODATA,
    Tile,
    decode,
    encode,
    parse_tile_key,
    tile_key,
    tile_lat0,
    tile_lon0,
)

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {label}{f'  — {detail}' if detail else ''}")
    if not ok:
        FAILURES.append(label)


def make_tile(samples: int = 64, seed: int = 11) -> Tile:
    rng = np.random.default_rng(seed)
    grid = rng.integers(-400, 4800, size=(samples, samples)).astype("<i2")
    # The values that have historically broken naive codecs: the sentinel, both int16 extremes,
    # and a flat run that the predictor turns into a long stretch of zeroes.
    grid[0, 0] = NODATA
    grid[1, 1] = 32767
    grid[2, 2] = NODATA + 1
    grid[10:20, 10:40] = 1500
    return Tile(lat0=45, lon0=7, span=1, samples=samples, nodata=NODATA, elevations=grid.tobytes())


def test_round_trip() -> None:
    tile = make_tile()
    for compress in (True, False):
        for filtered in (True, False):
            back = decode(encode(tile, compress=compress, filtered=filtered))
            check(
                f"round trip (deflate={compress}, gradient={filtered})",
                back.elevations == tile.elevations
                and (back.lat0, back.lon0, back.span, back.samples) == (45, 7, 1, tile.samples),
            )


def test_header() -> None:
    tile = make_tile(samples=8)
    blob = encode(tile)
    check("magic", blob[:4] == b"MTCT", repr(blob[:4]))
    check("flags record both transforms", blob[5] == (FLAG_DEFLATE | FLAG_GRADIENT), hex(blob[5]))
    check("header is 16 bytes", len(encode(tile, compress=False, filtered=False)) == HEADER_SIZE + 8 * 8 * 2)

    for label, mutate in (
        ("bad magic is rejected", lambda b: b"XXXX" + b[4:]),
        ("unknown version is rejected", lambda b: b[:4] + bytes([9]) + b[5:]),
        ("truncated payload is rejected", lambda b: b[:-5]),
        ("a header-only file is rejected", lambda b: b[:8]),
    ):
        try:
            decode(mutate(blob))
        except ValueError:
            check(label, True)
        except Exception as error:  # noqa: BLE001 — any other type means a confusing failure mode
            check(label, False, f"raised {type(error).__name__}: {error}")
        else:
            check(label, False, "decoded without complaint")


def test_compression_actually_helps() -> None:
    # Real terrain, not noise: the filter is only worth its complexity on smooth ground.
    samples = 256
    ys, xs = np.mgrid[0:samples, 0:samples]
    terrain = (2000 + 1200 * np.sin(xs / 40) * np.cos(ys / 55) + xs * 1.5).astype("<i2")
    tile = Tile(lat0=45, lon0=7, span=1, samples=samples, nodata=NODATA, elevations=terrain.tobytes())
    plain = len(encode(tile, compress=True, filtered=False))
    filtered = len(encode(tile, compress=True, filtered=True))
    check("the gradient filter beats plain deflate", filtered < plain, f"{filtered:,} vs {plain:,} bytes")
    check("filtered round trip on smooth terrain",
          decode(encode(tile)).elevations == tile.elevations)


def test_tile_keys() -> None:
    cases = [(45, 7, "N45E007"), (0, 0, "N00E000"), (-9, -71, "S09W071"), (48, 16, "N48E016")]
    for lat0, lon0, expected in cases:
        check(f"tile_key({lat0}, {lon0})", tile_key(lat0, lon0) == expected, tile_key(lat0, lon0))
        check(f"parse_tile_key({expected})", parse_tile_key(expected) == (lat0, lon0))
    for bad in ("N45E07", "", "X45E007", "N45X007"):
        try:
            parse_tile_key(bad)
        except ValueError:
            check(f"malformed key {bad!r} is rejected", True)
        else:
            check(f"malformed key {bad!r} is rejected", False, "accepted")


def test_cell_addressing() -> None:
    """The lookups the app performs, checked against the convention the module documents.

    Latitude closes at the top of a cell and longitude at the bottom, so a position exactly on a
    whole degree belongs to the tile below it in latitude and the tile east of it in longitude.
    Getting this wrong puts a pilot's glide over the wrong ridge at a tile seam, and it is
    invisible everywhere except within 92 m of a degree line.
    """
    samples, span = 1200, 1

    def cell(lat0: int, lon0: int, lat: float, lon: float) -> tuple[int, int]:
        return (
            int((lat0 + span - lat) * samples / span),
            int((lon - lon0) * samples / span),
        )

    check("north edge of a tile is row 0", cell(45, 7, 46.0, 7.0)[0] == 0)
    check("west edge of a tile is column 0", cell(45, 7, 46.0, 7.0)[1] == 0)
    check("just inside the south edge is the last row", cell(45, 7, 45.0 + 1e-9, 7.0)[0] == samples - 1)
    check("just inside the east edge is the last column", cell(45, 7, 46.0, 8.0 - 1e-9)[1] == samples - 1)

    # The seam. Latitude 45.0 exactly is row 0 of the N44 tile, not row 1200 of the N45 tile —
    # which does not exist and would read off the end of the grid.
    check("tile holding latitude 45.0 is N44", tile_lat0(45.0) == 44, str(tile_lat0(45.0)))
    check("tile holding latitude 45.5 is N45", tile_lat0(45.5) == 45, str(tile_lat0(45.5)))
    check("a whole degree of latitude lands in row 0 of that tile",
          cell(tile_lat0(45.0), 7, 45.0, 7.5)[0] == 0)
    check("every latitude in a tile is in range",
          all(0 <= cell(tile_lat0(lat), 7, lat, 7.5)[0] < samples
              for lat in (45.0, 45.0001, 45.5, 45.9999, 46.0)))

    # Longitude closes at the bottom instead, so a whole degree belongs to the tile to its east.
    check("tile holding longitude 8.0 is E008", tile_lon0(8.0) == 8, str(tile_lon0(8.0)))
    check("a whole degree of longitude lands in column 0 of that tile",
          cell(45, tile_lon0(8.0), 45.5, 8.0)[1] == 0)
    check("every longitude in a tile is in range",
          all(0 <= cell(45, tile_lon0(lon), 45.5, lon)[1] < samples
              for lon in (7.0, 7.0001, 7.5, 7.9999, 8.0)))


def main() -> None:
    test_round_trip()
    test_header()
    test_compression_actually_helps()
    test_tile_keys()
    test_cell_addressing()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
