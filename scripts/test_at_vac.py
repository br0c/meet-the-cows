#!/usr/bin/env python3
"""Tests for the Austrian chart import: cycle selection, complete-AIP ZIP resolution from the
AIM page, and the chart merge/attach import."""
from __future__ import annotations

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402


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

    def test_explicit_zip_url(self):
        url, date = build_pack.resolve_at_chart_zip("https://x/AIP_AUSTRIA_260709_y.zip")
        self.assertEqual(url, "https://x/AIP_AUSTRIA_260709_y.zip")
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

    def test_download_retries_then_succeeds(self):
        # A mid-stream drop on the first attempt must be retried, not fatal, and the partial
        # file from the failed attempt must be cleaned up before the retry writes the good one.
        import http.client
        import urllib.request

        original_sleep = build_pack.time.sleep
        orig_urlopen = urllib.request.urlopen
        build_pack.time.sleep = lambda *_: None
        attempt = {"n": 0}

        class FakeResp:
            """First attempt drops mid-read; second streams one chunk then EOF (empty read)."""
            def __init__(self, fail):
                self.fail, self.sent = fail, False
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=-1):
                if self.fail:
                    raise http.client.IncompleteRead(b"partial")
                if self.sent:
                    return b""
                self.sent = True
                return b"complete-zip-bytes"

        def fake_urlopen(request, timeout=0):
            attempt["n"] += 1
            return FakeResp(fail=(attempt["n"] == 1))

        try:
            with tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / "aip.zip"
                target.write_bytes(b"stale-partial")  # must be cleaned up after the failed attempt
                urllib.request.urlopen = fake_urlopen
                build_pack._download_at_zip("https://x/aip.zip", target, attempts=3)
                self.assertEqual(attempt["n"], 2)                       # retried exactly once
                self.assertEqual(target.read_bytes(), b"complete-zip-bytes")
        finally:
            build_pack.time.sleep = original_sleep
            urllib.request.urlopen = orig_urlopen

    def test_import_soft_fails_when_download_gives_up(self):
        # Austro Control outage: the importer degrades to zero charts, never raising.
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"; raw.mkdir()
            docs = Path(tmp) / "docs" / "vac"; docs.mkdir(parents=True)
            fields = [make_field("LOWI")]

            def boom(url, target, **kwargs):
                raise OSError("connection reset")
            build_pack._download_at_zip = boom
            count = build_pack.import_at_chart_pdfs(
                fields=fields, zip_url="https://x/zip", docs_dir=docs,
                at_vac_date="2026-07-09", raw_dir=raw, max_vac=0)
            self.assertEqual(count, 0)
            self.assertEqual(fields[0]["media"], [])  # no charts, but the build goes on

    def test_state_includes_at_cycle(self):
        state = build_pack.build_source_state(cupx="c", vac="2026-07-09", vac_at="2026-07-01", streckenflug="s")
        self.assertEqual(state["vacAt"], "2026-07-01")
        self.assertTrue(build_pack.source_states_match(state, dict(state)))
        self.assertFalse(build_pack.source_states_match(state, dict(state, vacAt="2026-08-06")))


if __name__ == "__main__":
    unittest.main(verbosity=1)
