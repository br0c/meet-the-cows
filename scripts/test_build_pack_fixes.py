#!/usr/bin/env python3
"""Fast, offline regression tests for field-name selection and German translation.

Run directly: `python scripts/test_build_pack_fixes.py`. No network or API key needed;
the DeepL call is monkeypatched. Guards the fixes for:
  - truncated airfield names (Barcelonnett / Sisteron The / LFNC St Crepin)
  - German notes not being fully translated (French must stay French)
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_build_pack():
    spec = importlib.util.spec_from_file_location("build_pack", ROOT / "scripts" / "build_pack.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bp = load_build_pack()
GUIDE = "planeur-net / Guide des Aires de Sécurité"
SECONDARY = "Secondary source"  # any non-primary source (scores below the Guide in name selection)


def field(source: str, name: str) -> dict:
    return {"source": {"name": source}, "name": name}


def test_clean_display_name_strips_leading_code():
    assert bp.clean_display_name("#42 LFMR Barcelonnette") == "Barcelonnette"
    assert bp.clean_display_name("#40 LFNC St Crepin") == "St Crepin"
    assert bp.clean_display_name("#32 LFNS Sisteron") == "Sisteron"
    # Trailing code still stripped.
    assert bp.clean_display_name("Barcelonnette LFMR") == "Barcelonnette"


def test_clean_display_name_keeps_place_names():
    # Title-case place names starting with L must not be mistaken for ICAO codes.
    for name in ["Livigno", "Lion-sur-Mer", "Lus la Croix Haute", "La Motte", "Lissabon"]:
        assert bp.clean_display_name(name) == name, name


def test_guide_full_name_beats_truncated_secondary():
    cases = [
        ("#42 LFMR Barcelonnette", "Barcelonnett", "Barcelonnette"),
        ("#32 LFNS Sisteron", "Sisteron The", "Sisteron"),
        ("#40 LFNC St Crepin", "LFNC St Crepin", "St Crepin"),
    ]
    for guide_name, alt_name, expected in cases:
        group = [field(GUIDE, guide_name), field(SECONDARY, alt_name)]
        assert bp.choose_best_name(group, group[0]) == expected, (guide_name, alt_name)


def test_openaip_name_wins_when_present():
    group = [field(GUIDE, "#42 LFMR Barcelonnette"), field("OpenAIP", "Barcelonnette - Saint-Pons")]
    assert bp.choose_best_name(group, group[0]) == "Barcelonnette - Saint-Pons"


def test_deepl_url_resolution():
    assert bp.resolve_deepl_api_url("abc:fx").endswith("api-free.deepl.com/v2/translate")
    assert bp.resolve_deepl_api_url("abc").endswith("://api.deepl.com/v2/translate")
    assert bp.resolve_deepl_api_url("") == ""


def test_translation_cache_dedups_and_translates(monkeypatch=None):
    bp.DEEPL_API_KEY = "key:fx"
    bp.DEEPL_API_URL = "http://mock"
    bp._DEEPL_DISABLED = False
    bp._TRANSLATION_CACHE = {}
    bp._TRANSLATION_STATS = {"deepl": 0, "cache": 0, "fallback": 0}
    calls = {"n": 0}

    def fake_ex(text: str, target_lang: str):
        calls["n"] += 1
        return ("EN:" + text, "DE")

    original = bp.deepl_translate_ex
    bp.deepl_translate_ex = fake_ex
    try:
        assert bp.localize_note_cached("Achtung Hochspannung", "en")[0] == "EN:Achtung Hochspannung"
        assert bp.localize_note_cached("Achtung Hochspannung", "en")[0] == "EN:Achtung Hochspannung"
        assert calls["n"] == 1, "second identical string must come from cache"
        assert bp._TRANSLATION_STATS == {"deepl": 1, "cache": 1, "fallback": 0}
    finally:
        bp.deepl_translate_ex = original


def test_localize_note_keeps_native_source_and_skips_self_translation():
    # A German-sourced note must keep its native German verbatim and never be sent to DeepL for
    # German (no round-trip, no wasted characters) — only English and French are requested.
    bp.DEEPL_API_KEY = "key:fx"
    bp.DEEPL_API_URL = "http://mock"
    bp._DEEPL_DISABLED = False
    bp._DEEPL_BUDGET_CHARS = None
    bp._TRANSLATION_CACHE = {}
    bp._TRANSLATION_STATS = {"deepl": 0, "cache": 0, "fallback": 0}
    seen = []

    def fake_ex(text, target_lang):
        seen.append(target_lang)
        return (f"{target_lang}:{text}", "DE")

    original = bp.deepl_translate_ex
    bp.deepl_translate_ex = fake_ex
    try:
        note = bp.localize_note("Wiese mit Zaun", source_lang="de")
        assert note["de"] == "Wiese mit Zaun", "native German kept verbatim"
        assert note["en"] == "EN-GB:Wiese mit Zaun"
        assert note["fr"] == "FR:Wiese mit Zaun"
        assert sorted(seen) == ["EN-GB", "FR"], "German source is never re-translated to German"
    finally:
        bp.deepl_translate_ex = original


def test_translation_cache_seeds_from_published_pack_only_when_empty():
    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps({"en\x1fWiese": "Meadow", "fr\x1fWiese": "Prairie"}).encode()

    original = bp.urllib.request.urlopen
    bp.urllib.request.urlopen = lambda *a, **k: Resp()
    try:
        # Empty cache + state URL -> seeded from the sibling translation-cache.json.
        bp._TRANSLATION_CACHE = {}
        bp.seed_translation_cache_from_url("https://example.org/packs/fr-alps/state.json")
        assert bp._TRANSLATION_CACHE == {"en\x1fWiese": "Meadow", "fr\x1fWiese": "Prairie"}
        # Non-empty cache -> untouched (CI cache hit wins).
        bp._TRANSLATION_CACHE = {"en\x1fZaun": "Fence"}
        bp.seed_translation_cache_from_url("https://example.org/packs/fr-alps/state.json")
        assert bp._TRANSLATION_CACHE == {"en\x1fZaun": "Fence"}
        # No state URL -> no-op.
        bp._TRANSLATION_CACHE = {}
        bp.seed_translation_cache_from_url("")
        assert bp._TRANSLATION_CACHE == {}
    finally:
        bp.urllib.request.urlopen = original
        bp._TRANSLATION_CACHE = {}


def test_is_major_airport_excludes_big_airfields_only():
    # Long paved runway or an explicit major/military ICAO -> excluded.
    assert bp.is_major_airport({"kind": "airfield", "code": "LFML", "lengthM": 3490}) is True   # Marseille
    assert bp.is_major_airport({"kind": "airfield", "code": "LFLP", "lengthM": 1630}) is True    # Annecy (list)
    assert bp.is_major_airport({"kind": "airfield", "code": "LFXA", "lengthM": 1990}) is True    # Ambérieu mil (list)
    # Real gliding aerodromes are kept, even the longer ones.
    assert bp.is_major_airport({"kind": "airfield", "code": "LFMX", "lengthM": 1200}) is False   # St-Auban
    assert bp.is_major_airport({"kind": "airfield", "code": "LFMA", "lengthM": 1590}) is False   # Aix-les-Milles gliding
    # Outlanding fields are never dropped, whatever their (rare) length value.
    assert bp.is_major_airport({"kind": "outlanding", "code": "", "lengthM": 3000}) is False
    assert bp.is_major_airport({"kind": "airfield", "code": "", "lengthM": None}) is False


def test_drop_major_airports_filters_and_keeps_order():
    fields = [
        {"kind": "outlanding", "code": "", "name": "Grass field", "lengthM": None},
        {"kind": "airfield", "code": "LFML", "name": "Marseille", "lengthM": 3490},
        {"kind": "airfield", "code": "LFMX", "name": "St-Auban", "lengthM": 1200},
    ]
    kept = bp.drop_major_airports(fields)
    assert [f["code"] for f in kept] == ["", "LFMX"]


def test_note_source_lang_by_source_name():
    assert bp.note_source_lang({"source": {"name": GUIDE}}) == "fr"
    assert bp.note_source_lang({"source": {"name": "OpenAIP"}}) == "en"
    assert bp.note_source_lang({"source": {"name": "SIA VAC + OpenAIP/airport coordinates"}}) == "en"
    assert bp.note_source_lang({"source": {"name": "mystery source"}}) is None


def test_merge_notes_merges_each_language_natively():
    group = [
        {"notes": {"en": "Grass field", "fr": "Terrain en herbe", "de": "Wiese"}},
        {"notes": {"en": "Power lines", "fr": "Lignes électriques", "de": "Stromleitungen"}},
    ]
    merged = bp.merge_notes(group)
    assert merged["fr"] == "Terrain en herbe\n\n---\n\nLignes électriques"
    assert merged["de"] == "Wiese\n\n---\n\nStromleitungen"
    assert "Grass field" in merged["en"] and "Power lines" in merged["en"]


def test_source_language_matching_target_keeps_original():
    # When DeepL detects that the source already matches the target language, keep the
    # original text instead of round-tripping it (e.g. French prose asked for French).
    def resp_detecting(source_lang):
        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return json.dumps(
                    {"translations": [{"detected_source_language": source_lang, "text": "DISCARD ME"}]}
                ).encode()

        return Resp

    bp.DEEPL_API_KEY = "key:fx"
    bp.DEEPL_API_URL = "http://mock"
    bp._DEEPL_DISABLED = False
    bp._DEEPL_BUDGET_CHARS = None
    bp._DEEPL_CHARS_SPENT = 0
    original = bp.urllib.request.urlopen
    try:
        # French text asked for French: unchanged.
        bp.urllib.request.urlopen = lambda *a, **k: resp_detecting("FR")()
        assert bp.deepl_translate("Terrain en herbe, pente douce", "FR") == "Terrain en herbe, pente douce"
        # French text asked for English: DeepL's translation is used.
        assert bp.deepl_translate("Terrain en herbe, pente douce", "EN-GB") == "DISCARD ME"
    finally:
        bp.urllib.request.urlopen = original


def test_localize_note_covers_three_languages():
    # localize_note must return an en/fr/de dict, keep the detected source's original text,
    # and translate the other two languages.
    bp.DEEPL_API_KEY = "key:fx"
    bp.DEEPL_API_URL = "http://mock"
    bp._DEEPL_DISABLED = False
    bp._DEEPL_BUDGET_CHARS = None
    bp._TRANSLATION_CACHE = {}
    bp._TRANSLATION_STATS = {"deepl": 0, "cache": 0, "fallback": 0}

    def fake_ex(text, target_lang):
        # Pretend every source is German; echo a target-tagged translation.
        return (f"{target_lang}:{text}", "DE")

    original = bp.deepl_translate_ex
    bp.deepl_translate_ex = fake_ex
    try:
        note = bp.localize_note("Wiese mit Zaun")
        assert set(note.keys()) == {"en", "fr", "de"}
        assert note["de"] == "Wiese mit Zaun", "detected German source keeps the original"
        assert note["en"] == "EN-GB:Wiese mit Zaun"
        assert note["fr"] == "FR:Wiese mit Zaun"
        assert bp.localize_note("") == {"en": "", "fr": "", "de": ""}
    finally:
        bp.deepl_translate_ex = original


def test_fallback_without_key_leaves_source_untouched():
    # No DeepL key: every language slot falls back to the source text (the offline German
    # dictionary leaves non-German text alone), so French input stays French everywhere.
    bp.DEEPL_API_KEY = ""
    bp.DEEPL_API_URL = ""
    bp._DEEPL_DISABLED = False
    bp._DEEPL_BUDGET_CHARS = None
    bp._TRANSLATION_CACHE = {}
    french = "Terrain en herbe, attention au maïs"
    assert bp.localize_note_cached(french, "fr")[0] == french
    assert bp.localize_note_cached(french, "de")[0] == french
    assert bp.localize_note_cached(french, "en")[0] == french
    note = bp.localize_note(french, source_lang="fr")
    assert note == {"en": french, "fr": french, "de": french}


def test_budget_guard_stops_spending():
    # A tiny per-run allowance must halt DeepL and disable it before overspending.
    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps({"translations": [{"detected_source_language": "DE", "text": "EN"}]}).encode()

    bp.DEEPL_API_KEY = "key:fx"
    bp.DEEPL_API_URL = "https://api-free.deepl.com/v2/translate"
    bp._DEEPL_DISABLED = False
    bp._DEEPL_CHARS_SPENT = 0
    bp._DEEPL_BUDGET_CHARS = 10
    original = bp.urllib.request.urlopen
    bp.urllib.request.urlopen = lambda *a, **k: Resp()
    try:
        assert bp.deepl_translate("kurz") == "EN"          # 4 chars, under cap
        assert bp._DEEPL_CHARS_SPENT == 4
        assert bp.deepl_translate("langeres") is None       # 4+8 > 10 -> guard trips
        assert bp._DEEPL_DISABLED is True
    finally:
        bp.urllib.request.urlopen = original
        bp._DEEPL_BUDGET_CHARS = None
        bp._DEEPL_DISABLED = False
        bp._DEEPL_CHARS_SPENT = 0


def test_deepl_retries_on_429_then_succeeds(monkeypatch=None):
    # Rate limit twice, then succeed: the call must retry (not fall back) and count chars once.
    import urllib.error

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps({"translations": [{"detected_source_language": "DE", "text": "EN"}]}).encode()

    attempts = {"n": 0}

    def flaky(*a, **k):
        attempts["n"] += 1
        if attempts["n"] <= 2:
            raise urllib.error.HTTPError("url", 429, "Too Many Requests", {}, None)
        return Resp()

    bp.DEEPL_API_KEY = "key:fx"
    bp.DEEPL_API_URL = "https://api-free.deepl.com/v2/translate"
    bp._DEEPL_DISABLED = False
    bp._DEEPL_BUDGET_CHARS = None
    bp._DEEPL_CHARS_SPENT = 0
    orig_open, orig_sleep = bp.urllib.request.urlopen, bp.time.sleep
    bp.urllib.request.urlopen = flaky
    bp.time.sleep = lambda *_: None
    try:
        assert bp.deepl_translate("Wiese") == "EN"
        assert attempts["n"] == 3, "should retry twice then succeed"
        assert bp._DEEPL_CHARS_SPENT == len("Wiese")
    finally:
        bp.urllib.request.urlopen = orig_open
        bp.time.sleep = orig_sleep
        bp._DEEPL_CHARS_SPENT = 0


def test_source_states_match():
    base = bp.build_source_state(cupx="etagA", vac="2026-06-11", contributions="c1")
    assert bp.source_states_match(dict(base), base) is True
    assert bp.source_states_match(None, base) is False
    # Any source change -> mismatch -> rebuild.
    assert bp.source_states_match({**base, "cupx": "etagB"}, base) is False
    assert bp.source_states_match({**base, "vac": "2026-07-09"}, base) is False
    assert bp.source_states_match({**base, "contributions": "c2"}, base) is False
    # A schema bump forces a rebuild even if sources are identical.
    assert bp.source_states_match({**base, "schemaVersion": base["schemaVersion"] - 1}, base) is False
    # A published state from before the contributions key existed still matches when there are
    # no contributions (missing == empty).
    old = {k: v for k, v in base.items() if k != "contributions"}
    assert bp.source_states_match(old, {**base, "contributions": ""}) is True


def test_contributions_fingerprint(tmp_path=None):
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp) / "contributions"
        assert bp.contributions_fingerprint(d) == ""          # missing dir
        d.mkdir()
        assert bp.contributions_fingerprint(d) == ""          # empty dir
        (d / "f1").mkdir()
        (d / "f1" / "a.json").write_text('{"x":1}')
        fp1 = bp.contributions_fingerprint(d)
        assert fp1
        (d / "f1" / "a.json").write_text('{"x":2}')           # content change
        fp2 = bp.contributions_fingerprint(d)
        assert fp2 and fp2 != fp1
        (d / "f1" / "b.json").write_text('{"y":1}')           # new file
        assert bp.contributions_fingerprint(d) not in (fp1, fp2)


def test_find_contribution_field_matching():
    fields = [
        {"id": "id_a", "code": "LFNF", "latitude": 43.7378, "longitude": 5.7836},
        {"id": "id_b", "code": "LFMX", "latitude": 44.0600, "longitude": 5.9900},
    ]
    # Exact id wins.
    assert bp.find_contribution_field(fields, {"fieldId": "id_b"})["id"] == "id_b"
    # Stale id falls back to unique code.
    assert bp.find_contribution_field(fields, {"fieldId": "gone", "fieldCode": "LFNF"})["id"] == "id_a"
    # No id/code: nearest within 1 km of the stored coordinates.
    near = {"fieldId": "gone", "fieldCode": "", "fieldLat": 43.7380, "fieldLon": 5.7840}
    assert bp.find_contribution_field(fields, near)["id"] == "id_a"
    # Too far from anything -> no match.
    far = {"fieldId": "gone", "fieldCode": "", "fieldLat": 48.85, "fieldLon": 2.35}
    assert bp.find_contribution_field(fields, far) is None


def test_merge_contributions_notes_and_photo():
    import io as _io
    import tempfile
    from pathlib import Path
    from PIL import Image

    # No DeepL: localize_note falls back to the source text in every language slot.
    bp.DEEPL_API_KEY = ""
    bp.DEEPL_API_URL = ""
    bp._DEEPL_DISABLED = False
    bp._TRANSLATION_CACHE = {}

    buf = _io.BytesIO()
    Image.new("RGB", (3000, 2000), (90, 120, 70)).save(buf, "JPEG", quality=60)
    jpeg_bytes = buf.getvalue()
    original_fetch = bp._fetch_contribution_asset
    bp._fetch_contribution_asset = lambda url: jpeg_bytes

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            contrib = tmp / "contributions" / "id_a"
            contrib.mkdir(parents=True)
            (contrib / "2026-07-08_x1.json").write_text(json.dumps({
                "schema": 2, "fieldId": "id_a", "fieldCode": "LFNF",
                "fieldLat": 43.7378, "fieldLon": 5.7836, "fieldName": "Vinon",
                "date": "2026-07-08",
                "description": "New windsock at the north end.",
                "photoAsset": {"id": 1, "name": "id_a_x1.jpg", "url": "https://example.org/a.jpg", "size": 123},
                "submitter": {"handle": "smoke"},
                "geo": {"verified": True, "source": "exif", "distanceM": 150},
            }))
            (contrib / "bad.json").write_text("{not json")  # must be skipped, not fatal

            fields = [{
                "id": "id_a", "code": "LFNF", "latitude": 43.7378, "longitude": 5.7836,
                "notes": {"en": "Grass strip.", "fr": "Piste en herbe.", "de": "Graspiste."},
                "media": [],
            }]
            media_dir = tmp / "media"
            notes, photos = bp.merge_contributions(fields, tmp / "contributions", media_dir)
            assert (notes, photos) == (1, 1)
            f = fields[0]
            for lang, header in (("en", "Pilot report"), ("fr", "Rapport pilote"), ("de", "Pilotenbericht")):
                assert f"{header} 2026-07-08 (smoke): New windsock" in f["notes"][lang], lang
                assert f["notes"][lang].startswith({"en": "Grass strip.", "fr": "Piste en herbe.", "de": "Graspiste."}[lang])
            assert len(f["media"]) == 1
            media = f["media"][0]
            assert media["source"] == "Community contribution"
            written = media_dir / "id_a" / Path(media["url"]).name
            assert written.exists() and written.stat().st_size > 0
            with Image.open(written) as img:
                assert max(img.size) <= 2560, "photo must be pack-optimized"
    finally:
        bp._fetch_contribution_asset = original_fetch


def test_merge_new_field_proposal_and_multi_photo():
    import io as _io
    import tempfile
    from pathlib import Path
    from PIL import Image

    bp.DEEPL_API_KEY = ""
    bp.DEEPL_API_URL = ""
    bp._DEEPL_DISABLED = False
    bp._TRANSLATION_CACHE = {}

    buf = _io.BytesIO()
    Image.new("RGB", (3000, 2000), (60, 90, 120)).save(buf, "JPEG", quality=60)
    jpeg_bytes = buf.getvalue()
    original_fetch = bp._fetch_contribution_asset
    bp._fetch_contribution_asset = lambda url: jpeg_bytes

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            contrib = tmp / "contributions" / "new-les-crots"
            contrib.mkdir(parents=True)
            (contrib / "2026-07-10_p1.json").write_text(json.dumps({
                "schema": 3, "type": "new-field", "fieldId": "new-les-crots",
                "fieldLat": 44.53, "fieldLon": 6.44, "fieldName": "Les Crots",
                "proposed": {
                    "name": "Les Crots", "kind": "outlanding", "country": "FR",
                    "latitude": 44.53, "longitude": 6.44, "elevationM": 790,
                    "difficulty": "B", "runway": "07/25", "lengthM": 420, "widthM": 40,
                    "surface": "grass", "frequency": "123.500",
                },
                "date": "2026-07-10",
                "description": "Long meadow by the lake, land uphill.",
                "photoAssets": [
                    {"name": "p1_1.jpg", "url": "https://example.org/1.jpg", "geo": {"verified": True}},
                    {"name": "p1_2.jpg", "url": "https://example.org/2.jpg", "geo": {"verified": False}},
                ],
                "submitter": {"handle": "smoke"},
                "geo": {"verified": False, "source": "exif", "distanceM": 1400},
            }))
            # A second proposal 80 m from an existing field must fold into it, not duplicate it.
            dup = tmp / "contributions" / "new-vinon-bis"
            dup.mkdir(parents=True)
            (dup / "2026-07-10_p2.json").write_text(json.dumps({
                "schema": 3, "type": "new-field", "fieldId": "new-vinon-bis",
                "fieldLat": 43.7378, "fieldLon": 5.7836, "fieldName": "Vinon bis",
                "proposed": {"name": "Vinon bis", "kind": "outlanding", "country": "FR",
                             "latitude": 43.7385, "longitude": 5.7838},
                "date": "2026-07-10", "description": "Actually the same strip.",
                "photoAssets": [], "geo": {"verified": True, "source": "device", "distanceM": 20},
            }))

            fields = [{
                "id": "id_a", "code": "LFNF", "latitude": 43.7378, "longitude": 5.7836,
                "notes": {"en": "Grass strip.", "fr": "Piste en herbe.", "de": "Graspiste."},
                "media": [],
            }]
            notes, photos = bp.merge_contributions(fields, tmp / "contributions", tmp / "media")
            assert photos == 2
            assert len(fields) == 2, "exactly one new field created"
            created = fields[1]
            assert created["name"] == "Les Crots" and created["kind"] == "outlanding"
            assert created["country"] == "FR" and created["difficulty"] == "B"
            assert created["runwayDirectionDeg"] == 70.0 and created["lengthM"] == 420
            # slugify id: underscores, accents folded, deterministic coordinate-hash suffix.
            assert created["id"].startswith("new_les_crots-")
            assert "Long meadow" in created["notes"]["en"]
            assert "Surface: grass" in created["notes"]["en"]
            assert "Direction: 07/25" in created["notes"]["en"]
            assert len(created["media"]) == 2, "both photos attached to the created field"
            # Duplicate proposal became a note on the existing field instead of a new one.
            assert "Actually the same strip" in fields[0]["notes"]["en"]
            # Deterministic id across rebuilds.
            again, created_flag = bp.create_proposed_field([], json.loads((contrib / "2026-07-10_p1.json").read_text()))
            assert created_flag and again["id"] == created["id"]
    finally:
        bp._fetch_contribution_asset = original_fetch


def test_parse_runway_direction():
    assert bp.parse_runway_direction_deg("07/25") == 70.0
    assert bp.parse_runway_direction_deg("070") == 70.0
    assert bp.parse_runway_direction_deg("25") == 250.0
    assert bp.parse_runway_direction_deg("361") is None
    assert bp.parse_runway_direction_deg("grass") is None
    assert bp.parse_runway_direction_deg("") is None
    # Free-text runway values (e.g. 'Grasbahn 07/25') go through the same parser.
    assert bp.parse_runway_direction_deg("Grasbahn 07/25") == 70.0
    assert bp.parse_runway_direction_deg("N-S") is None


def test_import_vac_second_pass_restricted():
    """The FR (SIA) importer joins the late-fields second pass: restrict_codes scopes the
    probes, PDFs from pass 1 are reused from disk, and already-attached fields are skipped."""
    import io
    import tempfile
    import urllib.request
    from unittest import mock

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 60), (5, 10, 15)).save(buf, "PDF")
    pdf = buf.getvalue()

    class FakeResponse:
        status = 200
        headers = {"Content-Type": "application/pdf"}
        def read(self): return pdf
        def __enter__(self): return self
        def __exit__(self, *exc): return False

    probed = []
    def fake_urlopen(request, timeout=0):
        probed.append(request.full_url)
        return FakeResponse()

    def mk(code):
        return {"id": f"fr_{code.lower()}", "code": code, "kind": "airfield",
                "country": "FR", "media": []}

    with tempfile.TemporaryDirectory() as tmp:
        docs = Path(tmp) / "vac"
        docs.mkdir()
        fields = [mk("LFXA")]
        kwargs = dict(vac_root="https://sia.example/vac", docs_dir=docs, vac_date="2026-07-10",
                      max_vac=0, airport_index={}, runway_index={}, frequency_index={},
                      extra_codes=set(), pack_id="fr")
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            result = bp.import_vac_pdfs(fields=fields, **kwargs)
            assert result["downloaded"] == 1 and len(fields[0]["media"]) == 1
            fields.append(mk("LFXA"))  # late twin of an already-attached code
            fields.append(mk("LFHM"))  # genuinely new late code
            fields.append(mk("LFNX"))  # not late: the restricted pass must not probe it
            probed.clear()
            result = bp.import_vac_pdfs(fields=fields, restrict_codes={"LFXA", "LFHM"}, **kwargs)
        assert result["downloaded"] == 1, "only the new code's PDF counts as downloaded"
        assert probed == ["https://sia.example/vac/AD-2.LFHM.pdf"], probed
        assert [len(f["media"]) for f in fields] == [1, 1, 1, 0]
        assert fields[1]["docs"]["vac"] == "docs/vac/LFXA.pdf"


def test_parse_cup_honors_source_name():
    # Extra CUPs (Champs des Alpes, BASULM) are parsed with their own attribution and still map
    # to French for localisation; the default stays the Guide.
    cup = ('name,code,country,lat,lon,elev,style,rwdir,rwlen,rwwidth,freq,desc\n'
           '"213 Aups",V13,FR,4337.517N,00610.983E,450.0m,3,,300.0m,,,"Zone cultures"\n')
    extra = bp.parse_cup(cup, "fr", source_name="planeur-net / BASULM terrains ULM")
    assert len(extra) == 1
    assert extra[0]["source"]["name"] == "planeur-net / BASULM terrains ULM"
    assert bp.note_source_lang(extra[0]) == "fr"
    assert bp.parse_cup(cup, "fr")[0]["source"]["name"] == "planeur-net / Guide des Aires de Sécurité"


def main() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for test in tests:
        test()
        print(f"  ok  {test.__name__}")
    print(f"\nAll {len(tests)} build_pack fix tests passed")


if __name__ == "__main__":
    main()
