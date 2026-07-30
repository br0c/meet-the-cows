#!/usr/bin/env python3
"""Tests for the automated review of generated views.

The point of the QA is to catch a render that looks fine and is drawn round the wrong
strip. These tests use the real candidate geometry at LSGS Sion, where that happened, and
pin both directions: the bug is flagged, and the fix is not.

    python3 scripts/test_field_views_qa.py
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts/field_views_lab"))

import field_views as fv  # noqa: E402
import qa_review  # noqa: E402

# The three ways OSM maps within 70 m of Sion's recorded coordinate, as fetched.
THRESHOLD_WAY = {"id": 1243727842,
                 "pts": [(46.21985, 7.32690), (46.22008, 7.32818)],
                 "tags": {"aeroway": "runway", "runway": "displaced_threshold",
                          "surface": "grass", "width": "30"}}
ASPHALT_WAY = {"id": 257612277,
               "pts": [(46.21706, 7.31386), (46.22400, 7.33580)],
               "tags": {"aeroway": "runway", "ref": "07/25", "surface": "asphalt",
                        "length": "2000"}}
GRASS_WAY = {"id": 1243727841,
             "pts": [(46.22006, 7.32473), (46.22183, 7.33130)],
             "tags": {"aeroway": "runway", "ref": "07L/25R", "surface": "grass",
                      "length": "660"}}

SION = {"id": "ch_78_lsgs_sion", "name": "#78 LSGS Sion", "kind": "airfield",
        "lat": 46.22, "lon": 7.3288833, "country": "CH"}


def geom(way):
    """The geometry the matcher would derive for this way at Sion."""
    return fv.runway_geometry(SION, way)


def cells(*ways):
    out = {}
    for w in ways:
        la, lo = w["pts"][0]
        out.setdefault((round(la, 1), round(lo, 1)), []).append(w)
    return out


class TestUnexplainedChoice(unittest.TestCase):
    def test_the_sion_bug_is_flagged(self):
        """Drawing a short marking rather than a runway must not pass review."""
        match = dict(SION, osm={"len": 98.5, "dist": 23.1})
        rival = qa_review.unexplained_choice(
            match, 600.0, cells(THRESHOLD_WAY, ASPHALT_WAY, GRASS_WAY))
        self.assertIsNotNone(rival, "a 98 m marking drawn for an airfield should flag")

    def test_the_deliberate_glider_strip_is_not_flagged(self):
        """The 560 m grass strip is chosen on purpose over the 1871 m asphalt."""
        grass = geom(GRASS_WAY)
        match = dict(SION, osm=grass)
        rival = qa_review.unexplained_choice(
            match, grass["len"] * 1.07, cells(THRESHOLD_WAY, ASPHALT_WAY, GRASS_WAY))
        self.assertIsNone(rival, "a shorter runway the stated length explains is correct")

    def test_a_lone_runway_is_never_flagged(self):
        match = dict(SION, osm=geom(GRASS_WAY))
        self.assertIsNone(qa_review.unexplained_choice(match, 600.0, cells(GRASS_WAY)))

    def test_threshold_markings_never_become_candidates(self):
        self.assertIsNone(geom(THRESHOLD_WAY))


class TestIndexChecks(unittest.TestCase):
    def run_check(self, index, inventory=None, matches=None, ways=None):
        findings = []
        qa_review.check(index, matches or [], ways or [], inventory or {}, findings)
        return {c for _, c, _, _ in findings}

    def test_failed_render_is_imagery(self):
        got = self.run_check({"x": {"ok": False, "name": "X", "note": "no provider"}})
        self.assertIn("imagery", got)

    def test_missing_length_is_geometry(self):
        got = self.run_check({"x": {"ok": True, "name": "X", "len": 0}})
        self.assertIn("geometry", got)

    def test_short_runway_for_an_airfield(self):
        got = self.run_check({"x": {"ok": True, "name": "X", "len": 98.5}},
                             inventory={"x": {"id": "x", "kind": "airfield"}})
        self.assertIn("short-runway", got)

    def test_a_normal_airfield_is_quiet(self):
        got = self.run_check({"x": {"ok": True, "name": "X", "len": 900.0}},
                             inventory={"x": {"id": "x", "kind": "airfield",
                                              "lengthM": 900.0}})
        self.assertEqual(got, set())

    def test_length_mismatch_is_reported_but_not_for_a_close_figure(self):
        near = self.run_check({"x": {"ok": True, "name": "X", "len": 560.0}},
                              inventory={"x": {"id": "x", "kind": "airfield",
                                               "lengthM": 600.0}})
        self.assertEqual(near, set())
        far = self.run_check({"x": {"ok": True, "name": "X", "len": 98.5}},
                             inventory={"x": {"id": "x", "kind": "outlanding",
                                              "lengthM": 600.0}})
        self.assertIn("length-mismatch", far)


if __name__ == "__main__":
    unittest.main(verbosity=2)
