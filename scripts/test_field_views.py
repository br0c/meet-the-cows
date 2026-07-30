#!/usr/bin/env python3
"""Offline tests for the multi-provider imagery machinery in field_views.py: the UTM and
mercator math, WMS parameter building across versions and CRSs, provider routing by bbox, the
blank-coverage detector and ortho_crop's fall-through. Network access is stubbed throughout —
the live services get exercised by the lab's verification runs, not by CI."""
from __future__ import annotations

import io
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import field_views as fv  # noqa: E402


def jpeg_bytes(color=(120, 90, 60), noise=False, size=(64, 64)):
    from PIL import Image
    img = Image.new("RGB", size, color)
    if noise:
        px = img.load()
        for i in range(0, size[0], 2):
            for j in range(0, size[1], 3):
                px[i, j] = ((i * 37) % 255, (j * 53) % 255, ((i + j) * 11) % 255)
    out = io.BytesIO()
    img.save(out, "JPEG")
    return out.getvalue()


class TestUtm(unittest.TestCase):
    def test_central_meridian_identities(self):
        # On the central meridian at the equator, UTM is (500000, 0) by construction.
        for epsg, cm in ((25832, 9.0), (25833, 15.0), (32632, 9.0)):
            e, n = fv.utm_from_wgs84(0.0, cm, epsg)
            self.assertAlmostEqual(e, 500000.0, delta=0.01)
            self.assertAlmostEqual(n, 0.0, delta=0.01)

    def test_meridian_arc_scale(self):
        # One degree of latitude up the central meridian is the meridian arc times k0.
        _, n = fv.utm_from_wgs84(1.0, 9.0, 25832)
        self.assertAlmostEqual(n, 110574.39 * 0.9996, delta=5)

    def test_east_west_symmetry(self):
        e_east, n_east = fv.utm_from_wgs84(50.0, 10.0, 25832)
        e_west, n_west = fv.utm_from_wgs84(50.0, 8.0, 25832)
        self.assertAlmostEqual(e_east - 500000, 500000 - e_west, delta=0.01)
        self.assertAlmostEqual(n_east, n_west, delta=0.01)

    def test_erfurt_plausible(self):
        # Erfurt is ~2° east of zone 32's central meridian at 51°N: easting well above
        # 500 km, northing ~5.65 Mm. Coarse bounds, but they catch degree/radian slips
        # and zone-number arithmetic errors outright.
        e, n = fv.utm_from_wgs84(50.98, 11.03, 25832)
        self.assertTrue(630000 < e < 660000, e)
        self.assertTrue(5.60e6 < n < 5.70e6, n)


class TestWmsParams(unittest.TestCase):
    def test_v130_geographic_is_latlon(self):
        p = dict(url="u", layer="L")
        params = fv.wms_getmap_params(p, 48.0, 11.0, 1000, 1000)
        self.assertEqual(params["VERSION"], "1.3.0")
        self.assertIn("CRS", params)
        south, west, north, east = map(float, params["BBOX"].split(","))
        self.assertLess(south, north)
        self.assertLess(west, east)
        self.assertTrue(south < 48.0 < north and west < 11.0 < east)

    def test_v111_geographic_is_lonlat_and_srs(self):
        p = dict(url="u", layer="L", version="1.1.1")
        params = fv.wms_getmap_params(p, 48.0, 11.0, 1000, 1000)
        self.assertIn("SRS", params)
        self.assertNotIn("CRS", params)
        west, south, east, north = map(float, params["BBOX"].split(","))
        self.assertTrue(west < 11.0 < east and south < 48.0 < north)

    def test_projected_crs_boxes_in_metres(self):
        p = dict(url="u", layer="L", crs="EPSG:25832")
        params = fv.wms_getmap_params(p, 50.98, 11.03, 600, 800)
        e0, n0, e1, n1 = map(float, params["BBOX"].split(","))
        self.assertAlmostEqual(e1 - e0, 600, delta=0.01)
        self.assertAlmostEqual(n1 - n0, 800, delta=0.01)
        centre_e, centre_n = fv.utm_from_wgs84(50.98, 11.03, 25832)
        self.assertAlmostEqual((e0 + e1) / 2, centre_e, delta=0.01)
        self.assertAlmostEqual((n0 + n1) / 2, centre_n, delta=0.01)


class TestWmts(unittest.TestCase):
    def test_tile_indices_at_origin(self):
        self.assertEqual(fv.wmts_tile(0.0, 0.0, 1), (1, 1))
        self.assertEqual(fv.wmts_tile(0.1, -0.1, 1), (0, 0))

    def test_mercator_identities(self):
        x, y = fv.mercator_from_wgs84(0.0, 0.0)
        self.assertAlmostEqual(x, 0.0)
        self.assertAlmostEqual(y, 0.0)
        x, _ = fv.mercator_from_wgs84(0.0, 180.0)
        self.assertAlmostEqual(x, math.pi * 6378137.0, delta=1)


class TestRouting(unittest.TestCase):
    def test_munich_prefers_bayern(self):
        urls = [p["url"] for p in fv.providers_for("DE", 48.14, 11.58)]
        self.assertTrue(urls and "bayern" in urls[0])

    def test_erfurt_routes_to_thueringen_with_utm(self):
        cands = fv.providers_for("DE", 50.98, 11.03)
        self.assertTrue(any("geoportal-th" in p["url"] for p in cands))
        th = next(p for p in cands if "geoportal-th" in p["url"])
        self.assertEqual(th.get("crs"), "EPSG:25832")

    def test_overlap_yields_both_candidates(self):
        # The BW/Bayern bboxes overlap around 9-10.5°E: both must be candidates, in
        # table order, so the blank fall-through can settle which one actually covers it.
        urls = [p["url"] for p in fv.providers_for("DE", 48.5, 9.9)]
        self.assertTrue(any("bayern" in u for u in urls))
        self.assertTrue(any("lgl-bw" in u for u in urls))

    def test_venice_prefers_veneto_over_pcn(self):
        urls = [p["url"] for p in fv.providers_for("IT", 45.44, 12.34)]
        self.assertIn("veneto", urls[0])
        self.assertTrue(any("pcn" in u for u in urls[1:]), "PCN must remain the fallback")

    def test_rome_gets_only_pcn_zone33(self):
        cands = fv.providers_for("IT", 41.9, 12.5)
        self.assertEqual(len(cands), 1)
        self.assertIn("2012.33", cands[0]["layer"])
        self.assertEqual(cands[0].get("version"), "1.1.1")

    def test_france_still_leads_with_ign(self):
        # 44.5N 6.4E is French Alps, close enough to the border that the cross-border
        # fall-through offers an Italian service behind IGN. That is the point of it —
        # a field whose IGN tiles come back blank still gets imagery. What must not
        # change is the order: IGN is what France is served from.
        cands = fv.providers_for("FR", 44.5, 6.4)
        self.assertIn("geopf", cands[0]["url"])
        # and the fall-through really is border-specific: inland France gets IGN alone
        inland = fv.providers_for("FR", 47.0, 2.5)
        self.assertEqual([p["url"] for p in inland if "geopf" not in p["url"]], [])


class TestBlankDetection(unittest.TestCase):
    def test_flat_white_is_blank(self):
        self.assertTrue(fv.blankish(jpeg_bytes((255, 255, 255))))

    def test_flat_grey_is_blank(self):
        self.assertTrue(fv.blankish(jpeg_bytes((128, 128, 128))))

    def test_textured_image_is_not_blank(self):
        self.assertFalse(fv.blankish(jpeg_bytes(noise=True)))

    def test_undecodable_body_counts_as_blank(self):
        self.assertTrue(fv.blankish(b"<ServiceExceptionReport>boom</ServiceExceptionReport>"))


class TestOrthoCropFallback(unittest.TestCase):
    def setUp(self):
        self.real_get = fv.http_get

    def tearDown(self):
        fv.http_get = self.real_get

    def test_blank_first_candidate_falls_through(self):
        calls = []

        def fake(url, data=None, timeout=90):
            calls.append(url)
            return jpeg_bytes((255, 255, 255)) if "bayern" in url else jpeg_bytes(noise=True)

        fv.http_get = fake
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "c.jpg"
            # 48.5/9.9 sits in the BW/Bayern overlap; Bayern answers white, BW real.
            crop = fv.ortho_crop(48.5, 9.9, 600, out, "DE")
            self.assertTrue(out.stat().st_size > 0)
        self.assertIn("Baden-Württemberg", crop["attribution"])
        self.assertTrue(any("bayern" in u for u in calls), "first candidate was tried")

    def test_all_blank_raises(self):
        fv.http_get = lambda url, data=None, timeout=90: jpeg_bytes((255, 255, 255))
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                fv.ortho_crop(48.5, 9.9, 600, Path(tmp) / "c.jpg", "DE")

    def test_no_provider_for_point_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                # Sicily's west coast: outside every Italian bbox except PCN 33? Marsala
                # is lon 12.44 -> zone 33 covers it; use a point west of zone 32's bbox.
                fv.ortho_crop(41.9, 5.0, 600, Path(tmp) / "c.jpg", "IT")


class TestOsmPreference(unittest.TestCase):
    """Airfields are served from OSM, whatever a guide drew for them.

    The pack's own classifier only recognises French ICAO codes, so LIMW Aoste came
    through as an ordinary outlanding field and its guide page — a topographic map
    screenshot of the protected zone — was scanned for landing strips.
    """

    def test_foreign_icao_codes_prefer_osm(self):
        for code in ("LIMW", "LSGS", "LOWI", "LEZL", "EDDM", "LFLG"):
            self.assertTrue(fv.prefers_osm_view({"code": code}), code)

    def test_kind_airfield_prefers_osm(self):
        self.assertTrue(fv.prefers_osm_view({"kind": "airfield", "code": "331"}))

    def test_outlanding_fields_keep_their_drawings(self):
        for code in ("320", "331", "Ste-Jalle_2", "", None):
            self.assertFalse(fv.prefers_osm_view({"code": code}), repr(code))

    def test_synthetic_codes_are_not_icao(self):
        # build_pack mints codes like IT_ANDREA_BOZZO_...; they must not read as ICAO.
        self.assertFalse(fv.prefers_osm_view({"code": "LIXX", "syntheticCode": True}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
