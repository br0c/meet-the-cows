"""The .terr tile container: one binary elevation grid per 1° cell.

Kept separate from the builder so the encoder, the decoder and the tests all read the same
definition — the JavaScript decoder in src/terrain.js is a direct transcription of decode().

Layout (little-endian throughout):

    offset  size  field
    0       4     magic b"MTCT"
    4       1     format version (1)
    5       1     flags; bit 0 = raw-deflate compressed, bit 1 = gradient-filtered
    6       2     int16  lat0    south edge of the tile, whole degrees
    8       2     int16  lon0    west edge of the tile, whole degrees
    10      1     uint8  span    tile size in whole degrees
    11      2     uint16 samples samples per side
    13      2     int16  nodata  value standing for "no data"
    15      1     reserved, 0
    16      ...   payload: samples*samples int16 elevations in metres, row-major

Rows run north to south and columns west to east. Each sample is a CELL, not a point: it holds
the highest ground anywhere in the cell, so the grid never invents a gap through a ridge. With
h = span / samples, cell (r, c) covers

    latitude  (lat0 + span - (r+1)*h,  lat0 + span - r*h]     -- open below, closed above
    longitude [lon0 +      c*h,        lon0 + (c+1)*h)        -- closed below, open above

which is exactly what the lookups r = floor((lat0 + span - lat) / h) and c = floor((lon - lon0) / h)
give you. The latitude interval closes at the top because the source rows do; the practical
consequence is only at a tile seam, where the tile holding a given latitude is

    lat0 = ceil(lat) - 1        (not floor(lat) -- lat exactly 45.0 belongs to the N44 tile)
    lon0 = floor(lon)

Either way each position lands in exactly one cell of exactly one tile, so adjacent tiles can
never disagree about a sample.

The payload is deflated inside the container rather than relying on Content-Encoding,
because the tiles are served from several hosts (R2 behind a custom domain, GitHub Pages,
a plain local checkout) and only some of them negotiate compression for binary bodies.
Browsers decompress it with DecompressionStream('deflate-raw').

Before deflating, elevations go through the gradient filter below. Raw alpine terrain is too
high-entropy for deflate to do much with (2.02 MB for a 1° tile of the Aosta valley); predicting
each sample from its neighbours and splitting the residual bytes into two planes brings the same
tile to 1.25 MB, which is the difference between a plausible and an implausible download.
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass

MAGIC = b"MTCT"
FORMAT_VERSION = 1
HEADER_SIZE = 16
FLAG_DEFLATE = 0x01
FLAG_GRADIENT = 0x02
NODATA = -32768

_HEADER = struct.Struct("<4sBBhhBHhB")


def _gradient_filter(raw: bytes, samples: int) -> bytes:
    """Difference each sample against the gradient predictor left + up - upleft, then split bytes.

    Applying a horizontal difference and then a vertical one is exactly that predictor, and it
    inverts as two cumulative sums, which is what makes the JavaScript decoder cheap.

    Arithmetic is mod 2**16 on the two's-complement bit patterns, so a residual that overflows
    int16 still round-trips. Low and high residual bytes are then written as two separate planes:
    the high plane is nearly all 0x00/0xFF, which deflate collapses to almost nothing.
    """
    import numpy as np

    grid = np.frombuffer(raw, dtype="<u2").reshape(samples, samples).astype(np.uint32)
    horizontal = grid.copy()
    horizontal[:, 1:] = grid[:, 1:] - grid[:, :-1]
    residual = horizontal.copy()
    residual[1:, :] = horizontal[1:, :] - horizontal[:-1, :]
    residual = (residual & 0xFFFF).astype(np.uint16).ravel()
    return np.concatenate([
        (residual & 0xFF).astype(np.uint8),
        (residual >> 8).astype(np.uint8),
    ]).tobytes()


def _gradient_unfilter(payload: bytes, samples: int) -> bytes:
    """Inverse of _gradient_filter: rejoin the byte planes, then sum down and across."""
    import numpy as np

    count = samples * samples
    planes = np.frombuffer(payload, dtype=np.uint8)
    residual = (planes[:count].astype(np.uint32) | (planes[count:].astype(np.uint32) << 8))
    grid = residual.reshape(samples, samples)
    horizontal = np.cumsum(grid, axis=0, dtype=np.uint32)
    values = np.cumsum(horizontal, axis=1, dtype=np.uint32)
    return (values & 0xFFFF).astype("<u2").tobytes()


@dataclass(frozen=True)
class Tile:
    lat0: int
    lon0: int
    span: int
    samples: int
    nodata: int
    elevations: bytes  # samples*samples int16, little-endian, row-major, north-to-south


def tile_key(lat0: int, lon0: int) -> str:
    """Copernicus-style tile name: N45E006, S09W071."""
    ns = "N" if lat0 >= 0 else "S"
    ew = "E" if lon0 >= 0 else "W"
    return f"{ns}{abs(lat0):02d}{ew}{abs(lon0):03d}"


def parse_tile_key(key: str) -> tuple[int, int]:
    """Inverse of tile_key. Raises ValueError on anything malformed."""
    if len(key) != 7 or key[0] not in "NS" or key[3] not in "EW":
        raise ValueError(f"malformed tile key: {key!r}")
    if not (key[1:3].isdigit() and key[4:7].isdigit()):
        raise ValueError(f"malformed tile key: {key!r}")
    lat = int(key[1:3]) * (1 if key[0] == "N" else -1)
    lon = int(key[4:7]) * (1 if key[3] == "E" else -1)
    return lat, lon


def tile_lat0(lat: float) -> int:
    """South edge of the tile holding this latitude.

    ceil - 1, not floor: a cell's latitude interval is closed at the top, so a position exactly
    on a whole degree belongs to the tile below it. See the module header.
    """
    return math.ceil(lat) - 1


def tile_lon0(lon: float) -> int:
    """West edge of the tile holding this longitude — plain floor, longitude closes at the bottom."""
    return math.floor(lon)


def encode(tile: Tile, *, compress: bool = True, filtered: bool = True) -> bytes:
    expected = tile.samples * tile.samples * 2
    if len(tile.elevations) != expected:
        raise ValueError(f"payload is {len(tile.elevations)} bytes, expected {expected}")
    payload = tile.elevations
    flags = 0
    if filtered:
        payload = _gradient_filter(payload, tile.samples)
        flags |= FLAG_GRADIENT
    if compress:
        # Raw deflate (no zlib wrapper) so DecompressionStream('deflate-raw') reads it directly.
        compressor = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
        payload = compressor.compress(payload) + compressor.flush()
        flags |= FLAG_DEFLATE
    header = _HEADER.pack(
        MAGIC, FORMAT_VERSION, flags, tile.lat0, tile.lon0, tile.span, tile.samples, tile.nodata, 0
    )
    return header + payload


def decode(blob: bytes) -> Tile:
    if len(blob) < HEADER_SIZE:
        raise ValueError("truncated tile: shorter than the header")
    magic, version, flags, lat0, lon0, span, samples, nodata, _ = _HEADER.unpack(blob[:HEADER_SIZE])
    if magic != MAGIC:
        raise ValueError(f"not a .terr tile (magic {magic!r})")
    if version != FORMAT_VERSION:
        raise ValueError(f"unsupported .terr version {version}")
    payload = blob[HEADER_SIZE:]
    if flags & FLAG_DEFLATE:
        try:
            payload = zlib.decompress(payload, -zlib.MAX_WBITS)
        except zlib.error as error:
            # A half-written cache entry or a truncated download must read as a bad tile, not as
            # an exception type every caller has to know about.
            raise ValueError(f"corrupt .terr payload: {error}") from error
    expected = samples * samples * 2
    if len(payload) != expected:
        raise ValueError(f"payload is {len(payload)} bytes, expected {expected}")
    if flags & FLAG_GRADIENT:
        payload = _gradient_unfilter(payload, samples)
    return Tile(lat0=lat0, lon0=lon0, span=span, samples=samples, nodata=nodata, elevations=payload)
