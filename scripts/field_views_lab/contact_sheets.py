#!/usr/bin/env python3
"""Contact sheets for reviewing generated views by eye.

Nobody opens 2,500 images one at a time. These sheets put 24 views on a page with their
field names, so a reviewer can scan a whole tier and stop only where something looks
wrong — a rectangle off its strip, a blank crop, a marking in a lake.

    python3 contact_sheets.py --dir work/osm/out --out work/sheets --title "OSM tier"
"""
import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 6, 4
TILE = 300
LABEL = 26


def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    try:
        return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{name}", size)
    except OSError:
        return ImageFont.load_default()


def sheet(paths, out_path, title, page, pages):
    head = 40
    used_rows = max(1, math.ceil(len(paths) / COLS))   # a short last page stays short
    w, h = COLS * TILE, head + used_rows * (TILE + LABEL)
    img = Image.new("RGB", (w, h), (16, 20, 28))
    d = ImageDraw.Draw(img)
    d.text((12, 10), f"{title} — page {page}/{pages}", font=font(22, True),
           fill=(240, 243, 250))
    for i, p in enumerate(paths):
        col, row = i % COLS, i // COLS
        x, y = col * TILE, head + row * (TILE + LABEL)
        try:
            with Image.open(p) as tile:
                tile = tile.convert("RGB")
                # portrait views: fit by height so the whole frame is visible
                scale = min(TILE / tile.width, TILE / tile.height)
                tile = tile.resize((max(1, round(tile.width * scale)),
                                    max(1, round(tile.height * scale))))
                img.paste(tile, (x + (TILE - tile.width) // 2, y))
        except Exception:  # noqa: BLE001 - a broken file is exactly what review must catch
            d.rectangle([x + 4, y + 4, x + TILE - 4, y + TILE - 4], outline=(220, 60, 50), width=2)
            d.text((x + 10, y + TILE // 2), "UNREADABLE", font=font(14, True),
                   fill=(240, 120, 110))
        name = p.stem.replace("final_", "")
        d.text((x + 4, y + TILE + 4), name[:44], font=font(12), fill=(190, 198, 212))
    img.save(out_path, quality=88)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="Generated views")
    ap.add_argument("--max-pages", type=int, default=0, help="0 = all")
    args = ap.parse_args()

    paths = sorted(Path(args.dir).glob("final_*.jpg"))
    if not paths:
        print(f"no views in {args.dir}")
        return 0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    per = COLS * ROWS
    pages = math.ceil(len(paths) / per)
    limit = min(pages, args.max_pages) if args.max_pages else pages
    for page in range(limit):
        sheet(paths[page * per:(page + 1) * per],
              out / f"sheet_{page + 1:03d}.jpg", args.title, page + 1, pages)
    print(f"{len(paths)} views -> {limit} sheet(s) in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
