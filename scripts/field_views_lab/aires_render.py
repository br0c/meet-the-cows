#!/usr/bin/env python3
"""Render every Guide des Aires de Sécurité field from its drawn annotations.

Generic version of the per-field extractors that were hand-tuned on Bayons, St Blaise,
Prunieres and Marcoux: detect whichever annotation families a photo carries, register it
onto current imagery, project the drawn geometry and re-render. Deterministic, no model
call. Fields whose annotation cannot be transferred fall back to an unmarked current
overview (field_views.plain_view) rather than to nothing.

What gets drawn is only what the Guide drew: filled strips and drawn rings as red
outlines, danger rectangles as translucent red, measured arrows as white direction
arrows. No obstacle markers, no legend, no distance labels — those live in the field's
own parameters.

    FIELD_VIEWS_WORK=/path python3 aires_render.py [field-id ...]

Outputs $FIELD_VIEWS_WORK/aires/out/{final_<id>.jpg, index.json}.
"""
import json
import math
import os
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import field_views as fv  # noqa: E402
import transfer_cv as tc  # noqa: E402
from aires_sweep import PHOTOS, detect_families, inner_window, is_framed  # noqa: E402
from transfer_render import draw_arrow  # noqa: E402

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
AIRES = WORK / "aires"
OUT = AIRES / "out"
PXW, PXH = 975, 1300
MPP = 1800 / 975
DATUM = (487.5, 650.0)
RED = (226, 40, 25)

ARROW_BANDS = {
    "red": lambda r, g, b: (r > 150) & (g < 100) & (b < 100),
    "pink": lambda r, g, b: ((r > 205) & (g > 120) & (g < 210) & (b > 110) & (b < 215)
                             & (r - b > 35)),
    "blue": lambda r, g, b: (b > 140) & (b - r > 60) & (b - g > 60),
}


def _bands(img, win):
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    out = {}
    for name, fn in ARROW_BANDS.items():
        m = (fn(r, g, b).astype(np.uint8) * 255) & win
        out[name] = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return out


def split_thin_and_boxes(mask, min_area=60):
    """Separate thin drawn lines (arrows) from hollow drawn rectangles (danger zones)."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask)
    thin, boxes = [], []
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < min_area:
            continue
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
        long_, short = max(dw, dh), min(dw, dh)
        if long_ < 25:
            continue
        # Width alone separates them: an arrow is a pen line a few pixels across, while a
        # danger zone is a rectangle tens of pixels wide. Elongation cannot decide it —
        # Bayons' danger strip is 40 px wide and 6x as long, which an aspect test calls an
        # arrow.
        if short <= 14:
            thin.append(i)
        else:
            # Anything red and chunky is a drawn danger zone, whether the Guide outlined
            # it or filled it translucently (Bayons fills its one, which an outline-only
            # test misses). Arrows never reach here — they are caught as thin above.
            boxes.append(cv2.boxPoints(cv2.minAreaRect(pts)))
    return thin, boxes, lab


def arrow_axes(mask, min_area=60, line_tol=40):
    """Axes of each drawn arrow. Components collinear with one another belong to the same
    arrow — a label drawn across it splits the stroke in two — while a separate arrow
    elsewhere in the frame sits off that line."""
    thin, _, lab = split_thin_and_boxes(mask, min_area)
    groups = []
    for i in sorted(thin, key=lambda j: -int((lab == j).sum())):
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        placed = False
        for gp in groups:
            a, b = gp["axis"]
            ux, uy = b[0] - a[0], b[1] - a[1]
            norm = math.hypot(ux, uy) or 1
            ux, uy = ux / norm, uy / norm
            c = pts.mean(axis=0)
            if abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) <= line_tol:
                gp["pts"] = np.vstack([gp["pts"], pts])
                gp["axis"] = tc.axis_of(cv2.boxPoints(cv2.minAreaRect(gp["pts"])))
                placed = True
                break
        if not placed:
            groups.append({"pts": pts,
                           "axis": tc.axis_of(cv2.boxPoints(cv2.minAreaRect(pts)))})
    # A second pass merges groups that turned out collinear: the first segment seen sets a
    # group's axis, and a label splitting an arrow can leave its halves too far apart to
    # join until both axes exist (Marcoux's 250 m arrow splits exactly that way).
    merged = True
    while merged and len(groups) > 1:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i]["axis"]
                ux, uy = b[0] - a[0], b[1] - a[1]
                norm = math.hypot(ux, uy) or 1
                ux, uy = ux / norm, uy / norm
                c = groups[j]["pts"].mean(axis=0)
                if abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) <= line_tol:
                    pts = np.vstack([groups[i]["pts"], groups[j]["pts"]])
                    groups[i] = {"pts": pts,
                                 "axis": tc.axis_of(cv2.boxPoints(cv2.minAreaRect(pts)))}
                    groups.pop(j)
                    merged = True
                    break
            if merged:
                break
    return [g["axis"] for g in groups]


def fill_quads(img, win, min_area=350):
    """Outer boundary of each solid colour-filled strip the Guide painted."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    fill = (((h > 20) & (h < 70) & (s > 80) & (v > 110)).astype(np.uint8) * 255) & win
    fill = cv2.morphologyEx(fill, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(fill, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in cnts:
        if cv2.contourArea(c) < min_area:
            continue
        poly = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        out.append(poly.reshape(-1, 2).astype(np.float32))
    return out, fill


def annotations(img, framed):
    """Every drawn element in one photo, plus the masks to keep out of registration."""
    win = inner_window(img, framed)
    fam, masks = detect_families(img, framed)
    quads, fill_mask = fill_quads(img, win)
    bands = _bands(img, win)
    arrows, danger = [], []
    for name, mask in bands.items():
        axes = arrow_axes(mask)
        arrows += axes
        if name == "red":
            _, boxes, _ = split_thin_and_boxes(mask)
            # An arrowhead is a wide blob and would otherwise read as a danger zone, so
            # drop any box sitting on one of this band's own arrow axes.
            for quad in boxes:
                c = np.asarray(quad, np.float32).mean(axis=0)
                on_arrow = False
                for a, b in axes:
                    ux, uy = b[0] - a[0], b[1] - a[1]
                    norm = math.hypot(ux, uy) or 1
                    if abs((c[0] - a[0]) * uy / norm - (c[1] - a[1]) * ux / norm) <= 30:
                        on_arrow = True
                        break
                if not on_arrow:
                    danger.append(quad)
    rings = []
    if fam.get("ellipse"):
        # detect_families already fitted them; re-fit here to get the parameters back.
        # The speculative arc path stays off when a definite annotation was found.
        rings = _rings(img, framed, allow_arc=not (quads or arrows or danger))
    return dict(quads=quads, arrows=arrows, danger=danger, rings=rings,
                families=fam), masks + [fill_mask] + list(bands.values())


def _rings(img, framed, allow_arc=True):
    """Drawn ellipse rings, as polygons (same detection as the sweep's ellipse family)."""
    win = inner_window(img, framed)
    v = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 2]
    bh = cv2.morphologyEx(v, cv2.MORPH_BLACKHAT,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    dark = ((((bh > 25) & (v < 60)) | (v < 42)).astype(np.uint8) * 255) & win
    out = []
    cnts, hier = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is not None:
        for i, c in enumerate(cnts):
            if hier[0][i][3] == -1 or len(c) < 5 or cv2.contourArea(c) < 1500:
                continue
            (cx, cy), (d1, d2), ang = cv2.fitEllipse(c)
            fitted = math.pi * d1 * d2 / 4
            if fitted and min(d1, d2) >= 40 and 0.93 <= cv2.contourArea(c) / fitted <= 1.07:
                out.append(cv2.ellipse2Poly((round(cx), round(cy)),
                                            (round(d1 / 2), round(d2 / 2)),
                                            round(ang), 0, 360, 5).astype(np.float32))
    if out or not allow_arc:
        return out
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dark)
    probe = cv2.dilate(dark, np.ones((7, 7), np.uint8))
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 80:
            continue
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        if len(pts) < 60:
            continue
        (cx, cy), (d1, d2), ang = cv2.fitEllipse(pts)
        if min(d1, d2) < 40 or max(d1, d2) > 0.9 * min(dark.shape):
            continue
        poly = cv2.ellipse2Poly((round(cx), round(cy)), (round(d1 / 2), round(d2 / 2)),
                                round(ang), 0, 360, 5)
        ok = [(0 <= x < probe.shape[1] and 0 <= y < probe.shape[0]) for x, y in poly]
        if (any(ok)
                and sum(1 for (x, y), k in zip(poly, ok) if k and probe[y, x]) / len(poly) >= 0.80
                and tc.stroke_width(stats[i, cv2.CC_STAT_AREA], d1, d2) <= 4.5):
            return [poly.astype(np.float32)]
    return []


def px2m(p):
    return (round(float(p[0] - DATUM[0]) * MPP, 1), round(float(DATUM[1] - p[1]) * MPP, 1))


def transfer_field(f, photos):
    """Register each photo and collect its drawn geometry in metres of the field datum."""
    fid = f["id"]
    lat = f.get("lat") or f["latitude"]
    lon = f.get("lon") or f["longitude"]
    country = f.get("country") or "FR"
    cur_path = AIRES / f"{fid}_current.jpg"
    if not cur_path.exists():
        fv.ortho_crop(lat, lon, 1800, cur_path, country)
    cur = cv2.imread(str(cur_path))

    geom = {"quads": [], "rings": [], "danger": [], "runs": []}
    regs = []
    for name in photos:
        img = cv2.imread(str(PHOTOS / name))
        if img is None:
            continue
        framed = is_framed(img)
        ann, masks = annotations(img, framed)
        if not any((ann["quads"], ann["rings"], ann["danger"], ann["arrows"])):
            continue
        # A measured arrow is a scale bar: the field's own lengthM over the arrow's pixel
        # length gives the old photo's ground resolution, which pins the transform's scale.
        expect = None
        if ann["arrows"] and f.get("lengthM"):
            longest = max(math.dist(*a) for a in ann["arrows"])
            if longest > 30:
                expect = (float(f["lengthM"]) / longest) / MPP
                if not 0.05 < expect < 20:
                    expect = None
        try:
            M, stats = tc.register(img, cur, framed, masks, name, expect_scale=expect)
        except RuntimeError:
            wide_path = AIRES / f"{fid}_wide.jpg"
            if not wide_path.exists():
                fv.ortho_crop(lat, lon, 4500, wide_path, country)
            try:
                Mw, stats = tc.register(img, cv2.imread(str(wide_path)), framed, masks,
                                        f"{name}(wide)",
                                        expect_scale=expect / 2.5 if expect else None)
            except RuntimeError:
                continue
            k = (4500 / 975) / MPP
            C = np.array([[k, 0, DATUM[0] * (1 - k)], [0, k, DATUM[1] * (1 - k)], [0, 0, 1]])
            M = (C @ np.vstack([Mw, [0, 0, 1]]))[:2]
            stats["via"] = "wide 4500 m crop"
        stats["photo"] = name
        regs.append(stats)
        for key, src in (("quads", ann["quads"]), ("rings", ann["rings"]),
                         ("danger", ann["danger"])):
            for shape in src:
                geom[key].append([px2m(p) for p in tc.apply_m(M, shape)])
        for axis in ann["arrows"]:
            pm = [px2m(p) for p in tc.apply_m(M, np.array(axis, np.float32))]
            if math.dist(*pm) >= 40:
                geom["runs"].append(pm)
    return geom, regs


def render(f, geom, regs):
    from PIL import Image, ImageDraw
    fid = f["id"]
    lat = f.get("lat") or f["latitude"]
    lon = f.get("lon") or f["longitude"]
    country = f.get("country") or "FR"
    pts = [p for key in ("quads", "rings", "danger", "runs") for shape in geom[key]
           for p in shape]
    ce = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
    cn = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
    span = max(max(p[0] for p in pts) - min(p[0] for p in pts),
               max(p[1] for p in pts) - min(p[1] for p in pts))
    clat = lat + cn / 111320
    clon = lon + ce / (111320 * math.cos(math.radians(lat)))
    out_path = OUT / f"final_{fid}.jpg"
    tmp = out_path.with_suffix(".crop.jpg")
    crop = fv.ortho_crop(clat, clon, max(700, min(span * 1.7, 2600)), tmp, country)
    mpp = crop["mpp"]
    img = Image.open(tmp).convert("RGB")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    def to_px(p):
        return (PXW / 2 + (p[0] - ce) / mpp, PXH / 2 - (p[1] - cn) / mpp)

    for quad in geom["danger"]:
        d.polygon([to_px(p) for p in quad], fill=RED + (80,), outline=RED + (255,), width=3)
    for shape in geom["quads"] + geom["rings"]:
        d.polygon([to_px(p) for p in shape], outline=RED + (255,), width=4)
    for tail, head in geom["runs"]:
        draw_arrow(d, to_px, tail, head)
    fv.draw_chrome(d, f["name"], crop["attribution"],
                   " · Annotations: Guide des Aires de Sécurité")
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        out_path, quality=90)
    tmp.unlink()
    return out_path


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    inventory = json.loads((WORK / "inventory.json").read_text())
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    todo = []
    for f in inventory:
        if f.get("kind") == "airfield":
            continue
        photos = [Path(m.get("url", "")).name for m in (f.get("media") or [])
                  if "Aires" in (m.get("source") or "")
                  and (PHOTOS / Path(m.get("url", "")).name).exists()]
        if photos and (not only or f["id"] in only):
            todo.append((f, photos))
    print(f"{len(todo)} fields to render", flush=True)
    for f, photos in todo:
        fid = f["id"]
        if fid in index and not only:
            continue
        try:
            geom, regs = transfer_field(f, photos)
            if any(geom[k] for k in geom):
                path = render(f, geom, regs)
                index[fid] = {"name": f["name"], "mode": "annotated",
                              "shapes": {k: len(v) for k, v in geom.items()},
                              "registration": regs, "file": path.name}
                print(f"{fid} {f['name']}: annotated "
                      f"{ {k: len(v) for k, v in geom.items() if v} } "
                      f"({', '.join(str(r['inliers']) + ' inl' for r in regs)})", flush=True)
            else:
                raise RuntimeError("no transferable annotation")
        except Exception as err:  # noqa: BLE001 - a field always gets some view
            # The plain fallback fetches imagery too, so it can fail for the same reason
            # the transfer did — no provider covers the point, or every one is down. That
            # must not end the run: one uncovered field is a row in the index, not a
            # reason to lose the other seventy-seven.
            path = OUT / f"final_{fid}.jpg"
            try:
                fv.plain_view(f.get("lat") or f["latitude"], f.get("lon") or f["longitude"],
                              f["name"], path, f.get("country") or "FR", 1500)
                index[fid] = {"name": f["name"], "mode": "plain", "reason": str(err)[:160],
                              "file": path.name}
                print(f"{fid} {f['name']}: PLAIN ({str(err)[:70]})", flush=True)
            except Exception as err2:  # noqa: BLE001
                index[fid] = {"name": f["name"], "mode": "failed",
                              "reason": str(err)[:120], "imagery_error": str(err2)[:160]}
                print(f"{fid} {f['name']}: NO VIEW ({str(err2)[:90]})", flush=True)
        index_path.write_text(json.dumps(index, indent=1))
    from collections import Counter
    print(Counter(v["mode"] for v in index.values()))


if __name__ == "__main__":
    main()
