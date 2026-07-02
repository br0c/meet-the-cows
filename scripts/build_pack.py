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
from pathlib import Path
from typing import Any, Iterable

DEFAULT_CUPX_URL = "https://raw.githubusercontent.com/planeur-net/outlanding/main/guide_aires_securite.cupx"
OURAIRPORTS_AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OURAIRPORTS_RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
OURAIRPORTS_FREQUENCIES_URL = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"
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
ICAO_FR_RE = re.compile(r"^LF[A-Z0-9]{2}$")


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
    parser.add_argument("--out", default="data/packs/fr-alps", help="Output pack directory")
    parser.add_argument("--vac-root", default=os.environ.get("SIA_VAC_ROOT", "auto"), help="SIA VAC AD PDF directory URL ending in /AD, or auto to detect the current eAIP cycle")
    parser.add_argument("--vac-date", default=os.environ.get("SIA_VAC_DATE", "auto"), help="SIA VAC update/AIRAC date to show in attribution, or auto when --vac-root auto succeeds")
    parser.add_argument("--max-vac", type=int, default=0, help="Debug limit for VAC downloads; 0 means no limit")
    parser.add_argument("--include-vac-airfields", action="store_true", help="Create VAC-only airfield entries when an LFxx VAC exists but the airfield is absent from the CUP")
    parser.add_argument("--airports-csv", default=os.environ.get("AIRPORTS_CSV", OURAIRPORTS_AIRPORTS_URL), help="Airport CSV URL/path with at least ident,name,latitude_deg,longitude_deg,elevation_ft; defaults to OurAirports")
    parser.add_argument("--runways-csv", default=os.environ.get("RUNWAYS_CSV", OURAIRPORTS_RUNWAYS_URL), help="Optional runway CSV URL/path, defaults to OurAirports runways.csv")
    parser.add_argument("--frequencies-csv", default=os.environ.get("FREQUENCIES_CSV", OURAIRPORTS_FREQUENCIES_URL), help="Optional frequency CSV URL/path, defaults to OurAirports airport-frequencies.csv")
    parser.add_argument("--vac-codes", default="", help="Optional comma-separated ICAO codes or path/URL to a text file of ICAO codes to try. Use to limit/extend VAC candidates.")
    parser.add_argument("--keep-raw", action="store_true", help="Keep downloaded raw files in .cache")
    args = parser.parse_args()

    root = Path.cwd()
    out_dir = root / args.out
    cache_dir = root / ".cache" / args.pack_id
    raw_dir = cache_dir / "raw"
    media_dir = out_dir / "media"
    docs_dir = out_dir / "docs" / "vac"

    if out_dir.exists():
        shutil.rmtree(out_dir)
    media_dir.mkdir(parents=True, exist_ok=True)
    docs_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

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
    resolved_vac_root = ""
    resolved_vac_date = args.vac_date
    if args.vac_root and args.vac_root.lower() != "none":
        resolved_vac_root, inferred_vac_date = resolve_vac_root(args.vac_root, raw_dir)
        if resolved_vac_date.lower() == "auto":
            resolved_vac_date = inferred_vac_date or ""

    if resolved_vac_root:
        airport_index: dict[str, dict[str, Any]] = {}
        runway_index: dict[str, dict[str, Any]] = {}
        if args.include_vac_airfields:
            airport_index = load_airport_index(args.airports_csv, raw_dir)
            runway_index = load_runway_index(args.runways_csv, raw_dir)
        extra_codes = parse_vac_codes(args.vac_codes, raw_dir)
        vac_result = import_vac_pdfs(
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
        )
        vac_count = vac_result["downloaded"]
        vac_created_airfields = vac_result["createdAirfields"]

    fields.sort(key=lambda f: (0 if f.get("kind") == "outlanding" else 1, str(f.get("name", ""))))
    fields_path = out_dir / "fields.json"
    fields_path.write_text(json.dumps(fields, ensure_ascii=False, indent=2), encoding="utf-8")

    manifest = {
        "id": args.pack_id,
        "name": args.pack_name,
        "version": dt.datetime.now(dt.UTC).strftime("%Y%m%d-%H%M%S"),
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "isSample": False,
        "fieldsUrl": "fields.json",
        "fieldsCount": len(fields),
        "mediaCount": copied_media + vac_count,
        "vacCount": vac_count,
        "vacOnlyAirfieldsCreated": vac_created_airfields,
        "sources": [
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
                "name": "OurAirports airport/runway coordinates",
                "url": args.airports_csv if args.include_vac_airfields else "not used",
                "note": "Public-domain coordinates used only to place VAC-only airfield entries; verify official SIA documents.",
            },
            {
                "name": "OurAirports airport radio frequencies",
                "url": args.frequencies_csv if frequency_index else "not used",
                "note": "Non-authoritative radio frequency helper data; verify official VAC/current publications.",
            },
        ],
        "notices": [
            "Not for primary navigation. Straight-line distance/glide only: no wind, sink, terrain clearance or airspace.",
            "Check official/current SIA documents before flight. VAC PDFs are cycle-specific.",
            "VAC-only airfield coordinates may come from a non-authoritative open dataset; the attached SIA VAC is the official source.",
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # Maintain pack index.
    index_path = out_dir.parent / "index.json"
    index = [{"id": args.pack_id, "name": args.pack_name, "manifestUrl": f"data/packs/{args.pack_id}/manifest.json"}]
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    if not args.keep_raw:
        shutil.rmtree(cache_dir, ignore_errors=True)

    print(
        f"Built {args.pack_name}: {len(fields)} entries, {copied_media} photos, "
        f"{vac_count} VAC PDFs, {vac_created_airfields} VAC-only airfields"
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


def parse_float(value: str) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
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
            target_name = safe_filename(ref)
            target = field_dir / target_name
            target.write_bytes(blob)
            copied += 1
            kind = "pdf" if target.suffix.lower() == ".pdf" else "image"
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


def format_frequency_short(frequencies: list[dict[str, Any]]) -> str:
    if not frequencies:
        return ""
    first = frequencies[0]
    mhz = first.get("mhz")
    mhz_text = f"{float(mhz):.3f}".rstrip("0").rstrip(".") if isinstance(mhz, (int, float)) else ""
    return " ".join(part for part in (mhz_text, clean(first.get("type"))) if part)


def load_airport_index(airports_csv: str, raw_dir: Path) -> dict[str, dict[str, Any]]:
    print(f"Loading airport source {airports_csv}", file=sys.stderr)
    text = read_text(airports_csv, raw_dir)
    reader = csv.DictReader(io.StringIO(text))
    airports: dict[str, dict[str, Any]] = {}
    for row in reader:
        ident = clean(row.get("ident")).upper()
        if not ICAO_FR_RE.match(ident):
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
    print(f"Loaded {len(airports)} LFxx airport coordinates", file=sys.stderr)
    return airports


def load_runway_index(runways_csv: str, raw_dir: Path) -> dict[str, dict[str, Any]]:
    if not runways_csv:
        return {}
    print(f"Loading runway source {runways_csv}", file=sys.stderr)
    text = read_text(runways_csv, raw_dir)
    reader = csv.DictReader(io.StringIO(text))
    longest: dict[str, dict[str, Any]] = {}
    for row in reader:
        airport_ident = clean(row.get("airport_ident")).upper()
        if not ICAO_FR_RE.match(airport_ident):
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
    print(f"Loaded runway dimensions for {len(longest)} LFxx airports", file=sys.stderr)
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
        if not ICAO_FR_RE.match(airport_ident):
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
        if not ICAO_FR_RE.match(code):
            continue
        indexed = frequency_index.get(code) or []
        if not indexed:
            continue
        existing = list(field.get("frequencies") or [])
        seen = {f"{float(item.get('mhz')):.3f}" for item in existing if isinstance(item.get("mhz"), (int, float))}
        for item in indexed:
            key = f"{float(item.get('mhz')):.3f}"
            if key not in seen:
                existing.append(dict(item))
                seen.add(key)
        existing.sort(key=frequency_sort_key)
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

    candidate_codes = set(by_code.keys()) | extra_codes
    if airport_index:
        candidate_codes |= set(airport_index.keys())
    candidate_codes = sorted(code for code in candidate_codes if ICAO_FR_RE.match(code))
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
            for field in by_code[code]:
                field["media"].append(dict(media))
                field.setdefault("docs", {})["vac"] = media["url"]
            progress.update(index, extra=f"{code}: attached | ok {downloaded}, miss {misses}, err {errors}")
            continue

        airport = airport_index.get(code)
        if not airport:
            progress.update(index, extra=f"{code}: downloaded but no coordinates | ok {downloaded}, miss {misses}, err {errors}", force=True)
            continue
        new_field = make_vac_airfield_entry(airport, runway_index.get(code), frequency_index.get(code, []), media, pack_id)
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
    field_id = stable_id("FR", code, airport["name"], airport["latitude"], airport["longitude"])
    notes = "Official aerodrome entry created from SIA VAC import. Coordinates/dimensions are from the airport source, not from the VAC PDF. Verify the attached official VAC."
    return {
        "id": field_id,
        "kind": "airfield",
        "name": airport["name"],
        "code": code,
        "country": "FR",
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
            "name": "SIA VAC + OurAirports coordinates",
            "importedAt": dt.date.today().isoformat(),
            "packId": pack_id,
        },
        "media": [dict(media)],
        "docs": {"vac": media["url"]},
    }


def index_fields_by_code(fields: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_code: dict[str, list[dict[str, Any]]] = {}
    for field in fields:
        code = clean(field.get("code")).upper()
        if ICAO_FR_RE.match(code):
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
