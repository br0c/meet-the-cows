#!/usr/bin/env python3
"""Separate the two ways a transfer can be wrong, per field.

A bad view has exactly two possible causes, and the render alone cannot tell them apart:

  extraction — the shapes taken off the old photo are not the shapes the Guide drew
               (terrain read as a ring, an arrow measured as a fragment, roofs read
               as a strip)
  placement  — the shapes are right but the old photo was registered onto the current
               imagery incorrectly, so correct shapes land in the wrong place

For each field this writes two verification images, which answer the question directly:

  diag_<id>_trace.jpg   extracted geometry drawn back onto the OLD photo. If this is
                        wrong, extraction is at fault and registration is irrelevant.
  diag_<id>_blend.jpg   old photo warped onto the current crop, half-blended and in
                        alternating bands. If features line up across the bands,
                        placement is sound.

    FIELD_VIEWS_WORK=work python3 aires_diagnose.py <field-id> [...]
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
from aires_render import MPP, annotations  # noqa: E402
import shapes as sh  # noqa: E402
from aires_sweep import PHOTOS  # noqa: E402

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
OUT = WORK / "aires" / "diag"
MAGENTA = (255, 0, 255)


def trace(img, ann, path):
    vis = img.copy()
    for quad in ann["quads"]:
        cv2.polylines(vis, [quad.astype(np.int32)], True, MAGENTA, 2)
    for ring in ann["rings"]:
        cv2.polylines(vis, [ring.astype(np.int32)], True, (0, 255, 255), 2)
    for quad in ann["danger"]:
        cv2.polylines(vis, [np.asarray(quad, np.int32)], True, (0, 128, 255), 2)
    for a, b in ann["arrows"]:
        cv2.line(vis, tuple(map(round, a)), tuple(map(round, b)), (255, 255, 0), 2)
        cv2.circle(vis, tuple(map(round, a)), 5, (255, 255, 0), 2)
    cv2.imwrite(str(path), vis)


def diagnose(field, photos):
    fid = field["id"]
    lat = field.get("lat") or field["latitude"]
    lon = field.get("lon") or field["longitude"]
    country = field.get("country") or "FR"
    cur_path = WORK / "aires" / f"{fid}_current.jpg"
    if not cur_path.exists():
        cur_path.parent.mkdir(parents=True, exist_ok=True)
        fv.ortho_crop(lat, lon, 1800, cur_path, country)
    cur = cv2.imread(str(cur_path))

    for n, name in enumerate(photos):
        img = cv2.imread(str(PHOTOS / name))
        if img is None:
            continue
        ann, masks = annotations(img)
        framed = ann["style"] == sh.FRAMED
        counts = {k: len(ann[k]) for k in ("quads", "rings", "danger", "arrows")}
        arrow_px = [round(math.dist(*a)) for a in ann["arrows"]]
        trace(img, ann, OUT / f"diag_{fid}_{n}_trace.jpg")
        verdict = ""
        try:
            M, stats = tc.register(img, cur, framed, masks, name)
            tc.blend_check(img, cur, M, OUT / f"diag_{fid}_{n}_blend.jpg")
            verdict = (f"registered {stats['inliers']} inl {stats['rms_m']} m rms "
                       f"scale {stats['scale']}")
        except RuntimeError as err:
            verdict = f"REGISTRATION FAILED: {str(err)[:70]}"
        print(f"  {name}: {counts} arrows_px={arrow_px} | {verdict}", flush=True)


def main():
    ids = sys.argv[1:]
    if not ids:
        print(__doc__)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    inventory = {f["id"]: f for f in json.loads((WORK / "inventory.json").read_text())}
    for fid in ids:
        field = inventory.get(fid)
        if not field:
            print(f"{fid}: not in inventory")
            continue
        photos = [Path(m.get("url", "")).name for m in (field.get("media") or [])
                  if "Aires" in (m.get("source") or "")
                  and (PHOTOS / Path(m.get("url", "")).name).exists()]
        print(f"{fid} {field.get('name')} — {len(photos)} photo(s), "
              f"stated {field.get('lengthM')} m")
        diagnose(field, photos)
    print(f"\nverification images in {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
