#!/usr/bin/env python3
"""Generated field views: OSM runway geometry + orthophoto imagery.

Fields are routed to one of two tiers:
  - OSM tier: an OSM runway lies within --radius of the field's coordinate. Its
    geometry (centre, heading, length, width) is used as-is — validated against
    pilot memory on Alps strips, it beat vision placement on worst-case error and
    is deterministic and free.
  - Vision tier: everything else. Those fields need the model locate/refine/judge
    pipeline (separate tooling); this script only inventories them and can fetch
    the clean orthophoto crops that pipeline consumes.

Subcommands:
  runways --fields F.json --out runways.json   fetch aeroway=runway near all fields
  match   --fields F.json --runways R.json --out M.json [--radius 1000]
  crop    --lat .. --lon .. --out C.jpg [--width-m 1800]   clean portrait crop
  render  --match-entry M.json:ID --out V.jpg   OSM-tier view (validated style)

The runway fetch batches 1-degree tiles (only tiles containing fields) into
Overpass union queries, with the same mirror rotation and backoff discipline as
fetch_cols.py. Runways mapped as closed areas get a centreline via principal axis.
"""
import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "meet-the-cows field views (github.com/br0c/meet-the-cows)"
TILES_PER_QUERY = 20
PX_W, PX_H = 975, 1300  # portrait, phone-shaped — matches the validated prototypes

# Orthophoto providers by ISO country, all openly licensed WMS with attribution.
# Google imagery is deliberately absent: its terms forbid caching/redistribution.
WMS_PROVIDERS = {
    "FR": dict(
        url="https://data.geopf.fr/wms-r/wms",
        layer="ORTHOIMAGERY.ORTHOPHOTOS",
        attribution="Orthophoto © IGN France (Licence Ouverte)"),
    "ES": dict(
        url="https://www.ign.es/wms-inspire/pnoa-ma",
        layer="OI.OrthoimageCoverage",
        attribution="Orthophoto © IGN España PNOA (CC BY 4.0)"),
    "CH": dict(
        url="https://wms.geo.admin.ch/",
        layer="ch.swisstopo.images-swissimage",
        attribution="Orthophoto © swisstopo (SWISSIMAGE)"),
    # AT basemap.at (CC BY 4.0) is WMTS-only — needs a tile-stitch path.
    # DE (per-Land DOP) / IT (per-region): add each service as its licence is
    # confirmed open; fields without a confirmed provider get no generated view.
}


def http_get(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass(query, rounds=3, backoff_s=20):
    last_error = None
    for attempt in range(rounds):
        for mirror in OVERPASS_MIRRORS:
            try:
                body = urllib.parse.urlencode({"data": query}).encode()
                return json.loads(http_get(mirror, data=body, timeout=180))
            except Exception as e:  # noqa: BLE001 - mirror rotation
                last_error = e
        time.sleep(backoff_s * (attempt + 1))
    raise RuntimeError(f"every Overpass endpoint failed: {last_error}")


def load_fields(path):
    fields = json.loads(Path(path).read_text())
    out = []
    for f in fields:
        lat = f.get("latitude", f.get("lat"))
        lon = f.get("longitude", f.get("lon"))
        if lat is None or lon is None:
            continue
        media = f.get("media")
        out.append(dict(id=f.get("id"), name=f.get("name"), lat=lat, lon=lon,
                        kind=f.get("kind"), lengthM=f.get("lengthM"),
                        country=f.get("country"),
                        media=len(media) if isinstance(media, list) else (media or 0)))
    return out


def field_tiles(fields, pad=0.05):
    """1-degree tiles that contain at least one field, padded a little."""
    tiles = {}
    for f in fields:
        key = (math.floor(f["lat"]), math.floor(f["lon"]))
        tiles[key] = (key[0] - pad, key[1] - pad, key[0] + 1 + pad, key[1] + 1 + pad)
    return sorted(tiles.values())


def cmd_runways(args):
    fields = load_fields(args.fields)
    tiles = field_tiles(fields)
    ways = {}
    for i in range(0, len(tiles), TILES_PER_QUERY):
        batch = tiles[i:i + TILES_PER_QUERY]
        clauses = "".join(
            f'way["aeroway"="runway"]({s},{w},{n},{e});' for s, w, n, e in batch)
        q = f"[out:json][timeout:120];({clauses});out geom tags;"
        for el in overpass(q).get("elements", []):
            ways[el["id"]] = dict(
                id=el["id"],
                pts=[(g["lat"], g["lon"]) for g in el.get("geometry", [])],
                tags=el.get("tags", {}))
        print(f"tiles {i + 1}-{i + len(batch)}/{len(tiles)}: {len(ways)} runways so far",
              flush=True)
    Path(args.out).write_text(json.dumps(list(ways.values())))
    print(f"wrote {len(ways)} runway ways to {args.out}")


def local_en(lat0, lon0, lat, lon):
    return ((lon - lon0) * 111320 * math.cos(math.radians(lat0)),
            (lat - lat0) * 111320)


def principal_axis(pts):
    me = sum(p[0] for p in pts) / len(pts)
    mn = sum(p[1] for p in pts) / len(pts)
    cxx = sum((p[0] - me) ** 2 for p in pts) / len(pts)
    cyy = sum((p[1] - mn) ** 2 for p in pts) / len(pts)
    cxy = sum((p[0] - me) * (p[1] - mn) for p in pts) / len(pts)
    ang = 0.5 * math.atan2(2 * cxy, cxx - cyy)
    ux, uy = math.cos(ang), math.sin(ang)
    proj = [(p[0] - me) * ux + (p[1] - mn) * uy for p in pts]
    minor = [-(p[0] - me) * uy + (p[1] - mn) * ux for p in pts]
    lo, hi = min(proj), max(proj)
    return ((me + lo * ux, mn + lo * uy), (me + hi * ux, mn + hi * uy),
            max(minor) - min(minor))


def seg_dist(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy
    t = 0 if ll == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ll))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def runway_geometry(field, way):
    """Distance from the field to the runway, plus the runway's axis geometry."""
    pts = [local_en(field["lat"], field["lon"], la, lo) for la, lo in way["pts"]]
    if len(pts) < 2:
        return None
    closed = len(pts) > 3 and math.hypot(pts[0][0] - pts[-1][0],
                                         pts[0][1] - pts[-1][1]) < 1
    ring = pts[:-1] if closed else pts
    if closed:
        (e1, n1), (e2, n2), area_width = principal_axis(ring)
    else:
        (e1, n1), (e2, n2), area_width = pts[0], pts[-1], None
    dist = min(seg_dist((0, 0), ring[i], ring[(i + 1) % len(ring)])
               for i in range(len(ring) - (0 if closed else 1)))
    tags = way["tags"]
    try:
        width = float(str(tags.get("width", "")).split()[0])
    except (ValueError, IndexError):
        width = area_width
    return dict(
        osm_id=way["id"], dist=round(dist, 1),
        dx=round((e1 + e2) / 2, 1), dy=round((n1 + n2) / 2, 1),
        hdg=round(math.degrees(math.atan2(e2 - e1, n2 - n1)) % 180, 1),
        len=round(math.hypot(e2 - e1, n2 - n1), 1),
        width_m=width, surface=tags.get("surface"), ref=tags.get("ref"))


def cmd_match(args):
    fields = load_fields(args.fields)
    ways = json.loads(Path(args.runways).read_text())
    # Coarse spatial index: runway first-node into 0.1-degree cells.
    cells = {}
    for w in ways:
        if not w["pts"]:
            continue
        la, lo = w["pts"][0]
        cells.setdefault((round(la, 1), round(lo, 1)), []).append(w)
    matches, osm_count = [], 0
    for f in fields:
        near = []
        base = (round(f["lat"], 1), round(f["lon"], 1))
        for dla in (-0.1, 0, 0.1):
            for dlo in (-0.1, 0, 0.1, -0.2, 0.2):
                near.extend(cells.get((round(base[0] + dla, 1),
                                       round(base[1] + dlo, 1)), []))
        best = None
        for w in near:
            g = runway_geometry(f, w)
            if g and g["dist"] <= args.radius and (best is None or g["dist"] < best["dist"]):
                best = g
        entry = dict(id=f["id"], name=f["name"], kind=f["kind"], lat=f["lat"],
                     lon=f["lon"], country=f.get("country"), media=f["media"],
                     osm=best)
        matches.append(entry)
        osm_count += best is not None
    Path(args.out).write_text(json.dumps(matches))
    by_kind = {}
    for m in matches:
        k = m["kind"] or "?"
        got = m["osm"] is not None
        by_kind.setdefault(k, [0, 0])
        by_kind[k][0] += got
        by_kind[k][1] += 1
    print(f"fields: {len(matches)}  OSM tier: {osm_count} "
          f"({100 * osm_count / max(len(matches), 1):.1f}%)  "
          f"vision tier: {len(matches) - osm_count}")
    for k, (got, tot) in sorted(by_kind.items()):
        print(f"  {k:12} {got}/{tot} from OSM")


def wms_crop(lat, lon, width_m, out_path, country="FR"):
    p = WMS_PROVIDERS[country]
    height_m = width_m * PX_H / PX_W
    dlat = height_m / 111320
    dlon = width_m / (111320 * math.cos(math.radians(lat)))
    bbox = (lat - dlat / 2, lon - dlon / 2, lat + dlat / 2, lon + dlon / 2)
    params = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap",
              "LAYERS": p["layer"], "STYLES": "", "CRS": "EPSG:4326",
              "BBOX": ",".join(f"{v:.6f}" for v in bbox),
              "WIDTH": str(PX_W), "HEIGHT": str(PX_H), "FORMAT": "image/jpeg"}
    Path(out_path).write_bytes(http_get(p["url"] + "?" + urllib.parse.urlencode(params)))
    return width_m / PX_W


def cmd_crop(args):
    mpp = wms_crop(args.lat, args.lon, args.width_m, args.out, args.country)
    print(f"wrote {args.out} ({args.width_m:.0f} m wide, {mpp:.2f} m/px)")


def cmd_render(args):
    from PIL import Image, ImageDraw, ImageFont  # lazy: only render needs Pillow

    path, fid = args.match_entry.rsplit(":", 1)
    entry = next(m for m in json.loads(Path(path).read_text()) if str(m["id"]) == fid)
    if not entry.get("osm"):
        sys.exit(f"{fid} has no OSM geometry; it is a vision-tier field")
    g = entry["osm"]
    country = (entry.get("country") or "FR")[:2].upper()
    frame_w = max(g["len"] * 1.6, 1000)
    clat = entry["lat"] + (g["dy"] / 2) / 111320
    clon = entry["lon"] + (g["dx"] / 2) / (111320 * math.cos(math.radians(entry["lat"])))
    tmp = Path(args.out).with_suffix(".crop.jpg")
    mpp = wms_crop(clat, clon, frame_w, tmp, country)
    img = Image.open(tmp).convert("RGB")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    red = (226, 40, 25)

    def to_px(e, n):
        return (PX_W / 2 + (e - g["dx"] / 2) / mpp, PX_H / 2 - (n - g["dy"] / 2) / mpp)

    h = math.radians(g["hdg"])
    ax, ay = math.sin(h), math.cos(h)
    px_, py_ = math.cos(h), -math.sin(h)
    wid = max(g.get("width_m") or 35, 30)
    pts = [to_px(g["dx"] + sa * ax * g["len"] / 2 + sp * px_ * wid / 2,
                 g["dy"] + sa * ay * g["len"] / 2 + sp * py_ * wid / 2)
           for sa, sp in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
    d.polygon(pts, outline=red + (255,), width=4)

    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        small = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
        nfont = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
    except OSError:
        font = small = nfont = ImageFont.load_default()
    x, y, r = 56, 70, 36
    d.ellipse([x - r - 7, y - r - 7, x + r + 7, y + r + 7], fill=(10, 15, 25, 140))
    d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255, 220), width=2)
    for ang in range(0, 360, 45):
        hh = math.radians(ang)
        ln = r if ang % 90 == 0 else r * 0.5
        tip = (x + ln * math.sin(hh), y - ln * math.cos(hh))
        bl = (x + 6 * math.sin(hh + math.pi / 2), y - 6 * math.cos(hh + math.pi / 2))
        br = (x + 6 * math.sin(hh - math.pi / 2), y - 6 * math.cos(hh - math.pi / 2))
        d.polygon([tip, bl, br], fill=red + (255,) if ang == 0 else (255, 255, 255, 235))
    d.text((x, y - r - 9), "N", font=nfont, fill=(255, 255, 255, 255), anchor="mb",
           stroke_width=2, stroke_fill=(10, 15, 25, 255))
    bar_h = 56
    d.rectangle([0, PX_H - bar_h, PX_W, PX_H], fill=(10, 15, 25, 175))
    d.text((14, PX_H - bar_h + 8), entry["name"], font=font, fill=(255, 255, 255, 255))
    d.text((14, PX_H - 20),
           WMS_PROVIDERS[country]["attribution"] + " · Runway © OpenStreetMap contributors",
           font=small, fill=(200, 206, 218, 255))
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        args.out, quality=90)
    tmp.unlink()
    print(f"rendered {args.out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("runways")
    p.add_argument("--fields", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_runways)
    p = sub.add_parser("match")
    p.add_argument("--fields", required=True)
    p.add_argument("--runways", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--radius", type=float, default=1000.0)
    p.set_defaults(fn=cmd_match)
    p = sub.add_parser("crop")
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--width-m", type=float, default=1800.0)
    p.add_argument("--country", default="FR")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_crop)
    p = sub.add_parser("render")
    p.add_argument("--match-entry", required=True,
                   help="matches.json:FIELD_ID from the match subcommand")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_render)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
