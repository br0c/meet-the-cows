#!/usr/bin/env python3
"""Tests for the Italian chart import: pre-fetched directory resolution/fingerprint, the
local attach importer, and the pure helpers of the authenticated ENAV fetcher (whose network
side runs only in CI)."""
from __future__ import annotations

import datetime as dt
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402
import fetch_enav_charts  # noqa: E402


def make_field(code: str, **extra) -> dict:
    field = {"id": f"it_{code.lower()}", "code": code, "kind": "airfield", "country": "IT", "media": []}
    field.update(extra)
    return field


def make_pdf(pages: int = 1) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    imgs = [Image.new("RGB", (50, 70), (10, 20, 30)) for _ in range(pages)]
    imgs[0].save(buf, "PDF", save_all=True, append_images=imgs[1:])
    return buf.getvalue()


class TestResolveDir(unittest.TestCase):
    def test_disabled_and_missing(self):
        self.assertEqual(build_pack.resolve_it_vac_dir(""), ("", "", ""))
        self.assertEqual(build_pack.resolve_it_vac_dir("none"), ("", "", ""))
        self.assertEqual(build_pack.resolve_it_vac_dir("/nonexistent/enav"), ("", "", ""))
        with tempfile.TemporaryDirectory() as tmp:  # exists but holds no PDFs
            self.assertEqual(build_pack.resolve_it_vac_dir(tmp), ("", "", ""))

    def test_resolves_cycle_date_and_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "LIPB.pdf").write_bytes(make_pdf())
            (Path(tmp) / "manifest.json").write_text(
                json.dumps({"cycle": "(A07-26)_2026_07_09", "cycleDate": "2026-07-09"}))
            charts_dir, date, fingerprint = build_pack.resolve_it_vac_dir(tmp)
            self.assertEqual(charts_dir, tmp)
            self.assertEqual(date, "2026-07-09")
            self.assertTrue(fingerprint.startswith("2026-07-09:"))

            # Same cycle but an extra chart appears -> the fingerprint must change so the
            # incremental build does not skip the rebuild.
            (Path(tmp) / "LILQ.pdf").write_bytes(make_pdf())
            _, _, fingerprint2 = build_pack.resolve_it_vac_dir(tmp)
            self.assertNotEqual(fingerprint, fingerprint2)

    def test_no_manifest_still_fingerprints(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "LIPB.pdf").write_bytes(make_pdf())
            charts_dir, date, fingerprint = build_pack.resolve_it_vac_dir(tmp)
            self.assertEqual(charts_dir, tmp)
            self.assertEqual(date, "")
            self.assertTrue(fingerprint)


class TestImport(unittest.TestCase):
    def test_attaches_wanted_non_major_fields_only(self):
        from pypdf import PdfReader
        fields = [
            make_field("LIPB"),                    # chart available -> attached
            make_field("LIMF", lengthM=3300.0),    # major airport -> excluded
            make_field("LILH"),                    # no chart in the directory -> untouched
        ]
        with tempfile.TemporaryDirectory() as tmp:
            charts = Path(tmp) / "enav"; charts.mkdir()
            (charts / "LIPB.pdf").write_bytes(make_pdf(2))
            (charts / "LIMF.pdf").write_bytes(make_pdf())
            (charts / "LIEE.pdf").write_bytes(make_pdf())  # not in the field set
            docs = Path(tmp) / "docs" / "vac"; docs.mkdir(parents=True)
            count = build_pack.import_it_chart_pdfs(
                fields=fields, charts_dir=str(charts), docs_dir=docs,
                it_vac_date="2026-07-09", max_vac=0)
            self.assertEqual(count, 1)
            self.assertEqual(sorted(p.name for p in docs.iterdir()), ["LIPB.pdf"])
            pdf = PdfReader(io.BytesIO((docs / "LIPB.pdf").read_bytes()))
            self.assertEqual(len(pdf.pages), 2)
        lipb = fields[0]
        self.assertEqual(lipb["media"][0]["caption"], "VAC LIPB")
        self.assertEqual(lipb["media"][0]["url"], "docs/vac/LIPB.pdf")
        self.assertEqual(lipb["media"][0]["updatedAt"], "2026-07-09")
        self.assertIn("ENAV", lipb["media"][0]["source"])
        self.assertEqual(lipb["docs"]["vac"], "docs/vac/LIPB.pdf")
        self.assertEqual(fields[1]["media"], [])  # major untouched
        self.assertEqual(fields[2]["media"], [])  # no chart -> untouched

    def test_second_pass_attaches_late_fields_only(self):
        # Streckenflug fields join the set after the concurrent chart imports ran — the second
        # pass must attach charts to those late fields without duplicating earlier attaches.
        fields = [make_field("LIPB")]
        with tempfile.TemporaryDirectory() as tmp:
            charts = Path(tmp) / "enav"; charts.mkdir()
            (charts / "LIPB.pdf").write_bytes(make_pdf())
            (charts / "LIDA.pdf").write_bytes(make_pdf())
            docs = Path(tmp) / "docs" / "vac"; docs.mkdir(parents=True)
            kwargs = dict(charts_dir=str(charts), docs_dir=docs, it_vac_date="", max_vac=0)
            self.assertEqual(build_pack.import_it_chart_pdfs(fields=fields, **kwargs), 1)
            fields.append(make_field("LIPB"))  # late twin of an already-attached code
            fields.append(make_field("LIDA"))  # genuinely new code
            self.assertEqual(build_pack.import_it_chart_pdfs(fields=fields, **kwargs), 2)
            for f in fields:
                self.assertEqual(len(f["media"]), 1, f["code"])  # attached exactly once each
            self.assertEqual(build_pack.import_it_chart_pdfs(fields=fields, **kwargs), 0)

    def test_state_includes_it_fingerprint(self):
        state = build_pack.build_source_state(
            cupx="c", vac="2026-07-09", vac_it="2026-07-09:abcd", streckenflug="s")
        self.assertEqual(state["vacIt"], "2026-07-09:abcd")
        self.assertTrue(build_pack.source_states_match(state, dict(state)))
        self.assertFalse(build_pack.source_states_match(state, dict(state, vacIt="2026-08-06:ffff")))
        # A pre-Italy published state (no vacIt key) must still match while imports stay disabled.
        old = {k: v for k, v in state.items() if k != "vacIt"}
        self.assertTrue(build_pack.source_states_match(old, dict(state, vacIt="")))


class TestFetchHelpers(unittest.TestCase):
    CYCLES = ["(A06-26)_2026_06_11", "(A07-26)_2026_07_09", "(A08-26)_2026_08_06"]

    def test_pick_cycle(self):
        self.assertEqual(fetch_enav_charts.pick_cycle(self.CYCLES, dt.date(2026, 7, 10)),
                         "(A07-26)_2026_07_09")
        self.assertEqual(fetch_enav_charts.pick_cycle(self.CYCLES, dt.date(2026, 9, 1)),
                         "(A08-26)_2026_08_06")
        # All future -> earliest, matching the Austrian behaviour.
        self.assertEqual(fetch_enav_charts.pick_cycle(self.CYCLES, dt.date(2026, 1, 1)),
                         "(A06-26)_2026_06_11")
        self.assertEqual(fetch_enav_charts.pick_cycle([], dt.date(2026, 7, 10)), "")

    def test_cycle_date(self):
        self.assertEqual(fetch_enav_charts.cycle_date("(A07-26)_2026_07_09"), "2026-07-09")

    def test_extract_ad2_pages_prefers_english(self):
        # LIDT uses the real menu quirk: uncertified aerodromes have a double space after AD 2.
        menu = ("<a href='LI-AD 2 LIPB - BOLZANO 1-it-IT.html#AD-2-LIPB---BOLZANO-1'>x</a>"
                "<a href='LI-AD 2 LIPB - BOLZANO 1-en-GB.html#AD-2-LIPB---BOLZANO-1'>x</a>"
                "<a href='LI-AD 2  LIDT - TRENTO Mattarello 1-it-IT.html#AD-2--LIDT'>x</a>"
                "<a href='noContent.html' onclick=\"setNoContentLabel('AD 2 LIDR - RAVENNA 8 ')\">nil</a>"
                "<a href='LI-AD 1.5 Status-en-GB.html#AD-15'>not an aerodrome</a>")
        pages = fetch_enav_charts.extract_ad2_pages(menu)
        self.assertEqual(sorted(pages), ["LIDT", "LIPB"])
        self.assertEqual(pages["LIPB"], "LI-AD 2 LIPB - BOLZANO 1-en-GB.html")
        self.assertEqual(pages["LIDT"], "LI-AD 2  LIDT - TRENTO Mattarello 1-it-IT.html")

    def test_select_visual_charts(self):
        base = "https://x/AIP/(A07-26)_2026_07_09/documents/Root/ENAV/Cartografia/AD/AD_2"
        urls = [
            f"{base}/AD_2_PRINCIPALI/LIBF/2-1/AERODROME%20CHART%20ICAO.pdf",
            f"{base}/AD_2_PRINCIPALI/LIBF/5-1/VISUAL%20APPROACH%20CHART.pdf",
            f"{base}/AD_2_PRINCIPALI/LIBF/6-1/SID%20RWY%2033.pdf",              # instrument
            f"{base}/AD_2_SECONDARI/LILB/2-1/AERODROME%20LANDING%20CHART.pdf",  # secondari VAC
            f"{base}/AD_2_PRINCIPALI/LIPB/3-1/AERODROME%20OBSTACLE%20CHART%20-%20TYPE%20B%20ICAO.pdf",
            f"{base}/AD_2_MINORI/LIDT/2-1/CARTA%20DI%20AVVICINAMENTO%20A%20VISTA%20(VAC).pdf",
        ]
        selected = fetch_enav_charts.select_visual_charts(urls)
        self.assertEqual(len(selected), 4)  # SID + obstacle excluded
        self.assertNotIn(urls[2], selected)
        self.assertNotIn(urls[4], selected)
        self.assertIn(urls[3], selected)

    def test_charts_up_to_date_requires_fetcher_version(self):
        cycle = "(A07-26)_2026_07_09"
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "LILB.pdf").write_bytes(make_pdf())
            manifest = {"cycle": cycle, "fetcherVersion": fetch_enav_charts.FETCHER_VERSION,
                        "charts": {"LILB": ["AERODROME LANDING CHART.pdf"]}}
            (out / "manifest.json").write_text(json.dumps(manifest))
            self.assertTrue(fetch_enav_charts.charts_up_to_date(out, cycle))
            self.assertFalse(fetch_enav_charts.charts_up_to_date(out, "(A08-26)_2026_08_06"))
            manifest["fetcherVersion"] = fetch_enav_charts.FETCHER_VERSION - 1
            (out / "manifest.json").write_text(json.dumps(manifest))
            self.assertFalse(fetch_enav_charts.charts_up_to_date(out, cycle))


if __name__ == "__main__":
    unittest.main(verbosity=1)
