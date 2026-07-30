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
import read_labels  # noqa: E402
import shapes as sh  # noqa: E402
from aires_sweep import PHOTOS  # noqa: E402
from transfer_render import draw_arrow  # noqa: E402

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
AIRES = WORK / "aires"
OUT = AIRES / "out"
PXW, PXH = 975, 1300
MPP = 1800 / 975
DATUM = (487.5, 650.0)
RED = (226, 40, 25)


def annotations(img, photo_name=None):
    """Every drawn element in one photo, in this renderer's vocabulary.

    A thin adapter over shapes.py, which is the single implementation for both packs —
    the Aires guides and the APVV Pyrenees captures — so a fix reaches both instead of
    only the corpus it was found on. The extractors that used to live here were a second
    copy that had already drifted.
    """
    drawn, masks, style = sh.extract(img, labels=read_labels.load(photo_name)
                                     if photo_name else None)
    return dict(quads=drawn["strips"] + drawn["polygons"],
                rings=drawn["rings"],
                danger=drawn["danger"],
                arrows=drawn["arrows"],
                hazards=drawn["hazards"] + drawn["centrelines"],
                markers=drawn["markers"],
                circles=drawn["circles"],
                style=style), masks



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

    geom = {"quads": [], "rings": [], "danger": [], "runs": [],
            "hazards": [], "markers": [], "circles": []}
    regs = []
    for name in photos:
        img = cv2.imread(str(PHOTOS / name))
        if img is None:
            continue
        if not sh.is_aerial(img):
            continue                       # a ground-level photo has nothing to register
        ann, masks = annotations(img, name)
        framed = ann["style"] == sh.FRAMED
        if not any(ann[k] for k in ("quads", "rings", "danger", "arrows",
                                    "hazards", "markers", "circles")):
            continue
        # A measured arrow is a scale bar: the field's own lengthM over the arrow's pixel
        # length gives the old photo's ground resolution, which pins the transform's scale.
        # A measured arrow gives the old photo's ground scale — but only if it was
        # measured correctly. When the mask fragments (a label drawn across the shaft),
        # the derived prior is wrong, and as a FILTER it then rejects the true model:
        # Bayons' arrow read 77 px instead of ~200, yielding a prior of 1.84 that threw
        # away the correct 0.67 registration and left the field with no drawing at all.
        # So the prior is a rescue, never a gate — plain registration is tried first and
        # the prior only gets a turn when that finds nothing.
        expect = None
        if ann["arrows"] and f.get("lengthM"):
            longest = max(math.dist(*a) for a in ann["arrows"])
            if longest > 30:
                cand = (float(f["lengthM"]) / longest) / MPP
                expect = cand if 0.05 < cand < 20 else None
        attempts = [dict(expect_scale=None)]
        if expect:
            attempts.append(dict(expect_scale=expect))
        M = stats = None
        for kwargs in attempts:
            try:
                M, stats = tc.register(img, cur, framed, masks, name, **kwargs)
                break
            except RuntimeError:
                continue
        if M is None:
            wide_path = AIRES / f"{fid}_wide.jpg"
            if not wide_path.exists():
                fv.ortho_crop(lat, lon, 4500, wide_path, country)
            wide = cv2.imread(str(wide_path))
            for kwargs in ([dict(expect_scale=None)] +
                           ([dict(expect_scale=expect / 2.5)] if expect else [])):
                try:
                    Mw, stats = tc.register(img, wide, framed, masks,
                                            f"{name}(wide)", **kwargs)
                except RuntimeError:
                    continue
                k = (4500 / 975) / MPP
                C = np.array([[k, 0, DATUM[0] * (1 - k)], [0, k, DATUM[1] * (1 - k)],
                              [0, 0, 1]])
                M = (C @ np.vstack([Mw, [0, 0, 1]]))[:2]
                stats["via"] = "wide 4500 m crop"
                break
            if M is None:
                continue
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
        for axis in ann["hazards"]:
            geom["hazards"].append([px2m(p) for p in tc.apply_m(M, np.array(axis, np.float32))])
        # A marker is a point plus a radius; project the centre and scale the radius by
        # the transform, so a circled dam stays the size the guide drew it.
        scale = float(np.hypot(M[0, 0], M[0, 1]))
        for key in ("markers", "circles"):
            for cx, cy, radius in ann[key]:
                c = px2m(tc.apply_m(M, [[cx, cy]])[0])
                geom[key].append([c[0], c[1], round(radius * scale * MPP, 1)])
    return geom, regs


def render(f, geom, regs):
    from PIL import Image, ImageDraw
    fid = f["id"]
    lat = f.get("lat") or f["latitude"]
    lon = f.get("lon") or f["longitude"]
    country = f.get("country") or "FR"
    pts = [p for key in ("quads", "rings", "danger", "runs", "hazards")
           for shape in geom[key] for p in shape]
    pts += [(c[0], c[1]) for key in ("markers", "circles") for c in geom[key]]
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

    # Hazard lines: a cable is drawn the way the guide drew it, right across the view, so
    # a pilot sees what it crosses rather than a symbol beside it.
    for tail, head in geom["hazards"]:
        d.line([to_px(tail), to_px(head)], fill=RED + (255,), width=5)
        d.line([to_px(tail), to_px(head)], fill=(255, 235, 120, 255), width=2)

    # Obstacle marks keep the size the guide drew: a circled dam stays a circle round the
    # dam, and a dot stays a dot. No numbering and no legend — those were tried and are
    # unreadable in the air.
    for cx, cn_, radius in geom["circles"]:
        rpx = max(radius / mpp, 6)
        x, y = to_px((cx, cn_))
        d.ellipse([x - rpx, y - rpx, x + rpx, y + rpx], outline=RED + (255,), width=4)
    for cx, cn_, radius in geom["markers"]:
        rpx = max(radius / mpp, 5)
        x, y = to_px((cx, cn_))
        d.ellipse([x - rpx, y - rpx, x + rpx, y + rpx], fill=(255, 176, 32, 235),
                  outline=(60, 40, 10, 255), width=2)
    fv.draw_chrome(d, f["name"], crop["attribution"],
                   " · Annotations: Guide des Aires de Sécurité")
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        out_path, quality=90)
    tmp.unlink()
    return out_path


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # A bare number caps the run instead of naming fields, so a smoke test costs minutes
    # rather than the couple of hours a full tier of orthophoto fetching takes.
    args = sys.argv[1:]
    cap = int(args[0]) if len(args) == 1 and args[0].isdigit() else 0
    only = set() if cap else set(args)
    inventory = json.loads((WORK / "inventory.json").read_text())
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    todo = []
    for f in inventory:
        if fv.prefers_osm_view(f):
            continue      # OSM has surveyed runways; a drawing cannot beat that
        photos = [Path(m.get("url", "")).name for m in (f.get("media") or [])
                  if "Aires" in (m.get("source") or "")
                  and (PHOTOS / Path(m.get("url", "")).name).exists()]
        if photos and (not only or f["id"] in only):
            todo.append((f, photos))
    if cap:
        todo = todo[:cap]
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
                              "hazard_count": len(geom["hazards"]),
                              "run_lengths_m": [round(math.dist(*r)) for r in geom["runs"]],
                              # Largest drawn STRIP, in metres. QA uses it to spot terrain
                              # that passed for an annotation. Rings are excluded on
                              # purpose: one encircles the whole landable area and is
                              # meant to dwarf the usable strip.
                              "max_strip_m": round(max(
                                  [0] + [max(max(p[0] for p in s) - min(p[0] for p in s),
                                             max(p[1] for p in s) - min(p[1] for p in s))
                                         for k in ("quads", "danger")
                                         for s in geom[k]])),
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
