#!/usr/bin/env python3
"""Tests for the Spanish chart import: AIP index resolution, chart selection from the index,
and the attach importer. Network access is stubbed — the live ENAIRE fetch runs only in CI."""
from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402


def make_field(code: str, **extra) -> dict:
    field = {"id": f"es_{code.lower()}", "code": code, "kind": "airfield", "country": "ES", "media": []}
    field.update(extra)
    return field


def make_pdf(pages: int = 1) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    imgs = [Image.new("RGB", (50, 70), (10, 20, 30)) for _ in range(pages)]
    imgs[0].save(buf, "PDF", save_all=True, append_images=imgs[1:])
    return buf.getvalue()


# Shaped like the real AIP index: both language editions, visual and non-visual charts, the
# repeatable numeric suffix LEHC publishes, and the auto-generated effective-date header.
INDEX_HTML = """
<div id="actualizado">09-JUL-26 (Incorporados AIRAC 06/26 and AMDT 408/26)</div>
<a href="contenido_AIP/AD/AD2/LESU/LE_AD_2_LESU_VAC_1_en.pdf">VAC 1</a>
<a href="contenido_AIP/AD/AD2/LESU/LE_AD_2_LESU_VAC_2_en.pdf">VAC 2</a>
<a href="contenido_AIP/AD/AD2/LESU/LE_AD_2_LESU_ADC_1_en.pdf">ADC 1</a>
<a href="contenido_AIP/AD/AD2/LESU/LE_AD_2_LESU_IAC_1_en.pdf">IAC 1</a>
<a href="contenido_AIP/AD/AD2/LESU/LE_AD_2_LESU_AOC_1_en.pdf">AOC 1</a>
<a href="contenido_AIP/AD/AD2/LESU/LE_AD_2_LESU_SID_1_en.pdf">SID 1</a>
<a href="contenido_AIP/AD/AD2/LEHC/LE_AD_2_LEHC_ADC_1_3_en.pdf">ADC 1-3</a>
<a href="contenido_AIP/AD/AD2/LEHC/LE_AD_2_LEHC_ADC_1_1_en.pdf">ADC 1-1</a>
<a href="contenido_AIP/AD/AD2/LEHC/LE_AD_2_LEHC_VAC_1_es.pdf">VAC 1 es</a>
<a href="contenido_AIP/AD/AD2/LEHC/LE_AD_2_LEHC_VAC_1_en.pdf">VAC 1 en</a>
<a href="contenido_AIP/AD/AD2/GCGM/LE_AD_2_GCGM_VAC_1_en.pdf">Canaries VAC</a>
"""


class TestCycleDate(unittest.TestCase):
    def test_reads_effective_date(self):
        self.assertEqual(build_pack.es_cycle_date(INDEX_HTML), "2026-07-09")

    def test_missing_or_unparsable_header(self):
        self.assertEqual(build_pack.es_cycle_date("<div>no date here</div>"), "")
        self.assertEqual(build_pack.es_cycle_date("09-XXX-26 (Incorporados AIRAC 06/26)"), "")


class TestResolveRoot(unittest.TestCase):
    def test_disabled(self):
        self.assertEqual(build_pack.resolve_es_vac_root(""), ("", ""))
        self.assertEqual(build_pack.resolve_es_vac_root("none"), ("", ""))

    def test_auto_resolves_index_and_date(self):
        original = build_pack._fetch_es_vac
        build_pack._fetch_es_vac = lambda url, cache_dir=None: INDEX_HTML.encode()
        try:
            url, date = build_pack.resolve_es_vac_root("auto")
        finally:
            build_pack._fetch_es_vac = original
        self.assertEqual(url, build_pack.ES_AIP_INDEX)
        self.assertEqual(date, "2026-07-09")

    def test_source_outage_disables_spanish_charts_without_failing(self):
        original = build_pack._fetch_es_vac

        def boom(url, cache_dir=None):
            raise RuntimeError("502")

        build_pack._fetch_es_vac = boom
        try:
            self.assertEqual(build_pack.resolve_es_vac_root("auto"), ("", ""))
        finally:
            build_pack._fetch_es_vac = original


class TestChartSelection(unittest.TestCase):
    def setUp(self):
        self.charts = build_pack.parse_es_chart_index(INDEX_HTML, build_pack.ES_AIP_INDEX)

    def test_only_visual_charts_are_selected(self):
        joined = " ".join(self.charts["LESU"])
        self.assertIn("VAC_1", joined)
        self.assertIn("ADC_1", joined)
        for excluded in ("IAC", "AOC", "SID"):
            self.assertNotIn(excluded, joined, f"{excluded} is not a visual chart")

    def test_vac_precedes_adc_and_numbers_are_ordered(self):
        names = [u.rsplit("/", 1)[-1] for u in self.charts["LESU"]]
        self.assertEqual(names, ["LE_AD_2_LESU_VAC_1_en.pdf",
                                 "LE_AD_2_LESU_VAC_2_en.pdf",
                                 "LE_AD_2_LESU_ADC_1_en.pdf"])

    def test_repeatable_suffix_sorts_numerically(self):
        names = [u.rsplit("/", 1)[-1] for u in self.charts["LEHC"]]
        self.assertEqual(names, ["LE_AD_2_LEHC_VAC_1_en.pdf",
                                 "LE_AD_2_LEHC_ADC_1_1_en.pdf",
                                 "LE_AD_2_LEHC_ADC_1_3_en.pdf"])

    def test_english_edition_wins_over_spanish(self):
        self.assertTrue(all(u.endswith("_en.pdf") for u in self.charts["LEHC"]))

    def test_canary_aerodrome_keeps_its_published_le_prefix(self):
        # ENAIRE files GC**/GE** aerodromes under LE_AD_2_ too; rebuilding the path from the
        # ICAO code instead of using the published href 404s on every Canary chart.
        self.assertEqual([u.rsplit("/", 1)[-1] for u in self.charts["GCGM"]],
                         ["LE_AD_2_GCGM_VAC_1_en.pdf"])

    def test_urls_are_absolute(self):
        self.assertTrue(all(u.startswith("https://aip.enaire.es/AIP/")
                            for urls in self.charts.values() for u in urls))


class TestImport(unittest.TestCase):
    def setUp(self):
        self.original = build_pack._fetch_es_vac
        self.fetched: list[str] = []

        def fake(url, cache_dir=None):
            self.fetched.append(url)
            return INDEX_HTML.encode() if url.endswith(".html") else make_pdf()

        build_pack._fetch_es_vac = fake

    def tearDown(self):
        build_pack._fetch_es_vac = self.original

    def run_import(self, fields, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp)
            count = build_pack.import_es_chart_pdfs(
                fields=fields, index_url=build_pack.ES_AIP_INDEX, docs_dir=docs,
                es_vac_date="2026-07-09", max_vac=0, **kwargs)
            return count, sorted(p.name for p in docs.glob("*.pdf"))

    def test_attaches_chart_and_stamps_enaire_rights(self):
        fields = [make_field("LESU")]
        count, written = self.run_import(fields)
        self.assertEqual(count, 1)
        self.assertEqual(written, ["LESU.pdf"])
        media = fields[0]["media"][0]
        self.assertEqual(media["url"], "docs/vac/LESU.pdf")
        self.assertEqual(media["updatedAt"], "2026-07-09")
        self.assertIn("ENAIRE", media["source"])
        self.assertEqual(fields[0]["docs"]["vac"], "docs/vac/LESU.pdf")

    def test_multi_chart_aerodrome_merges_every_page(self):
        fields = [make_field("LESU")]
        with tempfile.TemporaryDirectory() as tmp:
            build_pack.import_es_chart_pdfs(
                fields=fields, index_url=build_pack.ES_AIP_INDEX, docs_dir=Path(tmp),
                es_vac_date="2026-07-09", max_vac=0)
            from pypdf import PdfReader
            pages = len(PdfReader(str(Path(tmp) / "LESU.pdf")).pages)
        self.assertEqual(pages, 3, "LESU publishes VAC 1, VAC 2 and ADC 1")

    def test_non_spanish_and_major_airports_are_skipped(self):
        fields = [make_field("LIPB"), make_field("LFXX"),
                  make_field("LESU", lengthM=3000, kind="airfield", name="MAJOR")]
        fields[2]["rawDifficulty"] = "aerodrome"
        original_is_major = build_pack.is_major_airport
        build_pack.is_major_airport = lambda f: f.get("name") == "MAJOR"
        try:
            count, written = self.run_import(fields)
        finally:
            build_pack.is_major_airport = original_is_major
        self.assertEqual((count, written), (0, []))

    def test_idempotent_second_pass_attaches_nothing_new(self):
        fields = [make_field("LESU")]
        self.run_import(fields)
        media_after_first = len(fields[0]["media"])
        self.run_import(fields)
        self.assertEqual(len(fields[0]["media"]), media_after_first)

    def test_restrict_codes_scopes_a_second_pass(self):
        fields = [make_field("LESU"), make_field("LEHC")]
        count, written = self.run_import(fields, restrict_codes={"LEHC"})
        self.assertEqual((count, written), (1, ["LEHC.pdf"]))

    def test_index_outage_returns_zero_without_raising(self):
        def boom(url, cache_dir=None):
            raise RuntimeError("503")

        build_pack._fetch_es_vac = boom
        fields = [make_field("LESU")]
        count, written = self.run_import(fields)
        self.assertEqual((count, written), (0, []))
        self.assertEqual(fields[0]["media"], [])


class TestSourceState(unittest.TestCase):
    def test_spanish_cycle_is_part_of_the_fingerprint(self):
        base = build_pack.build_source_state(cupx="c", vac="v", vac_es="2026-07-09")
        rolled = build_pack.build_source_state(cupx="c", vac="v", vac_es="2026-08-06")
        self.assertEqual(base["vacEs"], "2026-07-09")
        self.assertNotEqual(base, rolled, "an AIRAC roll must trigger a rebuild")


if __name__ == "__main__":
    unittest.main(verbosity=2)
