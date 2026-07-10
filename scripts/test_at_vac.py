#!/usr/bin/env python3
"""Tests for the Austro Control (AT) VAC import: cycle selection, AD 2 index parsing,
resolution fallbacks, and attach-only PDF import."""
from __future__ import annotations

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402

AD2_FIXTURE = """
<html><body>
<a href="PART_3/AD_2/PRI/AD_2_LOWI/LO_AD_2_LOWI_en.pdf">LOWI</a>
<a href="PART_3/AD_2/SRY/AD_2_LOAN/LO_AD_2_LOAN_en.pdf">LOAN</a>
<a href="PART_3/AD_2/SRY/AD_2_LOGO/LO_AD_2_LOGO_de.pdf">german-only kept as fallback</a>
<a href="PART_3/AD_2/SRY/AD_2_LOAN/LO_AD_2_LOAN_de.pdf">both editions: en preferred</a>
<a href="PART_3/AD_2/MIL/AD_2_LOXZ/LO_AD_2_LOXZ_en.pdf">LOXZ military</a>
<a href="css/aip.css">junk</a>
<a href="PART_3/AD_2/SRY/AD_2_ABCD/LO_AD_2_WXYZ_en.pdf">mismatched codes ignored</a>
</body></html>
"""

ROOT_FIXTURE = """
<a href="./lo/260709/index.htm">AIP</a>
<a href="./lo/260710/index.htm">AIP next</a>
<a href="./lo/260806/index.htm">AIP future</a>
"""


def make_field(code: str) -> dict:
    return {"id": f"at_{code.lower()}", "code": code, "kind": "airfield", "country": "AT", "media": []}


class TestCycleSelection(unittest.TestCase):
    def test_cycle_date(self):
        self.assertEqual(build_pack.at_cycle_date("260709"), "2026-07-09")

    def test_picks_latest_effective(self):
        today = dt.date(2026, 7, 15)
        self.assertEqual(build_pack.pick_at_cycle(["260709", "260710", "260806"], today), "260710")

    def test_all_future_falls_back_to_earliest(self):
        today = dt.date(2026, 7, 1)
        self.assertEqual(build_pack.pick_at_cycle(["260709", "260806"], today), "260709")

    def test_empty(self):
        self.assertEqual(build_pack.pick_at_cycle([], dt.date(2026, 7, 1)), "")


class TestAd2IndexParsing(unittest.TestCase):
    def test_parses_pri_and_sry_pdfs_preferring_english(self):
        index = build_pack.parse_at_ad2_index(AD2_FIXTURE, "https://eaip.example/lo/260709/")
        self.assertEqual(sorted(index), ["LOAN", "LOGO", "LOWI", "LOXZ"])
        self.assertEqual(index["LOWI"], "https://eaip.example/lo/260709/PART_3/AD_2/PRI/AD_2_LOWI/LO_AD_2_LOWI_en.pdf")
        # LOAN publishes both editions in the fixture: English must win.
        self.assertEqual(index["LOAN"], "https://eaip.example/lo/260709/PART_3/AD_2/SRY/AD_2_LOAN/LO_AD_2_LOAN_en.pdf")
        # LOGO is German-only: the German edition is the fallback.
        self.assertEqual(index["LOGO"], "https://eaip.example/lo/260709/PART_3/AD_2/SRY/AD_2_LOGO/LO_AD_2_LOGO_de.pdf")


class TestResolve(unittest.TestCase):
    def setUp(self):
        self._orig = build_pack._fetch_at_vac

    def tearDown(self):
        build_pack._fetch_at_vac = self._orig

    def test_auto_resolves_effective_cycle(self):
        def fake(url):
            if url == build_pack.AT_EAIP_ROOT:
                return ROOT_FIXTURE.encode("latin-1")
            self.assertIn("/lo/", url)
            self.assertTrue(url.endswith("ad_2.htm"))
            return AD2_FIXTURE.encode("latin-1")
        build_pack._fetch_at_vac = fake
        base, date, index = build_pack.resolve_at_vac_root("auto")
        self.assertTrue(base.startswith(build_pack.AT_EAIP_ROOT + "lo/26"))
        self.assertRegex(date, r"^2026-\d\d-\d\d$")
        self.assertIn("LOWI", index)

    def test_explicit_base(self):
        build_pack._fetch_at_vac = lambda url: AD2_FIXTURE.encode("latin-1")
        base, date, index = build_pack.resolve_at_vac_root("https://eaip.austrocontrol.at/lo/260709")
        self.assertEqual(base, "https://eaip.austrocontrol.at/lo/260709/")
        self.assertEqual(date, "2026-07-09")
        self.assertEqual(len(index), 4)

    def test_disabled(self):
        self.assertEqual(build_pack.resolve_at_vac_root("none"), ("", "", {}))
        self.assertEqual(build_pack.resolve_at_vac_root(""), ("", "", {}))

    def test_network_failure_is_soft(self):
        def boom(url):
            raise OSError("connection refused")
        build_pack._fetch_at_vac = boom
        self.assertEqual(build_pack.resolve_at_vac_root("auto"), ("", "", {}))


class TestImport(unittest.TestCase):
    def setUp(self):
        self._orig = build_pack._fetch_at_vac

    def tearDown(self):
        build_pack._fetch_at_vac = self._orig

    def test_attaches_to_matching_airfields_only(self):
        fields = [make_field("LOWI"), make_field("LOAN"), make_field("LOZZ"),  # LOZZ not in index
                  {"id": "fr_1", "code": "LFKR", "kind": "airfield", "country": "FR", "media": []}]
        fetched = []
        def fake(url):
            fetched.append(url)
            return b"%PDF-1.4 fake"
        build_pack._fetch_at_vac = fake
        index = {"LOWI": "https://x/LOWI.pdf", "LOAN": "https://x/LOAN.pdf", "LOAG": "https://x/LOAG.pdf"}
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp)
            count = build_pack.import_at_vac_pdfs(
                fields=fields, ad2_index=index, docs_dir=docs, at_vac_date="2026-07-09", max_vac=0)
            self.assertEqual(count, 2)  # LOWI + LOAN; LOAG has no field, LOZZ no chart
            self.assertEqual(sorted(fetched), ["https://x/LOAN.pdf", "https://x/LOWI.pdf"])
            aip = docs.parent / "aip"
            self.assertTrue((aip / "LOWI.pdf").exists() and (aip / "LOAN.pdf").exists())
        lowi = fields[0]
        self.assertEqual(lowi["media"][0]["type"], "pdf")
        self.assertEqual(lowi["media"][0]["url"], "docs/aip/LOWI.pdf")
        self.assertEqual(lowi["media"][0]["caption"], "AIP LOWI")
        self.assertEqual(lowi["media"][0]["updatedAt"], "2026-07-09")
        self.assertIn("Austro Control", lowi["media"][0]["source"])
        self.assertEqual(lowi["docs"]["aip"], "docs/aip/LOWI.pdf")
        self.assertEqual(fields[2]["media"], [])  # LOZZ untouched
        self.assertEqual(fields[3]["media"], [])  # FR field untouched

    def test_download_failure_skips_field(self):
        fields = [make_field("LOWI"), make_field("LOAN")]
        def flaky(url):
            if "LOWI" in url:
                raise OSError("boom")
            return b"%PDF ok"
        build_pack._fetch_at_vac = flaky
        with tempfile.TemporaryDirectory() as tmp:
            count = build_pack.import_at_vac_pdfs(
                fields=fields, ad2_index={"LOWI": "https://x/LOWI.pdf", "LOAN": "https://x/LOAN.pdf"},
                docs_dir=Path(tmp), at_vac_date="", max_vac=0)
        self.assertEqual(count, 1)
        self.assertEqual(fields[0]["media"], [])
        self.assertEqual(len(fields[1]["media"]), 1)
        self.assertNotIn("updatedAt", fields[1]["media"][0])

    def test_state_includes_at_cycle(self):
        state = build_pack.build_source_state(cupx="c", vac="2026-07-09", vac_at="2026-07-01", streckenflug="s")
        self.assertEqual(state["vacAt"], "2026-07-01")
        other = dict(state, vacAt="2026-08-06")
        self.assertTrue(build_pack.source_states_match(state, dict(state)))
        self.assertFalse(build_pack.source_states_match(state, other))




class TestChartZip(unittest.TestCase):
    AIM_HTML = ('<base href="/jart/prj3/ac/main.jart">'
                '<a href="data/dokumente/AIP_AUSTRIA_260709_2026-05-26_1.zip">ZIP-AIP</a>'
                '<a href="data/dokumente/AIP_AUSTRIA_260709_NO_CHARTS_2026-05-26_2.zip">no charts</a>'
                '<a href="data/dokumente/AIP_AUSTRIA_260806_2026-06-22_3.zip">future</a>')

    def setUp(self):
        self._fetch = build_pack._fetch_at_vac
        self._dl = build_pack._download_at_zip

    def tearDown(self):
        build_pack._fetch_at_vac = self._fetch
        build_pack._download_at_zip = self._dl

    def test_resolve_picks_effective_with_charts(self):
        build_pack._fetch_at_vac = lambda url: self.AIM_HTML.encode()
        url, date = build_pack.resolve_at_chart_zip("auto")
        self.assertEqual(url, "https://www.austrocontrol.at/jart/prj3/ac/data/dokumente/AIP_AUSTRIA_260709_2026-05-26_1.zip")
        self.assertEqual(date, "2026-07-09")

    def test_resolve_disabled_and_soft_fail(self):
        self.assertEqual(build_pack.resolve_at_chart_zip("none"), ("", ""))
        def boom(url):
            raise OSError("down")
        build_pack._fetch_at_vac = boom
        self.assertEqual(build_pack.resolve_at_chart_zip("auto"), ("", ""))

    def _fixture_zip(self, path):
        import io
        import zipfile
        from PIL import Image
        def pdf(pages=1):
            buf = io.BytesIO()
            imgs = [Image.new("RGB", (50, 70), (10, 20, 30)) for _ in range(pages)]
            imgs[0].save(buf, "PDF", save_all=True, append_images=imgs[1:])
            return buf.getvalue()
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("Charts/LOWI/LO_AD_2_LOWI_1-1_en.pdf", pdf())
            z.writestr("Charts/LOWI/LO_AD_2_LOWI_14-1_en.pdf", pdf(2))
            z.writestr("Charts/LOWI/LO_AD_2_LOWI_13-2-1_en.pdf", pdf())   # instrument: excluded
            z.writestr("Charts/SECONDARY_ LOAN/LO_AD_2_LOAN_14-2_de.pdf", pdf())  # de fallback
            z.writestr("Charts/SECONDARY_ LOAN/LO_AD_2_LOAN_14-2_en.pdf", pdf(3))  # en preferred
            z.writestr("PART_3/AD_2/SRY/AD_2_LOAN/LO_AD_2_LOAN_en.pdf", pdf())     # not a chart path

    def test_import_merges_selected_charts(self):
        import io
        from pypdf import PdfReader
        fields = [make_field("LOWI"), make_field("LOAN"), make_field("LOGK")]  # LOGK: no charts
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"; raw.mkdir()
            zip_path = raw / "at_aip_20260709.zip"
            self._fixture_zip(zip_path)  # pre-existing -> no download
            build_pack._download_at_zip = lambda url, target: (_ for _ in ()).throw(AssertionError("must not download"))
            docs = Path(tmp) / "docs" / "vac"; docs.mkdir(parents=True)
            count = build_pack.import_at_chart_pdfs(
                fields=fields, zip_url="https://x/zip", docs_dir=docs,
                at_vac_date="2026-07-09", raw_dir=raw, max_vac=0)
            self.assertEqual(count, 2)
            lowi_pdf = PdfReader(io.BytesIO((docs / "LOWI.pdf").read_bytes()))
            self.assertEqual(len(lowi_pdf.pages), 3)  # 1-1 (1p) + 14-1 (2p); 13-2-1 excluded
            loan_pdf = PdfReader(io.BytesIO((docs / "LOAN.pdf").read_bytes()))
            self.assertEqual(len(loan_pdf.pages), 3)  # en edition (3p), not the 1-page de
        lowi = fields[0]
        self.assertEqual(lowi["media"][0]["caption"], "VAC LOWI")
        self.assertEqual(lowi["media"][0]["url"], "docs/vac/LOWI.pdf")
        self.assertIn("CC BY 4.0", lowi["media"][0]["source"])
        self.assertEqual(lowi["docs"]["vac"], "docs/vac/LOWI.pdf")
        self.assertEqual(fields[2]["media"], [])  # LOGK untouched


if __name__ == "__main__":
    unittest.main(verbosity=1)
