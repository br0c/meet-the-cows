"""Tests for the line-level translation memory in build_pack.localize_note.

DeepL is left unconfigured (empty key) so translate calls fall back deterministically:
English -> offline dictionary, French/German -> source text. Reuse is exercised by
pre-seeding the (lang, text) cache and asserting which lookups hit it."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("bp", str(Path(__file__).resolve().parent / "build_pack.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


def seg_key(lang, text):
    return f"{lang}\x1f{bp.normalize_space(text)}"


class TranslationMemoryTests(unittest.TestCase):
    def setUp(self):
        bp.DEEPL_API_KEY = ""            # force offline fallback
        bp._DEEPL_DISABLED = False
        bp._TRANSLATION_CACHE.clear()
        bp._TRANSLATION_STATS.update({"deepl": 0, "cache": 0, "fallback": 0})

    def test_label_value_line_reassembles_from_segments(self):
        bp._TRANSLATION_CACHE[seg_key("fr", "Oberfläche:")] = "Surface :"
        bp._TRANSLATION_CACHE[seg_key("fr", "Wiese")] = "prairie"
        out = bp.localize_note_reusing_segments("Oberfläche: Wiese", "fr")
        self.assertEqual(out, "Surface : prairie")

    def test_label_is_reused_across_different_values(self):
        # Label cached once; each value translated on its own. Only the label hits.
        bp._TRANSLATION_CACHE[seg_key("fr", "Richtung:")] = "Direction :"
        a = bp.localize_note_reusing_segments("Richtung: 09/27", "fr")
        b = bp.localize_note_reusing_segments("Richtung: 18/36", "fr")
        self.assertEqual(a, "Direction : 09/27")   # value falls back to source (no key/DeepL)
        self.assertEqual(b, "Direction : 18/36")
        # Label present exactly once in cache, reused both times.
        self.assertIn(seg_key("fr", "Richtung:"), bp._TRANSLATION_CACHE)

    def test_multiline_note_translates_each_line_and_preserves_structure(self):
        note = "Info: nasse Wiese\nOberfläche: Wiese\nRückmeldungen:\n- Baum am Zaun"
        for de, fr in [("Info:", "Info :"), ("nasse Wiese", "prairie humide"),
                       ("Oberfläche:", "Surface :"), ("Wiese", "prairie"),
                       ("Rückmeldungen:", "Retours :"), ("Baum am Zaun", "arbre sur la clôture")]:
            bp._TRANSLATION_CACHE[seg_key("fr", de)] = fr
        out = bp.localize_note_reusing_segments(note, "fr")
        self.assertEqual(
            out,
            "Info : prairie humide\nSurface : prairie\nRetours :\n- arbre sur la clôture",
        )

    def test_whole_note_cache_short_circuits_without_resegmenting(self):
        # Simulates an FR/CH/IT note already translated as a whole note in a prior build:
        # it must return verbatim and NOT create any new segment cache entries.
        note = "Info: alte Wiese\nOberfläche: Acker"
        bp._TRANSLATION_CACHE[seg_key("fr", note)] = "PRE-TRANSLATED WHOLE"
        before = len(bp._TRANSLATION_CACHE)
        out = bp.localize_note_reusing_segments(note, "fr")
        self.assertEqual(out, "PRE-TRANSLATED WHOLE")
        self.assertEqual(len(bp._TRANSLATION_CACHE), before)   # no re-spend, no new entries
        self.assertEqual(bp._TRANSLATION_STATS["cache"], 1)
        self.assertEqual(bp._TRANSLATION_STATS["deepl"], 0)

    def test_localize_note_keeps_source_native_and_translates_others(self):
        bp._TRANSLATION_CACHE[seg_key("fr", "Oberfläche:")] = "Surface :"
        bp._TRANSLATION_CACHE[seg_key("fr", "Wiese")] = "prairie"
        out = bp.localize_note("Oberfläche: Wiese", source_lang="de")
        self.assertEqual(out["de"], "Oberfläche: Wiese")   # native slot verbatim
        self.assertEqual(out["fr"], "Surface : prairie")   # reassembled from segments
        self.assertIn("en", out)

    def test_bullet_marker_preserved(self):
        bp._TRANSLATION_CACHE[seg_key("fr", "Baum am Rand")] = "arbre au bord"
        out = bp.localize_note_reusing_segments("- Baum am Rand", "fr")
        self.assertEqual(out, "- arbre au bord")

    def test_blank_input_yields_empty_slots(self):
        self.assertEqual(bp.localize_note("", source_lang="de"), {"en": "", "fr": "", "de": ""})


if __name__ == "__main__":
    unittest.main(verbosity=2)
