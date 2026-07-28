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

# Generous outline of the Alpine arc AND its peri-alpine foreland as (lat, lon) vertices,
# traced clockwise from SW Provence. Deliberately not the legal Alpine Convention perimeter:
# it includes the flatland next to the mountains that pilots use to access them — the
# Drôme/Diois, the Grenoble/Chambéry/Annecy foreland, the Swiss Mittelland, the Bavarian
# Alpenvorland (up to München), the Po/Piedmont-Lombardy fringe, and the Vienna basin — while
# still excluding the Rhône valley floor (Lyon, Valence), the deep Po plain (Bologna), the
# Venetian lagoon, and the northern lowlands (Nürnberg, Paris, Berlin). Tune the vertices
# rather than the algorithm when an edge is wrong.
ALPS_GEOFENCE: tuple[tuple[float, float], ...] = (
    (43.55, 5.50),   # SW Provence (St-Auban, Vinon)
    (44.15, 5.15),   # Drôme provençale
    (44.70, 5.00),   # Drôme / Diois (keeps Aubenasson in, Valence out)
    (45.10, 5.15),   # western Vercors / Die
    (45.40, 5.25),   # Grenoble foreland (St-Geoirs)
    (45.75, 5.65),   # Chambéry / Aix-les-Bains
    (46.10, 5.75),   # Annecy / Geneva approach
    (46.55, 6.10),   # Lausanne / Lake Geneva
    (47.10, 6.60),   # NW Swiss plateau
    (47.50, 7.50),   # northern Swiss Mittelland
    (47.55, 8.60),   # Zürich
    (47.70, 9.60),   # Lake Constance
    (48.10, 10.90),  # Bavarian Alpenvorland, west
    (48.28, 11.65),  # München
    (48.10, 12.80),  # SE Bavaria
    (48.05, 13.50),  # Innviertel / north of Salzburg
    (48.20, 14.40),  # Upper Austria foreland
    (48.28, 15.60),  # Lower Austria (St. Pölten)
    (48.20, 16.55),  # Vienna basin
    (47.40, 16.62),  # Burgenland
    (46.60, 16.20),  # SE Styria / Slovenia border
    (46.00, 13.60),  # Julian Alps / Friuli
    (45.55, 12.40),  # Venetian plain (Treviso foreland)
    (45.35, 11.00),  # Verona / Vicenza foreland
    (45.20, 9.40),   # Lombardy plain (keeps Milano in)
    (45.05, 7.90),   # Piedmont (keeps Torino in)
    (44.55, 7.10),   # Cuneo
    (44.05, 7.30),   # Ligurian Alps, above Monaco
)


# The Pyrenees chain with the forelands on both sides, Atlantic to Mediterranean, drawn on
# the same principle as the Alps outline: include the flatland pilots actually use to reach
# the mountains — the Pau/Tarbes/Saint-Gaudens piedmont, the Aude gap down to the coast,
# the Empordà, the Segre/Somontano edge (keeps Huesca and Barbastro), and the Pamplona
# basin — while excluding the Ebro valley floor (Zaragoza, Lleida), the Toulouse area and
# the Atlantic industrial coast (Bilbao). Tune vertices, not the algorithm.
PYRENEES_GEOFENCE: tuple[tuple[float, float], ...] = (
    (43.60, -1.80),  # Atlantic coast (Bayonne / Biarritz)
    (43.55, -1.20),  # Basque foothills
    (43.45, -0.60),  # Pau foreland
    (43.45, 0.20),   # Tarbes
    (43.40, 0.80),   # Saint-Gaudens piedmont
    (43.35, 1.50),   # Lauragais (Toulouse stays out)
    (43.30, 2.20),   # Carcassonne fringe
    (43.05, 2.60),   # Corbières
    (42.95, 3.10),   # Mediterranean coast north of Perpignan
    (42.40, 3.25),   # Côte Vermeille / Cap de Creus
    (42.05, 3.05),   # Empordà coast
    (41.90, 2.20),   # SE pre-Pyrenees (Vic)
    (41.75, 1.20),   # Segre plain edge (Lleida out)
    (41.75, 0.20),   # Somontano edge (Zaragoza out)
    (41.85, -0.55),  # Hoya de Huesca (keeps Montflorite / Ayerbe in)
    (42.20, -1.60),  # southern Navarra (keeps Pamplona in)
    (43.20, -2.00),  # Basque interior (San Sebastián; Bilbao out)
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


def in_geofence(field: dict[str, Any], polygon: Sequence[tuple[float, float]]) -> bool:
    """True when a field's coordinates fall inside `polygon`."""
    lat = field.get("latitude")
    lon = field.get("longitude")
    if lat is None or lon is None:
        return False
    try:
        return point_in_polygon(float(lat), float(lon), polygon)
    except (TypeError, ValueError):
        return False


def in_alps(field: dict[str, Any]) -> bool:
    """True when a field's coordinates fall inside the Alps geofence."""
    return in_geofence(field, ALPS_GEOFENCE)


def in_pyrenees(field: dict[str, Any]) -> bool:
    """True when a field's coordinates fall inside the Pyrenees geofence."""
    return in_geofence(field, PYRENEES_GEOFENCE)


# The Alps pack ships as two overlapping halves so pilots download only the side they fly.
# The overlap band (Sion -> Locarno/Como) is the classic cross-border corridor: both packs
# carry it, and the app dedupes shared fields by id when both are selected.
ALPS_WEST_MAX_LON = 9.2   # eastern edge of the Western pack (keeps Locarno 8.78E, Alzate 9.16E)
ALPS_EAST_MIN_LON = 7.3   # western edge of the Eastern pack (keeps Sion 7.33E)


def in_alps_band(field: dict[str, Any], *, min_lon: float | None = None, max_lon: float | None = None) -> bool:
    """in_alps further clipped to a longitude band (bounds inclusive)."""
    if not in_alps(field):
        return False
    lon = float(field["longitude"])  # in_alps already validated the coordinates
    if min_lon is not None and lon < min_lon:
        return False
    return not (max_lon is not None and lon > max_lon)


# Notices attached to any pack carrying Spanish fields, on top of the notices every pack gets.
# Both are things a pilot can act on rather than boilerplate: the first explains why fields the
# pack claims to have may not be listed (unrated fields are hidden unless C and D are both
# enabled), the second is honest about the one country whose official charts this project does
# not ship — ENAIRE's licensing does not currently permit it, so there is nothing to attach and
# the pilot has to go to the source.
APVV_NOTICE = (
    "Spanish-side fields come from the APVV Guide des champs pyrénéens (2008): they carry no "
    "difficulty rating (enable both C and D fields in Settings to see them) and their details "
    "are dated — check current conditions."
)
ENAIRE_NOTICE = (
    "No Spanish aerodrome charts are included: check current ENAIRE AIP / Guía VFR publications "
    "before flight."
)

# Pack registry. `countries` selects by political country code; `geofence` selects by
# position. A pack uses exactly one selector. `name` is the display label shown in the app's
# pack picker (kept multilingual inline until the app localizes pack names from the manifest).
# Definition order IS picker order (write_packs_index publishes it verbatim): the mountain
# packs pilots actually fly first, then the country packs, largest communities first.
PACK_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"id": "alps-west", "names": {"en": "Western Alps", "fr": "Alpes occidentales", "de": "Westalpen"}, "geofence": "alps-west"},
    {"id": "alps-east", "names": {"en": "Eastern Alps", "fr": "Alpes orientales", "de": "Ostalpen"}, "geofence": "alps-east"},
    # Both slopes of the chain: the French side from the existing sources, the Spanish side
    # mostly from the APVV guide (2008), which rates nothing — those fields ship UNKNOWN, and
    # the app hides unrated fields unless both C and D are enabled, hence the notices.
    {"id": "pyr", "names": {"en": "Pyrenees", "fr": "Pyrénées", "de": "Pyrenäen"}, "geofence": "pyrenees",
     "extraNotices": [APVV_NOTICE, ENAIRE_NOTICE]},
    {"id": "fr", "names": {"en": "France", "fr": "France", "de": "Frankreich"}, "countries": ("FR",)},
    {"id": "ch", "names": {"en": "Switzerland", "fr": "Suisse", "de": "Schweiz"}, "countries": ("CH",)},
    {"id": "it", "names": {"en": "Italy", "fr": "Italie", "de": "Italien"}, "countries": ("IT",)},
    {"id": "at", "names": {"en": "Austria", "fr": "Autriche", "de": "Österreich"}, "countries": ("AT",)},
    {"id": "de", "names": {"en": "Germany", "fr": "Allemagne", "de": "Deutschland"}, "countries": ("DE",)},
    {"id": "es", "names": {"en": "Spain", "fr": "Espagne", "de": "Spanien"}, "countries": ("ES",),
     "extraNotices": [APVV_NOTICE, ENAIRE_NOTICE]},
    # Transitional alias for app shells cached from before the West/East split: those shells
    # resolve a stored 'alps' selection against packs.json and would otherwise fall back to the
    # France pack AND persist that, permanently destroying the pilot's Alps selection. Hidden
    # from the new picker; media is shared, so publishing it costs only the pack's JSON files.
    # Retire once pre-split shells have died out.
    {"id": "alps", "names": {"en": "Alps", "fr": "Alpes", "de": "Alpen"}, "geofence": "alps", "hidden": True},
)

# Every country a build must pull so the packs above can be sliced from one merged field set.
BUILD_COUNTRIES: tuple[str, ...] = ("FR", "CH", "DE", "IT", "AT", "ES")


def field_in_pack(field: dict[str, Any], pack: dict[str, Any]) -> bool:
    """True when `field` belongs in `pack` per that pack's selector."""
    countries = pack.get("countries")
    if countries:
        return str(field.get("country") or "").upper() in {c.upper() for c in countries}
    geofence = pack.get("geofence")
    if geofence == "alps":
        return in_alps(field)
    if geofence == "alps-west":
        return in_alps_band(field, max_lon=ALPS_WEST_MAX_LON)
    if geofence == "alps-east":
        return in_alps_band(field, min_lon=ALPS_EAST_MIN_LON)
    if geofence == "pyrenees":
        return in_pyrenees(field)
    return False


def select_pack_fields(fields: Iterable[dict[str, Any]], pack: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the subset of `fields` that belongs in `pack`."""
    return [f for f in fields if field_in_pack(f, pack)]
