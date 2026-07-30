#!/usr/bin/env python3
"""Tests for the run-label reader and the white-arrow family it unlocks.

No API calls: the model's job is reading text, and its answers are archived as data, so
everything downstream of that is testable offline — which is the point of the split.

    python3 scripts/test_field_views_labels.py
"""
import sys
import unittest
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts/field_views_lab"))

import read_labels  # noqa: E402
import white_arrows as wa  # noqa: E402

PHOTOS = ROOT / "data/sources/field-views/guide-photos"
LUS = PHOTOS / "515_lus_la_croix_haute_2.jpg"

# What 515 Lus letters on its own photo. Two of its four runs are drawn in white, which
# no colour band can see; these are the labels that vouch for them.
LUS_LABELS = [
    {"text": "240 m 73.0", "length_m": 240, "bearing_deg": 73.0, "arrow": "white"},
    {"text": "300 m 0.0", "length_m": 300, "bearing_deg": 0.0, "arrow": "red"},
    {"text": "275 m 15.2", "length_m": 275, "bearing_deg": 15.2, "arrow": "red"},
    {"text": "300 m 68.0", "length_m": 300, "bearing_deg": 68.0, "arrow": "white"},
]


def bearing(axis):
    import math
    a, b = axis
    return math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1]))) % 360


class TestReplyParsing(unittest.TestCase):
    def test_bare_json(self):
        got = read_labels._extract_json('{"labels": []}')
        self.assertEqual(got, {"labels": []})

    def test_fenced_json(self):
        got = read_labels._extract_json('```json\n{"labels": [1]}\n```')
        self.assertEqual(got, {"labels": [1]})

    def test_prose_around_json_still_parses(self):
        got = read_labels._extract_json('Here you go:\n{"labels": []}\nhope that helps')
        self.assertEqual(got, {"labels": []})

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            read_labels._extract_json("I could not read the image")


class TestCleaning(unittest.TestCase):
    """A misread must be dropped, not drawn on a chart a pilot flies with."""

    def test_keeps_a_normal_run(self):
        got = read_labels._clean([{"length_m": 240, "bearing_deg": 73.0, "arrow": "white"}])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["length_m"], 240)

    def test_drops_absurd_lengths(self):
        for bad in (0, 12, 9000):
            self.assertEqual(read_labels._clean(
                [{"length_m": bad, "bearing_deg": 10}]), [])

    def test_drops_malformed_entries(self):
        self.assertEqual(read_labels._clean([{"bearing_deg": 10}]), [])
        self.assertEqual(read_labels._clean([{"length_m": "long", "bearing_deg": 10}]), [])
        self.assertEqual(read_labels._clean("not a list"), [])

    def test_normalises_bearing_into_range(self):
        got = read_labels._clean([{"length_m": 300, "bearing_deg": 375.0}])
        self.assertEqual(got[0]["bearing_deg"], 15.0)


@unittest.skipUnless(LUS.exists(), "guide photo corpus not present")
class TestWhiteArrows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.img = cv2.imread(str(LUS))

    def test_lettered_white_runs_are_found_and_oriented(self):
        got = wa.arrows_from_labels(self.img, LUS_LABELS)
        self.assertEqual(len(got), 2)
        bearings = sorted(bearing(a) for a in got)
        # the guide letters 68.0 and 73.0; the locator is good to about a degree
        self.assertAlmostEqual(bearings[0], 68.0, delta=3.0)
        self.assertAlmostEqual(bearings[1], 73.0, delta=3.0)

    def test_a_bar_without_a_label_is_a_road(self):
        """The safety property. Pale bars exist in these photos; unlettered, none ships."""
        for name in ("613_taninges_1.jpg", "524_pellafol_1.jpg", "611_megevette_1.jpg"):
            img = cv2.imread(str(PHOTOS / name))
            if img is None:
                continue
            self.assertGreater(len(wa.white_bars(img)), 0, f"{name} should have pale bars")
            self.assertEqual(wa.arrows_from_labels(img, LUS_LABELS[1:3]), [],
                             f"{name} emitted a run with no white label")

    def test_no_labels_at_all_emits_nothing(self):
        self.assertEqual(wa.arrows_from_labels(self.img, []), [])
        self.assertEqual(wa.arrows_from_labels(self.img, None), [])

    def test_a_label_with_no_matching_bar_invents_nothing(self):
        odd = [{"length_m": 300, "bearing_deg": 137.0, "arrow": "white"}]
        self.assertEqual(wa.arrows_from_labels(self.img, odd), [])

    def test_one_bar_is_not_claimed_by_two_labels(self):
        """Cleaning drops the duplicate reading, so it cannot promote a second bar."""
        twice = read_labels._clean([dict(LUS_LABELS[0]), dict(LUS_LABELS[0])])
        self.assertEqual(len(twice), 1)
        self.assertEqual(len(wa.arrows_from_labels(self.img, twice)), 1)

    def test_close_bearings_take_the_nearer_bar_each(self):
        """68 and 73 are each inside the other's tolerance; both must land correctly."""
        got = wa.arrows_from_labels(self.img, [LUS_LABELS[0], LUS_LABELS[3]])
        self.assertEqual(len(got), 2)
        for axis, want in zip(sorted(got, key=bearing), (68.0, 73.0)):
            self.assertAlmostEqual(bearing(axis), want, delta=3.0)

    def test_label_bearing_decides_direction(self):
        """A bar is an undirected line; 73 and 253 are the same pixels."""
        fwd = wa.arrows_from_labels(self.img, [LUS_LABELS[0]])
        rev = wa.arrows_from_labels(
            self.img, [{"length_m": 240, "bearing_deg": 253.0, "arrow": "white"}])
        self.assertEqual(len(fwd), 1)
        self.assertEqual(len(rev), 1)
        self.assertAlmostEqual(abs((bearing(fwd[0]) - bearing(rev[0]) + 180) % 360 - 180),
                               180.0, delta=6.0)


class TestCacheContract(unittest.TestCase):
    def test_missing_cache_returns_none_not_empty(self):
        """None means 'never read'; [] would mean 'read, and there are no runs'."""
        self.assertIsNone(read_labels.load("this_photo_does_not_exist.jpg"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
