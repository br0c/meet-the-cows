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
# Each country maps to an ORDERED list of provider candidates. Sub-national providers carry a
# bbox (S, W, N, E) and are candidates only for points inside it; bboxes overlap (Länder,
# regions), so ortho_crop falls through to the next candidate when a fetch fails or comes back
# blank — a service asked about a point just outside its Land answers with white tiles, not an
# error. Order encodes preference: for Italy the regional services come first because they are
# recent (Veneto flies 2024) and the national PCN layer is from 2012 — legally fine either way
# (CAD art. 52 c.2: published without an express licence means open data by statute), but
# fourteen-year-old imagery is weak evidence for whether a parcel is still landable.
#
# `crs`/`version` exist because not everyone speaks WMS 1.3.0 + EPSG:4326: several German
# services advertise only ETRS89/UTM (EPSG:258xx), and PCN only answers WMS 1.1.1. Austria is
# WMTS (kind "wmts"): basemap.at publishes tiles, not GetMap, so its crop is stitched.
# Google imagery stays deliberately absent: its terms forbid caching and redistribution.
PROVIDERS: dict[str, list[dict]] = {
    "FR": [dict(url="https://data.geopf.fr/wms-r/wms", layer="ORTHOIMAGERY.ORTHOPHOTOS",
                attribution="Orthophoto © IGN France (Licence Ouverte)")],
    "ES": [dict(url="https://www.ign.es/wms-inspire/pnoa-ma", layer="OI.OrthoimageCoverage",
                attribution="Orthophoto © IGN España PNOA (CC BY 4.0)")],
    "CH": [dict(url="https://wms.geo.admin.ch/", layer="ch.swisstopo.images-swissimage",
                attribution="Orthophoto © swisstopo (SWISSIMAGE)")],
    "AT": [dict(kind="wmts",
                url="https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg",
                attribution="Orthophoto: Datenquelle: basemap.at")],
    # Germany has no usable national DOP service (the BKG endpoint is 403); the Länder publish
    # their own under CC BY 4.0 / DL-DE-BY-2.0 / their open-data terms — see field_views_lab/
    # NOTES.md for the licence audit. Hessen, Berlin, Hamburg, Bremen and Saarland are still
    # missing endpoints; fields only they cover simply get no crop until one is found.
    "DE": [
        # by_dop40c, not the DOP40 group: the group answers a valid but empty JPEG.
        dict(url="https://geoservices.bayern.de/od/wms/dop/v1/dop40", layer="by_dop40c",
             bbox=(47.2, 8.9, 50.6, 13.9),
             attribution="Orthophoto © Bayerische Vermessungsverwaltung (CC BY 4.0)"),
        dict(url="https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C",
             layer="IMAGES_DOP_20_RGB", bbox=(47.5, 7.5, 49.8, 10.5),
             attribution="Orthophoto © LGL Baden-Württemberg (dl-de/by-2-0)"),
        dict(url="https://www.wms.nrw.de/geobasis/wms_nw_dop", layer="nw_dop_rgb",
             bbox=(50.3, 5.8, 52.6, 9.5),
             attribution="Orthophoto © Geobasis NRW (Open Data)"),
        dict(url="https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms",
             layer="ni_dop20", bbox=(51.3, 6.6, 53.9, 11.6),
             attribution="Orthophoto © LGLN Niedersachsen (CC BY 4.0)"),
        dict(url="https://geo4.service24.rlp.de/wms/rp_dop20.fcgi", layer="rp_dop20",
             bbox=(48.9, 6.1, 50.95, 8.5),
             attribution="Orthophoto © GeoBasis-DE / LVermGeoRP (dl-de/by-2-0)"),
        dict(url="https://service.gdi-sh.de/WMS_SH_DOP20col_OpenGBD", layer="sh_dop20_rgb",
             bbox=(53.35, 7.8, 55.1, 11.4),
             attribution="Orthophoto © GeoBasis-DE/LVermGeo SH (CC BY 4.0)"),
        dict(url="https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", layer="sn_dop_020",
             bbox=(50.15, 11.8, 51.7, 15.1),
             attribution="Orthophoto © GeoSN Sachsen (Open Data)"),
        dict(url="https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP",
             # th_dop (the group), not th_dop20rgb: the sublayer alone raises a
             # ServiceException. UTM only — this service rejects EPSG:4326 outright.
             layer="th_dop", bbox=(50.2, 9.8, 51.65, 12.7), crs="EPSG:25832",
             attribution="Orthophoto © GDI-Th Thüringen (dl-de/by-2-0)"),
        dict(url="https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms", layer="bebb_dop20c",
             bbox=(51.35, 11.2, 53.6, 14.8),
             attribution="Orthophoto © GeoBasis-DE/LGB Brandenburg (dl-de/by-2-0)"),
        dict(url="https://www.geodaten-mv.de/dienste/adv_dop", layer="mv_dop",
             bbox=(53.1, 10.6, 54.7, 14.4),
             attribution="Orthophoto © GeoBasis-DE/MV"),
        dict(url="https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest",
             layer="lsa_lvermgeo_dop20_2", bbox=(50.9, 10.5, 53.05, 13.2),
             attribution="Orthophoto © LVermGeo Sachsen-Anhalt (dl-de/by-2-0)"),
    ],
    # Italian regional services first (recent imagery), national PCN 2012 as the fallback; the
    # PCN layer name's trailing number is its UTM zone.
    #
    # The regional services are used under the CC BY 4.0 licence their geoportals publish,
    # citing the source. The AGEA-derived layers also carry an upstream MASAF/Agea rights
    # notice, and a separate institutional sub-licence covers the raw ECW files handed to Enti
    # Locali — neither is what we rely on here.
    #
    # The credit names the REGION we fetch from, not AGEA or MASAF. Attribution under CC BY runs
    # to the licensor whose grant we rely on, and every source in this table carries its own
    # licence; crediting an upstream owner instead would assert reliance on terms we are not
    # using, and would not follow if the provider were later swapped. See NOTES.md.
    "IT": [
        dict(url="https://opengis.csi.it/mp/regp_agea_2024", layer="regp_agea_2024",
             bbox=(44.0, 6.6, 46.5, 9.3),
             attribution="Orthophoto © Regione Piemonte (CC BY 4.0)"),
        dict(url="https://idt2-geoserver.regione.veneto.it/geoserver/wms",
             layer="rv:ortofoto_agea_2024", bbox=(44.75, 10.6, 46.7, 13.1),
             attribution="Orthophoto © Regione del Veneto (CC BY 4.0)"),
        # p_bz- (the provincial coverage), not gvcc- (municipal, white outside towns);
        # the mapproxy rejects EPSG:4326 outright, so UTM it is.
        dict(url="https://geoservices.buergernetz.bz.it/mapproxy/ows/service",
             layer="p_bz-Orthoimagery:Aerial-2023-RGB", bbox=(46.2, 10.35, 47.1, 12.5),
             crs="EPSG:25832",
             attribution="Orthophoto © Provincia Autonoma di Bolzano (CC BY 4.0)"),
        dict(url="http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map",
             layer="OI.ORTOIMMAGINI.2012.32", bbox=(35.0, 6.0, 47.5, 12.0), version="1.1.1",
             attribution="Orthophoto © Geoportale Nazionale, MASE (open data)"),
        dict(url="http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map",
             layer="OI.ORTOIMMAGINI.2012.33", bbox=(35.0, 12.0, 47.5, 19.0), version="1.1.1",
             attribution="Orthophoto © Geoportale Nazionale, MASE (open data)"),
    ],
}

# Back-compat view for callers that predate the candidate lists (first entry per country).
WMS_PROVIDERS = {country: entries[0] for country, entries in PROVIDERS.items()}


# --- Coordinate plumbing for providers that do not speak EPSG:4326 --------------------------

def utm_from_wgs84(lat, lon, epsg):
    """WGS84 -> UTM easting/northing for EPSG:258xx / EPSG:326xx (zone = last two digits).

    Standard series expansion, sub-metre accurate — pyproj precision is not needed to place a
    600-2000 m image bbox, and this keeps the script dependency-free. ETRS89 vs WGS84 differ
    by well under a metre in Europe, so EPSG:258xx is served by the same math.
    """
    zone = int(str(epsg)[-2:])
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    k0, e0 = 0.9996, 500000.0
    lon0 = math.radians(zone * 6 - 183)
    phi, lam = math.radians(lat), math.radians(lon)
    n = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    t = math.tan(phi) ** 2
    c = ep2 * math.cos(phi) ** 2
    big_a = (lam - lon0) * math.cos(phi)
    m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * phi)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * phi)
             - (35 * e2 ** 3 / 3072) * math.sin(6 * phi))
    east = e0 + k0 * n * (big_a + (1 - t + c) * big_a ** 3 / 6
                          + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * big_a ** 5 / 120)
    north = k0 * (m + n * math.tan(phi) * (big_a ** 2 / 2
                  + (5 - t + 9 * c + 4 * c ** 2) * big_a ** 4 / 24
                  + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * big_a ** 6 / 720))
    return east, north


def mercator_from_wgs84(lat, lon):
    """WGS84 -> Web Mercator (EPSG:3857) metres, for WMTS tile math."""
    r = 6378137.0
    return r * math.radians(lon), r * math.atanh(math.sin(math.radians(lat)))


def wmts_tile(lat, lon, z):
    """Google-scheme tile indices containing a point at zoom z."""
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    lat_r = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
    return x, y


def providers_for(country, lat, lon):
    """Ordered provider candidates for a point: national ones always, sub-national by bbox.

    The field's own country is tried first, then any OTHER country whose provider bbox
    covers the point. A field's country is the guide's, not the ground's: Oulx sits in
    the Italian Val di Susa but reaches the pack through the French guide, and asking
    IGN France for it returns blank imagery rather than an error.
    """
    def covers(p):
        box = p.get("bbox")
        return box is None or (box[0] <= lat <= box[2] and box[1] <= lon <= box[3])

    out = [p for p in PROVIDERS.get(country, []) if covers(p)]
    for other, providers in PROVIDERS.items():
        if other == country:
            continue
        out += [p for p in providers if p.get("bbox") and covers(p)]
    return out


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


def wms_getmap_params(p, lat, lon, width_m, height_m):
    """GetMap query parameters honouring the provider's WMS version and CRS.

    Axis order is the eternal WMS trap: 1.3.0 + EPSG:4326 wants lat,lon; 1.1.1 wants lon,lat
    (and calls the key SRS); projected CRSs are easting,northing in both versions.
    """
    version = p.get("version", "1.3.0")
    crs = p.get("crs", "EPSG:4326")
    if crs.upper().startswith("EPSG:4326"):
        dlat = height_m / 111320
        dlon = width_m / (111320 * math.cos(math.radians(lat)))
        south, west = lat - dlat / 2, lon - dlon / 2
        north, east = lat + dlat / 2, lon + dlon / 2
        latlon_first = version == "1.3.0"
        box = (south, west, north, east) if latlon_first else (west, south, east, north)
    else:
        cx, cy = utm_from_wgs84(lat, lon, crs.split(":")[1])
        box = (cx - width_m / 2, cy - height_m / 2, cx + width_m / 2, cy + height_m / 2)
    return {"SERVICE": "WMS", "VERSION": version, "REQUEST": "GetMap",
            "LAYERS": p["layer"], "STYLES": "",
            ("CRS" if version == "1.3.0" else "SRS"): crs,
            "BBOX": ",".join(f"{v:.6f}" for v in box),
            "WIDTH": str(PX_W), "HEIGHT": str(PX_H), "FORMAT": "image/jpeg"}


def fetch_wmts_crop(p, lat, lon, width_m, height_m):
    """Stitch a lat/lon-boxed crop from a google-scheme WMTS tile pyramid -> JPEG bytes.

    The zoom is picked so the tile resolution meets the target metres-per-pixel; the mercator
    pixel box covering the frame is assembled from tiles and resampled to PX_W x PX_H. Over a
    one-or-two-kilometre frame the mercator-vs-equirectangular mismatch is centimetres.
    """
    import io

    from PIL import Image  # lazy: only imagery paths need Pillow

    target_mpp = width_m / PX_W
    z = min(19, max(1, math.ceil(math.log2(
        156543.03392804097 * math.cos(math.radians(lat)) / target_mpp))))
    res = 156543.03392804097 / 2 ** z  # mercator metres per pixel at this zoom
    half_h = height_m / 2
    dlat = half_h / 111320
    dlon = (width_m / 2) / (111320 * math.cos(math.radians(lat)))
    x_min, y_min = mercator_from_wgs84(lat, lon - dlon)[0], None
    west_x, north_y = mercator_from_wgs84(lat + dlat, lon - dlon)
    east_x, south_y = mercator_from_wgs84(lat - dlat, lon + dlon)
    origin = math.pi * 6378137.0
    px_west = (west_x + origin) / res
    px_east = (east_x + origin) / res
    px_north = (origin - north_y) / res
    px_south = (origin - south_y) / res
    tile_x0, tile_x1 = int(px_west // 256), int(px_east // 256)
    tile_y0, tile_y1 = int(px_north // 256), int(px_south // 256)
    canvas = Image.new("RGB", ((tile_x1 - tile_x0 + 1) * 256, (tile_y1 - tile_y0 + 1) * 256))
    for ty in range(tile_y0, tile_y1 + 1):
        for tx in range(tile_x0, tile_x1 + 1):
            tile = http_get(p["url"].format(z=z, x=tx, y=ty))
            canvas.paste(Image.open(io.BytesIO(tile)), ((tx - tile_x0) * 256, (ty - tile_y0) * 256))
    crop = canvas.crop((round(px_west - tile_x0 * 256), round(px_north - tile_y0 * 256),
                        round(px_east - tile_x0 * 256), round(px_south - tile_y0 * 256)))
    out = io.BytesIO()
    crop.resize((PX_W, PX_H), Image.LANCZOS).save(out, "JPEG", quality=90)
    return out.getvalue()


def blankish(image_bytes):
    """True when a fetched crop is effectively empty — the answer a WMS gives for a point
    outside its coverage is white (or a single flat tone), not an error."""
    import io

    from PIL import Image

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("L").resize((64, 64))
    except Exception:  # noqa: BLE001 - undecodable body = not a usable crop
        return True
    pixels = list(img.get_flattened_data() if hasattr(img, "get_flattened_data")
                  else img.getdata())
    mean = sum(pixels) / len(pixels)
    spread = sum(abs(v - mean) for v in pixels) / len(pixels)
    return spread < 3.0


def ortho_crop(lat, lon, width_m, out_path, country="FR"):
    """Fetch a portrait orthophoto crop, trying the country's providers in order.

    Falls through on HTTP errors, undecodable bodies and blank coverage, so overlapping
    sub-national bboxes cost one wasted request at worst. Returns
    {mpp, attribution, provider_url} or raises when every candidate failed.
    """
    height_m = width_m * PX_H / PX_W
    candidates = providers_for(country, lat, lon)
    if not candidates:
        raise RuntimeError(f"no imagery provider covers {country} ({lat:.4f}, {lon:.4f})")
    last_error = None
    for p in candidates:
        # Two attempts per provider before falling through: a transient 503 must cost a
        # retry, not this provider's (possibly much fresher) imagery. Blank coverage is
        # not retried — the service answered fine; it just does not cover the point.
        for attempt in range(2):
            try:
                if p.get("kind") == "wmts":
                    body = fetch_wmts_crop(p, lat, lon, width_m, height_m)
                else:
                    body = http_get(p["url"] + ("&" if "?" in p["url"] else "?")
                                    + urllib.parse.urlencode(wms_getmap_params(p, lat, lon, width_m, height_m)))
            except Exception as error:  # noqa: BLE001 - retry once, then next candidate
                last_error = error
                if attempt == 0:
                    time.sleep(3)
                continue
            if blankish(body):
                last_error = f"blank coverage from {p['url']}"
                # Blank normally means "outside my coverage", which no retry fixes. But a
                # national service answering white over its OWN territory is a fault, and
                # accepting it silently costs the field its annotation: St Blaise, deep
                # inside France, degraded to an unmarked view because IGN blanked once.
                # So retry the field's own national provider before giving up on it.
                if p is candidates[0] and attempt == 0 and not p.get("bbox"):
                    time.sleep(5)
                    continue
                break
            Path(out_path).write_bytes(body)
            return dict(mpp=width_m / PX_W, attribution=p["attribution"], provider_url=p["url"])
    raise RuntimeError(f"every provider failed for {country} ({lat:.4f}, {lon:.4f}): {last_error}")


def wms_crop(lat, lon, width_m, out_path, country="FR"):
    """Back-compat wrapper: metres-per-pixel only. New callers want ortho_crop."""
    return ortho_crop(lat, lon, width_m, out_path, country)["mpp"]


def cmd_crop(args):
    crop = ortho_crop(args.lat, args.lon, args.width_m, args.out, args.country)
    print(f"wrote {args.out} ({args.width_m:.0f} m wide, {crop['mpp']:.2f} m/px, "
          f"{crop['attribution']})")


def draw_chrome(d, name, attribution, extra_credit=""):
    """North rose, name and credit bar — the furniture every generated view carries."""
    from PIL import ImageFont
    red = (226, 40, 25)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
        nfont = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
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
    d.text((14, PX_H - bar_h + 8), name, font=font, fill=(255, 255, 255, 255))
    d.text((14, PX_H - 20), attribution + extra_credit, font=small,
           fill=(200, 206, 218, 255))


def plain_view(lat, lon, name, out_path, country="FR", width_m=1200.0):
    """Current imagery with no marking at all: north rose, name, credit, nothing else.

    For fields whose source photo shows a whole area of landable ground rather than one
    strip, and for fields whose annotation cannot be transferred. An unmarked, current
    overview is honest and still useful — the pilot picks — where a wrong or absent
    marking is neither.
    """
    from PIL import Image, ImageDraw
    tmp = Path(out_path).with_suffix(".crop.jpg")
    crop = ortho_crop(lat, lon, width_m, tmp, country)
    img = Image.open(tmp).convert("RGB")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_chrome(ImageDraw.Draw(overlay), name, crop["attribution"])
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        out_path, quality=90)
    tmp.unlink()
    return crop


def cmd_plain(args):
    crop = plain_view(args.lat, args.lon, args.name, args.out, args.country, args.width_m)
    print(f"wrote {args.out} ({crop['attribution']})")


def cmd_render(args):
    path, fid = args.match_entry.rsplit(":", 1)
    entry = next(m for m in json.loads(Path(path).read_text()) if str(m["id"]) == fid)
    if not entry.get("osm"):
        sys.exit(f"{fid} has no OSM geometry; it is a vision-tier field")
    render_osm_view(entry, args.out)
    print(f"rendered {args.out}")


def render_osm_view(entry, out_path):
    """OSM-tier view for one matched field. The batch driver calls this directly rather
    than shelling out per field, which would refetch and reparse the match file 2,400
    times."""
    from PIL import Image, ImageDraw, ImageFont  # lazy: only render needs Pillow

    g = entry["osm"]
    country = (entry.get("country") or "FR")[:2].upper()
    frame_w = max(g["len"] * 1.6, 1000)
    clat = entry["lat"] + (g["dy"] / 2) / 111320
    clon = entry["lon"] + (g["dx"] / 2) / (111320 * math.cos(math.radians(entry["lat"])))
    tmp = Path(out_path).with_suffix(".crop.jpg")
    crop = ortho_crop(clat, clon, frame_w, tmp, country)
    mpp = crop["mpp"]
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
           crop["attribution"] + " · Runway © OpenStreetMap contributors",
           font=small, fill=(200, 206, 218, 255))
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        out_path, quality=90)
    tmp.unlink()


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
    p = sub.add_parser("plain")
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--width-m", type=float, default=1200.0)
    p.add_argument("--country", default="FR")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_plain)
    p = sub.add_parser("render")
    p.add_argument("--match-entry", required=True,
                   help="matches.json:FIELD_ID from the match subcommand")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_render)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
