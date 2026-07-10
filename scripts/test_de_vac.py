#!/usr/bin/env python3
"""Tests for the DFS BasicVFR (DE) chart import: cycle date parsing, chapter crawl,
PNG-to-PDF assembly, and attach-only import (majors excluded)."""
from __future__ import annotations

import base64
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402

ROOT_HTML = b'<a href="ad.html">AD Flugpl\xc3\xa4tze AD Aerodromes &raquo;</a><a href="gen.html">GEN</a>'
AD_HTML = (b'<a href="ad2list.html">AD 2 Liste der Flugpl\xc3\xa4tze AD 2 List of Aerodromes &raquo;</a>'
           b'<a href="letterA.html">A A &raquo;</a>'
           b'<a href="letterKL.html">K-L K-L &raquo;</a>')
LETTER_A = b'<a href="aalen.html">Aalen-Heidenheim EDPA Aalen-Heidenheim EDPA &raquo;</a>'
LETTER_KL = b'<a href="kempten.html">Kempten-Durach EDMK Kempten-Durach EDMK &raquo;</a>'
KEMPTEN = (b'<a href="../pages/P1.html">EDMK Kempten-Durach 1 EDMK Kempten-Durach 1</a>'
           b'<a href="../pages/P2.html">EDMK Kempten-Durach 2 EDMK Kempten-Durach 2</a>'
           b'<a href="../pages/TXT.html">AD 2-55 AD 2-55</a>')
AALEN = b'<a href="../pages/PA.html">EDPA Aalen-Heidenheim 1 EDPA Aalen-Heidenheim 1</a>'


def tiny_png_page() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (87, 124), (200, 220, 255)).save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f'<img id="imgAIP" src="data:image/png;base64,{b64}"/>'.encode()


def make_router(pages: dict[str, bytes]):
    def fake(url, cache_dir=None):
        for key, body in pages.items():
            if url.endswith(key):
                return body, url
        raise OSError(f"no fixture for {url}")
    return fake


BASE = "https://aip.dfs.de/BasicVFR/2026JUN25/chapter/root.html"
FIXTURES = {
    "root.html": ROOT_HTML, "ad.html": AD_HTML,
    "letterA.html": LETTER_A, "letterKL.html": LETTER_KL,
    "kempten.html": KEMPTEN, "aalen.html": AALEN,
    "pages/P1.html": tiny_png_page(), "pages/P2.html": tiny_png_page(),
    "pages/PA.html": tiny_png_page(), "pages/TXT.html": b"<p>text page, no chart</p>",
}


def make_field(code: str) -> dict:
    return {"id": f"de_{code.lower()}", "code": code, "kind": "airfield", "country": "DE",
            "name": code, "media": []}


class TestCycleDate(unittest.TestCase):
    def test_parses_cycle_from_url(self):
        self.assertEqual(build_pack.de_cycle_date(BASE), "2026-06-25")

    def test_bad_url(self):
        self.assertEqual(build_pack.de_cycle_date("https://aip.dfs.de/whatever.html"), "")


class TestResolve(unittest.TestCase):
    def setUp(self):
        self._orig = build_pack._fetch_de_vac

    def tearDown(self):
        build_pack._fetch_de_vac = self._orig

    def test_auto_follows_redirect(self):
        build_pack._fetch_de_vac = lambda url: (b"", BASE)
        root, date = build_pack.resolve_de_vac_root("auto")
        self.assertEqual(root, BASE)
        self.assertEqual(date, "2026-06-25")

    def test_disabled_and_soft_failure(self):
        self.assertEqual(build_pack.resolve_de_vac_root("none"), ("", ""))
        def boom(url):
            raise OSError("down")
        build_pack._fetch_de_vac = boom
        self.assertEqual(build_pack.resolve_de_vac_root("auto"), ("", ""))


class TestCrawlAndImport(unittest.TestCase):
    def setUp(self):
        self._orig = build_pack._fetch_de_vac
        build_pack._fetch_de_vac = make_router(FIXTURES)

    def tearDown(self):
        build_pack._fetch_de_vac = self._orig

    def test_crawl_finds_wanted_chart_pages_only(self):
        pages = build_pack.crawl_de_chart_pages(BASE, {"EDMK"})
        self.assertEqual(sorted(pages), ["EDMK"])
        self.assertEqual(len(pages["EDMK"]), 2)  # the two chart sheets, not the AD 2-55 text page
        self.assertTrue(all("/pages/P" in u for u in pages["EDMK"]))

    def test_import_builds_pdf_and_attaches(self):
        fields = [make_field("EDMK"), make_field("EDPA"), make_field("EDZZ")]  # EDZZ has no folder
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp)
            count = build_pack.import_de_vac_pdfs(
                fields=fields, root_chapter_url=BASE, docs_dir=docs,
                de_vac_date="2026-06-25", max_vac=0)
            self.assertEqual(count, 2)
            pdf = (docs / "EDMK.pdf").read_bytes()
            self.assertTrue(pdf.startswith(b"%PDF"))
        edmk = fields[0]
        self.assertEqual(edmk["media"][0]["url"], "docs/vac/EDMK.pdf")
        self.assertEqual(edmk["media"][0]["caption"], "VAC EDMK")
        self.assertEqual(edmk["media"][0]["updatedAt"], "2026-06-25")
        self.assertIn("DFS", edmk["media"][0]["source"])
        self.assertEqual(edmk["docs"]["vac"], "docs/vac/EDMK.pdf")
        self.assertEqual(fields[2]["media"], [])

    def test_major_airports_are_not_crawled(self):
        munich = make_field("EDDM")
        munich["kind"] = "airfield"
        fields = [munich]
        if not build_pack.is_major_airport(munich):
            self.skipTest("EDDM not classified major by is_major_airport in this fixture shape")
        with tempfile.TemporaryDirectory() as tmp:
            count = build_pack.import_de_vac_pdfs(
                fields=fields, root_chapter_url=BASE, docs_dir=Path(tmp),
                de_vac_date="", max_vac=0)
        self.assertEqual(count, 0)
        self.assertEqual(munich["media"], [])

    def test_state_includes_de_cycle(self):
        state = build_pack.build_source_state(cupx="c", vac="v", vac_at="a", vac_de="2026-06-25", streckenflug="s")
        self.assertEqual(state["vacDe"], "2026-06-25")
        self.assertFalse(build_pack.source_states_match(state, dict(state, vacDe="2026-07-23")))
        self.assertTrue(build_pack.source_states_match(state, dict(state)))


class TestPdfAssembly(unittest.TestCase):
    def test_pages_without_images_return_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok = build_pack.de_pages_to_pdf([b"<p>nothing</p>"], Path(tmp) / "x.pdf")
        self.assertFalse(ok)

    def test_multi_page_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "m.pdf"
            ok = build_pack.de_pages_to_pdf([tiny_png_page(), tiny_png_page()], target)
            self.assertTrue(ok)
            data = target.read_bytes()
        self.assertTrue(data.startswith(b"%PDF"))
        self.assertGreaterEqual(data.count(b"/Type /Page"), 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
