"""Unit tests for pack selection and the Alps geofence (no network)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from packs import (  # noqa: E402
    ALPS_GEOFENCE,
    BUILD_COUNTRIES,
    PACK_DEFINITIONS,
    field_in_pack,
    in_alps,
    point_in_polygon,
    select_pack_fields,
)


def field(country, lat, lon, name="x"):
    return {"country": country, "latitude": lat, "longitude": lon, "name": name}


class GeofenceTests(unittest.TestCase):
    def test_points_inside_the_alps(self):
        inside = {
            "Innsbruck (AT)": (47.26, 11.39),
            "Chamonix (FR)": (45.92, 6.87),
            "Sion (CH)": (46.23, 7.36),
            "Bolzano (IT)": (46.50, 11.35),
            "Zell am See (AT)": (47.32, 12.80),
            "Briançon (FR)": (44.90, 6.63),
            "St-Auban (FR)": (44.06, 5.99),
            "Vinon (FR)": (43.74, 5.78),
            "Gap (FR)": (44.56, 6.08),
        }
        for label, (lat, lon) in inside.items():
            self.assertTrue(point_in_polygon(lat, lon, ALPS_GEOFENCE), f"{label} should be inside")

    def test_points_outside_the_alps(self):
        outside = {
            "Paris": (48.85, 2.35),
            "Marseille": (43.30, 5.37),
            "Munich": (48.14, 11.58),
            "Rome": (41.90, 12.50),
            "Berlin": (52.52, 13.40),
            "Zürich city": (47.38, 8.54),
        }
        for label, (lat, lon) in outside.items():
            self.assertFalse(point_in_polygon(lat, lon, ALPS_GEOFENCE), f"{label} should be outside")

    def test_in_alps_handles_missing_or_bad_coords(self):
        self.assertFalse(in_alps({"latitude": None, "longitude": 7.0}))
        self.assertFalse(in_alps({"latitude": "abc", "longitude": 7.0}))
        self.assertFalse(in_alps({}))


class RegistryTests(unittest.TestCase):
    def test_pack_ids_unique(self):
        ids = [p["id"] for p in PACK_DEFINITIONS]
        self.assertEqual(len(ids), len(set(ids)))

    def test_each_pack_has_exactly_one_selector(self):
        for p in PACK_DEFINITIONS:
            self.assertEqual(bool(p.get("countries")) ^ (p.get("geofence") is not None), True, p["id"])

    def test_country_selector_countries_are_built(self):
        built = {c.upper() for c in BUILD_COUNTRIES}
        for p in PACK_DEFINITIONS:
            for c in p.get("countries", ()):  # every country pack draws from the merged build set
                self.assertIn(c.upper(), built, f"{p['id']} needs {c} pulled by the build")


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.fields = [
            field("FR", 45.92, 6.87, "Chamonix"),      # FR + Alps
            field("FR", 47.32, -1.55, "Nantes"),        # FR only (Atlantic coast)
            field("CH", 46.23, 7.36, "Sion"),           # CH + Alps
            field("DE", 52.52, 13.40, "Berlin"),        # DE only
            field("DE", 47.48, 11.06, "Mittenwald"),    # DE + Alps
            field("AT", 47.26, 11.39, "Innsbruck"),     # AT + Alps
            field("IT", 45.46, 9.19, "Milano-ish"),     # IT (may be outside Alps)
        ]

    def test_country_pack_selects_by_country(self):
        fr = select_pack_fields(self.fields, {"id": "fr", "countries": ("FR",)})
        self.assertEqual({f["name"] for f in fr}, {"Chamonix", "Nantes"})

    def test_alps_pack_draws_from_all_countries(self):
        alps = select_pack_fields(self.fields, {"id": "alps", "geofence": "alps"})
        names = {f["name"] for f in alps}
        self.assertIn("Chamonix", names)
        self.assertIn("Sion", names)
        self.assertIn("Innsbruck", names)
        self.assertIn("Mittenwald", names)
        self.assertNotIn("Nantes", names)
        self.assertNotIn("Berlin", names)
        # Alps pack spans multiple countries
        self.assertGreaterEqual(len({field_in_pack.__self__ if False else self.country_of(n) for n in names}), 3)

    def country_of(self, name):
        return next(f["country"] for f in self.fields if f["name"] == name)

    def test_field_in_pack_unknown_selector_is_false(self):
        self.assertFalse(field_in_pack(self.fields[0], {"id": "bogus"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
