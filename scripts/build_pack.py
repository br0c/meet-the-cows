#!/usr/bin/env python3
"""Build an offline Meet the Cows data pack from CUP/CUPX plus optional SIA VAC PDFs.

Typical first real build:

  python scripts/build_pack.py \
    --cupx https://raw.githubusercontent.com/planeur-net/outlanding/main/guide_aires_securite.cupx \
    --pack-id fr-alps \
    --pack-name "France / Alps" \
    --vac-root https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_11_JUN_2026/Atlas-VAC/PDF_AIPparSSection/VAC/AD \
    --vac-date "2026-06-11 / AIRAC 06-26" \
    --include-vac-airfields

Design notes:
- The Guide des Aires CUPX is the primary outlanding dataset.
- VAC PDFs are imported as an independent official-airfield layer. If a VAC ICAO code is
  already present in the CUP file, the PDF is attached to that field. If it is not present,
  an airfield entry is created from the airport source and the VAC PDF is attached there.
- By default, --include-vac-airfields uses OurAirports airports.csv/runways.csv because it
  is public-domain and gives us coordinates for LFxx aerodromes. Do not use it as an
  authoritative navigation source; the SIA PDF remains the official document.
- CUPX is handled as concatenated ZIP files: pictures ZIP + points ZIP.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import html
from collections import Counter
import io
import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable, Sequence

# Pack registry + geofence (scripts/packs.py). Ensure this file's directory is importable
# whether build_pack is run as a script or loaded by path in tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import packs  # noqa: E402

DEFAULT_CUPX_URL = "https://raw.githubusercontent.com/planeur-net/outlanding/main/guide_aires_securite.cupx"
OURAIRPORTS_AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OURAIRPORTS_RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
OURAIRPORTS_FREQUENCIES_URL = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"
OPENAIP_API_BASE_URL = "https://api.core.openaip.net/api"
STRECKENFLUG_LIST_URL = "https://landout.streckenflug.at/index.php?id=&inc=landeplatz&task=list&side_buch=&side_kontinent=EU&side_region=&side_land=&side_art=&side_oberflaeche=&side_kategorie=&side_checked="
STRECKENFLUG_JSON_URL = "https://landout.streckenflug.at/json.php"
BASE_AIRAC_DATE = dt.date(2024, 1, 25)

DIFFICULTY_MAP = {
    "aerodrome": "A",
    "terrain": "A",
    "altiport": "A",
    "velisurface": "A",
    "facile": "A",
    "normal": "B",
    "difficile": "C",
    "tres_difficile": "D",
}
MEDIA_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
ICAO_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{2}$")
ICAO_FR_RE = re.compile(r"^LF[A-Z0-9]{2}$")
ICAO_AT_RE = re.compile(r"^LO[A-Z]{2}$")
AT_EAIP_ROOT = "https://eaip.austrocontrol.at/"
COUNTRY_ICAO_PREFIXES = {"FR": ("LF",), "CH": ("LS",), "IT": ("LI",)}
OPENAIP_AIRPORT_TYPES = {
    0: "Airport (civil/military)",
    1: "Glider Site",
    2: "Airfield Civil",
    3: "International Airport",
    4: "Heliport Military",
    5: "Military Aerodrome",
    6: "Ultra Light Flying Site",
    7: "Heliport Civil",
    8: "Aerodrome Closed",
    9: "Airport resp. Airfield IFR",
    10: "Airfield Water",
    11: "Landing Strip",
    12: "Agricultural Landing Strip",
    13: "Altiport",
}
GLIDER_KEYWORDS = (
    "glider", "gliding", "soaring", "sailplane",
    "planeur", "vol a voile", "vol à voile",
    "segelflug", "segelfluggelände", "segelflugplatz",
    "aliante", "volo a vela",
)
DEDUPE_DISTANCE_M = 350.0
DEDUPE_STRONG_NAME_DISTANCE_M = 800.0
PACK_IMAGE_MAX_LONG_EDGE = 2560
PACK_IMAGE_JPEG_QUALITY = 85

# Major airports where a glider must not land are dropped from the pack. OpenAIP's type filter
# does not catch them all — most leak in from the streckenflug landout list — so this is a
# source-agnostic rule on the assembled fields. Real gliding aerodromes in this dataset top out
# around 1300 m of runway, and every field at/above this paved length is a major commercial or
# controlled airport or an active military base, so the length rule is a clean discriminator.
MAJOR_AIRFIELD_MIN_RUNWAY_M = 2000.0
# Major commercial/controlled airports and active military bases with runways under the length
# threshold (gliders still prohibited). Kept explicit and short so it is easy to audit and tune.
MAJOR_AIRFIELD_ICAO = {
    "LFLP",  # Annecy (controlled commercial)
    "LFMD",  # Cannes-Mandelieu (busy Class D business aviation)
    "LFMV",  # Avignon-Caumont
    "LFMU",  # Béziers-Vias
    "LFLY",  # Lyon-Bron (controlled business airport)
    "LFXA",  # Ambérieu (BA 278 military)
    "LFMY",  # Salon-de-Provence (BA 701 military)
    "LFTF",  # Cuers-Pierrefeu (naval air station)
}

# DeepL translation of German streckenflug notes. Configured in main(); when no key is
# available the code falls back to the offline STRECKENFLUG_GERMAN_PHRASES dictionary.
DEEPL_API_KEY = ""
DEEPL_API_URL = ""
_DEEPL_DISABLED = False
_DEEPL_CHARS_SPENT = 0
# Max characters this run may send to DeepL. Set in main() to min(per-build cap, remaining
# lifetime quota). None means "not configured" (no guard). This is the budget safeguard:
# once tripped, deepl_translate returns None so callers fall back to the offline dictionary.
_DEEPL_BUDGET_CHARS: int | None = None
_TRANSLATION_CACHE: dict[str, str] = {}
_TRANSLATION_CACHE_PATH: Path | None = None
_TRANSLATION_STATS: dict[str, int] = {"deepl": 0, "cache": 0, "fallback": 0}
# Serialises DeepL access: streckenflug scraping runs on many worker threads, and concurrent
# calls get rate-limited (HTTP 429). One request at a time + backoff keeps us under the limit.
_DEEPL_LOCK = threading.Lock()

# Bump whenever the build LOGIC changes the pack output (parsing, merging, translation,
# schema). A mismatch with the published state forces a full rebuild even if the upstream
# sources are unchanged, so code changes always reach the deployed pack.
# v8: field notes are localized objects {"en","fr","de"} instead of a single string.
# v9: major commercial/controlled airports and military bases are excluded from the pack.
# v10: translation cache is published with the pack (self-heal for the evictable CI cache).
# v11: merged community contributions (contributions/) are folded into notes and media.
# v13: Austrian AD 2 chart PDFs (Austro Control eAIP) attached to AT airfields.
PACK_SCHEMA_VERSION = 13

# Localized header for community-contributed note fragments ("Pilot report 2026-07-08: …").
CONTRIB_NOTE_HEADER = {"en": "Pilot report", "fr": "Rapport pilote", "de": "Pilotenbericht"}
# A contribution's stored field coordinates must be within this of a pack field to match by
# position (the fallback when the field id/code changed between pack rebuilds).
CONTRIB_MATCH_RADIUS_M = 1000.0

# App languages. Notes are emitted per language so the app can show them in the pilot's
# language; the map converts our short codes to the DeepL target-language codes.
APP_LANGUAGES = ("en", "fr", "de")
LANG_TO_DEEPL = {"en": "EN-GB", "fr": "FR", "de": "DE"}



class Progress:
    def __init__(self, total: int, label: str, width: int = 28) -> None:
        self.total = max(int(total), 0)
        self.label = label
        self.width = width
        self.current = 0
        self.started = time.monotonic()
        self.last_render = 0.0
        self.extra = ""
        self.render(force=True)

    def update(self, current: int | None = None, *, step: int = 0, extra: str = "", force: bool = False) -> None:
        if current is not None:
            self.current = max(0, min(int(current), self.total or int(current)))
        elif step:
            self.current = max(0, min(self.current + step, self.total or self.current + step))
        if extra:
            self.extra = extra
        now = time.monotonic()
        if force or now - self.last_render >= 0.25 or self.current >= self.total:
            self.render(force=force)

    def render(self, *, force: bool = False) -> None:
        self.last_render = time.monotonic()
        if self.total:
            ratio = min(1.0, self.current / self.total)
            filled = int(self.width * ratio)
            bar = "█" * filled + "░" * (self.width - filled)
            pct = int(ratio * 100)
            elapsed = max(0.1, time.monotonic() - self.started)
            rate = self.current / elapsed
            remaining = int((self.total - self.current) / rate) if rate > 0 and self.current < self.total else 0
            eta = f" ETA {remaining}s" if remaining else ""
            message = f"\r{self.label} [{bar}] {self.current}/{self.total} {pct:3d}%{eta} {self.extra}"
        else:
            message = f"\r{self.label}: {self.current} {self.extra}"
        print(message[:220], end="", file=sys.stderr, flush=True)

    def done(self, extra: str = "") -> None:
        if self.total:
            self.current = self.total
        if extra:
            self.extra = extra
        self.render(force=True)
        print("", file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cupx", default=DEFAULT_CUPX_URL, help="CUP/CUPX URL or local file path")
    parser.add_argument("--pack-id", default="fr-alps")
    parser.add_argument("--pack-name", default="France / Alps")
    parser.add_argument("--countries", nargs="+", default=["FR"], help="Countries to import from OpenAIP for glider-airfield candidates, e.g. FR CH IT")
    parser.add_argument("--airfield-source", choices=["openaip", "ourairports", "none"], default=os.environ.get("AIRFIELD_SOURCE", "openaip"), help="Source for VAC-only/glider airfield coordinates; OpenAIP is preferred")
    parser.add_argument("--openaip-api-key", default=os.environ.get("OPENAIP_API_KEY", ""), help="OpenAIP API key; prefer OPENAIP_API_KEY env var, never commit it")
    parser.add_argument("--openaip-base-url", default=os.environ.get("OPENAIP_API_BASE_URL", OPENAIP_API_BASE_URL), help="OpenAIP Core API base URL")
    parser.add_argument("--openaip-airports", default="", help="Optional local JSON/GeoJSON export or URL to use instead of the API. May be repeated as comma-separated paths.")
    parser.add_argument("--openaip-include-types", default=os.environ.get("OPENAIP_INCLUDE_TYPES", "1,2,6,11,13"), help="Comma-separated OpenAIP airport type numbers to include as glider-relevant. Default: 1 Glider Site, 2 Airfield Civil, 6 Ultra Light Flying Site, 11 Landing Strip, 13 Altiport. Use '1' for strict glider-site-only imports.")
    parser.add_argument("--dedupe-distance-m", type=float, default=float(os.environ.get("DEDUPE_DISTANCE_M", "350")), help="Merge fields with matching/similar codes or names inside this radius. Default 350 m.")
    parser.add_argument("--include-streckenflug", action="store_true", help="Scrape the public streckenflug.at landout list/detail pages and merge additional fields. Does not require the logged-in CUPX download.")
    parser.add_argument("--streckenflug-url", default=os.environ.get("STRECKENFLUG_URL", STRECKENFLUG_LIST_URL), help="Public streckenflug.at list URL to scrape")
    parser.add_argument("--streckenflug-countries", nargs="+", default=os.environ.get("STRECKENFLUG_COUNTRIES", "FR CH IT").split(), help="Countries to keep from streckenflug.at, default FR CH IT")
    parser.add_argument("--streckenflug-max-detail", type=int, default=int(os.environ.get("STRECKENFLUG_MAX_DETAIL", "0")), help="Debug limit for streckenflug detail pages; 0 means no limit")
    parser.add_argument("--streckenflug-workers", type=int, default=int(os.environ.get("STRECKENFLUG_WORKERS", "1")), help="Number of concurrent streckenflug detail/image workers. Default 1; use 4-8 for full builds.")
    parser.add_argument("--no-streckenflug-images", action="store_true", help="Import streckenflug.at fields but skip downloading their public full-resolution images")
    parser.add_argument("--vac-candidate-mode", choices=["glider", "pack", "all"], default="glider", help="Which official VAC candidates to try: glider OpenAIP/pack airfields, existing pack only, or every airport from the coordinate source")
    parser.add_argument("--out", default="data/packs/fr-alps", help="Output pack directory (single-pack), or the packs root directory when --multi-pack is set")
    parser.add_argument("--multi-pack", action="store_true", help="Build every pack in scripts/packs.py (FR/CH/DE/IT/AT country packs + Alps) from one merged, translated field set. --out is treated as the packs root; --countries/--streckenflug-countries are forced to all build countries.")
    parser.add_argument("--vac-root", default=os.environ.get("SIA_VAC_ROOT", "auto"), help="SIA VAC AD PDF directory URL ending in /AD, or auto to detect the current eAIP cycle")
    parser.add_argument("--vac-date", default=os.environ.get("SIA_VAC_DATE", "auto"), help="SIA VAC update/AIRAC date to show in attribution, or auto when --vac-root auto succeeds")
    parser.add_argument("--at-vac-root", default=os.environ.get("AT_VAC_ROOT", "auto"), help="Austro Control eAIP cycle base URL (…/lo/<YYMMDD>/), auto to detect the effective cycle, or none to disable Austrian charts")
    parser.add_argument("--max-vac", type=int, default=0, help="Debug limit for VAC downloads; 0 means no limit")
    parser.add_argument("--include-vac-airfields", action="store_true", help="Create VAC-only airfield entries when an LFxx VAC exists but the airfield is absent from the CUP")
    parser.add_argument("--airports-csv", default=os.environ.get("AIRPORTS_CSV", OURAIRPORTS_AIRPORTS_URL), help="Airport CSV URL/path with at least ident,name,latitude_deg,longitude_deg,elevation_ft; defaults to OurAirports")
    parser.add_argument("--runways-csv", default=os.environ.get("RUNWAYS_CSV", OURAIRPORTS_RUNWAYS_URL), help="Optional runway CSV URL/path, defaults to OurAirports runways.csv")
    parser.add_argument("--frequencies-csv", default=os.environ.get("FREQUENCIES_CSV", ""), help="Optional legacy frequency CSV URL/path. Disabled by default; OpenAIP/SIA/CUP notes are preferred.")
    parser.add_argument("--vac-codes", default="", help="Optional comma-separated ICAO codes or path/URL to a text file of ICAO codes to try. Use to limit/extend VAC candidates.")
    parser.add_argument("--keep-raw", action="store_true", help="Keep downloaded raw files in .cache")
    parser.add_argument("--deepl-api-key", default=os.environ.get("DEEPL_API_KEY", ""), help="DeepL API key for translating German streckenflug notes to English; prefer the DEEPL_API_KEY env var. Without it, an offline dictionary is used.")
    parser.add_argument("--deepl-api-url", default=os.environ.get("DEEPL_API_URL", ""), help="Override the DeepL endpoint. Auto-selected from the key (free keys end in ':fx') when unset.")
    parser.add_argument("--deepl-max-chars", type=int, default=int(os.environ.get("DEEPL_MAX_CHARS", "300000")), help="Safety cap on DeepL characters spent in a single build (also bounded by remaining lifetime quota). 0 disables the per-build cap. Protects the finite free-tier budget if the translation cache is ever missed.")
    parser.add_argument("--state-url", default=os.environ.get("PACK_STATE_URL", ""), help="URL of the previously published state.json. When set and the source fingerprint is unchanged, the build short-circuits (skips the rebuild and deploy).")
    parser.add_argument("--force-full", action="store_true", default=os.environ.get("FORCE_FULL", "").lower() in ("1", "true", "yes"), help="Ignore the incremental short-circuit and rebuild everything.")
    args = parser.parse_args()
    global DEDUPE_DISTANCE_M, DEEPL_API_KEY, DEEPL_API_URL, _DEEPL_BUDGET_CHARS
    DEDUPE_DISTANCE_M = float(args.dedupe_distance_m)
    DEEPL_API_KEY = args.deepl_api_key
    DEEPL_API_URL = resolve_deepl_api_url(args.deepl_api_key, args.deepl_api_url)
    if DEEPL_API_KEY:
        usage = deepl_usage()
        if usage:
            used, limit = usage
            remaining = max(0, limit - used)
            _DEEPL_BUDGET_CHARS = min(args.deepl_max_chars, remaining) if args.deepl_max_chars > 0 else remaining
            pct = (used / limit * 100) if limit else 0
            print(
                f"DeepL usage before build: {used:,}/{limit:,} ({pct:.1f}% of lifetime used); "
                f"this run may spend up to {_DEEPL_BUDGET_CHARS:,} chars",
                file=sys.stderr,
            )
        else:
            _DEEPL_BUDGET_CHARS = args.deepl_max_chars if args.deepl_max_chars > 0 else None
            print(f"DeepL usage endpoint unavailable; per-build cap = {_DEEPL_BUDGET_CHARS}", file=sys.stderr)

    root = Path.cwd()
    if args.multi_pack:
        # One merged build feeds every pack, so pull every build country and stage the media in
        # a shared tree that each pack later copies just the files it references from.
        args.countries = list(packs.BUILD_COUNTRIES)
        args.streckenflug_countries = list(packs.BUILD_COUNTRIES)
        out_root = root / args.out
        # Media is written once into a shared tree that every pack references (so a field shared
        # by, e.g., France and Alps is downloaded once), not copied per pack. This tree deploys.
        out_dir = out_root / "_shared"
        cache_dir = root / ".cache" / "_multi"
    else:
        out_root = None
        out_dir = root / args.out
        cache_dir = root / ".cache" / args.pack_id
    raw_dir = cache_dir / "raw"
    media_dir = out_dir / "media"
    docs_dir = out_dir / "docs" / "vac"

    # Persisted across runs (not under the per-pack cache_dir that gets wiped each build)
    # so the daily rebuild only translates new/changed strings. If the CI cache was evicted,
    # recover the copy published with the last deployed pack instead of re-translating.
    load_translation_cache(root / ".cache" / "translation-cache.json")
    seed_translation_cache_from_url(args.state_url)

    # Wipe the whole packs root in multi-pack mode (drops stale packs + old staging); otherwise
    # just the single pack directory.
    wipe_target = out_root if args.multi_pack else out_dir
    if wipe_target.exists():
        shutil.rmtree(wipe_target)
    media_dir.mkdir(parents=True, exist_ok=True)
    docs_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    # --- Level 0 incremental: skip the whole rebuild when no source changed ---
    # Resolve the VAC cycle up front so it can feed the fingerprint and be reused below.
    resolved_vac_root = ""
    resolved_vac_date = args.vac_date
    if args.vac_root and args.vac_root.lower() != "none":
        resolved_vac_root, inferred_vac_date = resolve_vac_root(args.vac_root, raw_dir)
        if resolved_vac_date.lower() == "auto":
            resolved_vac_date = inferred_vac_date or ""
    at_vac_base, at_vac_date, at_vac_index = resolve_at_vac_root(args.at_vac_root)
    source_state = build_source_state(
        cupx=source_version_tag(args.cupx),
        vac=resolved_vac_date or resolved_vac_root,
        vac_at=at_vac_date or at_vac_base,
        streckenflug=(
            streckenflug_list_fingerprint(args.streckenflug_url, args.streckenflug_countries, raw_dir)
            if args.include_streckenflug else ""
        ),
        contributions=contributions_fingerprint(root / "contributions"),
    )
    if args.state_url and not args.force_full:
        if source_states_match(read_previous_state(args.state_url), source_state):
            print(f"No source changes since last build (schema {PACK_SCHEMA_VERSION}); skipping rebuild.", file=sys.stderr)
            write_build_status(root, changed=False)
            return
    print(f"Building pack (schema {PACK_SCHEMA_VERSION}); fingerprint {source_state}", file=sys.stderr)

    blob = read_bytes(args.cupx, raw_dir)
    cup_text, pictures = extract_cup_and_pictures(blob)
    fields = parse_cup(cup_text, args.pack_id)
    copied_media = copy_referenced_pictures(fields, pictures, media_dir)

    frequency_index: dict[str, list[dict[str, Any]]] = {}
    if args.frequencies_csv and args.include_vac_airfields:
        frequency_index = load_frequency_index(args.frequencies_csv, raw_dir)
        apply_frequency_index(fields, frequency_index)

    vac_count = 0
    vac_created_airfields = 0

    airport_index: dict[str, dict[str, Any]] = {}
    runway_index: dict[str, dict[str, Any]] = {}
    extra_codes: set[str] = set()
    if resolved_vac_root:
        if args.include_vac_airfields:
            if args.airfield_source == "openaip":
                # ICAO codes we already hold from the Guide parse. OpenAIP records for these
                # codes are kept regardless of type so their authoritative names win on merge.
                known_icao_codes = {
                    code
                    for f in fields
                    if (code := clean(f.get("code")).upper()) and re.fullmatch(r"[A-Z]{4}", code)
                }
                airport_index, runway_index, openaip_frequency_index = load_openaip_airfields(
                    countries=args.countries,
                    raw_dir=raw_dir,
                    api_key=args.openaip_api_key,
                    base_url=args.openaip_base_url,
                    local_sources=args.openaip_airports,
                    include_type_codes=parse_int_set(args.openaip_include_types),
                    candidate_mode=args.vac_candidate_mode,
                    known_codes=known_icao_codes,
                )
                merge_frequency_indexes(frequency_index, openaip_frequency_index)
                apply_frequency_index(fields, frequency_index)
            elif args.airfield_source == "ourairports":
                airport_index = load_airport_index(args.airports_csv, raw_dir, countries=args.countries)
                runway_index = load_runway_index(args.runways_csv, raw_dir, countries=args.countries)
            else:
                airport_index = {}
                runway_index = {}
        if airport_index:
            add_airfield_entries_from_index(fields, airport_index, runway_index, frequency_index, args.pack_id, args.vac_candidate_mode)
        extra_codes = parse_vac_codes(args.vac_codes, raw_dir)

    streckenflug_count = 0
    streckenflug_media_count = 0
    streckenflug_fields: list[dict[str, Any]] = []

    at_vac_count = 0

    # VAC imports (FR + AT) and streckenflug are independent network-heavy tasks after
    # OpenAIP/candidate preparation. Run them in parallel to avoid sitting idle on one
    # remote source while the others could already be downloading. The importers mutate
    # disjoint fields (LF vs LO codes), so concurrent attachment is safe.
    futures: dict[Any, str] = {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        if at_vac_index:
            futures[executor.submit(
                import_at_vac_pdfs,
                fields=fields,
                ad2_index=at_vac_index,
                docs_dir=docs_dir,
                at_vac_date=at_vac_date,
                max_vac=args.max_vac,
            )] = "at_vac"
        if resolved_vac_root:
            futures[executor.submit(
                import_vac_pdfs,
                fields=fields,
                vac_root=resolved_vac_root,
                docs_dir=docs_dir,
                vac_date=resolved_vac_date,
                max_vac=args.max_vac,
                airport_index=airport_index,
                runway_index=runway_index,
                frequency_index=frequency_index,
                extra_codes=extra_codes,
                pack_id=args.pack_id,
            )] = "vac"
        if args.include_streckenflug:
            futures[executor.submit(
                load_streckenflug_fields,
                args.streckenflug_url,
                raw_dir,
                workers=args.streckenflug_workers,
                media_dir=media_dir,
                pack_id=args.pack_id,
                countries=args.streckenflug_countries,
                max_detail=args.streckenflug_max_detail,
                include_images=not args.no_streckenflug_images,
            )] = "streckenflug"

        for future in as_completed(futures):
            task = futures[future]
            if task == "vac":
                vac_result = future.result()
                vac_count = vac_result["downloaded"]
                vac_created_airfields = vac_result["createdAirfields"]
            elif task == "at_vac":
                at_vac_count = future.result()
            elif task == "streckenflug":
                streckenflug_fields = future.result()
                streckenflug_count = len(streckenflug_fields)
                streckenflug_media_count = count_media_items(streckenflug_fields)

    if streckenflug_fields:
        fields.extend(streckenflug_fields)

    # Drop major airports / military bases (any source) before translating or merging: a glider
    # must not land there, and they otherwise dominate the pinned "best options" list.
    fields = drop_major_airports(fields)

    # Localize each note into every app language (en/fr/de) while the field still has a single
    # source, so the note stays native in its source language and is translated only into the
    # other two. Merging then combines the per-language notes fragment by fragment.
    localize_field_notes(fields)
    fields = consolidate_duplicate_fields(fields)
    # Fold in merged community contributions (reviewed via PR): localized dated note fragments
    # plus pack-optimized copies of contributed photos. After consolidation so contribution
    # field ids line up with the published pack.
    contrib_notes, contrib_photos = merge_contributions(fields, root / "contributions", media_dir)
    fields.sort(key=lambda f: (0 if f.get("kind") == "outlanding" else 1, str(f.get("name", ""))))

    generated_at = dt.datetime.now(dt.UTC).isoformat()
    version = source_state_version(source_state)
    sources = build_pack_sources(args, resolved_vac_root, resolved_vac_date, frequency_index, at_vac_base, at_vac_date)

    if args.multi_pack:
        # Slice the one merged, translated field set into every pack (media staged in out_dir).
        write_multi_packs(
            fields, packs.PACK_DEFINITIONS, out_dir, out_root,
            version=version, generated_at=generated_at, source_state=source_state,
            sources=sources, notices=PACK_NOTICES,
        )
    else:
        (out_dir / "fields.json").write_text(json.dumps(fields, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest = {
            "id": args.pack_id,
            "name": args.pack_name,
            "version": version,
            "generatedAt": generated_at,
            "isSample": False,
            "fieldsUrl": "fields.json",
            "fieldsCount": len(fields),
            "mediaCount": count_media_items(fields),
            "vacCount": vac_count,
            "atVacCount": at_vac_count,
            "vacOnlyAirfieldsCreated": vac_created_airfields,
            "streckenflugCount": streckenflug_count,
            "contributionNotes": contrib_notes,
            "contributionPhotos": contrib_photos,
            "sources": sources,
            "notices": PACK_NOTICES,
        }
        (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        # Per-file hash+size manifest so the app can download only changed media/docs.
        write_media_manifest(out_dir, version)
        # Publish the source fingerprint so the next build can detect "nothing changed".
        state_out = dict(source_state)
        state_out["builtAt"] = generated_at
        (out_dir / "state.json").write_text(json.dumps(state_out, ensure_ascii=False, indent=2), encoding="utf-8")
        # Publish the cache with the pack (next to state.json) so an evicted CI cache can be
        # re-seeded on the next build — see seed_translation_cache_from_url.
        (out_dir / "translation-cache.json").write_text(
            json.dumps(_TRANSLATION_CACHE, ensure_ascii=False, sort_keys=True, indent=0),
            encoding="utf-8",
        )

    write_build_status(root, changed=True)
    save_translation_cache()

    if not args.keep_raw:
        shutil.rmtree(cache_dir, ignore_errors=True)

    stats = _TRANSLATION_STATS
    translate_engine = "DeepL" if DEEPL_API_KEY and not _DEEPL_DISABLED else ("DeepL(disabled)" if DEEPL_API_KEY else "dictionary")
    print(
        f"Translation ({translate_engine}): {stats['deepl']} translated, "
        f"{stats['cache']} cached, {stats['fallback']} dictionary-fallback; "
        f"~{_DEEPL_CHARS_SPENT:,} DeepL chars spent this run",
        file=sys.stderr,
    )
    if DEEPL_API_KEY:
        usage = deepl_usage()
        if usage:
            used, limit = usage
            pct = (used / limit * 100) if limit else 0
            print(f"DeepL usage after build: {used:,}/{limit:,} ({pct:.1f}% of lifetime used)", file=sys.stderr)
    label = f"{len(packs.PACK_DEFINITIONS)} packs" if args.multi_pack else args.pack_name
    print(
        f"Built {label}: {len(fields)} merged entries, {copied_media} CUP photos, "
        f"{vac_count} FR + {at_vac_count} AT VAC PDFs, {vac_created_airfields} VAC-only airfields, "
        f"{streckenflug_count} streckenflug fields, {streckenflug_media_count} streckenflug images"
    )


def read_bytes(url_or_path: str, raw_dir: Path) -> bytes:
    if re.match(r"^https?://", url_or_path):
        target = raw_dir / Path(urllib.parse.urlparse(url_or_path).path).name
        request = urllib.request.Request(url_or_path, headers={"User-Agent": "MeetTheCows/0.4"})
        print(f"Downloading {url_or_path}", file=sys.stderr)
        chunks: list[bytes] = []
        with urllib.request.urlopen(request, timeout=120) as response:
            content_length = response.headers.get("Content-Length")
            total = int(content_length) if content_length and content_length.isdigit() else 0
            progress = Progress(total, f"Download {target.name}") if total else None
            downloaded = 0
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                chunks.append(chunk)
                downloaded += len(chunk)
                if progress:
                    progress.update(downloaded, extra=f"{downloaded / 1024 / 1024:.1f} MB")
            if progress:
                progress.done(f"{downloaded / 1024 / 1024:.1f} MB")
        data = b"".join(chunks)
        target.write_bytes(data)
        if not total:
            print(f"Downloaded {target.name}: {len(data) / 1024 / 1024:.1f} MB", file=sys.stderr)
        return data
    return Path(url_or_path).read_bytes()


def read_text(url_or_path: str, raw_dir: Path) -> str:
    data = read_bytes(url_or_path, raw_dir)
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


# --- Incremental build (Level 0): fingerprint the sources to skip unchanged rebuilds ---

def source_version_tag(url_or_path: str) -> str:
    """Cheap change signal for a remote/local file: ETag/Last-Modified, or size+mtime."""
    if re.match(r"^https?://", url_or_path, re.I):
        try:
            request = urllib.request.Request(url_or_path, method="HEAD")
            with urllib.request.urlopen(request, timeout=30) as response:
                tag = response.headers.get("ETag") or response.headers.get("Last-Modified") or ""
            return tag.strip('"')
        except Exception as error:  # noqa: BLE001 - unknown version -> force rebuild (safe)
            print(f"version check failed for {url_or_path}: {error}", file=sys.stderr)
            return ""
    path = Path(url_or_path)
    if path.exists():
        stat = path.stat()
        return f"{stat.st_size}-{int(stat.st_mtime)}"
    return ""


def extract_streckenflug_list_versions(page: str) -> list[tuple[str, str]]:
    """From a streckenflug list page, return (id, visit-year) pairs (the change signal)."""
    pairs: list[tuple[str, str]] = []
    for row_match in re.finditer(r"<tr\b[^>]*>(?P<row>.*?)</tr>", page, re.I | re.S):
        row = row_match.group("row")
        id_match = re.search(r"iID=(\d+)", row)
        if not id_match:
            continue
        cells = re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.I | re.S)
        visit = normalize_space(strip_html(cells[4])) if len(cells) > 4 else ""
        pairs.append((id_match.group(1), visit))
    return pairs


def streckenflug_list_fingerprint(list_url: str, countries: Sequence[str], raw_dir: Path) -> str:
    """Hash of (id, visit-year) across the country list pages. Year-granular by design."""
    entries: list[str] = []
    for country in countries:
        url = streckenflug_country_list_url(list_url, str(country).upper())
        try:
            page = read_text(url, raw_dir)
        except Exception as error:  # noqa: BLE001 - unknown -> force rebuild (safe)
            print(f"streckenflug list fingerprint failed for {country}: {error}", file=sys.stderr)
            return ""
        entries.extend(f"{iid}:{visit}" for iid, visit in extract_streckenflug_list_versions(page))
    entries.sort()
    return hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()[:16]


def build_source_state(*, cupx: str, vac: str, streckenflug: str, contributions: str = "", vac_at: str = "") -> dict[str, Any]:
    return {
        "schemaVersion": PACK_SCHEMA_VERSION,
        "cupx": cupx,
        "vac": vac,
        "vacAt": vac_at,
        "streckenflug": streckenflug,
        "contributions": contributions,
    }


def contributions_fingerprint(contrib_dir: Path) -> str:
    """Change signal for merged community contributions: hash of every JSON path + content.

    Part of the source fingerprint so merging a contribution PR triggers a rebuild+deploy on
    the next run even when the upstream aviation sources are unchanged. Empty when there are
    no contributions.
    """
    if not contrib_dir.exists():
        return ""
    entries: list[str] = []
    for path in sorted(contrib_dir.rglob("*.json")):
        entries.append(f"{path.relative_to(contrib_dir).as_posix()}:{hashlib.sha1(path.read_bytes()).hexdigest()[:12]}")
    if not entries:
        return ""
    return hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()[:16]


def source_states_match(previous: dict[str, Any] | None, current: dict[str, Any]) -> bool:
    if not previous:
        return False
    keys = ("schemaVersion", "cupx", "vac", "vacAt", "streckenflug", "contributions")
    return all(str(previous.get(k) or "") == str(current.get(k) or "") for k in keys)


def source_state_version(source_state: dict[str, Any]) -> str:
    """Content-stable pack version: a short hash of the source fingerprint.

    The app shows "New field data available" whenever this differs from the version the pilot
    last synced. Deriving it from the source state (schema + upstream fingerprints) rather than
    the build clock means a rebuild that changed nothing upstream — notably the weekly Sunday
    full refresh — keeps the same version and does NOT prompt every pilot to re-download the
    pack. It advances only when a source actually advances (new CUPX, VAC cycle, or streckenflug
    edit) or the schema is bumped.
    """
    payload = json.dumps(source_state, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def read_previous_state(state_url: str) -> dict[str, Any] | None:
    """Fetch the last published state.json (fresh, no cache). None if missing/unreadable."""
    if not state_url:
        return None
    try:
        request = urllib.request.Request(state_url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001 - missing state (first build) -> rebuild
        return None


def write_build_status(root: Path, *, changed: bool) -> None:
    """Signal the CI workflow whether a deploy is needed (skip when nothing changed)."""
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        try:
            with open(gh_output, "a", encoding="utf-8") as handle:
                handle.write(f"changed={'true' if changed else 'false'}\n")
        except Exception as error:  # noqa: BLE001
            print(f"could not write GITHUB_OUTPUT: {error}", file=sys.stderr)
    (root / "build-status.json").write_text(json.dumps({"changed": changed}), encoding="utf-8")


def write_media_manifest(out_dir: Path, version: str) -> int:
    """Emit media-manifest.json: pack-relative path -> {hash, size} for every media/doc file.

    The app diffs this against its last-synced copy to download only new/changed files and
    evict removed ones, instead of re-downloading the whole pack on every data update.
    """
    files: dict[str, dict[str, Any]] = {}
    for sub in ("media", "docs"):
        base = out_dir / sub
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            data = path.read_bytes()
            rel = path.relative_to(out_dir).as_posix()
            files[rel] = {"h": hashlib.sha1(data).hexdigest()[:16], "s": len(data)}
    payload = {"version": version, "count": len(files), "files": files}
    (out_dir / "media-manifest.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return len(files)


# ---------------------------------------------------------------------------
# Multi-pack output: one merged, translated field set is sliced into several
# packs (country packs + the Alps geofence pack). Each pack is self-contained —
# it carries copies of just the media/docs its own fields reference — so it can
# be downloaded on its own. Field ids are pack-independent (stable_id has no
# pack component), so a field shared by, say, the France and Alps packs keeps
# the same id and the app dedupes it when both packs are loaded.
# ---------------------------------------------------------------------------

def pack_media_refs(fields: Iterable[dict[str, Any]]) -> set[str]:
    """Pack-relative media/doc paths (media[].url, thumbnailUrl, docs.vac) referenced by
    `fields`. Absolute URLs are skipped — only local files get copied into a pack."""
    refs: set[str] = set()
    for field in fields:
        for item in field.get("media") or []:
            for key in ("url", "thumbnailUrl"):
                url = clean(item.get(key))
                if url and "://" not in url:
                    refs.add(url)
        vac = clean((field.get("docs") or {}).get("vac"))
        if vac and "://" not in vac:
            refs.add(vac)
    return refs


def copy_pack_media(refs: set[str], staging_dir: Path, pack_dir: Path) -> tuple[int, int]:
    """Copy each referenced file from the shared staging tree into the pack, preserving its
    relative path so the stored media URLs still resolve. Returns (files copied, total bytes)."""
    copied = 0
    total = 0
    for rel in sorted(refs):
        src = staging_dir / rel
        if not src.is_file():
            print(f"  media ref missing in staging: {rel}", file=sys.stderr)
            continue
        dst = pack_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        copied += 1
        total += src.stat().st_size
    return copied, total


def pack_selector_label(pack_def: dict[str, Any]) -> str:
    if pack_def.get("geofence"):
        return f"geofence:{pack_def['geofence']}"
    return "countries:" + ",".join(pack_def.get("countries", ()))


def shared_media_bytes(subset: list[dict[str, Any]]) -> tuple[int, int]:
    """(unique media file count, total bytes) a pack references from the shared tree, deduped by
    URL — media items carry a `bytes` size stamped by finalize_shared_media()."""
    seen: set[str] = set()
    total = 0
    for field in subset:
        for item in field.get("media") or []:
            url = clean(item.get("url"))
            if url and url not in seen:
                seen.add(url)
                total += int(item.get("bytes") or 0)
    return len(seen), total


def write_pack(
    pack_def: dict[str, Any],
    subset: list[dict[str, Any]],
    staging_dir: Path,
    out_root: Path,
    *,
    version: str,
    generated_at: str,
    source_state: dict[str, Any],
    sources: list[dict[str, Any]],
    notices: list[str],
    shared_media: bool = False,
) -> dict[str, Any]:
    """Write one pack directory (fields.json, manifest.json, state.json — plus media/docs copies
    and a media-manifest in self-contained mode) and return its manifest with sizes.

    In shared_media mode the media lives once in the packs' _shared tree and each field already
    references it (via finalize_shared_media), so nothing is copied and sizeBytes is the pack's
    footprint of that shared tree (fields.json + the unique files it references)."""
    pack_dir = out_root / pack_def["id"]
    if pack_dir.exists():
        shutil.rmtree(pack_dir)
    pack_dir.mkdir(parents=True)

    subset = sorted(subset, key=lambda f: (0 if f.get("kind") == "outlanding" else 1, str(f.get("name", ""))))
    fields_bytes = json.dumps(subset, ensure_ascii=False, indent=2).encode("utf-8")
    (pack_dir / "fields.json").write_bytes(fields_bytes)

    if shared_media:
        media_files, media_bytes = shared_media_bytes(subset)
    else:
        media_files, media_bytes = copy_pack_media(pack_media_refs(subset), staging_dir, pack_dir)

    # Localized display names travel with the pack so the app can show each in the pilot's
    # language; `name` stays as an English default for any non-localizing consumer.
    names = pack_def.get("names") or {"en": pack_def.get("name") or pack_def["id"]}
    display_name = names.get("en") or next(iter(names.values()), pack_def["id"])
    manifest = {
        "id": pack_def["id"],
        "name": display_name,
        "names": names,
        "version": version,
        "generatedAt": generated_at,
        "isSample": False,
        "fieldsUrl": "fields.json",
        "fieldsCount": len(subset),
        "mediaCount": count_media_items(subset),
        "mediaFiles": media_files,
        "fieldsBytes": len(fields_bytes),
        # This pack's own footprint (fields.json + the media it references). The app sums fieldsBytes
        # across the selection and unions media by URL for the true combined download size.
        "sizeBytes": len(fields_bytes) + media_bytes,
        "selector": pack_selector_label(pack_def),
        "sources": sources,
        "notices": notices,
    }
    (pack_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if not shared_media:
        write_media_manifest(pack_dir, version)

    state_out = dict(source_state)
    state_out["builtAt"] = generated_at
    (pack_dir / "state.json").write_text(json.dumps(state_out, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def write_packs_index(manifests: list[dict[str, Any]], out_root: Path) -> None:
    """Write packs.json listing every built pack with its size, for the app's pack picker."""
    index = {
        "schemaVersion": 2,
        "updatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "packs": [
            {
                "id": m["id"],
                "name": m["name"],
                "names": m.get("names"),
                "manifestUrl": f"packs/{m['id']}/manifest.json",
                "sizeBytes": m["sizeBytes"],
                "fieldsCount": m["fieldsCount"],
            }
            for m in manifests
        ],
    }
    (out_root / "packs.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


# Shared across every pack in a build (the sources differ only by the args, the notices are fixed).
PACK_NOTICES = [
    "Not for primary navigation. Straight-line distance/glide only: no wind, sink, terrain clearance or airspace.",
    "Check official/current SIA (FR) and Austro Control (AT) documents before flight. VAC/AD chart PDFs are cycle-specific.",
    "VAC-only airfield coordinates may come from a non-authoritative open dataset; the attached SIA VAC is the official source.",
]


def build_pack_sources(args, resolved_vac_root: str, resolved_vac_date: str,
                       frequency_index: dict[str, Any],
                       at_vac_base: str = "", at_vac_date: str = "") -> list[dict[str, Any]]:
    """The attribution/sources block shared by every pack's manifest."""
    return [
        {
            "name": "planeur-net / Guide des Aires de Sécurité",
            "url": str(args.cupx),
            "note": "Outlanding data and photos; verify upstream permission/licence before rehosting publicly.",
        },
        {
            "name": "Service de l’Information Aéronautique (SIA) VAC",
            "url": resolved_vac_root or "not imported",
            "updatedAt": resolved_vac_date or None,
            "licence": "Licence Ouverte for SIA public digital products, subject to attribution and no misrepresentation.",
        },
        {
            "name": "Austro Control eAIP (AIP Austria) AD 2 charts",
            "url": at_vac_base or "not imported",
            "updatedAt": at_vac_date or None,
            "note": "Official Austrian aerodrome charts; non-commercial use — commercial reproduction requires Austro Control's written consent.",
        },
        {
            "name": "OpenAIP glider airfields" if args.airfield_source == "openaip" else "OurAirports airport/runway coordinates",
            "url": args.openaip_base_url if args.airfield_source == "openaip" else (args.airports_csv if args.include_vac_airfields else "not used"),
            "countries": [str(c).upper() for c in args.countries],
            "note": "Used to discover glider-relevant official airfields and coordinates; verify official country AIP/VAC documents.",
        },
        {
            "name": "streckenflug.at Landout Database",
            "url": args.streckenflug_url if args.include_streckenflug else "not used",
            "countries": [str(c).upper() for c in args.streckenflug_countries] if args.include_streckenflug else [],
            "note": "Public list/detail pages scraped when enabled. Additional landout source; verify against current local knowledge before flight.",
        },
        {
            "name": "Radio frequency sources",
            "url": "SIA VAC text/OpenAIP/CUP notes" if frequency_index else "not used",
            "note": "Frequencies are helper data only; verify current official VAC/AIP publications before use.",
        },
    ]


def finalize_shared_media(fields: list[dict[str, Any]], shared_dir: Path) -> None:
    """Stamp each media item with its file size (`bytes`) and rewrite its URL to point at the
    shared _shared tree, so every pack references one copy. Idempotent (skips already-rewritten
    URLs and absolute URLs). Applied to the merged fields once, before slicing into packs."""
    for field in fields:
        for item in field.get("media") or []:
            for key in ("url", "thumbnailUrl"):
                rel = clean(item.get(key))
                if not rel or "://" in rel or rel.startswith("../_shared/"):
                    continue
                if key == "url":
                    path = shared_dir / rel
                    if path.is_file():
                        item["bytes"] = path.stat().st_size
                item[key] = f"../_shared/{rel}"
        docs = field.get("docs")
        if isinstance(docs, dict):
            vac = clean(docs.get("vac"))
            if vac and "://" not in vac and not vac.startswith("../_shared/"):
                docs["vac"] = f"../_shared/{vac}"


def write_multi_packs(
    fields: list[dict[str, Any]],
    pack_defs: Sequence[dict[str, Any]],
    staging_dir: Path,
    out_root: Path,
    *,
    version: str,
    generated_at: str,
    source_state: dict[str, Any],
    sources: list[dict[str, Any]],
    notices: list[str],
) -> list[dict[str, Any]]:
    """Slice the merged field set into every pack, then write packs.json. Media is shared: it lives
    once in staging_dir (the deployed _shared tree) and every field references it. The translation
    cache is published next to each pack's state.json so an evicted CI cache can self-heal."""
    finalize_shared_media(fields, staging_dir)
    cache_blob = json.dumps(_TRANSLATION_CACHE, ensure_ascii=False, sort_keys=True, indent=0)
    manifests: list[dict[str, Any]] = []
    for pack_def in pack_defs:
        subset = packs.select_pack_fields(fields, pack_def)
        manifest = write_pack(
            pack_def, subset, staging_dir, out_root,
            version=version, generated_at=generated_at, source_state=source_state,
            sources=sources, notices=notices, shared_media=True,
        )
        (out_root / pack_def["id"] / "translation-cache.json").write_text(cache_blob, encoding="utf-8")
        manifests.append(manifest)
        print(
            f"  pack {pack_def['id']:5} : {manifest['fieldsCount']:4d} fields, "
            f"{manifest['mediaFiles']:4d} media files, {manifest['sizeBytes'] / 1e6:6.1f} MB",
            file=sys.stderr,
        )
    write_packs_index(manifests, out_root)
    print(f"Wrote {len(manifests)} packs + packs.json to {out_root}", file=sys.stderr)
    return manifests


def extract_cup_and_pictures(blob: bytes) -> tuple[str, dict[str, bytes]]:
    """Return POINTS.CUP text and a mapping of media filename -> bytes."""
    zips = split_concatenated_zips(blob)
    if not zips:
        # Fallback: maybe this is a plain CUP file.
        try:
            return blob.decode("utf-8-sig"), {}
        except UnicodeDecodeError:
            return blob.decode("latin-1"), {}

    pictures: dict[str, bytes] = {}
    cup_text = ""
    for zip_bytes in zips:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for name in zf.namelist():
                lower = name.lower()
                if lower.endswith("points.cup") or lower.endswith(".cup"):
                    raw = zf.read(name)
                    try:
                        cup_text = raw.decode("utf-8-sig")
                    except UnicodeDecodeError:
                        cup_text = raw.decode("latin-1")
                elif Path(name).suffix.lower() in MEDIA_EXTS:
                    pictures[Path(name).name] = zf.read(name)
    if not cup_text:
        raise RuntimeError("No POINTS.CUP/.cup found in CUPX")
    return cup_text, pictures


def split_concatenated_zips(blob: bytes) -> list[bytes]:
    eocd_sig = b"PK\x05\x06"
    ends: list[int] = []
    start = 0
    while True:
        pos = blob.find(eocd_sig, start)
        if pos < 0:
            break
        if pos + 22 <= len(blob):
            comment_len = int.from_bytes(blob[pos + 20:pos + 22], "little")
            end = pos + 22 + comment_len
            if end <= len(blob):
                ends.append(end)
        start = pos + 4

    parts = []
    previous = 0
    for end in ends:
        candidate = blob[previous:end]
        if is_zip(candidate):
            parts.append(candidate)
            previous = end
    if previous < len(blob):
        candidate = blob[previous:]
        if is_zip(candidate):
            parts.append(candidate)
    if not parts and is_zip(blob):
        parts.append(blob)
    return parts


def is_zip(data: bytes) -> bool:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.testzip()
        return True
    except Exception:
        return False


def parse_cup(cup_text: str, pack_id: str) -> list[dict[str, Any]]:
    # Some CUP files are missing a newline after the header. Fix the common case so csv.DictReader works.
    cup_text = cup_text.replace('pics "version="', 'pics\n"version="', 1)
    rows = csv.DictReader(io.StringIO(cup_text))
    fields: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        name = clean(row.get("name"))
        if not name or name.lower().startswith("version="):
            continue
        lat = parse_coord(clean(row.get("lat")), is_lat=True)
        lon = parse_coord(clean(row.get("lon")), is_lat=False)
        if lat is None or lon is None:
            continue
        code = clean(row.get("code"))
        country = clean(row.get("country")) or ""
        elevation_m = parse_length(clean(row.get("elev")))
        length_m = parse_length(clean(row.get("rwlen")))
        width_m = parse_width(row)
        direction_deg = parse_float(clean(row.get("rwdir")))
        notes = clean(row.get("desc")) or clean(row.get("comment")) or ""
        raw_difficulty, difficulty = extract_difficulty(notes, row)
        media_refs = parse_media_refs(row)
        frequencies = extract_frequencies_from_row(row, notes)
        kind = "airfield" if raw_difficulty in {"aerodrome", "terrain", "altiport", "velisurface"} or ICAO_FR_RE.match(code.upper() or "") else "outlanding"
        field_id = stable_id(country or "xx", code, name, lat, lon)
        if field_id in seen:
            field_id = f"{field_id}_{len(seen)}"
        seen.add(field_id)
        fields.append({
            "id": field_id,
            "kind": kind,
            "name": name,
            "code": code,
            "country": country,
            "latitude": round(lat, 7),
            "longitude": round(lon, 7),
            "elevationM": elevation_m,
            "difficulty": difficulty,
            "rawDifficulty": raw_difficulty,
            "lengthM": length_m,
            "widthM": width_m,
            "runwayDirectionDeg": direction_deg,
            "frequency": format_frequency_short(frequencies),
            "frequencies": frequencies,
            "notes": strip_difficulty_tags(notes),
            "source": {
                "name": "planeur-net / Guide des Aires de Sécurité",
                "importedAt": dt.date.today().isoformat(),
                "packId": pack_id,
            },
            "_mediaRefs": media_refs,
            "media": [],
        })
    return fields


def parse_coord(value: str, *, is_lat: bool) -> float | None:
    if not value:
        return None
    value = value.strip().upper()
    # CUP format: DDMM.mmmN / DDDMM.mmmE
    match = re.match(r"^(\d{2,3})(\d{2}\.\d+)([NSEW])$", value)
    if match:
        deg_len = 2 if is_lat else 3
        deg = int(value[:deg_len])
        minutes = float(value[deg_len:-1])
        sign = -1 if value[-1] in {"S", "W"} else 1
        return sign * (deg + minutes / 60)
    # Decimal fallback.
    try:
        return float(value)
    except ValueError:
        return None


def parse_length(value: str) -> float | None:
    if not value:
        return None
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*(m|ft)?", value, flags=re.I)
    if not match:
        return None
    number = float(match.group(1))
    unit = (match.group(2) or "m").lower()
    return round(number * 0.3048, 1) if unit == "ft" else round(number, 1)


def parse_width(row: dict[str, Any]) -> float | None:
    for key in ("rwwidth", "width", "rw_width"):
        width = parse_length(clean(row.get(key)))
        if width:
            return width
    text = " ".join(clean(row.get(k)) for k in ("desc", "comment", "userdata") if row.get(k))
    match = re.search(r"(\d{2,4})\s*[x×]\s*(\d{1,3})\s*m?", text, flags=re.I)
    if match:
        return float(match.group(2))
    return None


def extract_difficulty(notes: str, row: dict[str, Any]) -> tuple[str, str]:
    text = " ".join(str(v or "") for v in [notes, row.get("userdata"), row.get("type")])
    tags = [t.strip().lower() for t in re.findall(r"\{([^}]+)\}", text)]
    for tag in tags:
        if tag in DIFFICULTY_MAP:
            return tag, DIFFICULTY_MAP[tag]
    style = clean(row.get("style"))
    if style == "5":
        return "aerodrome", "A"
    return "unknown", "UNKNOWN"


def strip_difficulty_tags(notes: str) -> str:
    return re.sub(r"\s*\{[^}]+\}\s*", " ", notes).strip()


def parse_media_refs(row: dict[str, Any]) -> list[str]:
    refs = []
    text = " ".join(clean(row.get(k)) for k in ("pics", "images", "files") if row.get(k))
    if not text:
        return []
    for token in re.split(r"[;|,\s]+", text):
        token = token.strip().strip('"')
        if Path(token).suffix.lower() in MEDIA_EXTS:
            refs.append(Path(token).name)
    return refs


def copy_referenced_pictures(fields: list[dict[str, Any]], pictures: dict[str, bytes], media_dir: Path) -> int:
    copied = 0
    for field in fields:
        refs = field.pop("_mediaRefs", [])
        field_dir = media_dir / field["id"]
        for ref in refs:
            blob = pictures.get(ref)
            if not blob:
                continue
            field_dir.mkdir(parents=True, exist_ok=True)
            original_name = safe_filename(ref)
            source_ext = Path(original_name).suffix.lower()
            if source_ext == ".pdf":
                target_name = original_name
                target = field_dir / target_name
                target.write_bytes(blob)
                kind = "pdf"
            else:
                target_name = f"{Path(original_name).stem}.jpg"
                target = field_dir / target_name
                write_optimized_jpeg_image(blob, target)
                kind = "image"
            copied += 1
            field["media"].append({
                "type": kind,
                "url": f"media/{field['id']}/{target_name}",
                "caption": ref,
                "source": "Guide des Aires de Sécurité",
            })
    return copied


def extract_frequencies_from_row(row: dict[str, Any], notes: str) -> list[dict[str, Any]]:
    text_parts = [notes]
    for key in ("freq", "frequency", "frequence", "fréquence", "radio", "userdata", "comment", "desc"):
        value = clean(row.get(key))
        if value:
            text_parts.append(value)
    return extract_frequencies_from_text(" ".join(text_parts), source="CUP notes")


def extract_frequencies_from_text(text: str, *, source: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in re.finditer(r"(?<!\d)(1[1-3][0-9])[\.,](\d{1,3})(?!\d)", text or ""):
        mhz = float(f"{match.group(1)}.{match.group(2).ljust(3, '0')[:3]}")
        if not 118.0 <= mhz <= 137.0:
            continue
        key = f"{mhz:.3f}"
        if key in seen:
            continue
        seen.add(key)
        # Try to pick up a nearby label such as AFIS/TWR/A/A.
        window = text[max(0, match.start() - 24): min(len(text), match.end() + 24)].upper()
        freq_type = ""
        for candidate in ("AFIS", "TWR", "TOUR", "A/A", "AUTO", "INFO", "APP", "ATIS", "ATF", "CTAF", "UNICOM"):
            if candidate in window:
                freq_type = candidate
                break
        found.append({"mhz": round(mhz, 3), "type": freq_type, "source": source})
    return found



def merge_frequency_lists(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for freqs in lists:
        for item in freqs or []:
            mhz = item.get("mhz")
            if not isinstance(mhz, (int, float)):
                continue
            key = f"{float(mhz):.3f}"
            if key in seen:
                continue
            merged.append(dict(item))
            seen.add(key)
    merged.sort(key=frequency_sort_key)
    return merged


_PYPDF_MISSING_WARNED = False


def extract_frequencies_from_pdf_bytes(data: bytes, *, source: str) -> list[dict[str, Any]]:
    global _PYPDF_MISSING_WARNED
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        # Never let a missing dependency silently strip VAC frequencies from the pack.
        if not _PYPDF_MISSING_WARNED:
            _PYPDF_MISSING_WARNED = True
            print("WARNING: pypdf is not installed; VAC PDF frequency extraction is disabled. Run: python -m pip install -r requirements.txt", file=sys.stderr)
        return []
    text = ""
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = []
        for page in reader.pages[:3]:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pass
        text = "\n".join(pages)
    except Exception:
        return []
    freqs = extract_frequencies_from_text(text, source=source)
    # SIA VAC pages contain many frequencies; keep all but prefer airfield-operational labels.
    return sorted(freqs, key=frequency_sort_key)

def format_frequency_short(frequencies: list[dict[str, Any]]) -> str:
    if not frequencies:
        return ""
    first = frequencies[0]
    mhz = first.get("mhz")
    mhz_text = f"{float(mhz):.3f}" if isinstance(mhz, (int, float)) else ""
    freq_type = clean(first.get("type"))
    if freq_type.isdigit() or freq_type.upper() in {"OTHER", "UNKNOWN", "N/A", "NA"}:
        freq_type = ""
    return " ".join(part for part in (mhz_text, freq_type) if part)



def parse_int_set(value: str) -> set[int]:
    result: set[int] = set()
    for token in re.split(r"[,\s]+", value or ""):
        if not token:
            continue
        try:
            result.add(int(token))
        except ValueError:
            pass
    return result


def load_openaip_airfields(
    *,
    countries: Sequence[str],
    raw_dir: Path,
    api_key: str,
    base_url: str,
    local_sources: str,
    include_type_codes: set[int],
    candidate_mode: str,
    known_codes: set[str] = frozenset(),
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    countries = [str(c).upper() for c in countries]
    airports: dict[str, dict[str, Any]] = {}
    runways: dict[str, dict[str, Any]] = {}
    freqs: dict[str, list[dict[str, Any]]] = {}

    records_by_country: dict[str, list[dict[str, Any]]] = {country: [] for country in countries}
    if local_sources:
        sources = [item.strip() for item in local_sources.split(",") if item.strip()]
        for source in sources:
            data = read_json(source, raw_dir)
            records = extract_openaip_records(data)
            for record in records:
                country = normalize_country(get_deep(record, "country", "properties.country", "countryCode", "properties.countryCode"))
                if country in records_by_country:
                    records_by_country[country].append(record)
                elif len(countries) == 1:
                    records_by_country[countries[0]].append(record)
    else:
        if not api_key:
            raise RuntimeError("OPENAIP_API_KEY is required for --airfield-source openaip unless --openaip-airports is supplied")
        for country in countries:
            records_by_country[country] = fetch_openaip_airports_for_country(country, raw_dir, api_key, base_url)

    for country, records in records_by_country.items():
        type_counts: Counter[str] = Counter()
        for record in records:
            type_counts[openaip_type_name(get_deep(record, "type", "properties.type")) or "UNKNOWN"] += 1
        if type_counts:
            top_types = ", ".join(f"{name}={count}" for name, count in type_counts.most_common(8))
            print(f"OpenAIP {country}: fetched type mix: {top_types}", file=sys.stderr)
        kept = 0
        kept_type_counts: Counter[str] = Counter()
        for record in records:
            airport = normalize_openaip_airport(record, country)
            if not airport:
                continue
            airport_code = clean(airport.get("code")).upper()
            if candidate_mode == "all":
                is_candidate = True
            elif candidate_mode == "pack":
                is_candidate = False
            else:
                is_candidate = is_openaip_glider_relevant(record, include_type_codes)
            # Always keep an OpenAIP airfield whose ICAO code we already have from a primary
            # source (Guide/streckenflug). This lets its authoritative name and metadata
            # merge onto that field even when it is not otherwise flagged glider-relevant
            # (e.g. type 0 aerodromes like LFMR/LFNS/LFNC with no glider keyword).
            if not is_candidate and airport_code and airport_code in known_codes:
                is_candidate = True
            if not is_candidate:
                continue
            code = airport.get("code") or airport.get("altCode") or stable_airfield_code(country, airport["name"], airport["latitude"], airport["longitude"])
            code = clean(code).upper()
            airport["code"] = code
            airport["vacCandidate"] = bool(ICAO_FR_RE.match(code))
            airports[code] = airport
            runway = normalize_openaip_runway(record)
            if runway:
                runways[code] = runway
            extracted_freqs = normalize_openaip_frequencies(record)
            if extracted_freqs:
                freqs[code] = extracted_freqs
            kept += 1
            kept_type_counts[airport.get("type") or "UNKNOWN"] += 1
        kept_types = ", ".join(f"{name}={count}" for name, count in kept_type_counts.most_common(8)) or "none"
        print(f"OpenAIP {country}: kept {kept} glider-relevant airfields from {len(records)} records ({kept_types})", file=sys.stderr)
    return airports, runways, freqs


def fetch_openaip_airports_for_country(country: str, raw_dir: Path, api_key: str, base_url: str) -> list[dict[str, Any]]:
    base = base_url.rstrip("/")
    endpoint = f"{base}/airports"
    all_records: list[dict[str, Any]] = []
    page = 1
    limit = 1000
    progress = Progress(0, f"OpenAIP {country}")
    while True:
        params = {
            "country": country,
            "countryCode": country,
            "limit": str(limit),
            "page": str(page),
        }
        url = endpoint + "?" + urllib.parse.urlencode(params)
        cache_name = raw_dir / f"openaip_airports_{country}_{page}.json"
        try:
            data = read_json_url(url, cache_name, api_key=api_key)
        except Exception as first_error:
            # Some OpenAIP deployments ignore country filters or expose a flatter endpoint. Try minimal query once.
            if page != 1:
                print(f"OpenAIP {country}: page {page} failed: {first_error}", file=sys.stderr)
                break
            fallback_url = endpoint
            data = read_json_url(fallback_url, raw_dir / "openaip_airports_all.json", api_key=api_key)
        records = extract_openaip_records(data)
        country_records = [r for r in records if record_matches_country(r, country)]
        all_records.extend(country_records)
        progress.update(page, extra=f"page {page}, +{len(country_records)} records", force=True)
        if len(records) < limit or not records or page >= 50:
            break
        page += 1
    progress.done(f"{len(all_records)} records")
    # Dedupe by id/code/name+position.
    deduped: dict[str, dict[str, Any]] = {}
    for record in all_records:
        key = clean(get_deep(record, "_id", "id", "properties._id", "properties.id"))
        if not key:
            code = clean(get_deep(record, "icaoCode", "icao", "properties.icaoCode", "properties.icao"))
            name = clean(get_deep(record, "name", "properties.name"))
            lat, lon = extract_openaip_lat_lon(record)
            key = f"{country}:{code}:{name}:{lat}:{lon}"
        deduped[key] = record
    return list(deduped.values())


def read_json(source: str, raw_dir: Path) -> Any:
    if re.match(r"^https?://", source):
        return read_json_url(source, raw_dir / Path(urllib.parse.urlparse(source).path).name)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def read_json_url(url: str, cache_path: Path, *, api_key: str = "") -> Any:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    api_key = (api_key or "").strip().strip('"').strip("'")
    headers = {"User-Agent": "MeetTheCows/0.5"}
    if api_key:
        # OpenAIP's current docs use x-openaip-api-key. Some older examples used
        # x-openaip-client-id, so send both; do not put the key in the URL.
        headers["x-openaip-api-key"] = api_key
        headers["x-openaip-client-id"] = api_key
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        body = ""
        try:
            body = error.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        if error.code in (401, 403) and "api.core.openaip.net" in url:
            raise RuntimeError(
                "OpenAIP authentication failed. Check that OPENAIP_API_KEY is exported "
                "in this shell, that it has no quotes/spaces copied into the value, and "
                "that the key is a Core API key. Tested headers: x-openaip-api-key and "
                f"x-openaip-client-id. HTTP {error.code}. Response: {body}"
            ) from error
        raise
    cache_path.write_bytes(raw)
    return json.loads(raw.decode("utf-8"))


def extract_openaip_records(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, dict):
        return []
    if data.get("type") == "FeatureCollection" and isinstance(data.get("features"), list):
        return [item for item in data["features"] if isinstance(item, dict)]
    for key in ("items", "data", "results", "airports", "features"):
        value = data.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return [data]


def get_deep(obj: dict[str, Any], *paths: str) -> Any:
    for path in paths:
        current: Any = obj
        ok = True
        for part in path.split("."):
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                ok = False
                break
        if ok and current not in (None, ""):
            return current
    return None


def normalize_country(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("code") or value.get("isoCode") or value.get("iso") or value.get("name")
    text = clean(value).upper()
    aliases = {"FRANCE": "FR", "SWITZERLAND": "CH", "SCHWEIZ": "CH", "SUISSE": "CH", "ITALY": "IT", "ITALIA": "IT"}
    return aliases.get(text, text[:2])


def record_matches_country(record: dict[str, Any], country: str) -> bool:
    country = country.upper()
    explicit = normalize_country(get_deep(record, "country", "properties.country", "countryCode", "properties.countryCode"))
    if explicit:
        return explicit == country
    code = clean(get_deep(record, "icaoCode", "icao", "properties.icaoCode", "properties.icao", "code", "properties.code")).upper()
    return is_country_icao(code, [country])


def normalize_openaip_airport(record: dict[str, Any], fallback_country: str) -> dict[str, Any] | None:
    props = record.get("properties") if isinstance(record.get("properties"), dict) else record
    name = clean(get_deep(record, "name", "properties.name"))
    lat, lon = extract_openaip_lat_lon(record)
    if not name or lat is None or lon is None:
        return None
    code = clean(get_deep(record, "icaoCode", "icao", "icao_code", "ident", "code", "properties.icaoCode", "properties.icao", "properties.icao_code", "properties.ident", "properties.code")).upper()
    if code in {"NIL", "NONE", "NULL", "-"}:
        code = ""
    alt_code = clean(get_deep(record, "altIdentifier", "alternateIdentifier", "localCode", "properties.altIdentifier", "properties.alternateIdentifier", "properties.localCode")).upper()
    country = normalize_country(get_deep(record, "country", "properties.country", "countryCode", "properties.countryCode")) or fallback_country
    elevation_m = normalize_elevation_m(get_deep(record, "elevation", "properties.elevation", "elevation.value", "properties.elevation.value", "elevationM", "properties.elevationM"))
    type_value = get_deep(record, "type", "properties.type")
    type_name = openaip_type_name(type_value)
    return {
        "code": code or alt_code,
        "altCode": alt_code,
        "name": name,
        "latitude": lat,
        "longitude": lon,
        "elevationM": elevation_m,
        "type": type_name,
        "country": country,
        "source": "OpenAIP",
    }


def extract_openaip_lat_lon(record: dict[str, Any]) -> tuple[float | None, float | None]:
    # GeoJSON: coordinates are lon, lat.
    coords = get_deep(record, "geometry.coordinates")
    if isinstance(coords, list) and len(coords) >= 2:
        lon = parse_float(str(coords[0]))
        lat = parse_float(str(coords[1]))
        if lat is not None and lon is not None:
            return lat, lon
    for lat_key, lon_key in [
        ("latitude", "longitude"), ("lat", "lon"), ("lat", "lng"),
        ("properties.latitude", "properties.longitude"), ("properties.lat", "properties.lon"),
        ("location.latitude", "location.longitude"), ("properties.location.latitude", "properties.location.longitude"),
    ]:
        lat = parse_float(clean(get_deep(record, lat_key)))
        lon = parse_float(clean(get_deep(record, lon_key)))
        if lat is not None and lon is not None:
            return lat, lon
    position = get_deep(record, "position", "properties.position", "location", "properties.location")
    if isinstance(position, dict):
        lat = parse_float(clean(position.get("lat") or position.get("latitude")))
        lon = parse_float(clean(position.get("lon") or position.get("lng") or position.get("longitude")))
        if lat is not None and lon is not None:
            return lat, lon
    return None, None


def normalize_elevation_m(value: Any) -> float | None:
    if isinstance(value, dict):
        raw = value.get("value") or value.get("m") or value.get("meter") or value.get("meters")
        unit = clean(value.get("unit") or value.get("uom") or value.get("unitCode")).lower()
    else:
        raw = value
        unit = ""
    number = parse_float(clean(raw))
    if number is None:
        return None
    if unit in {"ft", "feet", "2"}:
        return round(number * 0.3048, 1)
    return round(number, 1)


def openaip_type_name(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("name") or value.get("value") or value.get("code")
    if isinstance(value, int):
        return OPENAIP_AIRPORT_TYPES.get(value, str(value))
    text = clean(value)
    if text.isdigit():
        return OPENAIP_AIRPORT_TYPES.get(int(text), text)
    return text


def is_openaip_glider_relevant(record: dict[str, Any], include_type_codes: set[int]) -> bool:
    type_value = get_deep(record, "type", "properties.type")
    if isinstance(type_value, int) and type_value in include_type_codes:
        return True
    if isinstance(type_value, str) and type_value.isdigit() and int(type_value) in include_type_codes:
        return True
    searchable = json.dumps(record, ensure_ascii=False).lower()
    if any(keyword in searchable for keyword in GLIDER_KEYWORDS):
        return True
    return False


def normalize_openaip_runway(record: dict[str, Any]) -> dict[str, Any] | None:
    runways = get_deep(record, "runways", "properties.runways")
    if not isinstance(runways, list):
        return None
    best: dict[str, Any] | None = None
    for runway in runways:
        if not isinstance(runway, dict):
            continue
        length = normalize_dimension_m(get_deep(runway, "length", "dimension.length", "dimension.length.value", "dimensions.length", "dimensions.length.value"))
        width = normalize_dimension_m(get_deep(runway, "width", "dimension.width", "dimension.width.value", "dimensions.width", "dimensions.width.value"))
        direction = parse_float(clean(get_deep(runway, "trueHeading", "heading", "leHeading", "mainRunway.trueHeading")))
        name = clean(get_deep(runway, "designator", "name", "ident"))
        if length is None:
            continue
        if best and best.get("lengthM", 0) >= length:
            continue
        best = {"lengthM": length, "widthM": width, "runwayDirectionDeg": direction, "runwayName": name}
    return best


def normalize_dimension_m(value: Any) -> float | None:
    if isinstance(value, dict):
        raw = value.get("value") or value.get("m") or value.get("meter") or value.get("meters")
        unit = clean(value.get("unit") or value.get("uom") or value.get("unitCode")).lower()
    else:
        raw = value
        unit = ""
    number = parse_float(clean(raw))
    if number is None:
        return None
    if unit in {"ft", "feet", "2"}:
        return round(number * 0.3048, 1)
    return round(number, 1)


def normalize_openaip_frequencies(record: dict[str, Any]) -> list[dict[str, Any]]:
    freqs = get_deep(record, "frequencies", "properties.frequencies", "radioFrequencies", "properties.radioFrequencies")
    if not isinstance(freqs, list):
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in freqs:
        if not isinstance(item, dict):
            continue
        mhz = parse_float(clean(get_deep(item, "value", "frequency", "frequencyMhz", "mhz")))
        if mhz is None or not 118.0 <= mhz <= 137.0:
            continue
        key = f"{mhz:.3f}"
        if key in seen:
            continue
        seen.add(key)
        freq_type = openaip_frequency_type_name(get_deep(item, "type", "name"))
        result.append({
            "mhz": round(mhz, 3),
            "type": freq_type,
            "description": clean(get_deep(item, "description", "remarks", "name")),
            "source": "OpenAIP",
        })
    result.sort(key=frequency_sort_key)
    return result


def openaip_frequency_type_name(value: Any) -> str:
    mapping = {0: "OTHER", 1: "A/A", 2: "AFIS", 3: "TWR", 4: "APP", 5: "ATIS", 6: "GND", 7: "INFO"}
    if isinstance(value, int):
        return mapping.get(value, "")
    text = clean(value)
    if text.isdigit():
        return mapping.get(int(text), "")
    return text


def merge_frequency_indexes(target: dict[str, list[dict[str, Any]]], incoming: dict[str, list[dict[str, Any]]]) -> None:
    for code, freqs in incoming.items():
        existing = target.setdefault(code, [])
        seen = {f"{float(item.get('mhz')):.3f}" for item in existing if isinstance(item.get("mhz"), (int, float))}
        for freq in freqs:
            key = f"{float(freq.get('mhz')):.3f}"
            if key not in seen:
                existing.append(dict(freq))
                seen.add(key)
        existing.sort(key=frequency_sort_key)


def is_country_icao(code: str, countries: Sequence[str]) -> bool:
    code = clean(code).upper()
    if not ICAO_RE.match(code):
        return False
    for country in countries:
        prefixes = COUNTRY_ICAO_PREFIXES.get(str(country).upper(), ())
        if any(code.startswith(prefix) for prefix in prefixes):
            return True
    return False


def infer_country_from_icao(code: str) -> str:
    code = clean(code).upper()
    for country, prefixes in COUNTRY_ICAO_PREFIXES.items():
        if any(code.startswith(prefix) for prefix in prefixes):
            return country
    return ""


def stable_airfield_code(country: str, name: str, lat: float, lon: float) -> str:
    return f"{country.upper()}_{slugify(name)[:24]}_{lat:.3f}_{lon:.3f}".replace("-", "m").replace(".", "p").upper()

def load_airport_index(airports_csv: str, raw_dir: Path, countries: Sequence[str] = ("FR",)) -> dict[str, dict[str, Any]]:
    print(f"Loading airport source {airports_csv}", file=sys.stderr)
    text = read_text(airports_csv, raw_dir)
    reader = csv.DictReader(io.StringIO(text))
    airports: dict[str, dict[str, Any]] = {}
    for row in reader:
        ident = clean(row.get("ident")).upper()
        if not is_country_icao(ident, countries):
            continue
        lat = parse_float(clean(row.get("latitude_deg")))
        lon = parse_float(clean(row.get("longitude_deg")))
        if lat is None or lon is None:
            continue
        elevation_ft = parse_float(clean(row.get("elevation_ft")))
        airports[ident] = {
            "code": ident,
            "name": clean(row.get("name")) or ident,
            "latitude": lat,
            "longitude": lon,
            "elevationM": round(elevation_ft * 0.3048, 1) if elevation_ft is not None else None,
            "type": clean(row.get("type")) or "airport",
            "country": clean(row.get("iso_country")) or "FR",
        }
    print(f"Loaded {len(airports)} airport coordinates for {','.join(countries)}", file=sys.stderr)
    return airports


def load_runway_index(runways_csv: str, raw_dir: Path, countries: Sequence[str] = ("FR",)) -> dict[str, dict[str, Any]]:
    if not runways_csv:
        return {}
    print(f"Loading runway source {runways_csv}", file=sys.stderr)
    text = read_text(runways_csv, raw_dir)
    reader = csv.DictReader(io.StringIO(text))
    longest: dict[str, dict[str, Any]] = {}
    for row in reader:
        airport_ident = clean(row.get("airport_ident")).upper()
        if not is_country_icao(airport_ident, countries):
            continue
        length_ft = parse_float(clean(row.get("length_ft")))
        width_ft = parse_float(clean(row.get("width_ft")))
        if length_ft is None:
            continue
        existing = longest.get(airport_ident)
        if existing and existing.get("length_ft", 0) >= length_ft:
            continue
        le_ident = clean(row.get("le_ident"))
        heading_deg = parse_float(clean(row.get("le_heading_degT")))
        longest[airport_ident] = {
            "lengthM": round(length_ft * 0.3048, 1),
            "widthM": round(width_ft * 0.3048, 1) if width_ft is not None else None,
            "runwayDirectionDeg": heading_deg,
            "runwayName": le_ident,
            "length_ft": length_ft,
        }
    print(f"Loaded runway dimensions for {len(longest)} airports", file=sys.stderr)
    return longest



def load_frequency_index(frequencies_csv: str, raw_dir: Path) -> dict[str, list[dict[str, Any]]]:
    if not frequencies_csv:
        return {}
    print(f"Loading frequency source {frequencies_csv}", file=sys.stderr)
    text = read_text(frequencies_csv, raw_dir)
    reader = csv.DictReader(io.StringIO(text))
    by_airport: dict[str, list[dict[str, Any]]] = {}
    for row in reader:
        airport_ident = clean(row.get("airport_ident")).upper()
        if not is_country_icao(airport_ident, countries):
            continue
        mhz = parse_float(clean(row.get("frequency_mhz")))
        if mhz is None or not 118.0 <= mhz <= 137.0:
            continue
        entry = {
            "mhz": round(mhz, 3),
            "type": clean(row.get("type")),
            "description": clean(row.get("description")),
            "source": "OurAirports airport-frequencies.csv",
        }
        by_airport.setdefault(airport_ident, []).append(entry)
    for code, freqs in by_airport.items():
        freqs.sort(key=frequency_sort_key)
    print(f"Loaded radio frequencies for {len(by_airport)} LFxx airports", file=sys.stderr)
    return by_airport


def frequency_sort_key(freq: dict[str, Any]) -> tuple[int, float]:
    preferred = ["AFIS", "TWR", "CTAF", "ATF", "A/A", "UNICOM", "INFO", "RDO", "APP", "ATIS", "GND"]
    value = " ".join([clean(freq.get("type")), clean(freq.get("description"))]).upper()
    rank = next((i for i, token in enumerate(preferred) if token in value), len(preferred))
    return rank, float(freq.get("mhz") or 999)


def apply_frequency_index(fields: list[dict[str, Any]], frequency_index: dict[str, list[dict[str, Any]]]) -> None:
    for field in fields:
        code = clean(field.get("code")).upper()
        if not code:
            continue
        indexed = frequency_index.get(code) or []
        if not indexed:
            continue
        existing = merge_frequency_lists(list(field.get("frequencies") or []), indexed)
        field["frequencies"] = existing
        field["frequency"] = format_frequency_short(existing)


def parse_vac_codes(vac_codes: str, raw_dir: Path) -> set[str]:
    if not vac_codes:
        return set()
    if re.match(r"^https?://", vac_codes) or Path(vac_codes).exists():
        text = read_text(vac_codes, raw_dir)
    else:
        text = vac_codes
    codes = {code.upper() for code in re.findall(r"\bLF[A-Z0-9]{2}\b", text.upper())}
    return codes



def resolve_vac_root(vac_root: str, raw_dir: Path) -> tuple[str, str]:
    value = (vac_root or "").strip()
    if not value:
        return "", ""
    if value.lower() != "auto":
        return value.rstrip("/"), infer_vac_date_from_root(value)

    print("Auto-detecting current SIA VAC eAIP root", file=sys.stderr)
    for cycle_date in candidate_airac_dates():
        folder = f"eAIP_{cycle_date.strftime('%d_%b_%Y').upper()}"
        root = f"https://www.sia.aviation-civile.gouv.fr/media/dvd/{folder}/Atlas-VAC/PDF_AIPparSSection/VAC/AD"
        test_url = f"{root}/AD-2.LFMR.pdf"
        if url_looks_available(test_url):
            inferred = cycle_date.isoformat()
            print(f"Detected SIA VAC root: {root}", file=sys.stderr)
            return root, inferred
    print("Could not auto-detect SIA VAC root. Pass --vac-root explicitly.", file=sys.stderr)
    return "", ""


def candidate_airac_dates() -> list[dt.date]:
    today = dt.date.today()
    dates: list[dt.date] = []
    d = BASE_AIRAC_DATE
    while d < today - dt.timedelta(days=365):
        d += dt.timedelta(days=28)
    while d <= today + dt.timedelta(days=56):
        dates.append(d)
        d += dt.timedelta(days=28)
    # Try most recent/current first, then the next cycle in case SIA pre-published it.
    dates.sort(key=lambda x: abs((today - x).days))
    return dates


def url_looks_available(url: str) -> bool:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "MeetTheCows/0.3"})
        with urllib.request.urlopen(request, timeout=20) as response:
            content_type = response.headers.get("Content-Type", "").lower()
            return response.status == 200 and ("pdf" in content_type or url.lower().endswith(".pdf"))
    except Exception:
        return False


def infer_vac_date_from_root(vac_root: str) -> str:
    match = re.search(r"eAIP_(\d{2})_([A-Z]{3})_(\d{4})", vac_root.upper())
    if not match:
        return ""
    day, month_text, year = match.groups()
    month_lookup = {m.upper(): i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
    month = month_lookup.get(month_text)
    if not month:
        return ""
    return dt.date(int(year), month, int(day)).isoformat()



def add_airfield_entries_from_index(
    fields: list[dict[str, Any]],
    airport_index: dict[str, dict[str, Any]],
    runway_index: dict[str, dict[str, Any]],
    frequency_index: dict[str, list[dict[str, Any]]],
    pack_id: str,
    candidate_mode: str,
) -> None:
    by_code = index_fields_by_code(fields)
    created = 0
    for code, airport in sorted(airport_index.items()):
        if code in by_code:
            # Merge coordinates source frequencies into the already imported Guide/CUP entry.
            if code in frequency_index:
                apply_frequency_index(by_code[code], frequency_index)
            continue
        if candidate_mode == "pack":
            continue
        media_stub: dict[str, Any] = {}
        field = make_open_airfield_entry(airport, runway_index.get(code), frequency_index.get(code, []), pack_id)
        fields.append(field)
        by_code.setdefault(code, []).append(field)
        created += 1
    if created:
        print(f"Added {created} OpenAIP glider airfield entries without VAC docs", file=sys.stderr)


def make_open_airfield_entry(
    airport: dict[str, Any],
    runway: dict[str, Any] | None,
    frequencies: list[dict[str, Any]],
    pack_id: str,
) -> dict[str, Any]:
    code = clean(airport.get("code")).upper()
    country = clean(airport.get("country")) or infer_country_from_icao(code) or ""
    runway = runway or {}
    frequencies = sorted([dict(freq) for freq in frequencies], key=frequency_sort_key)
    field_id = stable_id(country or "xx", code, airport["name"], airport["latitude"], airport["longitude"])
    type_name = clean(airport.get("type")) or "glider airfield"
    notes = f"Glider-relevant airfield imported from OpenAIP ({type_name}). Verify current official AIP/VAC data before use."
    return {
        "id": field_id,
        "kind": "airfield",
        "name": airport["name"],
        "code": code,
        "country": country,
        "latitude": round(float(airport["latitude"]), 7),
        "longitude": round(float(airport["longitude"]), 7),
        "elevationM": airport.get("elevationM"),
        "difficulty": "A",
        "rawDifficulty": "openaip-glider-airfield",
        "lengthM": runway.get("lengthM"),
        "widthM": runway.get("widthM"),
        "runwayDirectionDeg": runway.get("runwayDirectionDeg"),
        "frequency": format_frequency_short(frequencies),
        "frequencies": frequencies,
        "notes": notes,
        "source": {"name": "OpenAIP", "importedAt": dt.date.today().isoformat(), "packId": pack_id},
        "media": [],
    }

# --- Austria: Austro Control eAIP AD 2 charts -------------------------------------------------
# The Austrian eAIP publishes one English PDF per aerodrome at a stable, anonymous URL:
#   {cycle_base}PART_3/AD_2/{PRI|SRY|MIL}/AD_2_<ICAO>/LO_AD_2_<ICAO>_{en|de}.pdf
# The eAIP root lists every published cycle as ./lo/<YYMMDD>/index.htm; the effective one is
# the latest whose date is not in the future. Attach-only: AT airfields come from OpenAIP.

def _fetch_at_vac(url: str) -> bytes:
    """Separate function so tests can stub network access."""
    request = urllib.request.Request(url, headers={"User-Agent": "MeetTheCows/0.7"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def at_cycle_date(cycle: str) -> str:
    """'260709' -> '2026-07-09' (eAIP cycle directories are YYMMDD)."""
    return f"20{cycle[0:2]}-{cycle[2:4]}-{cycle[4:6]}"


def pick_at_cycle(cycles: list[str], today: dt.date | None = None) -> str:
    """The effective cycle: latest not in the future (upcoming AIRAC cycles are pre-published)."""
    today = today or dt.date.today()
    effective = [c for c in sorted(set(cycles)) if dt.date.fromisoformat(at_cycle_date(c)) <= today]
    if effective:
        return effective[-1]
    return sorted(set(cycles))[0] if cycles else ""


def parse_at_ad2_index(html: str, base_url: str) -> dict[str, str]:
    """ICAO -> absolute chart-PDF URL from the eAIP AD 2 index page.

    Prefers the English edition; falls back to German for the few aerodromes (military LOX*)
    that publish German-only."""
    english: dict[str, str] = {}
    german: dict[str, str] = {}
    for path, code, lang in re.findall(
            r'href="(PART_3/AD_2/(?:PRI|SRY|MIL)/AD_2_(LO[A-Z]{2})/LO_AD_2_\2_(en|de)\.pdf)"', html):
        (english if lang == "en" else german)[code] = urllib.parse.urljoin(base_url, path)
    return {**german, **english}


def resolve_at_vac_root(spec: str) -> tuple[str, str, dict[str, str]]:
    """Resolve (cycle_base_url, cycle_date, {icao: pdf_url}); ('', '', {}) when disabled/failed.

    Best-effort like the SIA resolver: a broken eAIP must not fail the whole build — the
    fingerprint key just stays empty and charts are attached again on the next healthy run.
    """
    if not spec or spec.lower() in {"none", "off"}:
        return "", "", {}
    try:
        if spec.lower() == "auto":
            root_html = _fetch_at_vac(AT_EAIP_ROOT).decode("latin-1", "replace")
            cycles = re.findall(r'href="\./lo/(\d{6})/index\.htm"', root_html)
            cycle = pick_at_cycle(cycles)
            if not cycle:
                print("AT VAC: no cycles found on the eAIP root; skipping", file=sys.stderr)
                return "", "", {}
            base = f"{AT_EAIP_ROOT}lo/{cycle}/"
            date = at_cycle_date(cycle)
        else:
            base = spec if spec.endswith("/") else spec + "/"
            match = re.search(r"/lo/(\d{6})/", base)
            date = at_cycle_date(match.group(1)) if match else ""
        ad2_html = _fetch_at_vac(urllib.parse.urljoin(base, "ad_2.htm")).decode("latin-1", "replace")
        index = parse_at_ad2_index(ad2_html, base)
        if not index:
            print(f"AT VAC: AD 2 index at {base} lists no aerodrome PDFs; skipping", file=sys.stderr)
            return "", "", {}
        return base, date, index
    except Exception as error:  # noqa: BLE001 - source outage must not fail the build
        print(f"AT VAC: resolve failed ({error}); skipping Austrian charts", file=sys.stderr)
        return "", "", {}


def import_at_vac_pdfs(
    *,
    fields: list[dict[str, Any]],
    ad2_index: dict[str, str],
    docs_dir: Path,
    at_vac_date: str,
    max_vac: int,
) -> int:
    """Attach Austro Control AD 2 PDFs to existing AT airfields. Returns the download count."""
    by_code = index_fields_by_code(fields)
    candidates = sorted(code for code in by_code if ICAO_AT_RE.match(code) and code in ad2_index)
    progress = Progress(len(candidates), "AT VAC PDFs")
    downloaded = 0
    errors = 0
    for index, code in enumerate(candidates, start=1):
        if max_vac and downloaded >= max_vac:
            progress.update(index - 1, extra=f"downloaded {downloaded}, skipped limit", force=True)
            break
        try:
            data = _fetch_at_vac(ad2_index[code])
        except Exception as error:  # noqa: BLE001 - one missing chart must not fail the build
            errors += 1
            progress.update(index, extra=f"{code}: {error} | ok {downloaded}, err {errors}", force=True)
            continue
        (docs_dir / f"{code}.pdf").write_bytes(data)
        media = {
            "type": "pdf",
            "url": f"docs/vac/{code}.pdf",
            "caption": f"VAC {code}",
            "source": "Austro Control (AIP Austria)",
        }
        if at_vac_date:
            media["updatedAt"] = at_vac_date
        for field in by_code[code]:
            field["media"].append(dict(media))
            field.setdefault("docs", {})["vac"] = media["url"]
        downloaded += 1
        progress.update(index, extra=f"{code}: attached | ok {downloaded}, err {errors}")
    progress.done(f"downloaded {downloaded}, err {errors}")
    return downloaded


def import_vac_pdfs(
    *,
    fields: list[dict[str, Any]],
    vac_root: str,
    docs_dir: Path,
    vac_date: str,
    max_vac: int,
    airport_index: dict[str, dict[str, Any]],
    runway_index: dict[str, dict[str, Any]],
    frequency_index: dict[str, list[dict[str, Any]]],
    extra_codes: set[str],
    pack_id: str,
) -> dict[str, int]:
    downloaded = 0
    created_airfields = 0
    vac_root = vac_root.rstrip("/")
    by_code = index_fields_by_code(fields)

    candidate_codes = {code for code in (set(by_code.keys()) | extra_codes) if ICAO_FR_RE.match(code)}
    if airport_index:
        # SIA VAC is France-only here. Only probe OpenAIP airfields explicitly marked as VAC candidates.
        candidate_codes |= {code for code, airport in airport_index.items() if ICAO_FR_RE.match(code) and airport.get("vacCandidate", True)}
    candidate_codes = sorted(candidate_codes)
    if max_vac:
        print(f"VAC import limited to {max_vac} successful downloads", file=sys.stderr)

    progress = Progress(len(candidate_codes), "VAC PDFs")
    misses = 0
    errors = 0

    for index, code in enumerate(candidate_codes, start=1):
        if max_vac and downloaded >= max_vac:
            progress.update(index - 1, extra=f"downloaded {downloaded}, created {created_airfields}, skipped limit", force=True)
            break
        url = f"{vac_root}/AD-2.{code}.pdf"
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "MeetTheCows/0.4"})
            with urllib.request.urlopen(request, timeout=30) as response:
                content_type = response.headers.get("Content-Type", "").lower()
                if response.status != 200 or ("pdf" not in content_type and not url.lower().endswith(".pdf")):
                    misses += 1
                    progress.update(index, extra=f"{code}: no PDF | ok {downloaded}, miss {misses}, err {errors}")
                    continue
                data = response.read()
        except urllib.error.HTTPError as error:
            if error.code in {403, 404}:
                misses += 1
            else:
                errors += 1
                progress.update(index, extra=f"{code}: HTTP {error.code} | ok {downloaded}, miss {misses}, err {errors}", force=True)
            progress.update(index, extra=f"{code}: no PDF | ok {downloaded}, miss {misses}, err {errors}")
            continue
        except Exception as error:
            errors += 1
            progress.update(index, extra=f"{code}: {error} | ok {downloaded}, miss {misses}, err {errors}", force=True)
            continue

        target = docs_dir / f"{code}.pdf"
        target.write_bytes(data)
        pdf_frequencies = extract_frequencies_from_pdf_bytes(data, source="SIA VAC PDF")
        downloaded += 1
        media = {
            "type": "pdf",
            "url": f"docs/vac/{code}.pdf",
            "caption": f"VAC {code}",
            "source": "Service de l’Information Aéronautique (SIA)",
        }
        if vac_date:
            media["updatedAt"] = vac_date

        if code in by_code:
            merged_freqs = merge_frequency_lists(pdf_frequencies, frequency_index.get(code, []))
            for field in by_code[code]:
                field["media"].append(dict(media))
                field.setdefault("docs", {})["vac"] = media["url"]
                if merged_freqs:
                    all_freqs = merge_frequency_lists(list(field.get("frequencies") or []), merged_freqs)
                    field["frequencies"] = all_freqs
                    field["frequency"] = format_frequency_short(all_freqs)
            progress.update(index, extra=f"{code}: attached | ok {downloaded}, miss {misses}, err {errors}")
            continue

        airport = airport_index.get(code)
        if not airport:
            progress.update(index, extra=f"{code}: downloaded but no coordinates | ok {downloaded}, miss {misses}, err {errors}", force=True)
            continue
        merged_freqs = merge_frequency_lists(pdf_frequencies, frequency_index.get(code, []))
        new_field = make_vac_airfield_entry(airport, runway_index.get(code), merged_freqs, media, pack_id)
        fields.append(new_field)
        by_code.setdefault(code, []).append(new_field)
        created_airfields += 1
        progress.update(index, extra=f"{code}: created airfield | ok {downloaded}, created {created_airfields}, miss {misses}, err {errors}")

    progress.done(f"downloaded {downloaded}, created {created_airfields}, miss {misses}, err {errors}")
    return {"downloaded": downloaded, "createdAirfields": created_airfields}


def make_vac_airfield_entry(
    airport: dict[str, Any],
    runway: dict[str, Any] | None,
    frequencies: list[dict[str, Any]],
    media: dict[str, Any],
    pack_id: str,
) -> dict[str, Any]:
    code = airport["code"]
    runway = runway or {}
    frequencies = sorted([dict(freq) for freq in frequencies], key=frequency_sort_key)
    country = clean(airport.get("country")) or infer_country_from_icao(code) or "FR"
    field_id = stable_id(country, code, airport["name"], airport["latitude"], airport["longitude"])
    notes = "Official aerodrome entry created from SIA VAC import. Coordinates/dimensions are from the airport source, not from the VAC PDF. Verify the attached official VAC."
    return {
        "id": field_id,
        "kind": "airfield",
        "name": airport["name"],
        "code": code,
        "country": country,
        "latitude": round(float(airport["latitude"]), 7),
        "longitude": round(float(airport["longitude"]), 7),
        "elevationM": airport.get("elevationM"),
        "difficulty": "A",
        "rawDifficulty": "aerodrome-vac-only",
        "lengthM": runway.get("lengthM"),
        "widthM": runway.get("widthM"),
        "runwayDirectionDeg": runway.get("runwayDirectionDeg"),
        "frequency": format_frequency_short(frequencies),
        "frequencies": frequencies,
        "notes": notes,
        "source": {
            "name": "SIA VAC + OpenAIP/airport coordinates",
            "importedAt": dt.date.today().isoformat(),
            "packId": pack_id,
        },
        "media": [dict(media)],
        "docs": {"vac": media["url"]},
    }



def load_streckenflug_fields(
    list_url: str,
    raw_dir: Path,
    *,
    workers: int = 1,
    media_dir: Path,
    pack_id: str,
    countries: Sequence[str],
    max_detail: int = 0,
    include_images: bool = True,
) -> list[dict[str, Any]]:
    """Scrape the public streckenflug.at landout list and JSON detail endpoint.

    The list page supports a server-side side_land=<country> filter. Use that first
    so a FR/CH/IT build fetches only those countries instead of probing the full EU
    list and throwing most detail calls away afterwards.
    """
    country_filter = {str(c).upper() for c in countries if str(c).strip()}
    countries_to_fetch = sorted(country_filter) if country_filter else [""]

    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    for country in countries_to_fetch:
        country_url = streckenflug_country_list_url(list_url, country)
        label = country or "all countries"
        print(f"Loading streckenflug.at list {label}: {country_url}", file=sys.stderr)
        list_html = read_text(country_url, raw_dir)
        country_items = extract_streckenflug_links(list_html, country_url, {country} if country else country_filter)
        for item in country_items:
            source_id = clean(item.get("streckenflugId"))
            if not source_id or source_id in seen:
                continue
            if country and not clean(item.get("country")):
                item["country"] = country
            seen.add(source_id)
            candidates.append(item)
        print(f"streckenflug.at {label}: {len(country_items)} ids from public list", file=sys.stderr)

    if max_detail:
        candidates = candidates[:max_detail]
    print(f"streckenflug.at: {len(candidates)} candidate ids after country filtering", file=sys.stderr)

    if not candidates:
        return []

    worker_count = max(1, int(workers or 1))
    progress = Progress(len(candidates), "streckenflug.at details")
    fields: list[dict[str, Any]] = []
    skipped = 0
    failed = 0

    def fetch_one(item: dict[str, str]) -> tuple[dict[str, Any] | None, str]:
        source_id = clean(item.get("streckenflugId"))
        try:
            data = fetch_streckenflug_detail_json(source_id, raw_dir)
            field = parse_streckenflug_detail(data, item, pack_id, media_dir, include_images=include_images)
            if not field:
                return None, f"skip {item.get('name','')[:32]}"
            if country_filter and clean(field.get("country")).upper() not in country_filter:
                return None, f"skip country {field.get('country','')}"
            return field, f"+ {field.get('name','')[:32]}"
        except Exception as error:
            return None, f"err {item.get('name','')[:24]}: {error}"

    if worker_count == 1:
        for item in candidates:
            field, status = fetch_one(item)
            if field:
                fields.append(field)
            elif status.startswith("err"):
                failed += 1
            else:
                skipped += 1
            progress.update(step=1, extra=f"{status} ({len(fields)} imported)", force=status.startswith("err"))
    else:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [executor.submit(fetch_one, item) for item in candidates]
            for future in as_completed(futures):
                field, status = future.result()
                if field:
                    fields.append(field)
                elif status.startswith("err"):
                    failed += 1
                else:
                    skipped += 1
                progress.update(step=1, extra=f"{status} ({len(fields)} imported)", force=status.startswith("err"))

    fields.sort(key=lambda f: (clean(f.get("country")), clean(f.get("name"))))
    progress.done(f"imported {len(fields)}, skipped {skipped}, failed {failed}, {count_media_items(fields)} images")
    return fields


def streckenflug_country_list_url(list_url: str, country: str) -> str:
    if not country:
        return list_url
    parsed = urllib.parse.urlparse(list_url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    query["side_land"] = [country.upper()]
    if "side_kontinent" not in query:
        query["side_kontinent"] = ["EU"]
    # Keep blank fields stable; urlencode with doseq preserves the legacy endpoint shape.
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query, doseq=True)))


def extract_streckenflug_links(page: str, base_url: str, countries: set[str]) -> list[dict[str, str]]:
    """Extract streckenflug ids from either the list table or the map select."""
    country_map = {
        "FRANCE": "FR", "FRANKREICH": "FR",
        "SWITZERLAND": "CH", "SCHWEIZ": "CH", "SUISSE": "CH",
        "ITALY": "IT", "ITALIA": "IT", "ITALIEN": "IT",
        "AUSTRIA": "AT", "ÖSTERREICH": "AT", "OESTERREICH": "AT",
        "GERMANY": "DE", "DEUTSCHLAND": "DE",
    }
    items: list[dict[str, str]] = []
    seen: set[str] = set()

    # List view: rows contain iID links and country/category columns.
    row_pattern = re.compile(r"<tr\b[^>]*>(?P<row>.*?)</tr>", re.I | re.S)
    link_pattern = re.compile(r'<a\b[^>]*href=["\'](?P<href>[^"\']*iID=(?P<id>\d+)[^"\']*)["\'][^>]*>(?P<name>.*?)</a>', re.I | re.S)
    for row_match in row_pattern.finditer(page):
        row = row_match.group("row")
        link = link_pattern.search(row)
        if not link:
            continue
        source_id = link.group("id")
        if source_id in seen:
            continue
        name = normalize_streckenflug_option_name(strip_html(link.group("name")))
        if not name:
            continue
        row_text = strip_html(row)
        detected_country = ""
        for label, code in country_map.items():
            if re.search(rf"\b{re.escape(label)}\b", row_text, flags=re.I):
                detected_country = code
                break
        if countries and detected_country and detected_country not in countries:
            continue
        seen.add(source_id)
        items.append({
            "streckenflugId": source_id,
            "name": name,
            "url": urllib.parse.urljoin(base_url, html.unescape(link.group("href"))),
            "country": detected_country,
        })

    # Fallback for older pages without rows: scan iID links and nearby text.
    for match in link_pattern.finditer(page):
        source_id = match.group("id")
        if source_id in seen:
            continue
        name = normalize_streckenflug_option_name(strip_html(match.group("name")))
        if not name:
            continue
        nearby = strip_html(page[match.start(): match.end() + 700])
        detected_country = ""
        for label, code in country_map.items():
            if re.search(rf"\b{re.escape(label)}\b", nearby, flags=re.I):
                detected_country = code
                break
        if countries and detected_country and detected_country not in countries:
            continue
        seen.add(source_id)
        items.append({
            "streckenflugId": source_id,
            "name": name,
            "url": urllib.parse.urljoin(base_url, html.unescape(match.group("href"))),
            "country": detected_country,
        })

    # Map view fallback: <option value="339" style="...">L - Achensee</option>
    option_pattern = re.compile(r'<option\b[^>]*\bvalue=["\'](?P<id>\d+)["\'][^>]*>(?P<name>.*?)</option>', re.I | re.S)
    for match in option_pattern.finditer(page):
        source_id = match.group("id")
        if source_id in seen:
            continue
        name = normalize_streckenflug_option_name(strip_html(match.group("name")))
        if not name:
            continue
        seen.add(source_id)
        items.append({
            "streckenflugId": source_id,
            "name": name,
            "url": f"https://landout.streckenflug.at/index.php?inc=map&iID={source_id}",
            "country": next(iter(countries), "") if len(countries) == 1 else "",
        })
    return items

def normalize_streckenflug_option_name(value: str) -> str:
    value = normalize_space(value)
    # The public selector prefixes values with L/F, e.g. "L - Achensee".
    value = re.sub(r"^[A-Z]\s*-\s*", "", value)
    return value.strip()


def fetch_streckenflug_detail_json(source_id: str, raw_dir: Path) -> dict[str, Any]:
    cache_path = raw_dir / f"streckenflug-landeplatz-{source_id}.json"
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            cache_path.unlink(missing_ok=True)

    params = {"inc": "map", "task": "landeplatz", "id": str(source_id)}
    url = STRECKENFLUG_JSON_URL + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={
        "User-Agent": "MeetTheCows/0.4 (+https://github.com/)",
        "Accept": "application/json,text/javascript,*/*;q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"https://landout.streckenflug.at/index.php?inc=map&iID={source_id}",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read().decode("utf-8", errors="replace")
    data = json.loads(body)
    cache_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def parse_streckenflug_detail(
    data: dict[str, Any],
    item: dict[str, str],
    pack_id: str,
    media_dir: Path,
    *,
    include_images: bool = True,
) -> dict[str, Any] | None:
    name = clean(data.get("ueb")) or item.get("name", "")
    lat = parse_float(data.get("lat"))
    lon = parse_float(data.get("lon"))
    if not name or lat is None or lon is None:
        return None

    country = streckenflug_country_code(clean(data.get("land"))) or item.get("country") or infer_country_from_lon_lat(lon, lat) or ""
    code = clean(data.get("icao"))
    category = clean(data.get("kategorie"))
    raw_difficulty, difficulty = extract_streckenflug_difficulty(category)
    field_type = clean(data.get("art"))
    kind = "airfield" if "airfield" in field_type.lower() or "airport" in field_type.lower() or ICAO_RE.match(code or "") else "outlanding"
    elevation_m = parse_first_metric_length(data.get("hoehe"))
    length_m = parse_first_metric_length(data.get("laenge"))
    width_m = parse_first_metric_length(data.get("breite"))
    runway_direction = parse_runway_direction(data.get("richtung"))
    source_url = item.get("url") or f"https://landout.streckenflug.at/index.php?inc=map&iID={data.get('id') or item.get('streckenflugId', '')}"
    notes = build_streckenflug_notes_from_json(data)
    freqs = extract_frequencies_from_text(notes, source="streckenflug.at detail")
    field_id = stable_id(country or "xx", code, name, lat, lon)

    media: list[dict[str, Any]] = []
    if include_images:
        media = download_streckenflug_images(
            field_id=field_id,
            source_id=clean(data.get("id")) or item.get("streckenflugId", field_id),
            html_parts=[clean(data.get("fotos")), clean(data.get("feedback"))],
            media_dir=media_dir,
            source_url=source_url,
            updated_at=parse_streckenflug_date(clean(data.get("modified"))),
        )

    return {
        "id": field_id,
        "kind": kind,
        "name": name,
        "code": code,
        "country": country,
        "latitude": round(float(lat), 7),
        "longitude": round(float(lon), 7),
        "elevationM": elevation_m,
        "difficulty": difficulty,
        "rawDifficulty": raw_difficulty,
        "lengthM": length_m,
        "widthM": width_m,
        "runwayDirectionDeg": runway_direction,
        "frequency": format_frequency_short(freqs),
        "frequencies": freqs,
        "notes": notes,
        "source": {
            "name": "streckenflug.at Landout Database",
            "sourceId": clean(data.get("id")) or item.get("streckenflugId", ""),
            "importedAt": dt.date.today().isoformat(),
            "modified": clean(data.get("modified")),
            "packId": pack_id,
        },
        "media": media,
    }


def streckenflug_country_code(label: str) -> str:
    mapping = {
        "france": "FR", "frankreich": "FR",
        "switzerland": "CH", "schweiz": "CH", "suisse": "CH",
        "italy": "IT", "italia": "IT", "italien": "IT",
        "austria": "AT", "österreich": "AT", "oesterreich": "AT",
        "germany": "DE", "deutschland": "DE",
    }
    return mapping.get(label.strip().lower(), label.strip().upper() if len(label.strip()) == 2 else "")


STRECKENFLUG_GERMAN_PHRASES: list[tuple[str, str]] = [
    (r"\bBesichtigung am\b", "Inspection on"),
    (r"\bUnverändert wie beschrieben\b", "Unchanged from the description"),
    (r"\bDefinitiv nur Kategorie\s+([A-D])\b", r"Definitely category \1"),
    (r"\bnur für Notfälle\b", "emergencies only"),
    (r"\bBesichtigungs-Video\b", "Inspection video"),
    (r"\bSIP Kategorie\s+([A-D])\b", r"SIP category \1"),
    (r"\bWiese hängt zum See hin\b", "The meadow slopes toward the lake"),
    (r"\bHängt zum See hin\b", "Slopes toward the lake"),
    (r"\bmeist Nordwind\b", "usually northerly wind"),
    (r"\bWiese ist landbar\b", "The meadow is landable"),
    (r"\bDie Wiese ist weiterhin landbar\b", "The meadow remains landable"),
    (r"\bmit den bekannten Einschränkungen\b", "with the known limitations"),
    (r"\ballerdings mit Einschränkungen\b", "but with limitations"),
    (r"\bEndanflug über Bebauung\b", "final approach over buildings"),
    (r"\bkurze Wiese\b", "short meadow"),
    (r"\bnur südlichen Teil nutzen\b", "use only the southern part"),
    (r"\bbis zum Zaun bzw\. zur Baumreihe\b", "up to the fence / tree line"),
    (r"\bStromleitung nordöstlich beachten\b", "watch the power line to the northeast"),
    (r"\bZeitweise Vieh möglich\b", "livestock may be present at times"),
    (r"\binitiales feedback\b", "initial feedback"),
    (r"\bMittlerweile ist der Anflugbereich südlich der Querstraße bebaut worden\b", "The approach area south of the cross road has since been built up"),
    (r"\bMit etwas Sicherheitshöhe beim Überflug der Straße bleibt\b", "With some safety height while crossing the road, what remains is"),
    (r"\bein tatsächlich nutzbarer Streifen von ca\.\b", "an actually usable strip of about"),
    (r"\bder in der zweiten Hälfte zum Ufer hin abfällt\b", "which slopes down toward the shore in the second half"),
    (r"\bAm Ende der Wiese kommt dann die Baumreihe bzw\. der Graben\b", "At the end of the meadow there is the tree line / ditch"),
    (r"\bsind wesentlich besser und bieten mehr Alternativen\b", "are significantly better and offer more alternatives"),
    (r"\bSie sind länger bzw\. haben einen freien Anflug\b", "They are longer / have an unobstructed approach"),
    (r"\bEine Landung auf der Wiese in Buchau würde ich unter diese[mn] Umständen nicht mehr in Betracht ziehen\b", "I would no longer consider landing on the meadow in Buchau under these circumstances"),
    (r"\bist ebenfalls dieser Meinung\b", "shares this opinion"),
    (r"\bwir würden die Wiese aus dem SIP streichen\b", "we would remove the meadow from the SIP"),
    (r"\bDie Wiese hat im kurzen Endteil\s+(\d+)\s+eine Hochspannungsleitung\b", r"The meadow has a high-voltage power line on short final \1"),
    (r"\bsollte also nur\s+(\d+)\s+angeflogen werden\b", r"should therefore only be approached on \1"),
    (r"\bFeld im August\s+(\d{4})\s+besucht\b", r"Field visited in August \1"),
    (r"\bNeben dem markierte[nr] Abschnitt hat es ab und zu ein paar Steine\b", "Next to the marked section there are occasionally a few stones"),
    (r"\bdie jedoch überrollt werden können\b", "which can be rolled over"),
    (r"\bZufahrt von\s+([NSEW])\s+möglich\b", r"Access from \1 possible"),
    (r"\bWichtiges Feld falls man von Süden kommend den Sprung auf die Hochebene nicht mehr schafft\b", "Important field if arriving from the south and unable to climb onto the plateau"),
    (r"\bHeute absolut unlandbar\b", "Today absolutely not landable"),
    (r"\bEs sind zwei Wiesen durch ca\.\s*1m hohen Zaun.*?abgetrennt\b", "There are two meadows separated by an approximately 1 m high fence"),
    (r"\bSüdlicher Teil war sehr gut landbar\b", "Southern part was very landable"),
    (r"\bNördlicher Teil zu kurz\b", "Northern part too short"),
    (r"\bliegt optimal in der Windrichtung\b", "lies well aligned with the wind direction"),
    (r"\bkann bei Talwind sowie bei Südwind ohne Probleme angeflogen werden\b", "can be approached without problems in valley wind and southerly wind"),
    (r"\bZu beachten ist dass\b", "Note that"),
    (r"\bFelder mit Hagposten unterteilt sind\b", "fields are divided by hail-posts"),
    (r"\bHochspannungsstromleitungen östlich der Autobahn zusammengelegt\b", "high-voltage power lines east of the motorway have been consolidated"),
    (r"\bHier noch ein Bild von der nördliche[nr] Talseite\b", "Additional picture from the northern side of the valley"),
    (r"\bSchön flaches Feld\b", "Nice flat field"),
    (r"\bnur wenig Bodenwellen\b", "only slight undulations"),
    (r"\betwas schwieriger Anflug\b", "somewhat difficult approach"),
    (r"\bgrundsätzlich gut geeignet\b", "generally suitable"),
    (r"\bnicht nachvollziehbar\b", "not understandable"),
    (r"\bbezieht sich ev\.? auf ein anderes Feld\b", "may refer to another field"),
    (r"\bÖstliches Feld\b", "Eastern field"),
    (r"\bWestliches Feld\b", "Western field"),
    (r"\bin der ersten Hälfte wellig\b", "wavy in the first half"),
    (r"\bdaher bei Getreidebau schlecht\b", "therefore poor when planted with grain"),
    (r"\bdeutlich besser\b", "clearly better"),
    (r"\bRichtung\s+([A-Z])\b", r"Direction \1"),
    (r"\bVorsicht Baumreihe im Anflug\b", "caution: tree line on approach"),
    (r"\bFeld ist eben und bretthart\b", "Field is flat and very hard"),
    (r"\bNur kleinere Steine zwischendrin\b", "Only small stones here and there"),
    (r"\bGut landbar\b", "Good landing option"),
    (r"\bim südlichen Teil läuft ein Graben durch\b", "a ditch runs through the southern part"),
    (r"\bNur die nördliche Hälfte entlang des Weges nutzen\b", "Use only the northern half along the track"),
    (r"\bZufahrt zum Feld an der Nordspitze\b", "Access to the field at the northern tip"),
    (r"\bwie unten beschrieben\b", "As described below"),
    (r"\bBesichtigungs-Video:\s*https?://\S+\b", ""),
    (r"\bBesichtigt am\b", "Inspected on"),
    (r"\bBesichtigung\s+am\b", "Inspection on"),
    (r"\bBesichtigung\s+(\d)", r"Inspection \1"),
    (r"\bUL-Piste mit Windsack\b", "UL strip with windsock"),
    (r"\bAnsteigend von Südost nach Nordwest, Landung daher nur von Südost nach Nordwest\b", "Climbs from southeast to northwest; land only from southeast to northwest"),
    (r"\bZwei weiße, kegelförmige Landereiter markieren die Schwelle\b", "Two white cone-shaped markers indicate the threshold"),
    (r"\bAufsetzen nicht vor der Schwelle, da der Boden davor uneben ist\b", "Do not touch down before the threshold; the ground before it is uneven"),
    (r"\bAufsetzen aber auch nicht weit nach der Schwelle, da bei langem Ausrollen bergauf Richtung Nordwest der Boden zunehmend unebener wird\b", "Also do not touch down far after the threshold; on a long uphill rollout toward the northwest the ground becomes increasingly uneven"),
    (r"\bAm besten sind die ersten 150 Meter nach der Schwelle\b", "The first 150 m after the threshold are best"),
    (r"\bAus der Luft sieht das Feld farblich scheckig, uneinheitlich und dadurch schlechter aus, als es ist\b", "From the air the field looks patchy and uneven in color, so it looks worse than it is"),
    (r"\bRingsum sind aber auch viele landwirtschaftliche Felder\b", "There are also many agricultural fields around it"),
    (r"\bSchwierige Wahl; bei der UL-Piste weiß man zumindest, was man hat\b", "Difficult choice; with the UL strip at least you know what you have"),
    (r"\bIm März 2023 war die Piste eher schlecht gepflegt, mit einzelnen kleinen dornigen Büschen hier und da\b", "In March 2023 the strip was rather poorly maintained, with a few small thorny bushes here and there"),
    (r"\bHallo, die Oberfläche von Montgardin ist in der Datei als Asphaltpiste eingetragen\b", "The Montgardin surface is listed as asphalt in the file"),
    (r"\bDies ist nicht korrekt, bei der Oberfläche handelt es sich um Gras\b", "This is not correct; the surface is grass"),
    (r"\bViele Grüße!?\s*(?:Tore Graeber)?\b", ""),
    (r"\bFeld unverändert gut\b", "Field unchanged and good"),
    (r"\bAm\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\s+dort gelandet\b", r"Landed there on \1"),
    (r"\bLanderichtung\s+([0-9/]+)\b", r"Landing direction \1."),
    (r"\bLanderichtung\b", "Landing direction"),
    (r"\bDurch Windräder sehr leicht auffindbar\b", "Very easy to find thanks to wind turbines"),
    (r"\bAnflug ohne Hindernisse und Landung problemlos\b", "Approach without obstacles and landing uncomplicated"),
    (r"\bMehrere Möglichkeiten\b", "Several options"),
    (r"\bMein Feld mit den Windrädern lag östlich der kleinen Straße\b", "My field with the wind turbines was east of the small road"),
    (r"\bLandung im August\s+(\d{4})\b", r"Landing in August \1"),
    (r"\bauf Getreidefeld\b", "on a grain field"),
    (r"\bWiese steigt deutlich von Süd nach Nord an\b", "The meadow climbs noticeably from south to north"),
    (r"\bLandung nur von Süd nach Nord möglich\b", "Landing possible only from south to north"),
    (r"\bStromleitung quert\b", "power line crosses"),
    (r"\bAufsetzen nach\b", "Touch down after"),
    (r"\bAusrollen darunter hindurch\b", "roll out underneath it"),
    (r"\bMuss besichtigt werden\b", "Must be inspected"),
    (r"\bSteigt gegen\s+([A-Z]+)\s+an\b", r"Climbs toward \1"),
    (r"\bMomentan Getreide auf dem Feld\b", "Currently grain on the field"),
    (r"\bNur von Osten her anfliegbar\b", "Approachable only from the east"),
    (r"\bhoch anfliegen\b", "approach high"),
    (r"\bFrisch gemäht\b", "Freshly mowed"),
    (r"\bEntlang der Straße ist ein Zaun\b", "There is a fence along the road"),
    (r"\bEntlang der Strasse ist ein Zaun\b", "There is a fence along the road"),
    (r"\bSüdlichen Teil der Wiese benützen\b", "Use the southern part of the meadow"),
    (r"\bGras noch tief\b", "Grass still low"),
    (r"\bLuftaufnahme März\s+(\d{4})\b", r"Aerial photo March \1"),
    (r"\bGut landbar, Naturwiese\b", "Good landing option, natural meadow"),
    (r"\bAnflug nur Richtung\s+([0-9°]+)\b", r"Approach only direction \1"),
    (r"\bWestliches Feld\b", "Western field"),
    (r"\bNördliches Feld\b", "Northern field"),
    (r"\bHindernisse im Anflug\b", "Obstacles on approach"),
    (r"\bim Anflug\b", "on approach"),
    (r"\bAufsetzen erst nach Querweg empfehlenswert\b", "Touchdown recommended only after the crossing track"),
    (r"\bvorsicht Leitungen\b", "caution: lines"),
    (r"\bBahnlinie mit Fahrleitung beachten\b", "watch the railway line with overhead wire"),
    (r"\bBei Alternative Ost\b", "For the eastern alternative"),
    (r"\btalaufwärts\b", "up-valley"),
    (r"\bratsam\b", "advisable"),
    (r"\bWiese\b", "meadow"),
    (r"\bWiesen\b", "meadows"),
    (r"\bFeld\b", "field"),
    (r"\bFelder\b", "fields"),
    (r"\blandbar\b", "landable"),
    (r"\bunlandbar\b", "not landable"),
    (r"\bEinschränkungen\b", "limitations"),
    (r"\bAnflugbereich\b", "approach area"),
    (r"\bAnflug\b", "approach"),
    (r"\bEndanflug\b", "final approach"),
    (r"\bBebauung\b", "buildings"),
    (r"\bAussenlandefeld\b", "outlanding field"),
    (r"\bAußenlandefeld\b", "outlanding field"),
    (r"\bLandefeld\b", "landing field"),
    (r"\bLandefelder\b", "landing fields"),
    (r"\bLandung\b", "landing"),
    (r"\bLandungen\b", "landings"),
    (r"\blanden\b", "land"),
    (r"\bgelandet\b", "landed"),
    (r"\bangeflogen\b", "approached"),
    (r"\bAngeflogen\b", "Approached"),
    (r"\banfliegbar\b", "approachable"),
    (r"\bAufsetzen\b", "touchdown"),
    (r"\bAusrollen\b", "rollout"),
    (r"\bHochspannungsleitung\b", "high-voltage power line"),
    (r"\bHochspannungsstromleitungen\b", "high-voltage power lines"),
    (r"\bStrommasten\b", "power pylons"),
    (r"\bMasten\b", "pylons"),
    (r"\bZaun\b", "fence"),
    (r"\bZäune\b", "fences"),
    (r"\bPfosten\b", "posts"),
    (r"\bBaumreihe\b", "tree line"),
    (r"\bBäume\b", "trees"),
    (r"\bHecken\b", "hedges"),
    (r"\bStromleitung\b", "power line"),
    (r"\bLeitung\b", "line"),
    (r"\bLeitungen\b", "lines"),
    (r"\bbeachten\b", "watch"),
    (r"\bAchtung\b", "caution"),
    (r"\bVorsicht\b", "caution"),
    (r"\bVieh\b", "livestock"),
    (r"\bmöglich\b", "possible"),
    (r"\bZufahrt\b", "access"),
    (r"\bSteine\b", "stones"),
    (r"\bGetreidefeld\b", "grain field"),
    (r"\bGetreide\b", "grain"),
    (r"\bBewuchs\b", "vegetation"),
    (r"\bBodenwellen\b", "undulations"),
    (r"\bwellig\b", "wavy"),
    (r"\büberrollt\b", "rolled over"),
    (r"\büberrollbar\b", "rollable"),
    (r"\bGräben\b", "ditches"),
    (r"\bHälfte\b", "half"),
    (r"\bTeil\b", "part"),
    (r"\bAbschnitt\b", "section"),
    (r"\bGemäht\b", "mowed"),
    (r"\bgemäht\b", "mowed"),
    (r"\bFläche\b", "area"),
    (r"\bFlächen\b", "areas"),
    (r"\bGefälle\b", "slope"),
    (r"\bOberfläche\b", "surface"),
    (r"\bBewässerungsstangen\b", "irrigation poles"),
    (r"\bBewässerungsrohre\b", "irrigation pipes"),
    (r"\bBewässerung\b", "irrigation"),
    (r"\bHagposten\b", "hail-posts"),
    (r"\bWindrichtung\b", "wind direction"),
    (r"\bTalwind\b", "valley wind"),
    (r"\bSüdwind\b", "southerly wind"),
    (r"\bGelände\b", "terrain"),
    (r"\bHindernisse\b", "obstacles"),
    (r"\bHindernis\b", "obstacle"),
    (r"\bsüdlichen\b", "southern"),
    (r"\bsüdlich\b", "south"),
    (r"\bSüdlicher\b", "Southern"),
    (r"\bsüdlicher\b", "southern"),
    (r"\bnördlich\b", "northern"),
    (r"\bnördliche\b", "northern"),
    (r"\bNördlicher\b", "Northern"),
    (r"\bnördlicher\b", "northern"),
    (r"\bnordöstlich\b", "northeast"),
    (r"\böstlich\b", "east"),
    (r"\böstlichen\b", "eastern"),
    (r"\böstliche\b", "eastern"),
    (r"\bsüdöstlich\b", "southeast"),
    (r"\bwestlich\b", "west"),
    (r"\bwestliche\b", "western"),
    (r"\bSüden\b", "south"),
    (r"\bOsten\b", "east"),
    (r"\bWesten\b", "west"),
    (r"\bNord\b", "north"),
    (r"\bSüd\b", "south"),
    (r"\bSee\b", "lake"),
    (r"\bUfer\b", "shore"),
    (r"\bStraße\b", "road"),
    (r"\bStrasse\b", "road"),
    (r"\bWeg\b", "track"),
    (r"\bQuerweg\b", "crossing track"),
    (r"\bBahnlinie\b", "railway line"),
    (r"\bAutobahn\b", "motorway"),
    (r"\bGraben\b", "ditch"),
    (r"\bNotfälle\b", "emergencies"),
    (r"\bKategorie\b", "category"),
    (r"\bBesichtigung\b", "inspection"),
    (r"\bbeschrieben\b", "described"),
    (r"\bunverändert\b", "unchanged"),
    (r"\bfreie[nr]?\b", "clear"),
    (r"\bfrisch\b", "freshly"),
    (r"\bhohe[rsn]?\b", "high"),
    (r"\blänger\b", "longer"),
    (r"\bkurz\b", "short"),
    (r"\bsehr gut\b", "very good"),
    (r"\bgut\b", "good"),
    (r"\bweiterhin\b", "still"),
    (r"\baber\b", "but"),
    (r"\bund\b", "and"),
    (r"\bnur\b", "only"),
    (r"\bnicht\b", "not"),
    (r"\bohne\b", "without"),
    (r"\bmit\b", "with"),
    (r"\bmöglichkeit\b", "possibility"),
    (r"\bMöglichkeit\b", "possibility"),
    (r"\bMöglichkeiten\b", "possibilities"),
    (r"\bmöglich\b", "possible"),
    (r"\bmögliche\b", "possible"),
    (r"\bkönnen\b", "can"),
    (r"\bkönnte\b", "could"),
    (r"\bwürde\b", "would"),
]


GERMAN_TEXT_HINT_RE = re.compile(
    r"[äöüß]|\b(?:"
    r"aussenlandefeld|außenlandefeld|anflug|angeflogen|anfliegbar|aufsetzen|ausrollen|"
    r"beachten|besichtigung|besichtigt|boden|feld|felder|gemäht|graben|"
    r"hindernis|hindernisse|landbar|landung|landungen|leitunge?n|"
    r"möglich|nördlich|oberfläche|piste|schwelle|südlich|strom|"
    r"uneben|unverändert|vorsicht|wiese|wiesen|zaun|zufahrt|"
    r"aber|am|bei|beschrieben|da|das|der|die|durch|ist|mit|nach|nicht|nur|und|von|zu|zum|zur"
    r")\b",
    flags=re.I,
)


def build_streckenflug_notes_from_json(data: dict[str, Any]) -> str:
    """Assemble the streckenflug note in its native German.

    Labels and hazard phrases are German and the free-text values are left untranslated, so the
    note is coherent German. localize_note() then keeps this German text as the "de" slot (no
    round-trip) and translates it once into English and French.
    """
    parts: list[str] = []
    for label, key in [
        ("Info", "info"),
        ("Oberfläche", "oberflaeche"),
        ("Richtung", "richtung"),
        ("Neigung", "steigung"),
        ("Besichtigung", "last_check_year"),
        ("Geändert", "modified"),
    ]:
        value = clean(data.get(key))
        if value:
            value = clean_streckenflug_text(value)
            parts.append(f"{label}: {value}")
    obstacles: list[str] = []
    if clean(data.get("z_uneben")) == "1":
        obstacles.append("unebener Boden")
    if clean(data.get("z_bodenhindernis")) == "1":
        obstacles.append("Bodenhindernisse")
    if clean(data.get("z_leitungen")) == "1":
        obstacles.append("Strom-/andere Leitungen")
    if obstacles:
        parts.append("Gemeldete Gefahren: " + ", ".join(obstacles))
    feedback_entries = extract_streckenflug_feedback_entries(clean(data.get("feedback")))
    if feedback_entries:
        parts.append("Rückmeldungen:\n" + "\n".join(f"- {entry}" for entry in feedback_entries[:4]))
    return "\n".join(parts).strip()


def extract_streckenflug_feedback_entries(value: str) -> list[str]:
    if not value:
        return []
    entries: list[str] = []
    pattern = re.compile(
        r"<p\b[^>]*>\s*<b>(?P<header>.*?)</b>\s*</p>\s*<p\b[^>]*>(?P<body>.*?)</p>",
        flags=re.I | re.S,
    )
    for match in pattern.finditer(value):
        header = tidy_streckenflug_text(strip_html(match.group("header")))
        body = streckenflug_html_text(match.group("body"))
        if not body:
            continue
        entries.append(f"{header}: {body}" if header else body)
    if entries:
        return entries
    fallback = streckenflug_html_text(value)
    return [fallback] if fallback else []


def streckenflug_html_text(value: str) -> str:
    value = re.sub(r"<\s*(?:br|/p|/div|hr)\b[^>]*>", ". ", value, flags=re.I)
    value = strip_html(value)
    value = re.sub(r"https?://\S+", "", value, flags=re.I)
    return tidy_streckenflug_text(value)


def clean_streckenflug_text(value: str) -> str:
    """Tidy a streckenflug free-text value without translating it.

    Notes are kept in their native language and translated later by localize_note(); this only
    strips URLs and the trailing "Inspection video" marker and normalises whitespace/casing.
    """
    text = normalize_space(value)
    if not text:
        return ""
    text = re.sub(r"https?://\S+", "", text, flags=re.I)
    text = re.sub(r"\bInspection video:\s*(?:[.;]\s*)?$", "", text, flags=re.I)
    return tidy_streckenflug_text(text)


def deepl_translate(text: str, target_lang: str = "EN-GB") -> str | None:
    """Return the translation of `text` into `target_lang`, or None when DeepL is unavailable.

    Thin wrapper over deepl_translate_ex that drops the detected source language.
    """
    result = deepl_translate_ex(text, target_lang)
    return None if result is None else result[0]


def deepl_translate_ex(text: str, target_lang: str = "EN-GB") -> tuple[str, str] | None:
    """Translate `text` into `target_lang`; return (translated, detected_source) or None.

    When DeepL detects that the source language already matches the target, the original
    text is returned unchanged (e.g. French Guide prose asked for French, German asked for
    German) so we never round-trip a note through its own language. Any auth/quota error
    disables DeepL for the rest of the run so we degrade to the dictionary/source instead of
    hammering the API. `detected_source` is the upper-case DeepL code (e.g. "FR", "DE", "EN").
    """
    global _DEEPL_DISABLED, _DEEPL_CHARS_SPENT
    if _DEEPL_DISABLED or not DEEPL_API_KEY or not DEEPL_API_URL:
        return None
    stripped = text.strip()
    if not stripped:
        return None
    # Budget safeguard: never spend past the per-run allowance (min of the per-build cap and
    # remaining lifetime quota). Once tripped, stop calling DeepL for the rest of the build.
    if _DEEPL_BUDGET_CHARS is not None and _DEEPL_CHARS_SPENT + len(stripped) > _DEEPL_BUDGET_CHARS:
        if not _DEEPL_DISABLED:
            print(
                f"DeepL budget guard: stopping at {_DEEPL_CHARS_SPENT:,} chars this run "
                f"(allowance {_DEEPL_BUDGET_CHARS:,}); remaining notes use the offline dictionary",
                file=sys.stderr,
            )
        _DEEPL_DISABLED = True
        return None
    body = urllib.parse.urlencode({"text": stripped, "target_lang": target_lang}).encode("utf-8")
    request = urllib.request.Request(
        DEEPL_API_URL,
        data=body,
        headers={
            "Authorization": f"DeepL-Auth-Key {DEEPL_API_KEY}",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "MeetTheCows-pack-build/0.4",
        },
        method="POST",
    )
    payload = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as error:
            if error.code == 429:
                # Rate limited: honour Retry-After (seconds) else exponential backoff, then retry.
                retry_after = error.headers.get("Retry-After") if error.headers else None
                delay = float(retry_after) if (retry_after and retry_after.isdigit()) else min(2 ** attempt, 16)
                time.sleep(delay)
                continue
            if error.code in (401, 403, 456):
                _DEEPL_DISABLED = True
                print(f"DeepL disabled for this run (HTTP {error.code}); using offline dictionary", file=sys.stderr)
            else:
                print(f"DeepL request failed (HTTP {error.code})", file=sys.stderr)
            return None
        except Exception as error:  # noqa: BLE001 - network/JSON errors should not abort the build
            print(f"DeepL request error: {error}", file=sys.stderr)
            return None
    if payload is None:
        print("DeepL rate limit persisted after retries; using offline dictionary for this note", file=sys.stderr)
        return None
    translations = payload.get("translations") or []
    if not translations:
        return None
    # DeepL bills for the characters it processed regardless of detected language.
    _DEEPL_CHARS_SPENT += len(stripped)
    first = translations[0]
    detected = clean(first.get("detected_source_language")).upper()
    translated = clean(first.get("text"))
    # Source already matches the target (e.g. FR asked for FR): keep the original text.
    if detected == target_lang.split("-")[0].upper():
        return stripped, detected
    return (translated or stripped), detected


def localize_note_cached(text: str, lang: str) -> tuple[str, str]:
    """Translate `text` into app language `lang` ('en'|'fr'|'de'), memoised per (lang, text).

    Returns (translated, detected_source_lower). The cache is language-qualified so the same
    source string can hold a separate translation per target language; cache hits report an
    empty detected-source (unknown after the fact). Falls back to the offline German
    dictionary for English, and to the untouched source text for French/German, so a missing
    DeepL key degrades gracefully instead of dropping notes.
    """
    key = f"{lang}\x1f{normalize_space(text)}"
    with _DEEPL_LOCK:
        cached = _TRANSLATION_CACHE.get(key)
        if cached is not None:
            _TRANSLATION_STATS["cache"] += 1
            return cached, ""
        result = deepl_translate_ex(text, LANG_TO_DEEPL[lang])
        if result is not None:
            translated, detected = result
            _TRANSLATION_CACHE[key] = translated
            _TRANSLATION_STATS["deepl"] += 1
            return translated, detected.lower()[:2]
        _TRANSLATION_STATS["fallback"] += 1
    if lang == "en":
        return dictionary_translate_german(text), ""
    return text, ""


# A "Label: value" line: a short label (no colon in it) followed by a non-empty value.
_LABEL_LINE_RE = re.compile(r"^([^:]{1,24}):\s+(\S.*)$", re.S)
# A "- feedback" bullet: leading marker kept, body translated.
_BULLET_RE = re.compile(r"^(\s*-\s+)(.*)$", re.S)


def _translate_line(line: str, lang: str) -> str:
    """Translate one note line into `lang`, reusing sub-segments.

    A "Label: value" line translates the label and the value separately, so the (highly
    repetitive) German labels — "Oberfläche:", "Richtung:", "Besichtigung:" … — are cached
    once across every field instead of once per distinct value. A "- feedback" bullet keeps its
    marker and translates only the body. Blank lines pass through untouched.
    """
    if not line.strip():
        return line
    prefix = ""
    content = line
    bullet = _BULLET_RE.match(content)
    if bullet:
        prefix, content = bullet.group(1), bullet.group(2)
    labelled = _LABEL_LINE_RE.match(content)
    if labelled:
        label, value = labelled.group(1), labelled.group(2)
        t_label, _ = localize_note_cached(f"{label}:", lang)
        t_value, _ = localize_note_cached(value, lang)
        return f"{prefix}{t_label} {t_value}"
    translated, _ = localize_note_cached(content, lang)
    return f"{prefix}{translated}"


def localize_note_reusing_segments(text: str, lang: str) -> str:
    """Translate `text` into `lang`, reusing already-translated lines/labels (a lightweight
    translation memory).

    Whole-note exact matches short-circuit first: a note we already paid to translate — or any
    identical repeat — is free, so this never re-spends on the FR/CH/IT notes already cached and
    only sends genuinely new lines to DeepL. Multi-line notes are translated line by line and
    reassembled in order; a single-line note falls straight through to the line translator.
    """
    whole_key = f"{lang}\x1f{normalize_space(text)}"
    with _DEEPL_LOCK:
        hit = _TRANSLATION_CACHE.get(whole_key)
    if hit is not None:
        _TRANSLATION_STATS["cache"] += 1
        return hit
    lines = text.split("\n")
    if len(lines) <= 1:
        return _translate_line(text, lang)
    assembled = "\n".join(_translate_line(line, lang) for line in lines)
    # Remember the assembled note so an identical multi-line note is O(1) next build.
    with _DEEPL_LOCK:
        _TRANSLATION_CACHE.setdefault(whole_key, assembled)
    return assembled


def localize_note(text: str, source_lang: str | None = None) -> dict[str, str]:
    """Turn a native note string into {"en","fr","de"}.

    When the note's source language is known (Guide = French, streckenflug = German, our own
    airfield boilerplate = English), that slot keeps the original text verbatim and only the two
    other languages are translated — no round-trip through a third language, and no DeepL
    characters spent re-encoding a note into its own language. When the source is unknown (e.g.
    a legacy mixed note), the English slot is translated first so DeepL can report the source and
    that language is kept native. Empty input yields empty strings in every slot.
    """
    text = clean(text)
    if not text:
        return {lang: "" for lang in APP_LANGUAGES}
    if source_lang in APP_LANGUAGES:
        out: dict[str, str] = {source_lang: text}
        for lang in APP_LANGUAGES:
            if lang != source_lang:
                out[lang] = localize_note_reusing_segments(text, lang)
        return {lang: out.get(lang, "") for lang in APP_LANGUAGES}
    english, detected = localize_note_cached(text, "en")
    out = {"en": text if detected == "en" else english}
    if detected in ("fr", "de"):
        out[detected] = text
    for lang in ("fr", "de"):
        if lang not in out:
            out[lang], _ = localize_note_cached(text, lang)
    return {lang: out.get(lang, "") for lang in APP_LANGUAGES}


def note_source_lang(field: dict[str, Any]) -> str | None:
    """Best-effort native language of a field's note, from its (single) source name.

    Called before duplicate fields are merged, so every field still has one source. Returns
    None for anything unrecognised, letting localize_note fall back to language detection.
    """
    name = clean((field.get("source") or {}).get("name")).lower()
    if "streckenflug" in name:
        return "de"
    if "guide" in name or "planeur-net" in name:
        return "fr"
    if "openaip" in name or "sia" in name or "vac" in name or "aerodrome" in name:
        return "en"
    return None


def is_major_airport(field: dict[str, Any]) -> bool:
    """True for a major commercial/controlled airport or active military base a glider must not
    land at, identified by a long paved runway or an explicit ICAO list. Never true for
    outlanding fields — only airfields are ever dropped.
    """
    if clean(field.get("kind")) != "airfield":
        return False
    if clean(field.get("code")).upper() in MAJOR_AIRFIELD_ICAO:
        return True
    length = field.get("lengthM")
    return isinstance(length, (int, float)) and length >= MAJOR_AIRFIELD_MIN_RUNWAY_M


def drop_major_airports(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove major airports/military bases before translating and merging, so they never appear
    as landing options (they otherwise dominate the pinned 'best options')."""
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for field in fields:
        (dropped if is_major_airport(field) else kept).append(field)
    if dropped:
        labels = ", ".join(sorted({clean(f.get("code")) or clean(f.get("name")) or "?" for f in dropped}))
        print(f"Excluded {len(dropped)} major airport(s) not landable by glider: {labels}", file=sys.stderr)
    return kept


def find_contribution_field(fields: list[dict[str, Any]], meta: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve which pack field a contribution belongs to.

    Exact field id first; then ICAO/code; then nearest field within CONTRIB_MATCH_RADIUS_M of
    the coordinates stored on the contribution. The fallbacks matter because pack field ids are
    derived from upstream name/coords and can change between rebuilds.
    """
    contrib_id = clean(meta.get("fieldId"))
    if contrib_id:
        for field in fields:
            if field.get("id") == contrib_id:
                return field
    code = clean(meta.get("fieldCode")).upper()
    if code:
        matches = [f for f in fields if clean(f.get("code")).upper() == code]
        if len(matches) == 1:
            return matches[0]
    lat, lon = parse_float(meta.get("fieldLat")), parse_float(meta.get("fieldLon"))
    if lat is not None and lon is not None:
        best, best_d = None, CONTRIB_MATCH_RADIUS_M
        for field in fields:
            d = distance_m(lat, lon, field.get("latitude"), field.get("longitude"))
            if d is not None and d <= best_d:
                best, best_d = field, d
        return best
    return None


def _fetch_contribution_asset(url: str) -> bytes:
    """Download a contribution photo (release asset). Separate function so tests can stub it."""
    request = urllib.request.Request(url, headers={"User-Agent": "MeetTheCows/0.6"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def merge_contributions(fields: list[dict[str, Any]], contrib_dir: Path, media_dir: Path) -> tuple[int, int]:
    """Fold merged community contributions into the pack fields.

    Each contributions/<fieldId>/<stamp>.json (written by the intake Worker, reviewed and
    merged as a PR) adds a localized, dated "Pilot report" fragment to its field's notes and —
    when a photo asset is attached — a pack-optimized copy of the photo to the field's media.
    Runs after consolidation so contribution field ids match the published pack. A malformed
    contribution or a failed photo download degrades to a warning, never a failed build.
    Returns (notes_added, photos_added).
    """
    if not contrib_dir.exists():
        return (0, 0)
    notes_added = 0
    photos_added = 0
    for path in sorted(contrib_dir.rglob("*.json")):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001
            print(f"contribution skipped (bad JSON): {path}: {error}", file=sys.stderr)
            continue
        if not isinstance(meta, dict):
            continue
        field = find_contribution_field(fields, meta)
        if field is None:
            print(f"contribution skipped (no matching field): {path.name} -> {meta.get('fieldId')}", file=sys.stderr)
            continue

        date = clean(meta.get("date")) or clean(meta.get("submittedAt"))[:10]
        handle = clean((meta.get("submitter") or {}).get("handle")) if isinstance(meta.get("submitter"), dict) else ""
        attribution = f" ({handle})" if handle else ""

        description = clean(meta.get("description"))
        if description:
            localized = localize_note(description)
            notes = field.get("notes")
            if not isinstance(notes, dict):
                notes = {lang: clean(notes) for lang in APP_LANGUAGES}
            for lang in APP_LANGUAGES:
                fragment = f"{CONTRIB_NOTE_HEADER[lang]} {date}{attribution}: {localized.get(lang) or description}"
                notes[lang] = f"{notes.get(lang, '')}\n\n---\n\n{fragment}".strip() if notes.get(lang) else fragment
            field["notes"] = notes
            notes_added += 1

        asset = meta.get("photoAsset") if isinstance(meta.get("photoAsset"), dict) else None
        if asset and clean(asset.get("url")):
            try:
                data = _fetch_contribution_asset(clean(asset.get("url")))
                name = safe_filename(clean(asset.get("name")) or f"{path.stem}.jpg")
                target_name = f"contrib-{Path(name).stem}.jpg"
                field_dir = media_dir / field["id"]
                field_dir.mkdir(parents=True, exist_ok=True)
                write_optimized_jpeg_image(data, field_dir / target_name)
                field.setdefault("media", []).append({
                    "type": "image",
                    "url": f"media/{field['id']}/{target_name}",
                    "caption": f"Pilot photo · {date}{attribution}",
                    "source": "Community contribution",
                    "updatedAt": date,
                })
                photos_added += 1
            except Exception as error:  # noqa: BLE001 - keep the note even when the photo fails
                print(f"contribution photo skipped: {path.name}: {error}", file=sys.stderr)
    if notes_added or photos_added:
        print(f"Merged community contributions: {notes_added} note(s), {photos_added} photo(s)", file=sys.stderr)
    return (notes_added, photos_added)


def localize_field_notes(fields: list[dict[str, Any]]) -> None:
    """Replace every field's native `notes` string with a localized {"en","fr","de"} object.

    Runs BEFORE duplicate fields are merged so each note is localized while it still has a single
    known source language and is kept native in that language. DeepL access is memoised across
    builds, so a routine rebuild only pays for new or changed notes.
    """
    progress = Progress(len(fields), "Localize notes")
    for index, field in enumerate(fields, start=1):
        field["notes"] = localize_note(clean(field.get("notes")), note_source_lang(field))
        progress.update(index, extra=f"{_TRANSLATION_STATS['deepl']} translated, {_TRANSLATION_STATS['cache']} cached")
    progress.done(f"{_TRANSLATION_STATS['deepl']} translated, {_TRANSLATION_STATS['cache']} cached")


def dictionary_translate_german(text: str) -> str:
    if not looks_german_text(text):
        return text
    translated = text
    for pattern, replacement in STRECKENFLUG_GERMAN_PHRASES:
        translated = re.sub(pattern, replacement, translated, flags=re.I)
    return translated


def resolve_deepl_api_url(api_key: str, override: str = "") -> str:
    if override:
        return override
    if not api_key:
        return ""
    # DeepL free-tier auth keys end with ":fx".
    if api_key.strip().endswith(":fx"):
        return "https://api-free.deepl.com/v2/translate"
    return "https://api.deepl.com/v2/translate"


def deepl_usage() -> tuple[int, int] | None:
    """Return (character_count, character_limit) from DeepL, or None if unavailable."""
    if not DEEPL_API_KEY or not DEEPL_API_URL:
        return None
    usage_url = DEEPL_API_URL.rsplit("/", 1)[0] + "/usage"
    try:
        request = urllib.request.Request(usage_url, headers={"Authorization": f"DeepL-Auth-Key {DEEPL_API_KEY}"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        return int(data.get("character_count", 0)), int(data.get("character_limit", 0))
    except Exception as error:  # noqa: BLE001
        print(f"DeepL usage check failed: {error}", file=sys.stderr)
        return None


def seed_translation_cache_from_url(state_url: str) -> None:
    """Re-seed an empty translation cache from the copy published next to the pack.

    The CI cache (actions/cache) is evictable; the deployed pack is not. Each build publishes
    the cache alongside state.json, and a build that starts with an empty cache pulls that copy
    back — so losing the CI cache costs one download instead of re-spending DeepL quota on a
    full re-translation. No-op when the cache already has entries or no state URL is set.
    """
    global _TRANSLATION_CACHE
    if _TRANSLATION_CACHE or not state_url:
        return
    url = urllib.parse.urljoin(state_url, "translation-cache.json")
    try:
        request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=60) as response:
            loaded = json.loads(response.read().decode("utf-8"))
        if isinstance(loaded, dict) and loaded:
            _TRANSLATION_CACHE = {str(k): str(v) for k, v in loaded.items()}
            print(f"Translation cache seeded from published pack: {len(_TRANSLATION_CACHE):,} entries", file=sys.stderr)
    except Exception as error:  # noqa: BLE001 - seed is best-effort; DeepL cache/quota still guard
        print(f"translation cache seed skipped ({url}): {error}", file=sys.stderr)


def load_translation_cache(path: Path) -> None:
    global _TRANSLATION_CACHE, _TRANSLATION_CACHE_PATH
    _TRANSLATION_CACHE_PATH = path
    try:
        if path.exists():
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                _TRANSLATION_CACHE = {str(k): str(v) for k, v in loaded.items()}
    except Exception as error:  # noqa: BLE001
        print(f"translation cache load failed: {error}", file=sys.stderr)


def save_translation_cache() -> None:
    if _TRANSLATION_CACHE_PATH is None:
        return
    try:
        _TRANSLATION_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _TRANSLATION_CACHE_PATH.write_text(
            json.dumps(_TRANSLATION_CACHE, ensure_ascii=False, sort_keys=True, indent=0),
            encoding="utf-8",
        )
    except Exception as error:  # noqa: BLE001
        print(f"translation cache save failed: {error}", file=sys.stderr)


def looks_german_text(value: str) -> bool:
    return bool(GERMAN_TEXT_HINT_RE.search(value or ""))


def tidy_streckenflug_text(value: str) -> str:
    text = normalize_space(value)
    text = re.sub(r"\s+([.,;:])", r"\1", text)
    text = re.sub(r"([.!?])\s*\.", r"\1", text)
    text = re.sub(r"\.{2,}", ".", text)
    text = re.sub(r"([.!?])\s+([a-z])", lambda m: f"{m.group(1)} {m.group(2).upper()}", text)
    return text.strip()


def extract_streckenflug_photo_urls(html_parts: Sequence[str], source_url: str) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    # Full-resolution images are on photoswipe anchors. Avoid img src thumbnails.
    anchor_pattern = re.compile(r'<a\b[^>]*(?:class=["\'][^"\']*photoswipe[^"\']*["\'][^>]*)?\bhref=["\'](?P<url>[^"\']*shield\.php\?[^"\']+)["\'][^>]*>', re.I | re.S)
    datasrc_pattern = re.compile(r'\bdata-src=["\'](?P<url>[^"\']*shield\.php\?[^"\']+)["\']', re.I | re.S)
    for part in html_parts:
        if not part:
            continue
        for pattern in (anchor_pattern, datasrc_pattern):
            for match in pattern.finditer(part):
                url = html.unescape(match.group("url"))
                url = urllib.parse.urljoin(source_url or "https://landout.streckenflug.at/", url)
                if url in seen:
                    continue
                seen.add(url)
                urls.append(url)
    return urls


def download_streckenflug_images(
    *,
    field_id: str,
    source_id: str,
    html_parts: Sequence[str],
    media_dir: Path,
    source_url: str,
    updated_at: str = "",
) -> list[dict[str, Any]]:
    urls = extract_streckenflug_photo_urls(html_parts, source_url)
    if not urls:
        return []
    field_dir = media_dir / field_id
    field_dir.mkdir(parents=True, exist_ok=True)
    media: list[dict[str, Any]] = []
    for index, url in enumerate(urls, start=1):
        try:
            data, _content_type = download_url_bytes(url, referer=source_url)
            target_name = f"streckenflug_{safe_filename(source_id)}_{index:02d}.jpg"
            target = field_dir / target_name
            write_optimized_jpeg_image(data, target)
            item = {
                "type": "image",
                "url": f"media/{field_id}/{target_name}",
                "caption": f"streckenflug.at photo {index}",
                "source": "streckenflug.at",
                "sourceUrl": url,
            }
            if updated_at:
                item["updatedAt"] = updated_at
            media.append(item)
        except Exception as error:
            print(f"streckenflug.at image download failed for {field_id}: {error}", file=sys.stderr)
    return media

def download_url_bytes(url: str, *, referer: str = "") -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={
        "User-Agent": "MeetTheCows/0.4 (+https://github.com/)",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": referer or "https://landout.streckenflug.at/",
    })
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read(), response.headers.get("Content-Type", "")


def write_optimized_jpeg_image(data: bytes, target: Path) -> None:
    """Write a phone-optimised JPEG: max 2560 px long edge, RGB, q85, no metadata."""
    try:
        from PIL import Image, ImageOps  # type: ignore
    except ModuleNotFoundError as error:
        raise RuntimeError("Pillow is required for image resizing. Run: python -m pip install -r requirements.txt") from error

    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode not in {"RGB", "L"}:
            # Flatten transparency against white before converting to JPEG.
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                image = Image.alpha_composite(background, rgba).convert("RGB")
            else:
                image = image.convert("RGB")
        elif image.mode == "L":
            image = image.convert("RGB")

        width, height = image.size
        longest = max(width, height)
        if longest > PACK_IMAGE_MAX_LONG_EDGE:
            scale = PACK_IMAGE_MAX_LONG_EDGE / float(longest)
            new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
            resample = getattr(Image, "Resampling", Image).LANCZOS
            image = image.resize(new_size, resample)

        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, format="JPEG", quality=PACK_IMAGE_JPEG_QUALITY, optimize=True, progressive=True)


def parse_first_metric_length(value: object) -> float | None:
    text = clean(value)
    if not text:
        return None
    # streckenflug values look like "940m | 3084" or "200m | 656ft".
    match = re.search(r"(-?\d+(?:[.,]\d+)?)\s*m\b", text, flags=re.I)
    if match:
        return float(match.group(1).replace(",", "."))
    match = re.search(r"(-?\d+(?:[.,]\d+)?)", text)
    return float(match.group(1).replace(",", ".")) if match else None


def parse_float(value: object) -> float | None:
    text = clean(value).replace(",", ".")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_runway_direction(value: object) -> float | None:
    text = clean(value)
    if not text:
        return None
    numbers = [int(n) for n in re.findall(r"\b(\d{1,2})\b", text)]
    if not numbers:
        return None
    # Convert runway designator to approximate magnetic/true-ish bearing for display only.
    deg = numbers[0] * 10
    return float(deg) if 0 <= deg <= 360 else None


def parse_streckenflug_date(value: str) -> str:
    match = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", value or "")
    if not match:
        return value
    day, month, year = match.groups()
    return f"{year}-{month}-{day}"


def strip_html(value: str) -> str:
    value = re.sub(r"<script\b.*?</script>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<style\b.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    return html.unescape(value)


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or " ").strip()


def infer_country_from_lon_lat(lon: float, lat: float) -> str:
    # Rough fallback only, used when the scraped page omits a country label.
    if 41 <= lat <= 52 and -5 <= lon <= 10:
        return "FR"
    if 45 <= lat <= 48.5 and 5 <= lon <= 11:
        return "CH"
    if 36 <= lat <= 47.5 and 6 <= lon <= 19:
        return "IT"
    return ""


def extract_streckenflug_difficulty(text: str) -> tuple[str, str]:
    match = re.search(r"\b([ABCDU])\s*-\s*(Good option|Caution|Only for emergencies|no longer landable|Unknown)", text, flags=re.I)
    if match:
        raw = f"streckenflug-{match.group(1).upper()}"
        value = match.group(1).upper()
        return raw, "UNKNOWN" if value == "U" else value
    if re.search(r"Good option", text, flags=re.I): return "streckenflug-A", "A"
    if re.search(r"Caution", text, flags=re.I): return "streckenflug-B", "B"
    if re.search(r"Only for emergencies", text, flags=re.I): return "streckenflug-C", "C"
    if re.search(r"no longer landable", text, flags=re.I): return "streckenflug-D", "D"
    return "streckenflug-unknown", "UNKNOWN"


def consolidate_duplicate_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge the same physical landing place imported from multiple sources.

    This is deliberately conservative: merge exact matching codes first, then merge
    same/similar names within DEDUPE_DISTANCE_M. The goal is one cockpit entry per
    landing place while preserving source notes/media and preferring more current
    structured data such as OpenAIP/SIA frequencies.
    """
    remaining = list(fields)
    groups: list[list[dict[str, Any]]] = []

    # Pass 1: exact code match, including non-standard codes such as LF0431.
    by_code: dict[str, list[dict[str, Any]]] = {}
    no_code: list[dict[str, Any]] = []
    for field in remaining:
        code = clean(field.get("code")).upper()
        if code:
            by_code.setdefault(code, []).append(field)
        else:
            no_code.append(field)
    for code, items in by_code.items():
        if len(items) > 1:
            groups.append(items)
        else:
            no_code.extend(items)

    # Pass 2: similar name + nearby coordinates. Use connected components rather
    # than a first-item grouping so A~B and B~C does not leave C stranded.
    groups.extend(group_duplicate_fields(no_code))

    result: list[dict[str, Any]] = []
    merged_count = 0
    for group in groups:
        if len(group) == 1:
            result.append(group[0])
            continue
        merged_count += len(group) - 1
        result.append(merge_field_group(group))
    if merged_count:
        print(f"Consolidated {merged_count} duplicate field entries", file=sys.stderr)
    return result


def group_duplicate_fields(fields: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    if not fields:
        return []
    parent = list(range(len(fields)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(a: int, b: int) -> None:
        root_a = find(a)
        root_b = find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for i, field in enumerate(fields):
        for j in range(i + 1, len(fields)):
            if are_duplicate_fields(field, fields[j]):
                union(i, j)

    by_root: dict[int, list[dict[str, Any]]] = {}
    for index, field in enumerate(fields):
        by_root.setdefault(find(index), []).append(field)
    return list(by_root.values())


def are_duplicate_fields(a: dict[str, Any], b: dict[str, Any]) -> bool:
    code_a = clean(a.get("code")).upper()
    code_b = clean(b.get("code")).upper()
    if code_a and code_b and code_a == code_b:
        return True
    distance = distance_m(a.get("latitude"), a.get("longitude"), b.get("latitude"), b.get("longitude"))
    if distance is None:
        return False
    name_a = normalize_name_for_match(clean(a.get("name")))
    name_b = normalize_name_for_match(clean(b.get("name")))
    if not name_a or not name_b:
        return False
    if name_a == name_b:
        return distance <= DEDUPE_STRONG_NAME_DISTANCE_M
    base_a = normalize_name_for_match(clean(a.get("name")), strip_direction_tokens=True)
    base_b = normalize_name_for_match(clean(b.get("name")), strip_direction_tokens=True)
    strong_name_match = bool(base_a and base_b and (base_a == base_b or token_similarity(base_a, base_b) >= 0.85))
    if strong_name_match:
        if has_conflicting_direction_tokens(clean(a.get("name")), clean(b.get("name"))):
            return False
        return distance <= DEDUPE_STRONG_NAME_DISTANCE_M
    if distance > DEDUPE_DISTANCE_M:
        return False
    if name_a in name_b or name_b in name_a:
        return True
    return token_similarity(name_a, name_b) >= 0.62


def merge_field_group(group: list[dict[str, Any]]) -> dict[str, Any]:
    # Best base: official/current airfield sources > OpenAIP > SIA VAC > Guide, but
    # keep Guide photos/notes/media. If all else equal, pick the most complete record.
    base = max(group, key=field_quality_score)
    merged = json.loads(json.dumps(base))

    merged["name"] = choose_best_name(group, base)
    merged["code"] = choose_best_code(group) or clean(base.get("code"))
    merged["country"] = choose_best_value(group, "country") or infer_country_from_icao(merged.get("code", "")) or clean(base.get("country"))
    merged["kind"] = choose_kind(group)
    merged["difficulty"] = choose_difficulty(group)
    merged["rawDifficulty"] = choose_raw_difficulty(group, merged.get("difficulty"))

    for key in ("latitude", "longitude"):
        value = choose_source_preferred_number(group, key)
        if value is not None:
            merged[key] = round(float(value), 7)
    for key in ("elevationM", "lengthM", "widthM", "runwayDirectionDeg"):
        value = choose_source_preferred_number(group, key)
        if value is not None:
            merged[key] = value

    all_freqs: list[dict[str, Any]] = []
    for field in group:
        all_freqs.extend(list(field.get("frequencies") or []))
        # Keep compatibility with older generated fields that only had a string.
        for key in ("frequency", "radio"):
            text = clean(field.get(key))
            all_freqs.extend(extract_frequencies_from_text(text, source=clean((field.get("source") or {}).get("name")) or "existing field"))
    all_freqs = merge_frequency_lists_by_source(*[all_freqs])
    if all_freqs:
        merged["frequencies"] = all_freqs
        merged["frequency"] = format_frequency_short(all_freqs)

    merged["media"] = merge_media_lists(*(field.get("media") or [] for field in group))
    docs: dict[str, Any] = {}
    for field in group:
        docs.update(field.get("docs") or {})
    if docs:
        merged["docs"] = docs

    notes = merge_notes(group)
    if notes:
        merged["notes"] = notes
    merged["source"] = merge_sources(group)
    merged["id"] = stable_id(merged.get("country") or "xx", merged.get("code") or "", merged.get("name") or "field", merged.get("latitude") or 0, merged.get("longitude") or 0)
    merged.pop("_mediaRefs", None)
    return merged


def field_quality_score(field: dict[str, Any]) -> tuple[int, int, int, int, int]:
    source_name = clean((field.get("source") or {}).get("name")).lower()
    source_score = 0
    if "openaip" in source_name:
        source_score += 40
    if "sia" in source_name or any((m.get("source") or "").lower().find("sia") >= 0 for m in field.get("media", []) if isinstance(m, dict)):
        source_score += 30
    if "guide" in source_name or "planeur-net" in source_name:
        source_score += 20
    completeness = sum(1 for k in ("code", "latitude", "longitude", "elevationM", "lengthM", "frequency") if field.get(k) not in (None, "", []))
    media_count = len(field.get("media") or [])
    freq_count = len(field.get("frequencies") or [])
    kind_score = 1 if field.get("kind") == "airfield" else 0
    return source_score, completeness, freq_count, media_count, kind_score


def choose_best_name(group: list[dict[str, Any]], base: dict[str, Any]) -> str:
    candidates = [(field, clean(field.get("name"))) for field in group if clean(field.get("name"))]
    if not candidates:
        return clean(base.get("name"))
    field, name = max(candidates, key=lambda item: name_quality_score(item[0], item[1]))
    return clean_display_name(name)


def name_quality_score(field: dict[str, Any], name: str) -> tuple[int, int, int, int, int, int, str]:
    source_name = clean((field.get("source") or {}).get("name")).lower()
    openaip_score = 0
    source_score = 0
    if "openaip" in source_name:
        openaip_score = 1
        source_score = 100
    elif "sia" in source_name:
        source_score = 90
    elif "guide" in source_name or "planeur-net" in source_name:
        source_score = 70
    elif "streckenflug" in source_name:
        source_score = 50

    cleaned = clean_display_name(name)
    typo_penalty = 1 if re.search(r"\bcair\b", cleaned, flags=re.I) else 0
    code_penalty = 1 if re.search(r"\b(?:LF|LS|LI)[A-Z0-9]{2,4}\b", cleaned, flags=re.I) else 0
    number_penalty = 1 if re.match(r"^#?\d+\b", cleaned) else 0
    numeric_suffix_penalty = 1 if re.search(r"\b\d+\b", cleaned) else 0
    return openaip_score, -typo_penalty, -code_penalty, -number_penalty, -numeric_suffix_penalty, source_score, cleaned


def clean_display_name(name: str) -> str:
    value = re.sub(r"^(?:#?\d+\s+)+", "", clean(name)).strip()
    # Strip a leading ICAO code token, e.g. "LFMR Barcelonnette" -> "Barcelonnette".
    # Case-sensitive on purpose: real codes in the source are upper-case, so this does
    # not eat title-case place names such as "Livigno", "Lion" or "Lus". Only strip when
    # descriptive text follows, so a code-only name keeps the code as its label.
    value = re.sub(r"^(?:LF|LS|LI)[A-Z0-9]{2,4}\b\s+(?=\S)", "", value).strip()
    value = re.sub(r"\s+\b(?:LF|LS|LI)[A-Z0-9]{2,4}\b\s*$", "", value, flags=re.I).strip()
    return normalize_display_name(value)


def normalize_display_name(name: str) -> str:
    words = []
    lowercase_words = {"de", "du", "des", "la", "le", "les", "sur", "en", "au", "aux", "d", "l"}
    word_index = 0
    for word in re.split(r"(\s+|-)", name.strip()):
        if not word or word.isspace() or word == "-":
            words.append(word)
            continue
        lower = word.lower()
        if lower == "sued":
            words.append("Sud")
        elif lower in lowercase_words and word_index > 0:
            words.append(lower)
        elif word.isupper() or word.islower() or word.istitle():
            words.append(lower.capitalize())
        else:
            words.append(word)
        word_index += 1
    return "".join(words)


def choose_best_code(group: list[dict[str, Any]]) -> str:
    codes = [clean(f.get("code")).upper() for f in group if clean(f.get("code"))]
    if not codes:
        return ""
    # Prefer real ICAO/non-standard LF/LS/LI codes over synthetic OpenAIP fallback IDs.
    real = [c for c in codes if re.match(r"^(LF|LS|LI)[A-Z0-9]{2,4}$", c)]
    return sorted(real or codes, key=lambda c: (len(c), c))[0]


def choose_best_value(group: list[dict[str, Any]], key: str) -> Any:
    for field in sorted(group, key=field_quality_score, reverse=True):
        value = field.get(key)
        if value not in (None, "", []):
            return value
    return None


def choose_source_preferred_number(group: list[dict[str, Any]], key: str) -> float | int | None:
    for field in sorted(group, key=field_quality_score, reverse=True):
        value = field.get(key)
        if isinstance(value, (int, float)):
            return value
    return None


def choose_kind(group: list[dict[str, Any]]) -> str:
    return "airfield" if any(f.get("kind") == "airfield" for f in group) else "outlanding"


def choose_difficulty(group: list[dict[str, Any]]) -> str:
    # Keep the most conservative difficulty among A/B/C/D.
    order = {"A": 0, "B": 1, "C": 2, "D": 3}
    values = [clean(f.get("difficulty")).upper() for f in group if clean(f.get("difficulty")).upper() in order]
    return max(values, key=lambda v: order[v]) if values else "UNKNOWN"


def choose_raw_difficulty(group: list[dict[str, Any]], difficulty: str) -> str:
    for field in group:
        raw = clean(field.get("rawDifficulty"))
        if raw:
            return raw
    return difficulty or ""


def merge_frequency_lists_by_source(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Same MHz can appear from Guide, OpenAIP and SIA. Keep the best source label.
    by_mhz: dict[str, dict[str, Any]] = {}
    for freqs in lists:
        for item in freqs or []:
            mhz = item.get("mhz")
            if not isinstance(mhz, (int, float)):
                continue
            key = f"{float(mhz):.3f}"
            current = by_mhz.get(key)
            candidate = dict(item)
            candidate["mhz"] = round(float(mhz), 3)
            if current is None or frequency_source_score(candidate) > frequency_source_score(current):
                by_mhz[key] = candidate
    return sorted(by_mhz.values(), key=frequency_sort_key)


def frequency_source_score(freq: dict[str, Any]) -> int:
    source = clean(freq.get("source")).lower()
    score = 0
    if "sia" in source or "aip" in source:
        score += 50
    if "openaip" in source:
        score += 40
    if "guide" in source or "cup" in source or "planeur" in source:
        score += 10
    if clean(freq.get("type")):
        score += 2
    if clean(freq.get("description")):
        score += 1
    return score



def count_media_items(fields: Iterable[dict[str, Any]]) -> int:
    return sum(len(field.get("media") or []) for field in fields)

def merge_media_lists(*media_lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for media_list in media_lists:
        for item in media_list or []:
            url = clean(item.get("url"))
            if not url or url in seen:
                continue
            merged.append(dict(item))
            seen.add(url)
    return merged


def merge_notes(group: list[dict[str, Any]]) -> dict[str, str]:
    """Combine the localized notes of a merged group, per language.

    Notes are already localized dicts at merge time, so each language is merged independently:
    a French fragment stays native French in the "fr" slot, a German one native German in "de",
    etc. A legacy plain-string note (older path) is placed in every language.
    """
    parts: dict[str, list[str]] = {lang: [] for lang in APP_LANGUAGES}
    seen: dict[str, set[str]] = {lang: set() for lang in APP_LANGUAGES}

    def add(lang: str, note: str) -> None:
        note = clean(note)
        if not note:
            return
        key = normalize_name_for_match(note[:300])
        if key in seen[lang]:
            return
        parts[lang].append(note)
        seen[lang].add(key)

    for field in group:
        notes = field.get("notes")
        if isinstance(notes, dict):
            for lang in APP_LANGUAGES:
                add(lang, notes.get(lang, ""))
        else:
            for lang in APP_LANGUAGES:
                add(lang, notes if isinstance(notes, str) else "")
    return {lang: "\n\n---\n\n".join(parts[lang]) for lang in APP_LANGUAGES}


def merge_sources(group: list[dict[str, Any]]) -> dict[str, Any]:
    names: list[str] = []
    for field in group:
        name = clean((field.get("source") or {}).get("name"))
        if name and name not in names:
            names.append(name)
    return {
        "name": " + ".join(names) if names else "merged sources",
        "importedAt": dt.date.today().isoformat(),
        "mergedDuplicates": len(group),
        "sources": [field.get("source") for field in group if field.get("source")],
    }


def normalize_name_for_match(value: str, *, strip_direction_tokens: bool = False) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"\b(lf|ls|li)\d*[a-z0-9]{2,4}\b", " ", value)
    value = re.sub(r"^#?\d+\s+", " ", value)
    value = re.sub(r"\b(aerodrome|airfield|terrain|ulm|altisurface|altiport|de|du|des|la|le|les|sur|en|st|saint)\b", " ", value)
    if strip_direction_tokens:
        value = re.sub(r"\b(?:north|nord|n|south|sud|sued|s|east|est|e|west|ouest|o|w|[1234])\b", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def has_conflicting_direction_tokens(a: str, b: str) -> bool:
    directions_a = direction_tokens_for_match(a)
    directions_b = direction_tokens_for_match(b)
    return bool(directions_a and directions_b and directions_a.isdisjoint(directions_b))


def direction_tokens_for_match(value: str) -> set[str]:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    words = set(re.findall(r"[a-z0-9]+", value.lower()))
    aliases = {
        "north": "north", "nord": "north", "n": "north",
        "south": "south", "sud": "south", "sued": "south", "s": "south",
        "east": "east", "est": "east", "e": "east",
        "west": "west", "ouest": "west", "o": "west", "w": "west",
    }
    return {aliases[word] for word in words if word in aliases}


def token_similarity(a: str, b: str) -> float:
    set_a = set(a.split())
    set_b = set(b.split())
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


def distance_m(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> float | None:
    try:
        from math import asin, cos, radians, sin, sqrt
        phi1, phi2 = radians(float(lat1)), radians(float(lat2))
        dphi = radians(float(lat2) - float(lat1))
        dlambda = radians(float(lon2) - float(lon1))
        a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlambda / 2) ** 2
        return 6371000 * 2 * asin(sqrt(a))
    except Exception:
        return None

def index_fields_by_code(fields: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_code: dict[str, list[dict[str, Any]]] = {}
    for field in fields:
        code = clean(field.get("code")).upper()
        if ICAO_RE.match(code):
            by_code.setdefault(code, []).append(field)
    return by_code


def stable_id(country: str, code: str, name: str, lat: float, lon: float) -> str:
    parts = [country.lower() or "xx"]
    if code and re.match(r"^[A-Z0-9]{3,5}$", code.upper()):
        parts.append(code.lower())
    parts.append(slugify(name)[:48])
    parts.append(f"{lat:.4f}".replace("-", "m").replace(".", "p"))
    parts.append(f"{lon:.4f}".replace("-", "m").replace(".", "p"))
    return "_".join(p for p in parts if p)


def slugify(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return value or "field"


def safe_filename(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(value).name)


def clean(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip().strip('"')


if __name__ == "__main__":
    main()
