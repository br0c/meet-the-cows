#!/usr/bin/env python3
"""Classification sweep over the Guide des Aires de Sécurité photo corpus.

For every non-airfield field carrying a Guide photo: detect which annotation families
the photo draws (fill quad, black ellipse, measured arrows, red danger box, dot marker),
attempt SIFT registration onto a fresh IGN crop, and record a per-field verdict. No
renders here — the sweep decides which fields transfer cleanly today, which need an
extra extractor family, and which need eyes.

Inputs: $FIELD_VIEWS_WORK/inventory.json (merged pack fields) and
data/sources/field-views/guide-photos/. Output: $FIELD_VIEWS_WORK/aires/verdicts.json,
resumable — fields already in it are skipped.
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

PHOTOS = Path(__file__).resolve().parents[2] / "data/sources/field-views/guide-photos"
WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
AIRES = WORK / "aires"
MPP = 1800 / 975


def is_framed(img):
    """Guide-framed photos have a saturated uniform border; screenshots do not."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    border = np.concatenate([hsv[2:6, :, 1].ravel(), hsv[-6:-2, :, 1].ravel(),
                             hsv[:, 2:6, 1].ravel(), hsv[:, -6:-2, 1].ravel()])
    return float(np.median(border)) > 60


def inner_window(img, framed):
    h, w = img.shape[:2]
    m = np.zeros((h, w), np.uint8)
    if framed:
        m[95:-95, 20:-20] = 255
    else:
        m[6:-70, 6:-6] = 255
    return m


def detect_families(img, framed):
    """Which annotation families are drawn, with their masks."""
    win = inner_window(img, framed)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hch, s, v = cv2.split(hsv)
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    fam, masks = {}, []

    fill = (((hch > 20) & (hch < 70) & (s > 80) & (v > 110)).astype(np.uint8) * 255) & win
    fill = cv2.morphologyEx(fill, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fill)
    quads = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= 350]
    if quads:
        fam["fill_quad"] = len(quads)
        masks.append(fill)

    # measured/line arrows in the saturated line colours the guide uses
    arrows = 0
    for name, m in {
        "red": ((r > 150) & (g < 100) & (b < 100)),
        "pink": ((r > 205) & (g > 120) & (g < 210) & (b > 110) & (b < 215) & (r - b > 35)),
        "blue": ((b > 140) & (b - r > 60) & (b - g > 60)),
    }.items():
        mm = (m.astype(np.uint8) * 255) & win
        mm = cv2.morphologyEx(mm, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        n, lab, stats, _ = cv2.connectedComponentsWithStats(mm)
        comps = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= 60]
        thin, boxes = 0, 0
        for i in comps:
            pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
            (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
            long_, short = max(dw, dh), min(dw, dh)
            if long_ < 25:
                continue
            ratio = stats[i, cv2.CC_STAT_AREA] / max(long_ * short, 1)
            if short <= 14 or (long_ / max(short, 1) > 4):
                thin += 1
            elif ratio < 0.5:      # hollow outline -> drawn box (danger / field rect)
                boxes += 1
        if thin:
            arrows += thin
            masks.append(mm)
        if boxes and name == "red":
            fam["danger_box"] = boxes
            masks.append(mm)
    if arrows:
        fam["arrows"] = arrows

    # Thin black ellipse ring. Found as a HOLE in the thin-dark mask rather than by
    # fitting a curve to every dark pixel in the photo: over a whole frame the ring is a
    # small minority of thin-dark pixels (field edges, roads, shadows), which starves
    # random sampling and any support-fraction test. A hole also carries its own shape
    # test — enclosed area over fitted-ellipse area is 1.0 for an ellipse and 4/pi ~ 1.27
    # for a rectangle, so a bordered strip does not masquerade as a ring.
    bh = cv2.morphologyEx(v, cv2.MORPH_BLACKHAT,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    dark = ((((bh > 25) & (v < 60)) | (v < 42)).astype(np.uint8) * 255) & win
    rings = []
    cnts, hier = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is not None:
        for i, c in enumerate(cnts):
            if hier[0][i][3] == -1 or len(c) < 5:
                continue
            area = cv2.contourArea(c)
            if area < 1500:
                continue
            (cx, cy), (d1, d2), ang = cv2.fitEllipse(c)
            fitted = math.pi * d1 * d2 / 4
            if not fitted or min(d1, d2) < 40:
                continue
            if 0.82 <= area / fitted <= 1.18:
                rings.append(((cx, cy), (d1, d2), ang))
    if not rings:
        # Partial ring: forest or a crossing arrow breaks the loop, so there is no hole.
        # Fit each dark arc on its own and keep it only if the resulting ellipse's
        # PERIMETER is largely painted — a scale-free test that does not care how much
        # other dark clutter the frame holds.
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
            poly = cv2.ellipse2Poly((round(cx), round(cy)),
                                    (round(d1 / 2), round(d2 / 2)), round(ang), 0, 360, 5)
            inside = [(0 <= x < probe.shape[1] and 0 <= y < probe.shape[0]) for x, y in poly]
            if not any(inside):
                continue
            hit = sum(1 for (x, y), ok in zip(poly, inside) if ok and probe[y, x])
            if hit / len(poly) >= 0.55:
                rings.append(((cx, cy), (d1, d2), ang))
                break
    if rings:
        fam["ellipse"] = len(rings)
        ring_mask = np.zeros(dark.shape, np.uint8)
        for e in rings:
            cv2.ellipse(ring_mask, e, 255, 6)
        masks.append(ring_mask)
    return fam, masks


def main():
    AIRES.mkdir(parents=True, exist_ok=True)
    vpath = AIRES / "verdicts.json"
    verdicts = json.loads(vpath.read_text()) if vpath.exists() else {}
    inventory = json.loads((WORK / "inventory.json").read_text())
    todo = []
    for f in inventory:
        photos = [Path(m.get("url", "")).name for m in (f.get("media") or [])
                  if "Aires" in (m.get("source") or "") and (PHOTOS / Path(m.get("url", "")).name).exists()]
        if photos:
            todo.append((f, photos))
    print(f"{len(todo)} fields carry Guide photos", flush=True)
    for f, photos in todo:
        fid = f["id"]
        if fid in verdicts:
            continue
        if f.get("kind") == "airfield":
            verdicts[fid] = {"name": f["name"], "verdict": "skip-airfield-osm-tier",
                             "photos": photos}
            continue
        row = {"name": f["name"], "photos": photos, "views": []}
        for name in photos:
            img = cv2.imread(str(PHOTOS / name))
            framed = is_framed(img)
            fam, masks = detect_families(img, framed)
            view = {"photo": name, "framed": framed, "families": fam}
            try:
                cur_path = AIRES / f"{fid}_current.jpg"
                if not cur_path.exists():
                    fv.ortho_crop(f.get("lat") or f["latitude"],
                                  f.get("lon") or f["longitude"], 1800, cur_path, "FR")
                cur = cv2.imread(str(cur_path))
                try:
                    _, stats = tc.register(img, cur, framed, masks, name,
                                           prescales=(1, 1.5, 2, 3, 4))
                except RuntimeError:
                    # feature-starved frames (half lake, uniform forest) register against
                    # a wider crop of the same datum — Prunieres needs this
                    wide_path = AIRES / f"{fid}_wide.jpg"
                    if not wide_path.exists():
                        fv.ortho_crop(f.get("lat") or f["latitude"],
                                      f.get("lon") or f["longitude"], 4500, wide_path, "FR")
                    _, stats = tc.register(img, cv2.imread(str(wide_path)), framed, masks,
                                           f"{name}(wide)", prescales=(1, 1.5, 2, 3, 4))
                    stats["via"] = "wide 4500 m crop"
                view["registration"] = stats
            except Exception as err:  # noqa: BLE001 - verdict rows carry failures
                view["registration_error"] = str(err)[:200]
            row["views"].append(view)
        good_reg = any("registration" in v for v in row["views"])
        any_fam = any(v["families"] for v in row["views"])
        row["verdict"] = ("ready" if good_reg and any_fam else
                          "no-annotation-found" if good_reg else
                          "registration-failed" if any_fam else "nothing")
        verdicts[fid] = row
        vpath.write_text(json.dumps(verdicts, indent=1))
        print(f"{fid} {f['name']}: {row['verdict']} "
              f"{[v['families'] for v in row['views']]}", flush=True)
    from collections import Counter
    print(Counter(v["verdict"] for v in verdicts.values()))


if __name__ == "__main__":
    main()
