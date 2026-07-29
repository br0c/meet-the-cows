#!/usr/bin/env python3
"""Transfer the APVV Pyrenees guide's drawn field outlines onto PNOA/IGN imagery.

Input: data/sources/field-views/pyr-google/ (annotated Google Earth captures + index).
Only CHAMP entries run — aerodromes and ULM strips get OSM-tier views.

Per entry: mask the orange outline in the nadir capture (ge1), SIFT-register the capture
onto a fresh crop at the guide's coordinates (ES -> PNOA, FR -> IGN), project the quad,
render in the house style. ge2 is used as a cross-check when it registers too. Work dir
$FIELD_VIEWS_WORK/pyr/ gets crops, trace/blend verification images, renders and
verdicts.json. Deterministic — no model call.
"""
import json
import math
import os
import re
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import field_views as fv  # noqa: E402
import transfer_cv as tc  # noqa: E402

SRC = Path(__file__).resolve().parents[2] / "data/sources/field-views/pyr-google"
WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work")) / "pyr"
OUT = WORK / "out"
PXW, PXH = 975, 1300
MPP = 1800 / 975
DATUM = (487.5, 650.0)
RED = (226, 40, 25)


def orange_mask(img):
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    m = ((r > 190) & (g > 40) & (g < 150) & (b < 110) & (r - b > 110)).astype(np.uint8) * 255
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))


def chrome_boxes(img):
    """exclusion mask for the N-arrow (always top-left) and the capture's frame edge."""
    h, w = img.shape[:2]
    m = np.zeros((h, w), np.uint8)
    m[: int(h * 0.40), : int(w * 0.16)] = 255   # N arrow + label
    m[:8, :] = 255; m[-8:, :] = 255; m[:, :8] = 255; m[:, -8:] = 255
    return m


def split_arrows(mask, stroke=9):
    """Separate the thick solid direction arrows from the thin drawn outlines.

    The guide's arrows are ~30 px of solid fill while an outline is a ~5 px stroke, and
    an arrow usually TOUCHES the field it points into — so they merge into one component
    and a bounding box over the pair spans both (La Peña measured 1526 m against a stated
    500 m that way). Eroding by more than the stroke width leaves only the arrows, which
    are then dilated back and removed from the mask.
    """
    k = np.ones((stroke, stroke), np.uint8)
    thick = cv2.erode(mask, k)
    thick = cv2.dilate(thick, k)          # restore the arrows' own girth
    # generous dilation: the arrow's anti-aliased halo survives a tight subtraction and
    # becomes a phantom shape where the tip crosses an outline
    outlines = mask & cv2.bitwise_not(cv2.dilate(thick, np.ones((13, 13), np.uint8)))
    return cv2.morphologyEx(outlines, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)), thick


def extract_shapes(img, min_area=400):
    """Every drawn field outline in the capture, as its own traced polygon.

    Not a min-area rectangle: the guide draws irregular hand-traced boundaries that
    follow the terrain (Sort is a lens shape along a river), and several entries draw
    TWO strips because two landing directions are usable. The polygon is the truth;
    reproduce each one.
    """
    mask = orange_mask(img)
    # Trace the HOLES in the orange mask, not the strokes around them. The interior of a
    # drawn field outline is a hole; an arrow that touches (or crosses) the outline adds
    # mass outside it and leaves the hole intact, where subtracting the arrow would cut
    # the loop open. The guide's hand-written orange labels ("Champ", "C", "E" at Ainsa)
    # are open strokes and enclose nothing, so they disappear for free.
    cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    shapes = []
    if hier is not None:
        hier = hier[0]
        for i, c in enumerate(cnts):
            if hier[i][3] == -1:              # outer boundary, not an interior
                continue
            if cv2.contourArea(c) < min_area:
                continue
            (_, _), (dw, dh), _ = cv2.minAreaRect(c)
            if max(dw, dh) < 30:
                continue
            poly = cv2.approxPolyDP(c, 0.012 * cv2.arcLength(c, True), True)
            shapes.append(poly.reshape(-1, 2).astype(np.float32))
    if not shapes:
        raise RuntimeError("no drawn outline found")
    shapes.sort(key=lambda s: -cv2.contourArea(s.astype(np.int32)))
    # a genuine second strip is comparable in size to the first; leftovers from an arrow
    # crossing an outline are not
    biggest = cv2.contourArea(shapes[0].astype(np.int32))
    shapes = [s for s in shapes
              if cv2.contourArea(s.astype(np.int32)) >= 0.15 * biggest]
    return shapes, mask


def px2m(p):
    return (round(float(p[0] - DATUM[0]) * MPP, 1), round(float(DATUM[1] - p[1]) * MPP, 1))


def length_check(dims, longueur_stated):
    """Compare the longest drawn shape against the guide's stated length.

    These are two different quantities: the outline is the whole landable field, the
    text gives the usable run inside it (Sort draws 860 m and states 600 m). So a drawing
    LARGER than the stated length is normal and only flagged for review, while a drawing
    much SMALLER means the extraction lost part of the shape — that one is a defect.
    """
    nums = [int(n) for n in re.findall(r"(\d{2,4})\s*m", longueur_stated or "")]
    if not nums or not dims:
        return {"stated_m": None, "verdict": "no-stated-length"}
    stated = max(nums)
    got = max(d["len_m"] for d in dims)
    ratio = got / stated
    verdict = ("ok" if 0.8 <= ratio <= 1.6
               else "drawn-short" if ratio < 0.8      # defect: shape lost
               else "drawn-generous")                 # normal: outline > usable run
    return {"stated_m": stated, "drawn_m": got, "ratio": round(ratio, 2), "verdict": verdict}


def transfer(entry):
    slug = f"{entry['id']}_{entry['name'].replace(' ', '_')}"
    country = "FR" if entry["id"].startswith("F") else "ES"
    cur_path = WORK / f"{slug}_current.jpg"
    if not cur_path.exists():
        fv.ortho_crop(entry["lat"], entry["lon"], 1800, cur_path, country)
    cur = cv2.imread(str(cur_path))

    ge1 = cv2.imread(str(SRC / entry["files"][0]))
    shapes, mask = extract_shapes(ge1)
    vis = ge1.copy()
    cv2.polylines(vis, [s.astype(np.int32) for s in shapes], True, (255, 0, 255), 2)
    cv2.imwrite(str(OUT / f"trace_{slug}.jpg"), vis)

    try:
        M, stats = tc.register(ge1, cur, False, [mask, chrome_boxes(ge1)], slug)
    except RuntimeError:
        wide_path = WORK / f"{slug}_wide.jpg"
        if not wide_path.exists():
            fv.ortho_crop(entry["lat"], entry["lon"], 4500, wide_path, country)
        wide = cv2.imread(str(wide_path))
        M_w, stats = tc.register(ge1, wide, False, [mask, chrome_boxes(ge1)], f"{slug}(wide)")
        k = (4500 / 975) / MPP
        C = np.array([[k, 0, DATUM[0] * (1 - k)], [0, k, DATUM[1] * (1 - k)], [0, 0, 1]])
        M = (C @ np.vstack([M_w, [0, 0, 1]]))[:2]
        stats["via"] = "wide 4500 m crop"
        stats["rms_m"] = round(stats["rms_px"] * (4500 / 975), 1)
        tc.blend_check(ge1, wide, M_w, OUT / f"blend_{slug}.jpg")
    else:
        tc.blend_check(ge1, cur, M, OUT / f"blend_{slug}.jpg")

    polys_m, dims = [], []
    for s in shapes:
        pm = [px2m(p) for p in tc.apply_m(M, s)]
        polys_m.append(pm)
        (_, _), (dw, dh), ang = cv2.minAreaRect(np.array(pm, np.float32))
        long_, short = max(dw, dh), min(dw, dh)
        # minAreaRect angle is measured on the long side, in metre space (north-up)
        axis = (90 - ang) % 180 if dw >= dh else (-ang) % 180
        dims.append({"len_m": round(long_), "width_m": round(short), "axis_deg": round(axis, 1)})
    doc = {"id": entry["id"], "name": entry["name"], "country": country,
           "lat": entry["lat"], "lon": entry["lon"],
           "orientation_stated": entry["orientation"], "longueur_stated": entry["longueur"],
           "shapes_m": polys_m, "shape_dims": dims,
           "registration": stats}
    doc["length_check"] = length_check(dims, entry["longueur"])
    return doc


def render(doc):
    from PIL import Image, ImageDraw, ImageFont
    slug = f"{doc['id']}_{doc['name'].replace(' ', '_')}"
    allpts = [p for poly in doc["shapes_m"] for p in poly]
    ce = (min(p[0] for p in allpts) + max(p[0] for p in allpts)) / 2
    cn = (min(p[1] for p in allpts) + max(p[1] for p in allpts)) / 2
    clat = doc["lat"] + cn / 111320
    clon = doc["lon"] + ce / (111320 * math.cos(math.radians(doc["lat"])))
    tmp = OUT / f"final_{slug}.crop.jpg"
    span = max(max(p[0] for p in allpts) - min(p[0] for p in allpts),
               max(p[1] for p in allpts) - min(p[1] for p in allpts))
    crop = fv.ortho_crop(clat, clon, max(900, span * 1.5), tmp, doc["country"])
    mpp = crop["mpp"]
    img = Image.open(tmp).convert("RGB")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    def to_px(p):
        return (PXW / 2 + (p[0] - ce) / mpp, PXH / 2 - (p[1] - cn) / mpp)

    for poly in doc["shapes_m"]:
        d.polygon([to_px(p) for p in poly], outline=RED + (255,), width=4)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
        nfont = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
    except OSError:
        font = small = nfont = ImageFont.load_default()
    x, y, r = 56, 70, 36
    d.ellipse([x - r - 7, y - r - 7, x + r + 7, y + r + 7], fill=(10, 15, 25, 140))
    d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255, 220), width=2)
    for ang in range(0, 360, 45):
        hh = math.radians(ang)
        ln = r if ang % 90 == 0 else r * 0.5
        tip = (x + ln * math.sin(hh), y - ln * math.cos(hh))
        bl = (x + 6 * math.sin(hh + math.pi / 2), y - 6 * math.cos(hh + math.pi / 2))
        br = (x + 6 * math.sin(hh - math.pi / 2), y - 6 * math.cos(hh - math.pi / 2))
        d.polygon([tip, bl, br], fill=RED + (255,) if ang == 0 else (255, 255, 255, 235))
    d.text((x, y - r - 9), "N", font=nfont, fill=(255, 255, 255, 255), anchor="mb",
           stroke_width=2, stroke_fill=(10, 15, 25, 255))
    bar_h = 56
    d.rectangle([0, PXH - bar_h, PXW, PXH], fill=(10, 15, 25, 175))
    d.text((14, PXH - bar_h + 8), doc["name"], font=font, fill=(255, 255, 255, 255))
    d.text((14, PXH - 20),
           crop["attribution"] + " · Annotations: Guide des champs pyrénéens (APVV)",
           font=small, fill=(200, 206, 218, 255))
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        OUT / f"final_{slug}.jpg", quality=90)
    tmp.unlink()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = json.loads((SRC / "index.json").read_text())
    only = set(sys.argv[1:])
    verdicts = {}
    for entry in index:
        if not entry["type"].startswith("CHAMP"):
            continue
        if only and entry["id"] not in only:
            continue
        try:
            doc = transfer(entry)
            render(doc)
            verdicts[entry["id"]] = doc
            dims = ", ".join(f"{d['len_m']}x{d['width_m']}m@{d['axis_deg']}°"
                             for d in doc["shape_dims"])
            print(f"{entry['id']} {entry['name']}: {doc['length_check']['verdict']} "
                  f"[{len(doc['shapes_m'])} shape(s): {dims}] stated "
                  f"{doc['orientation_stated']} / {doc['longueur_stated']} | reg "
                  f"{doc['registration']['inliers']} inl {doc['registration']['rms_m']} m",
                  flush=True)
        except Exception as err:  # noqa: BLE001 - verdict per field, keep going
            verdicts[entry["id"]] = {"id": entry["id"], "name": entry["name"], "error": str(err)}
            print(f"{entry['id']} {entry['name']}: FAILED {err}", flush=True)
    (OUT / "verdicts.json").write_text(json.dumps(verdicts, indent=1))
    ok = sum(1 for v in verdicts.values() if "error" not in v)
    print(f"{ok}/{len(verdicts)} champs transferred; artifacts in {OUT}")


if __name__ == "__main__":
    main()
