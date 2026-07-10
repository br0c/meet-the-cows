#!/usr/bin/env python3
"""Render docs/alps-packs.svg: a fixed map of the two Alps packs' boundaries.

Draws the Alps geofence (packs.ALPS_GEOFENCE) with the Western/Eastern halves shaded and the
Sion -> Alzate/Locarno overlap corridor visible where the shadings blend, plus reference cities
and (optionally) field dots for context. Regenerate after tuning the geofence or the split
longitudes:

  python scripts/generate_alps_pack_map.py [--fields path/to/fields.json]

--fields accepts a pack fields.json (list of objects with latitude/longitude) or the compact
{n, c, lat, lon} rows used during boundary review. Pure stdlib; output is a self-contained SVG
that GitHub renders directly in the README.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import packs  # noqa: E402

# Viewport (lat/lon) chosen to frame the whole geofence with a margin.
LON_MIN, LON_MAX = 4.2, 17.4
LAT_MIN, LAT_MAX = 42.9, 49.1
WIDTH = 940
K = math.cos(math.radians((LAT_MIN + LAT_MAX) / 2))  # equirectangular lon compression
HEIGHT = round(WIDTH * (LAT_MAX - LAT_MIN) / ((LON_MAX - LON_MIN) * K))

CITIES = [
    (43.30, 5.37, "Marseille", "s"), (43.70, 7.27, "Nice", "s"), (45.19, 5.72, "Grenoble", "w"),
    (45.76, 4.84, "Lyon", "w"), (46.20, 6.14, "Genève", "w"), (46.23, 7.36, "Sion", "n"),
    (46.16, 8.78, "Locarno", "s"), (45.77, 9.16, "Alzate", "s"), (45.46, 9.19, "Milano", "s"),
    (45.07, 7.69, "Torino", "s"), (47.38, 8.54, "Zürich", "n"), (48.14, 11.58, "München", "n"),
    (47.26, 11.39, "Innsbruck", "n"), (46.50, 11.35, "Bolzano", "e"), (47.80, 13.04, "Salzburg", "n"),
    (48.21, 16.37, "Wien", "n"), (46.06, 14.51, "Ljubljana", "s"),
]

WEST_FILL = "#3b82c4"   # Western Alps pack
EAST_FILL = "#e0a03c"   # Eastern Alps pack


def xy(lat: float, lon: float) -> tuple[float, float]:
    x = (lon - LON_MIN) / (LON_MAX - LON_MIN) * WIDTH
    y = (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * HEIGHT
    return round(x, 1), round(y, 1)


def load_fields(path: str) -> list[tuple[float, float]]:
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    out = []
    for r in rows:
        lat = r.get("latitude", r.get("lat"))
        lon = r.get("longitude", r.get("lon"))
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            out.append((float(lat), float(lon)))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fields", default="", help="Optional fields JSON for context dots")
    parser.add_argument("--out", default="docs/alps-packs.svg")
    args = parser.parse_args()

    poly_points = " ".join(f"{x},{y}" for x, y in (xy(lat, lon) for lat, lon in packs.ALPS_GEOFENCE))
    x_east_edge_of_west, _ = xy(LAT_MIN, packs.ALPS_WEST_MAX_LON)
    x_west_edge_of_east, _ = xy(LAT_MIN, packs.ALPS_EAST_MIN_LON)

    svg: list[str] = []
    svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT + 74}" '
               f'font-family="system-ui, -apple-system, sans-serif">')
    svg.append(f'<rect width="{WIDTH}" height="{HEIGHT + 74}" fill="#fcfcf9"/>')
    svg.append(f'<clipPath id="alps"><polygon points="{poly_points}"/></clipPath>')

    # Pack shadings, clipped by the geofence. The two rects overlap between the split
    # longitudes, so the shared Sion->Locarno/Como corridor shows as the blended colour.
    svg.append(f'<g clip-path="url(#alps)">')
    svg.append(f'<rect x="0" y="0" width="{x_east_edge_of_west}" height="{HEIGHT}" fill="{WEST_FILL}" fill-opacity="0.30"/>')
    svg.append(f'<rect x="{x_west_edge_of_east}" y="0" width="{WIDTH - x_west_edge_of_east}" height="{HEIGHT}" fill="{EAST_FILL}" fill-opacity="0.34"/>')
    svg.append('</g>')
    svg.append(f'<polygon points="{poly_points}" fill="none" stroke="#5a6b57" stroke-width="1.6"/>')

    # Split meridians with their anchor labels.
    for lon, label, anchor_x_off in ((packs.ALPS_EAST_MIN_LON, f"{packs.ALPS_EAST_MIN_LON}°E · Sion", 4),
                                     (packs.ALPS_WEST_MAX_LON, f"{packs.ALPS_WEST_MAX_LON}°E · Alzate / Locarno", 4)):
        x, _ = xy(LAT_MIN, lon)
        svg.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{HEIGHT}" stroke="#8a4f7d" stroke-width="1.1" stroke-dasharray="6,5"/>')
        svg.append(f'<text x="{x + anchor_x_off}" y="16" font-size="12" fill="#8a4f7d">{label}</text>')

    # Context dots: light gray outside the packs, pack colours inside.
    if args.fields:
        dots = []
        for lat, lon in load_fields(args.fields):
            if not (LON_MIN < lon < LON_MAX and LAT_MIN < lat < LAT_MAX):
                continue
            f = {"latitude": lat, "longitude": lon}
            west = packs.in_alps_band(f, max_lon=packs.ALPS_WEST_MAX_LON)
            east = packs.in_alps_band(f, min_lon=packs.ALPS_EAST_MIN_LON)
            color = "#7a4fb0" if (west and east) else (WEST_FILL if west else (EAST_FILL if east else "#b9b9b3"))
            x, y = xy(lat, lon)
            dots.append(f'<circle cx="{x}" cy="{y}" r="1.7" fill="{color}"/>')
        svg.extend(dots)

    for lat, lon, name, side in CITIES:
        x, y = xy(lat, lon)
        svg.append(f'<circle cx="{x}" cy="{y}" r="2.6" fill="#333"/>')
        dx, dy, anchor = {"n": (0, -7, "middle"), "s": (0, 15, "middle"),
                          "e": (7, 4, "start"), "w": (-7, 4, "end")}[side]
        svg.append(f'<text x="{x + dx}" y="{y + dy}" font-size="12" fill="#333" text-anchor="{anchor}">{name}</text>')

    # Legend.
    ly = HEIGHT + 14
    legend = [(WEST_FILL, "0.30", "Western Alps pack"), (EAST_FILL, "0.34", "Eastern Alps pack")]
    lx = 12
    for fill, opacity, label in legend:
        svg.append(f'<rect x="{lx}" y="{ly}" width="26" height="16" fill="{fill}" fill-opacity="{opacity}" stroke="#5a6b57" stroke-width="0.8"/>')
        svg.append(f'<text x="{lx + 32}" y="{ly + 13}" font-size="13" fill="#333">{label}</text>')
        lx += 32 + 9 * len(label) + 24
    svg.append(f'<rect x="{lx}" y="{ly}" width="13" height="16" fill="{WEST_FILL}" fill-opacity="0.30" stroke="#5a6b57" stroke-width="0.8"/>')
    svg.append(f'<rect x="{lx + 13}" y="{ly}" width="13" height="16" fill="{EAST_FILL}" fill-opacity="0.34" stroke="#5a6b57" stroke-width="0.8"/>')
    svg.append(f'<text x="{lx + 32}" y="{ly + 13}" font-size="13" fill="#333">Overlap — in both packs (Sion → Locarno / Como)</text>')
    svg.append(f'<text x="12" y="{ly + 40}" font-size="11.5" fill="#777">Fixed equirectangular sketch of the pack geofence '
               f'(scripts/packs.py) — regenerate with scripts/generate_alps_pack_map.py after tuning boundaries.</text>')
    svg.append('</svg>')

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(svg), encoding="utf-8")
    print(f"wrote {out_path} ({out_path.stat().st_size:,} bytes, {WIDTH}x{HEIGHT + 74})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
