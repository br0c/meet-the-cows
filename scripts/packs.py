"""Pack definitions and geofencing for multi-pack builds.

A single build run produces several packs from one merged, translated field set:
country packs (fields selected by political country) and geofenced packs such as
the whole-Alps pack (fields selected by position, drawn from every country).

Selection is deliberately kept out of build_pack.py so it can be unit-tested without
the network-heavy build. Cross-pack de-duplication (e.g. Alps + France chosen together
in the app) is NOT done here: every field keeps its deterministic stable_id, identical
across packs, so the app dedupes by id at load time — the same physical field can appear
in several packs but is only ever shown once.
"""
from __future__ import annotations

from typing import Any, Iterable, Sequence

# Approximate outline of the Alpine arc as (lat, lon) vertices, traced clockwise from the
# Maritime Alps. This is a generous working boundary, not the legal Alpine Convention
# perimeter — it is meant to catch soaring terrain across FR/CH/IT/AT/DE (and the Slovenian
# Julian Alps edge) while excluding the Paris basin, the Swiss Mittelland lakes, Munich, and
# most of the Po plain. Tune the vertices rather than the algorithm when the edge is wrong.
ALPS_GEOFENCE: tuple[tuple[float, float], ...] = (
    (43.60, 5.55),   # SW: lower Durance / Verdon (St-Auban, Vinon soaring sites)
    (44.30, 5.50),   # Dévoluy / western Vercors
    (45.10, 5.55),   # west of Grenoble
    (45.90, 6.05),   # Chambéry / west of the Mont Blanc massif
    (46.45, 6.05),   # south shore of Lake Geneva
    (46.95, 7.05),   # Bernese Oberland, north edge
    (47.30, 8.55),   # Glarus / south of Zürich
    (47.60, 9.60),   # Bregenz / Lake Constance
    (47.75, 11.00),  # Bavarian Alps (Garmisch), north edge
    (47.80, 13.05),  # Salzburg
    (47.90, 14.60),  # Ennstal, Austrian northern limestone Alps
    (47.95, 16.05),  # Vienna Alps, eastern end
    (46.85, 16.10),  # SE Austria / Slovenia border
    (46.20, 13.55),  # Julian Alps
    (46.00, 11.05),  # Trento / south Dolomites
    (45.65, 9.55),   # Bergamo pre-Alps
    (45.30, 7.35),   # south of the Aosta valley, north edge of the Po plain
    (44.30, 7.05),   # Cuneo / eastern Maritime Alps
    (43.85, 7.20),   # Ligurian Alps, above Monaco
)


def point_in_polygon(lat: float, lon: float, polygon: Sequence[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test. Polygon vertices are (lat, lon); x=lon, y=lat."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        # Does a horizontal ray at `lat` cross the edge (i, j), and is the crossing east of lon?
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def in_alps(field: dict[str, Any]) -> bool:
    """True when a field's coordinates fall inside the Alps geofence."""
    lat = field.get("latitude")
    lon = field.get("longitude")
    if lat is None or lon is None:
        return False
    try:
        return point_in_polygon(float(lat), float(lon), ALPS_GEOFENCE)
    except (TypeError, ValueError):
        return False


# Pack registry. `countries` selects by political country code; `geofence` selects by
# position. A pack uses exactly one selector. `name` is the display label shown in the app's
# pack picker (kept multilingual inline until the app localizes pack names from the manifest).
PACK_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"id": "fr", "name": "France", "countries": ("FR",)},
    {"id": "ch", "name": "Schweiz · Suisse · Svizzera", "countries": ("CH",)},
    {"id": "de", "name": "Deutschland", "countries": ("DE",)},
    {"id": "it", "name": "Italia", "countries": ("IT",)},
    {"id": "at", "name": "Österreich", "countries": ("AT",)},
    {"id": "alps", "name": "Alps · Alpes · Alpen", "geofence": "alps"},
)

# Every country a build must pull so the packs above can be sliced from one merged field set.
BUILD_COUNTRIES: tuple[str, ...] = ("FR", "CH", "DE", "IT", "AT")


def field_in_pack(field: dict[str, Any], pack: dict[str, Any]) -> bool:
    """True when `field` belongs in `pack` per that pack's selector."""
    countries = pack.get("countries")
    if countries:
        return str(field.get("country") or "").upper() in {c.upper() for c in countries}
    if pack.get("geofence") == "alps":
        return in_alps(field)
    return False


def select_pack_fields(fields: Iterable[dict[str, Any]], pack: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the subset of `fields` that belongs in `pack`."""
    return [f for f in fields if field_in_pack(f, pack)]
