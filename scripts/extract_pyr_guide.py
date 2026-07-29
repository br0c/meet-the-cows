#!/usr/bin/env python3
"""Extract the APVV "Guide des champs pyrénéens" (2008) into a committed CUP source.

Input is the guide PDF (not in the repo — APVV distributes it to member clubs; ask them).
Output is data/sources/apvv-pyrenees/: a POINTS.cup plus Pics/*.jpg, the same layout the
planeur-net CUPX sources use, so build_pack.py ingests it through the existing extra-CUP
path (see EXTRA_CUPS).

    python3 scripts/extract_pyr_guide.py /path/to/Champs_pyr_esp_v9_fr_br.pdf

Editorial decisions, agreed with the guide in hand:
- The guide lists no difficulty. Champs stay UNKNOWN (no difficulty tag emitted) and
  aerodromes/ULM strips get {aerodrome} -> A. No guessing beyond that.
- The guide is from 2008, so its radio frequencies are dropped entirely: the freq column
  stays empty AND "Fréq. = ..." is stripped from the notes, because the builder also mines
  notes text for frequencies (extract_frequencies_from_row). Current frequencies come from
  OpenAIP/AIP sources, which win on merge. ICAO codes found next to the frequencies are
  kept as the waypoint code so those merges line up.
- Each entry page is a fixed quadrant grid: info block top-left, Google Earth capture
  top-right, Michelin map bottom-left, and — when the club had one — its own aerial or
  ground photo bottom-right. Only that club photo is APVV's to redistribute; the other
  quadrants are never extracted. On pages with no club photo the bottom-right slot holds
  a SECOND Google Earth view (tilted or re-zoomed, same imagery as top-right), so photo
  extraction runs off the CLUB_PHOTO_IDS whitelist below, built by comparing the two
  right-side quadrants of every page, not off the page layout alone.
  The photo is cropped from a 300 dpi page render rather than pulled from the embedded
  JPEG so the vector overlays (red field outline and arrow) survive; 300 dpi oversamples
  the ~200 ppi originals slightly, which is the cheap side of that trade.

Requires poppler-utils (pdftotext, pdftoppm) and Pillow.
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from PIL import Image

ENTRY_PAGES = range(4, 31)  # E1..E25 then F1/F2, one entry per page
EXPECTED_ENTRIES = 27

# Where the parsed entries must land (decimal degrees). Catches a mis-read digit in the
# degree/minute conversion, which a plausible-looking CUP string would otherwise hide.
LAT_RANGE = (41.9, 42.8)
LON_RANGE = (-1.4, 2.2)

# Bottom-right photo quadrant as page-size ratios, calibrated on the 150 dpi render of
# page 5 (box 786,622,1442,1044 on 1755x1240) and identical across entry pages.
PHOTO_BOX_RATIOS = (0.4479, 0.5016, 0.8217, 0.8419)
RENDER_DPI = 300

# Entries whose bottom-right quadrant is a genuine club photo (oblique film aerials for
# E1-E3/E5-E8/E11, ground shots for E4/E9/E10). From E12 on, that slot is a tilted or
# re-zoomed Google Earth view of the same imagery as the top-right quadrant — third-party
# imagery the guide could embed but this pack cannot, so no photo is extracted for those.
CLUB_PHOTO_IDS = {"E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11"}

# Entries the guide lists that no longer exist on the ground. The guide is from 2008 and
# cannot be corrected upstream, so the exclusion lives here: without it, re-running this
# extractor would resurrect a removed field. Each needs current imagery as evidence.
#   E13 Graus  — the whole drawn field is a photovoltaic plant in PNOA imagery
#                (found 2026-07-29 by transferring the guide's own outline onto it).
GONE_IDS = {"E13"}

# pdftotext -layout splits glyphs inside words where the PDF kerns them apart. Fixed
# table, not a heuristic: every artifact was read off the actual pages.
KERNING_FIXES = (
    ("m ontée", "montée"),
    ("m ilieu", "milieu"),
    ("com m ercial", "commercial"),
    ("cham p", "champ"),
    ("nom breuses", "nombreuses"),
    ("20m .", "20m."),
)

HEADER_RE = re.compile(r"^([EF]\d{1,2})\s*/\s*(AERO|ULM|CHAMPS?)\s*[–-]\s*(.+)$")
POSITION_RE = re.compile(
    r"N\s*(\d{1,2})°\s*(\d{1,2}),(\d{1,3})['’]?\s*[–-]\s*([EW])\s*(\d{1,3})°\s*(\d{1,2}),(\d{1,3})['’]?"
)
# Photo/map annotations bleed into the text column at high indents; a run of >=10 spaces
# separates them from real text, while justification gaps inside sentences stay narrower.
BLEED_RE = re.compile(r"\s{10,}.*$")
FREQ_RE = re.compile(r"(?:\b[A-Z]{4}\s*-\s*)?Fréq\.?\s*=?\s*[\d.,]+(?:\s*/\s*[\d.,]+)*\s*MHz\.?\s*")
ICAO_RE = re.compile(r"\b(L[EF][A-Z]{2})\s*-\s*(?=Fréq)")
# Same shape extract_frequencies_from_text() mines for — the notes must not match it.
AIRBAND_RE = re.compile(r"(?<!\d)1[1-3]\d[.,]\d")

# Particles that stay lowercase when the ALL-CAPS guide names are title-cased.
LOWER_PARTICLES = {"de", "del", "d’", "d'"}


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def page_text(pdf: Path, page: int) -> str:
    result = subprocess.run(
        ["pdftotext", "-layout", "-f", str(page), "-l", str(page), str(pdf), "-"],
        check=True, capture_output=True)
    return result.stdout.decode("utf-8")


def strip_bleed(line: str) -> str:
    return BLEED_RE.sub("", line).rstrip()


def clean_text(text: str) -> str:
    for wrong, right in KERNING_FIXES:
        text = text.replace(wrong, right)
        text = text.replace(wrong.capitalize(), right.capitalize())
    text = re.sub(r"\s+", " ", text).strip()
    # Missing space after a sentence end ("herbe.Ne pas...").
    text = re.sub(r"\.(?=[A-ZÀ-Ý])", ". ", text)
    return text


def titlecase_name(name: str) -> str:
    words = name.strip().title().split()
    out = [w if i == 0 or w.lower() not in LOWER_PARTICLES else w.lower()
           for i, w in enumerate(words)]
    text = " ".join(out)
    # "D’Urgell" -> "d’Urgell" mid-name (the particle glued to the next word).
    return re.sub(r"(?<=.)\bD([’'])", r"d\1", text)


def ascii_slug(name: str) -> str:
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "_", plain).strip("_").upper()


def cup_coord(deg: int, minutes: int, frac: str, hemi: str, *, is_lat: bool) -> str:
    deg_width = 2 if is_lat else 3
    return f"{deg:0{deg_width}d}{minutes:02d}.{frac.ljust(3, '0')[:3]}{hemi}"


def decimal_deg(deg: int, minutes: int, frac: str, hemi: str) -> float:
    value = deg + (minutes + float(f"0.{frac.ljust(3, '0')}")) / 60
    return -value if hemi in "SW" else value


def parse_longueur(text: str) -> tuple[float | None, float | None]:
    """Longest strip's length and its width. "600 m x 50 m", "430 x 25 m", "500 m",
    "950 m / 650 m / 650 m", "2100x45 m / 600x12 m"."""
    best: tuple[float, float | None] | None = None
    for segment in text.split("/"):
        match = re.search(r"(\d+)\s*(?:m\s*)?(?:[x×]\s*(\d+)\s*m?)?", segment)
        if not match:
            continue
        length = float(match.group(1))
        width = float(match.group(2)) if match.group(2) else None
        if best is None or length > best[0]:
            best = (length, width)
    return (best[0], best[1]) if best else (None, None)


def parse_entry(text: str, page: int) -> dict:
    lines = text.splitlines()
    header = next((HEADER_RE.match(strip_bleed(l)) for l in lines if HEADER_RE.match(strip_bleed(l))), None)
    if not header:
        raise ValueError(f"page {page}: no entry header found")
    entry_id, entry_type, raw_name = header.group(1), header.group(2), header.group(3).strip()

    fields: dict[str, str] = {}
    obs_lines: list[str] = []
    collecting_obs = False
    for line in lines:
        stripped = strip_bleed(line)
        if collecting_obs:
            if not stripped.strip():
                collecting_obs = False
                continue
            obs_lines.append(stripped.strip())
            continue
        for label in ("Altitude", "Position", "Orientation", "Longueur", "État surface"):
            match = re.match(rf"\s*{label}\s*:\s*(.*)$", stripped)
            if match and label not in fields:
                fields[label] = match.group(1).strip()
        obs_match = re.match(r"\s*Observations\s*:\s*(.*)$", stripped)
        if obs_match and not obs_lines:
            collecting_obs = True
            if obs_match.group(1).strip():
                obs_lines.append(obs_match.group(1).strip())

    position = POSITION_RE.search(fields.get("Position", ""))
    if not position:
        raise ValueError(f"page {page} ({entry_id}): unparseable position {fields.get('Position')!r}")
    lat_d, lat_m, lat_f = int(position.group(1)), int(position.group(2)), position.group(3)
    lon_h, lon_d, lon_m, lon_f = position.group(4), int(position.group(5)), int(position.group(6)), position.group(7)

    observations = clean_text(" ".join(obs_lines))
    icao_match = ICAO_RE.search(observations)
    icao = icao_match.group(1) if icao_match else ""
    observations = clean_text(FREQ_RE.sub("", observations))
    if AIRBAND_RE.search(observations):
        raise ValueError(f"page {page} ({entry_id}): frequency survived stripping: {observations!r}")

    altitude = re.search(r"(\d+)\s*m", fields.get("Altitude", ""))
    orientation = fields.get("Orientation", "")
    directions = [int(d) for d in re.findall(r"(\d{1,3})\s*°", orientation)]
    length_m, width_m = parse_longueur(fields.get("Longueur", ""))

    return {
        "page": page,
        "id": entry_id,
        "type": entry_type,
        "name": titlecase_name(raw_name),
        "icao": icao,
        "lat_cup": cup_coord(lat_d, lat_m, lat_f, "N", is_lat=True),
        "lon_cup": cup_coord(lon_d, lon_m, lon_f, lon_h, is_lat=False),
        "lat": decimal_deg(lat_d, lat_m, lat_f, "N"),
        "lon": decimal_deg(lon_d, lon_m, lon_f, lon_h),
        "altitude_m": int(altitude.group(1)) if altitude else None,
        "orientation": orientation,
        "directions": directions,
        "longueur": fields.get("Longueur", ""),
        "length_m": length_m,
        "width_m": width_m,
        "surface": clean_text(fields.get("État surface", "")),
        "observations": observations,
    }


def compose_desc(entry: dict) -> str:
    parts: list[str] = []
    if entry["type"] in {"AERO", "ULM"}:
        parts.append("{aerodrome}")
    if entry["type"] == "ULM":
        parts.append("Plateforme ULM.")
    if entry["surface"]:
        parts.append(f"Surface : {entry['surface'].rstrip('.')}.")
    # rwdir carries one direction; spell the orientation out whenever it says more than a
    # plain reciprocal pair (a one-way slope, alternate axes, several strips).
    directions = entry["directions"]
    plain_pair = len(directions) == 2 and abs(abs(directions[1] - directions[0]) - 180) <= 15
    if entry["orientation"] and not plain_pair:
        parts.append(f"Orientation : {entry['orientation'].rstrip('.')}.")
    if "/" in entry["longueur"]:
        parts.append(f"Pistes : {entry['longueur'].rstrip('.')}.")
    if entry["observations"]:
        parts.append(entry["observations"])
    return " ".join(parts)


def cup_style(entry: dict) -> str:
    # SeeYou styles: 2 grass airfield, 3 outlanding, 5 solid-surface airfield. Only "5" is
    # meaningful to the builder (extract_difficulty); the rest is honest metadata.
    if entry["type"] in {"CHAMP", "CHAMPS"}:
        return "3"
    surface = entry["surface"].lower()
    return "5" if "dur" in surface else "2"


def photo_filename(entry: dict) -> str:
    if entry["id"] not in CLUB_PHOTO_IDS:
        return ""
    return f"{entry['id']}_{ascii_slug(entry['name'])}.jpg"


def extract_photo(pdf: Path, entry: dict, pics_dir: Path, render_dir: Path) -> None:
    page = entry["page"]
    prefix = render_dir / f"page-{page:02d}"
    run(["pdftoppm", "-r", str(RENDER_DPI), "-f", str(page), "-l", str(page),
         "-jpeg", "-jpegopt", "quality=92", str(pdf), str(prefix)])
    rendered = next(render_dir.glob(f"page-{page:02d}*.jpg"))
    with Image.open(rendered) as image:
        left, top, right, bottom = PHOTO_BOX_RATIOS
        box = (round(image.width * left), round(image.height * top),
               round(image.width * right), round(image.height * bottom))
        photo = image.crop(box)
        photo = trim_white_margins(photo)
        photo.save(pics_dir / photo_filename(entry), "JPEG", quality=88, optimize=True)


def trim_white_margins(image: Image.Image) -> Image.Image:
    """Drop the near-white page background around the photo, keeping its own frame."""
    grey = image.convert("L")
    mask = grey.point(lambda value: 0 if value > 242 else 255)
    bbox = mask.getbbox()
    return image.crop(bbox) if bbox else image


def write_cup(entries: list[dict], out_path: Path) -> None:
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writerow(["name", "code", "country", "lat", "lon", "elev", "style",
                     "rwdir", "rwlen", "rwwidth", "freq", "desc", "userdata", "pics"])
    for entry in entries:
        writer.writerow([
            entry["name"],
            entry["icao"] or entry["id"],
            "FR" if entry["id"].startswith("F") else "ES",
            entry["lat_cup"],
            entry["lon_cup"],
            f"{entry['altitude_m']}m" if entry["altitude_m"] is not None else "",
            cup_style(entry),
            str(entry["directions"][0]) if entry["directions"] else "",
            f"{entry['length_m']:.0f}m" if entry["length_m"] else "",
            f"{entry['width_m']:.0f}m" if entry["width_m"] else "",
            "",  # 2008 frequencies deliberately dropped; current sources supply them
            compose_desc(entry),
            "",
            photo_filename(entry),
        ])
    out_path.write_text(buffer.getvalue(), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", type=Path, help="APVV guide PDF (v9, 2008)")
    parser.add_argument("--out", type=Path, default=Path("data/sources/apvv-pyrenees"))
    parser.add_argument("--render-dir", type=Path, default=Path(".cache/apvv-renders"),
                        help="scratch dir for page renders (not committed)")
    args = parser.parse_args()

    pics_dir = args.out / "Pics"
    pics_dir.mkdir(parents=True, exist_ok=True)
    args.render_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    for page in ENTRY_PAGES:
        entry = parse_entry(page_text(args.pdf, page), page)
        if not (LAT_RANGE[0] <= entry["lat"] <= LAT_RANGE[1]):
            raise ValueError(f"{entry['id']}: latitude {entry['lat']:.4f} outside {LAT_RANGE}")
        if not (LON_RANGE[0] <= entry["lon"] <= LON_RANGE[1]):
            raise ValueError(f"{entry['id']}: longitude {entry['lon']:.4f} outside {LON_RANGE}")
        entries.append(entry)

    if len(entries) != EXPECTED_ENTRIES:
        raise ValueError(f"parsed {len(entries)} entries, expected {EXPECTED_ENTRIES}")
    # Checked AFTER the count so a guide re-parse still has to yield all 27 pages; the
    # gone fields are then dropped from the output the pack reads.
    entries = [e for e in entries if e["id"] not in GONE_IDS]
    ids = [e["id"] for e in entries]
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate entry ids: {ids}")

    for stale in pics_dir.glob("*.jpg"):
        stale.unlink()
    with_photo = [e for e in entries if photo_filename(e)]
    for entry in with_photo:
        extract_photo(args.pdf, entry, pics_dir, args.render_dir)

    write_cup(entries, args.out / "POINTS.cup")

    aero = sum(1 for e in entries if e["type"] == "AERO")
    ulm = sum(1 for e in entries if e["type"] == "ULM")
    champs = len(entries) - aero - ulm
    print(f"{len(entries)} entries -> {args.out} ({aero} AERO, {ulm} ULM, {champs} champs, "
          f"{len(with_photo)} club photos)")
    for entry in entries:
        code = entry["icao"] or entry["id"]
        print(f"  {entry['id']:>3} {entry['type']:<6} {entry['name']:<18} {code:<5} "
              f"{entry['lat']:.4f} {entry['lon']:7.4f}  alt {entry['altitude_m']}m "
              f"len {entry['length_m'] or '?'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
