#!/usr/bin/env python3
"""Tests for the curated aerodrome operator-documents import (data/airfield-docs.json)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402


def make_field(code: str, country: str = "CH") -> dict:
    return {"id": f"x_{code.lower()}", "code": code, "kind": "airfield", "country": country, "media": []}


def write_docs(path: Path, documents) -> None:
    path.write_text(json.dumps({"documents": documents}), encoding="utf-8")


class TestLoad(unittest.TestCase):
    def test_missing_file(self):
        self.assertEqual(build_pack.load_airfield_docs(Path("/nonexistent/x.json")), ([], ""))

    def test_load_and_fingerprint_changes_with_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "docs.json"
            write_docs(p, [{"code": "LSZS", "url": "https://x/a.pdf"}])
            entries1, fp1 = build_pack.load_airfield_docs(p)
            self.assertEqual(len(entries1), 1)
            self.assertTrue(fp1)
            write_docs(p, [{"code": "LSZS", "url": "https://x/b.pdf"}])
            _, fp2 = build_pack.load_airfield_docs(p)
            self.assertNotEqual(fp1, fp2)

    def test_entries_without_code_or_url_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "docs.json"
            write_docs(p, [{"code": "LSZS"}, {"url": "https://x"}, {"code": "LSZF", "url": "https://x/f.pdf"}])
            entries, _ = build_pack.load_airfield_docs(p)
            self.assertEqual([e["code"] for e in entries], ["LSZF"])

    def test_broken_json_is_soft(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "docs.json"
            p.write_text("{not json", encoding="utf-8")
            self.assertEqual(build_pack.load_airfield_docs(p), ([], ""))


class TestImport(unittest.TestCase):
    def setUp(self):
        self._orig = build_pack._fetch_airfield_doc

    def tearDown(self):
        build_pack._fetch_airfield_doc = self._orig

    def test_attach_and_layout(self):
        fields = [make_field("LSZS"), make_field("LSZF")]
        build_pack._fetch_airfield_doc = lambda url: b"%PDF-1.7 fake"
        entries = [{"code": "LSZS", "url": "https://op/briefing.pdf", "caption": "Briefing Segelflug LSZS",
                    "source": "Engadin Airport (operator briefing)", "updatedAt": "2025-07"},
                   {"code": "LSXX", "url": "https://op/none.pdf"}]  # no matching airfield
        with tempfile.TemporaryDirectory() as tmp:
            docs_dir = Path(tmp) / "docs" / "vac"
            docs_dir.mkdir(parents=True)
            count = build_pack.import_airfield_docs(fields=fields, entries=entries, docs_dir=docs_dir, max_vac=0)
            self.assertEqual(count, 1)
            saved = list((Path(tmp) / "docs" / "briefing").glob("*.pdf"))
            self.assertEqual(len(saved), 1)
            self.assertTrue(saved[0].name.startswith("LSZS-"))
        media = fields[0]["media"][0]
        self.assertEqual(media["type"], "pdf")
        self.assertTrue(media["url"].startswith("docs/briefing/LSZS-"))
        self.assertEqual(media["caption"], "Briefing Segelflug LSZS")
        self.assertEqual(media["updatedAt"], "2025-07")
        self.assertIn("Engadin", media["source"])
        self.assertEqual(fields[0]["docs"]["briefing"], media["url"])
        self.assertEqual(fields[1]["media"], [])

    def test_non_pdf_and_errors_are_soft(self):
        fields = [make_field("LSZS"), make_field("LSZF")]
        def flaky(url):
            if "LSZS" in url:
                return b"<html>not a pdf</html>"
            raise OSError("timeout")
        build_pack._fetch_airfield_doc = flaky
        entries = [{"code": "LSZS", "url": "https://op/LSZS.pdf"}, {"code": "LSZF", "url": "https://op/LSZF.pdf"}]
        with tempfile.TemporaryDirectory() as tmp:
            docs_dir = Path(tmp) / "docs" / "vac"
            docs_dir.mkdir(parents=True)
            count = build_pack.import_airfield_docs(fields=fields, entries=entries, docs_dir=docs_dir, max_vac=0)
        self.assertEqual(count, 0)
        self.assertEqual(fields[0]["media"], [])
        self.assertEqual(fields[1]["media"], [])

    def test_fingerprint_key_in_state(self):
        state = build_pack.build_source_state(cupx="c", vac="v", streckenflug="s", airfield_docs="abc123")
        self.assertEqual(state["airfieldDocs"], "abc123")
        self.assertFalse(build_pack.source_states_match(state, dict(state, airfieldDocs="def456")))

    def test_repo_seed_file_is_valid(self):
        entries, fp = build_pack.load_airfield_docs(Path(__file__).parent.parent / "data" / "airfield-docs.json")
        self.assertTrue(fp)
        self.assertGreaterEqual(len(entries), 1)
        self.assertTrue(all(e["url"].startswith("https://") for e in entries))
        self.assertNotIn("ivao", json.dumps(entries).lower())  # simulator charts are banned


if __name__ == "__main__":
    unittest.main(verbosity=1)
