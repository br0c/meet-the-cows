#!/usr/bin/env python3
"""Archive the APVV guide's annotated Google Earth captures for the transfer pipeline.

Each entry page carries a nadir Google Earth view top-right with the field outlined in
orange (and an arrow on some pages); pages without a club photo carry a second, tilted or
re-zoomed GE view bottom-right. These drawings are the authoritative placement for the
Pyrenees fields, so the captures are archived under data/sources/field-views/pyr-google/
as pipeline INPUT — they are never packed or served (Google imagery cannot be
redistributed to pilots; the generated views are re-drawn on PNOA/IGN instead).

    python3 scripts/extract_pyr_ge_views.py /path/to/Champs_pyr_esp_v9_fr_br.pdf

Requires poppler-utils and Pillow, like extract_pyr_guide.py, which supplies the page
parsing and quadrant calibration this reuses.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from extract_pyr_guide import (  # noqa: E402
    CLUB_PHOTO_IDS, ENTRY_PAGES, EXPECTED_ENTRIES, PHOTO_BOX_RATIOS, RENDER_DPI,
    ascii_slug, page_text, parse_entry, run, trim_white_margins,
)

# The GE quadrant sits directly above the photo quadrant: same x-range, upper half.
# Top edge is generous and trim_white_margins tightens to the capture's own frame.
GE_TOP_BOX_RATIOS = (PHOTO_BOX_RATIOS[0], 0.150, PHOTO_BOX_RATIOS[2], 0.498)


def crop_ratios(image: Image.Image, ratios: tuple[float, float, float, float]) -> Image.Image:
    left, top, right, bottom = ratios
    box = (round(image.width * left), round(image.height * top),
           round(image.width * right), round(image.height * bottom))
    return trim_white_margins(image.crop(box))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, default=Path("data/sources/field-views/pyr-google"))
    parser.add_argument("--render-dir", type=Path, default=Path(".cache/apvv-renders"))
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    args.render_dir.mkdir(parents=True, exist_ok=True)

    index: list[dict] = []
    for page in ENTRY_PAGES:
        entry = parse_entry(page_text(args.pdf, page), page)
        prefix = args.render_dir / f"page-{page:02d}"
        run(["pdftoppm", "-r", str(RENDER_DPI), "-f", str(page), "-l", str(page),
             "-jpeg", "-jpegopt", "quality=92", str(args.pdf), str(prefix)])
        rendered = next(args.render_dir.glob(f"page-{page:02d}*.jpg"))
        stem = f"{entry['id']}_{ascii_slug(entry['name'])}"
        files = []
        with Image.open(rendered) as image:
            views = [(GE_TOP_BOX_RATIOS, f"{stem}_ge1.jpg")]
            if entry["id"] not in CLUB_PHOTO_IDS:
                # bottom-right is the second GE view, not a club photo
                views.append((PHOTO_BOX_RATIOS, f"{stem}_ge2.jpg"))
            for ratios, name in views:
                crop_ratios(image, ratios).save(args.out / name, "JPEG",
                                                quality=88, optimize=True)
                files.append(name)
        index.append({
            "id": entry["id"], "name": entry["name"], "page": page,
            # CHAMP entries are the transfer targets; aerodromes and ULM strips get
            # their generated views from the OSM tier instead
            "type": entry["type"],
            "lat": round(entry["lat"], 6), "lon": round(entry["lon"], 6),
            "orientation": entry.get("orientation", ""),
            "longueur": entry.get("longueur", ""),
            "files": files,
        })
        print(f"{entry['id']}: {', '.join(files)}", file=sys.stderr)

    if len(index) != EXPECTED_ENTRIES:
        raise ValueError(f"extracted {len(index)} entries, expected {EXPECTED_ENTRIES}")
    (args.out / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (args.out / "meta.json").write_text(json.dumps({
        "source": "http://crvvaquitaine.free.fr/download/down/Champs_pyr_esp_v9_fr_br.pdf",
        "sourceSha256": hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
        "retrieved": dt.date.today().isoformat(),
        "entries": len(index),
        "views": sum(len(e["files"]) for e in index),
    }, indent=1) + "\n", encoding="utf-8")
    print(f"archived {sum(len(e['files']) for e in index)} GE views "
          f"for {len(index)} entries -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
