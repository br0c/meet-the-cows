"""Synthetic end-to-end test for multi-pack writing (no network).

Builds a fake staging tree with a few media files and a handful of fields across countries,
then slices them into a country pack and the Alps pack and checks that each pack is
self-contained, sized correctly, and that a shared field keeps one id across packs."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("bp", str(_here / "build_pack.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
import packs  # noqa: E402


def field(fid, name, country, lat, lon, media=None):
    f = {"id": fid, "kind": "outlanding", "name": name, "country": country,
         "latitude": lat, "longitude": lon, "media": media or []}
    return f


class MultiPackWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.staging = self.tmp / "staging"
        (self.staging / "media").mkdir(parents=True)
        (self.staging / "docs" / "vac").mkdir(parents=True)
        # fake media files with known sizes
        (self.staging / "media" / "cham.jpg").write_bytes(b"A" * 1000)
        (self.staging / "media" / "nantes.jpg").write_bytes(b"B" * 500)
        (self.staging / "media" / "inns.jpg").write_bytes(b"C" * 700)
        (self.staging / "docs" / "vac" / "LOWI.pdf").write_bytes(b"D" * 2000)

        self.fields = [
            field("fr-cham", "Chamonix", "FR", 45.92, 6.87,
                  media=[{"type": "image", "url": "media/cham.jpg"}]),
            field("fr-nantes", "Nantes", "FR", 47.22, -1.55,
                  media=[{"type": "image", "url": "media/nantes.jpg"}]),
            field("at-inns", "Innsbruck", "AT", 47.26, 11.39,
                  media=[{"type": "image", "url": "media/inns.jpg"},
                         {"type": "pdf", "url": "docs/vac/LOWI.pdf"}]),
            field("de-berlin", "Berlin", "DE", 52.52, 13.40),
        ]
        self.fields[2]["docs"] = {"vac": "docs/vac/LOWI.pdf"}
        self.out = self.tmp / "packs"
        self.out.mkdir()
        self.common = dict(version="1.0.0", generated_at="2026-07-09T00:00:00Z",
                           source_state={"schemaVersion": bp.PACK_SCHEMA_VERSION},
                           sources=[{"name": "test"}], notices=["n"])

    def write(self, pack_def):
        subset = packs.select_pack_fields(self.fields, pack_def)
        return bp.write_pack(pack_def, subset, self.staging, self.out, **self.common), subset

    def test_country_pack_is_self_contained_and_sized(self):
        m, subset = self.write({"id": "fr", "name": "France", "countries": ("FR",)})
        pack = self.out / "fr"
        stored = json.loads((pack / "fields.json").read_text())
        self.assertEqual({f["name"] for f in stored}, {"Chamonix", "Nantes"})
        # only FR media copied; no Innsbruck / Berlin media
        self.assertTrue((pack / "media" / "cham.jpg").exists())
        self.assertTrue((pack / "media" / "nantes.jpg").exists())
        self.assertFalse((pack / "media" / "inns.jpg").exists())
        fields_bytes = (pack / "fields.json").read_bytes()
        self.assertEqual(m["sizeBytes"], len(fields_bytes) + 1000 + 500)
        self.assertEqual(m["fieldsCount"], 2)
        self.assertEqual(m["mediaFiles"], 2)
        self.assertEqual(m["selector"], "countries:FR")
        self.assertTrue((pack / "manifest.json").exists())
        self.assertTrue((pack / "state.json").exists())
        self.assertTrue((pack / "media-manifest.json").exists())

    def test_alps_pack_pulls_multiple_countries_and_copies_vac(self):
        m, subset = self.write({"id": "alps", "name": "Alps", "geofence": "alps"})
        pack = self.out / "alps"
        stored = json.loads((pack / "fields.json").read_text())
        names = {f["name"] for f in stored}
        self.assertIn("Chamonix", names)     # FR + Alps
        self.assertIn("Innsbruck", names)    # AT + Alps
        self.assertNotIn("Nantes", names)    # FR, not Alps
        self.assertNotIn("Berlin", names)    # DE, not Alps
        # VAC pdf referenced once via both media[] and docs.vac -> copied once
        self.assertTrue((pack / "docs" / "vac" / "LOWI.pdf").exists())
        fields_bytes = (pack / "fields.json").read_bytes()
        self.assertEqual(m["sizeBytes"], len(fields_bytes) + 1000 + 700 + 2000)

    def test_shared_field_keeps_one_id_across_packs(self):
        fr, _ = self.write({"id": "fr", "name": "France", "countries": ("FR",)})
        alps, _ = self.write({"id": "alps", "name": "Alps", "geofence": "alps"})
        fr_ids = {f["id"] for f in json.loads((self.out / "fr" / "fields.json").read_text())}
        alps_ids = {f["id"] for f in json.loads((self.out / "alps" / "fields.json").read_text())}
        # Chamonix is in both packs under the exact same id -> app can dedupe it.
        self.assertIn("fr-cham", fr_ids & alps_ids)

    def test_shared_media_mode_copies_nothing_and_dedupes_size(self):
        # finalize stamps byte sizes and rewrites URLs to the shared tree; write_pack(shared) then
        # sizes from those bytes (unique per URL) and copies no media into the pack.
        bp.finalize_shared_media(self.fields, self.staging)
        cham = next(f for f in self.fields if f["name"] == "Chamonix")
        self.assertTrue(cham["media"][0]["url"].startswith("../_shared/media/"))
        self.assertEqual(cham["media"][0]["bytes"], 1000)

        subset = packs.select_pack_fields(self.fields, {"id": "alps", "geofence": "alps"})
        m = bp.write_pack({"id": "alps", "name": "Alps", "geofence": "alps"}, subset,
                          self.staging, self.out, shared_media=True, **self.common)
        pack = self.out / "alps"
        self.assertFalse((pack / "media").exists())          # nothing copied
        self.assertFalse((pack / "media-manifest.json").exists())
        fb = len((pack / "fields.json").read_bytes())
        self.assertEqual(m["fieldsBytes"], fb)
        # Chamonix(1000) + Innsbruck jpg(700) + shared VAC pdf(2000)
        self.assertEqual(m["sizeBytes"], fb + 1000 + 700 + 2000)
        self.assertEqual(m["mediaFiles"], 3)

    def test_packs_index_lists_all_with_sizes(self):
        manifests = []
        for pd in ({"id": "fr", "name": "France", "countries": ("FR",)},
                   {"id": "alps", "name": "Alps", "geofence": "alps"}):
            m, _ = self.write(pd)
            manifests.append(m)
        bp.write_packs_index(manifests, self.out)
        idx = json.loads((self.out / "packs.json").read_text())
        self.assertEqual(idx["schemaVersion"], 2)
        by_id = {p["id"]: p for p in idx["packs"]}
        self.assertEqual(by_id["fr"]["manifestUrl"], "packs/fr/manifest.json")
        self.assertGreater(by_id["alps"]["sizeBytes"], 0)
        self.assertEqual(by_id["fr"]["fieldsCount"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
