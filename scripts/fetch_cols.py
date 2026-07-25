#!/usr/bin/env python3
"""Fetch named cols and passes from OpenStreetMap, for describing a routed glide.

A routed glide is limited somewhere specific, and "tightest over ground at 1,744 m, 18 km away on
196°" is precise but not how anyone thinks about it. "Via the Col de Joux" is the same fact in the
form a pilot already holds it in.

Only nodes that carry a name are kept: an unnamed saddle cannot improve on the geometric
description the app falls back to, so it would be bytes for nothing.

Output: <out>/_terrain/cols.json, beside the tiles it annotates.

  python scripts/fetch_cols.py --bbox 43 5 49 17 --out data/packs
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Mirrors, tried in order. Overpass instances rate-limit and go down; one bad day should not fail
# a build that is only decorating a feature.
ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
ATTRIBUTION = "© OpenStreetMap contributors, ODbL"

# natural=saddle is the col itself; mountain_pass=yes catches the ones tagged as crossings. Both
# are restricted to named nodes.
QUERY = """[out:json][timeout:{timeout}];
(
  node["natural"="saddle"]["name"]({south},{west},{north},{east});
  node["mountain_pass"="yes"]["name"]({south},{west},{north},{east});
);
out body;
"""


def fetch(query: str, timeout: int) -> dict:
    last_error: Exception | None = None
    for endpoint in ENDPOINTS:
        try:
            body = urllib.parse.urlencode({"data": query}).encode()
            request = urllib.request.Request(
                endpoint, data=body,
                headers={"User-Agent": "meet-the-cows col fetcher (github.com/br0c/meet-the-cows)"},
            )
            with urllib.request.urlopen(request, timeout=timeout + 30) as response:
                return json.loads(response.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            print(f"{endpoint}: {error}", file=sys.stderr)
            last_error = error
            time.sleep(5)
    raise RuntimeError(f"every Overpass endpoint failed: {last_error}")


def parse_elevation(raw: object) -> int | None:
    """OSM ele tags are free text: '2925', '2925 m', '2,925'. Anything else is not worth guessing."""
    text = str(raw or "").strip().replace(",", "").replace("m", "").strip()
    try:
        return round(float(text))
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"),
                        default=[43, 5, 49, 17], help="Bounding box, south west north east")
    parser.add_argument("--out", default="data/packs", help="Packs root; writes <out>/_terrain/cols.json")
    parser.add_argument("--timeout", type=int, default=300, help="Overpass server-side timeout")
    parser.add_argument("--chunk", type=float, default=2.0,
                        help="Split the box into chunks this many degrees across. Overpass rejects "
                             "or times out on very large areas.")
    args = parser.parse_args()

    south, west, north, east = args.bbox
    out_dir = Path(args.out) / "_terrain"
    out_dir.mkdir(parents=True, exist_ok=True)

    seen: dict[tuple[int, int], dict] = {}
    lat = south
    while lat < north:
        lon = west
        lat_to = min(lat + args.chunk, north)
        while lon < east:
            lon_to = min(lon + args.chunk, east)
            query = QUERY.format(timeout=args.timeout, south=lat, west=lon, north=lat_to, east=lon_to)
            print(f"chunk {lat},{lon} .. {lat_to},{lon_to}", file=sys.stderr)
            data = fetch(query, args.timeout)
            for element in data.get("elements", []):
                name = (element.get("tags") or {}).get("name", "").strip()
                if not name:
                    continue
                latitude, longitude = element.get("lat"), element.get("lon")
                if latitude is None or longitude is None:
                    continue
                # Key on rounded position rather than OSM id: the same col is often mapped twice,
                # once as a saddle and once as a pass, and two chips for one place reads as a bug.
                key = (round(latitude * 2000), round(longitude * 2000))
                if key in seen:
                    continue
                entry = {"name": name, "lat": round(latitude, 5), "lon": round(longitude, 5)}
                elevation = parse_elevation((element.get("tags") or {}).get("ele"))
                if elevation is not None:
                    entry["elevationM"] = elevation
                seen[key] = entry
            lon = lon_to
            time.sleep(2)  # be a good citizen; these are free public servers
        lat = lat_to

    cols = sorted(seen.values(), key=lambda c: (c["lat"], c["lon"]))
    payload = {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "attribution": ATTRIBUTION,
        "bbox": [south, west, north, east],
        "count": len(cols),
        "cols": cols,
    }
    target = out_dir / "cols.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(cols)} named cols, {target.stat().st_size:,} bytes, to {target}", file=sys.stderr)


if __name__ == "__main__":
    main()
