#!/usr/bin/env python3
"""Tests for the Italian chart import: pre-fetched directory resolution/fingerprint and the
local attach importer (the authenticated ENAV fetch itself runs in a separate CI step)."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_pack  # noqa: E402


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

    def test_state_includes_it_fingerprint(self):
        state = build_pack.build_source_state(
            cupx="c", vac="2026-07-09", vac_it="2026-07-09:abcd", streckenflug="s")
        self.assertEqual(state["vacIt"], "2026-07-09:abcd")
        self.assertTrue(build_pack.source_states_match(state, dict(state)))
        self.assertFalse(build_pack.source_states_match(state, dict(state, vacIt="2026-08-06:ffff")))
        # A pre-Italy published state (no vacIt key) must still match while imports stay disabled.
        old = {k: v for k, v in state.items() if k != "vacIt"}
        self.assertTrue(build_pack.source_states_match(old, dict(state, vacIt="")))


if __name__ == "__main__":
    unittest.main(verbosity=1)
