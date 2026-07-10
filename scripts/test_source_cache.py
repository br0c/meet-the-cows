#!/usr/bin/env python3
"""Tests for the source-download cache (cached_http_get): the layer that stops a full rebuild
triggered by one changed source from re-fetching all the others. No real network."""
from __future__ import annotations

import io
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pack  # noqa: E402


class FakeResponse:
    def __init__(self, body: bytes, headers: dict | None = None, url: str = "https://x/"):
        self._buf = io.BytesIO(body)
        self.headers = headers or {}
        self.status = 200
        self._url = url

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n if n is not None and n >= 0 else None)

    def geturl(self) -> str:
        return self._url

    def __enter__(self): return self

    def __exit__(self, *exc): return False


class SourceCacheTests(unittest.TestCase):
    def setUp(self):
        self._urlopen = urllib.request.urlopen
        self.calls: list[dict] = []  # one entry per real network call

    def tearDown(self):
        urllib.request.urlopen = self._urlopen

    def install(self, responder):
        def fake(request, timeout=0):
            self.calls.append({"url": request.full_url, "headers": dict(request.headers)})
            return responder(request)
        urllib.request.urlopen = fake

    def test_versioned_reuse_makes_no_request_when_cached(self):
        self.install(lambda req: FakeResponse(b"AT-ZIP-v1", {"ETag": '"a"'}))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "at_aip_260709.zip"
            first = build_pack.cached_http_get("https://x/aip.zip", path, versioned=True)
            self.assertEqual(first, b"AT-ZIP-v1")
            self.assertEqual(len(self.calls), 1)
            # Second call: the file pins the cycle -> no request at all.
            second = build_pack.cached_http_get("https://x/aip.zip", path, versioned=True)
            self.assertEqual(second, b"AT-ZIP-v1")
            self.assertEqual(len(self.calls), 1)

    def test_ttl_reuse_then_revalidation_after_expiry(self):
        body = b'{"airports": []}'
        self.install(lambda req: FakeResponse(body, {"ETag": '"v1"'}))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "openaip.json"
            build_pack.cached_http_get("https://api/airports", path)
            self.assertEqual(len(self.calls), 1)
            # Within the TTL: reused with no request, and no conditional header sent.
            build_pack.cached_http_get("https://api/airports", path)
            self.assertEqual(len(self.calls), 1)

            # Force expiry by backdating the sidecar, then a 304 must reuse the cached bytes.
            import json
            meta = build_pack._cache_meta_path(path)
            data = json.loads(meta.read_text())
            data["fetched_at"] = 0
            meta.write_text(json.dumps(data))

            def not_modified(req):
                self.assertEqual(req.headers.get("If-none-match"), '"v1"')  # conditional GET
                raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", {}, None)
            self.calls.clear()
            self.install(not_modified)
            out = build_pack.cached_http_get("https://api/airports", path)
            self.assertEqual(out, body)             # served from cache on 304
            self.assertEqual(len(self.calls), 1)    # exactly one (conditional) request

    def test_expired_without_validator_refetches_fresh(self):
        state = {"body": b"v1"}
        self.install(lambda req: FakeResponse(state["body"]))  # no ETag/Last-Modified
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "guide.cupx"
            self.assertEqual(build_pack.cached_http_get("https://x/g", path), b"v1")
            import json
            meta = build_pack._cache_meta_path(path)
            d = json.loads(meta.read_text()); d["fetched_at"] = 0; meta.write_text(json.dumps(d))
            state["body"] = b"v2"
            self.assertEqual(build_pack.cached_http_get("https://x/g", path), b"v2")  # refetched
            self.assertEqual(len(self.calls), 2)

    def test_read_bytes_second_call_hits_cache(self):
        self.install(lambda req: FakeResponse(b"guide-bytes"))
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp)
            a = build_pack.read_bytes("https://x/guide_aires.cupx", raw)
            b = build_pack.read_bytes("https://x/guide_aires.cupx", raw)  # within TTL -> cached
            self.assertEqual(a, b, b"guide-bytes")
            self.assertEqual(len(self.calls), 1)


def _small_pdf() -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), (8, 8, 8)).save(buf, "PDF")
    return buf.getvalue()


class VersionedImporterCacheTests(unittest.TestCase):
    """The per-cycle raw caches for the sources that write to the wiped docs_dir (SIA, DFS)."""

    def setUp(self):
        self._urlopen = urllib.request.urlopen
        self.hits = 0

    def tearDown(self):
        urllib.request.urlopen = self._urlopen

    def test_sia_reuses_cached_pdf_across_a_wiped_docs_dir(self):
        pdf = _small_pdf()

        def fake(request, timeout=0):
            self.hits += 1
            return FakeResponse(pdf, {"Content-Type": "application/pdf"})
        urllib.request.urlopen = fake

        def run(docs, raw):
            fields = [{"id": "fr_lfab", "code": "LFAB", "kind": "airfield", "country": "FR", "media": []}]
            return build_pack.import_vac_pdfs(
                fields=fields, vac_root="https://sia/vac", docs_dir=docs, vac_date="2026-07-10",
                max_vac=0, airport_index={}, runway_index={}, frequency_index={},
                extra_codes=set(), pack_id="fr", raw_dir=raw)

        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            docs1 = Path(tmp) / "b1" / "docs"; docs1.mkdir(parents=True)
            run(docs1, raw)
            self.assertEqual(self.hits, 1)
            self.assertTrue((raw / "vac-fr" / "20260710" / "LFAB.pdf").is_file())
            # Next build: docs_dir is wiped/fresh, but the cycle cache in raw_dir persists.
            docs2 = Path(tmp) / "b2" / "docs"; docs2.mkdir(parents=True)
            run(docs2, raw)
            self.assertEqual(self.hits, 1)  # reused from cache -> no second download
            self.assertTrue((docs2 / "LFAB.pdf").is_file())

    def test_de_fetch_versioned_cache(self):
        def fake(request, timeout=0):
            self.hits += 1
            return FakeResponse(b"<html>page</html>")
        urllib.request.urlopen = fake
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "de" / "20260625"
            url = "https://aip.dfs.de/BasicVFR/2026JUN25/pages/EDAB-1.html"
            body1, _ = build_pack._fetch_de_vac(url, cache)
            body2, _ = build_pack._fetch_de_vac(url, cache)  # URL pins the cycle -> cached
            self.assertEqual(body1, body2, b"<html>page</html>")
            self.assertEqual(self.hits, 1)


class PruneAndVersionsTests(unittest.TestCase):
    def test_prune_keeps_only_the_current_cycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp)
            (raw / "at_aip_20260709.zip").write_bytes(b"new")  # digits of the 2026-07-09 cycle
            (raw / "at_aip_20260611.zip").write_bytes(b"old")
            for d in ("vac-fr/20260709", "vac-fr/20260611", "de/20260625", "de/20260528"):
                (raw / d).mkdir(parents=True)
                (raw / d / "x.pdf").write_bytes(b"x")
            # Unversioned single-file caches must be left alone.
            (raw / "openaip_airports_FR_1.json").write_bytes(b"{}")

            build_pack.prune_source_cache(raw, at_zip_date="2026-07-09",
                                          de_vac_date="2026-06-25", vac_date="2026-07-09")

            self.assertTrue((raw / "at_aip_20260709.zip").is_file())
            self.assertFalse((raw / "at_aip_20260611.zip").is_file())
            self.assertTrue((raw / "vac-fr" / "20260709").is_dir())
            self.assertFalse((raw / "vac-fr" / "20260611").exists())
            self.assertTrue((raw / "de" / "20260625").is_dir())
            self.assertFalse((raw / "de" / "20260528").exists())
            self.assertTrue((raw / "openaip_airports_FR_1.json").is_file())

    def test_write_source_versions_is_stable_and_sorted(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp)
            build_pack.write_source_versions(raw, {"sia": "2026-07-10", "at": "2026-07-09"})
            text = (raw / build_pack.SOURCE_VERSIONS_FILE).read_text()
            self.assertEqual(list(json.loads(text)), ["at", "sia"])  # sorted -> stable hash
            build_pack.write_source_versions(raw, {"at": "2026-07-09", "sia": "2026-07-10"})
            self.assertEqual((raw / build_pack.SOURCE_VERSIONS_FILE).read_text(), text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
