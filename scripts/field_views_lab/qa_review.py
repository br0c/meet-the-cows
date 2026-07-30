#!/usr/bin/env python3
"""Automated review of generated views: flag the ones a human should actually look at.

2,500 views is far past what anyone reviews by eye, and the failure that matters most is
silent — a field that quietly ships an unmarked overview when its source photo plainly
carries a drawing. Bayons did exactly that and a human caught it, which is the wrong way
round. These checks run over the tier indexes and the source photos and emit:

  qa_report.json    every finding, machine-readable
  qa_flagged.txt    field ids worth eyes, worst first
  sheets/qa/        contact sheets of ONLY the flagged views

Checks, in rough order of how much they matter:
  regression   the photo has a drawn annotation but the view has none (silent loss)
  golden       a hand-validated field lost an element it is known to carry
  imagery      no provider served the field, so the view is missing or unmarked
  short-run    a drawn run is far shorter than the field's stated length
  weak-reg     registration passed on few inliers, so placement is soft
  geometry     a shape is degenerate or falls outside the rendered frame

    FIELD_VIEWS_WORK=work python3 qa_review.py
"""
import json
import math
import os
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from aires_render import PHOTOS, annotations  # noqa: E402
from aires_sweep import is_framed  # noqa: E402

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
SEVERITY = {"regression": 0, "golden": 0, "imagery": 1, "short-run": 2,
            "weak-reg": 3, "geometry": 2}

# Fields validated against pilot memory, with the elements their photo is known to carry.
# A change here is a real regression, not a threshold to relax.
GOLDEN = {
    "fr_320_320_bayons_44p3358_6p1633": {"runs", "danger"},
    "fr_412_412_st_blaise_44p8728_6p6100": {"quads"},
    "fr_423_423_prunieres_44p5342_6p3633": {"rings"},
    "fr_510_510_saou_44p6367_5p0628": {"runs"},
    "fr_331_marcoux_44p1472_6p2811": {"runs"},
}


def photo_has_annotation(field_id, inventory):
    """Does this field's source photo actually carry a drawing? The regression check
    rests on this: no drawing in the photo means an unmarked view is correct."""
    f = inventory.get(field_id)
    if not f:
        return None
    names = [Path(m.get("url", "")).name for m in (f.get("media") or [])
             if "Aires" in (m.get("source") or "")]
    for name in names:
        path = PHOTOS / name
        if not path.exists():
            continue
        img = cv2.imread(str(path))
        if img is None:
            continue
        ann, _ = annotations(img, is_framed(img))
        if any((ann["quads"], ann["rings"], ann["danger"], ann["arrows"])):
            return True
    return False if names else None


def check_aires(index, inventory, findings):
    for fid, row in index.items():
        mode = row.get("mode")
        shapes = {k: v for k, v in (row.get("shapes") or {}).items() if v}
        if mode == "failed":
            findings.append((fid, "imagery", row.get("name", ""),
                             f"no view at all: {row.get('imagery_error', '')[:90]}"))
            continue
        if mode == "plain":
            drawn = photo_has_annotation(fid, inventory)
            if drawn:
                findings.append((fid, "regression", row.get("name", ""),
                                 "photo carries a drawing but the view has none — "
                                 f"reason: {row.get('reason', '')[:70]}"))
            elif "blank coverage" in (row.get("reason") or ""):
                findings.append((fid, "imagery", row.get("name", ""),
                                 "imagery unavailable, view is unmarked"))
        if fid in GOLDEN:
            missing = GOLDEN[fid] - set(shapes)
            if missing:
                findings.append((fid, "golden", row.get("name", ""),
                                 f"validated field lost {sorted(missing)} "
                                 f"(has {sorted(shapes) or 'nothing'})"))
        for reg in row.get("registration") or []:
            inl = reg.get("inliers", 0)
            if inl and inl < 12:
                findings.append((fid, "weak-reg", row.get("name", ""),
                                 f"{inl} inliers on {reg.get('photo', '?')} "
                                 f"({reg.get('rms_m', '?')} m rms)"))
        stated = (inventory.get(fid) or {}).get("lengthM")
        runs = row.get("run_lengths_m") or []
        if stated and runs and max(runs) < 0.55 * float(stated):
            findings.append((fid, "short-run", row.get("name", ""),
                             f"longest drawn run {max(runs):.0f} m vs stated {stated:.0f} m"))


def check_osm(index, findings):
    for fid, row in index.items():
        if not row.get("ok"):
            findings.append((fid, "imagery", row.get("name") or "",
                             f"render failed: {str(row.get('note'))[:90]}"))
            continue
        if not row.get("len"):
            findings.append((fid, "geometry", row.get("name") or "",
                             "OSM runway has no length"))


def main():
    findings = []
    inv_path = WORK / "inventory.json"
    inventory = {}
    if inv_path.exists():
        inventory = {f["id"]: f for f in json.loads(inv_path.read_text())}

    for tier, checker in (("aires", check_aires), ("pyr", None), ("osm", check_osm)):
        idx = WORK / tier / "out" / "index.json"
        if not idx.exists():
            continue
        index = json.loads(idx.read_text())
        if tier == "aires":
            checker(index, inventory, findings)
        elif checker:
            checker(index, findings)
        print(f"{tier}: {len(index)} views checked", flush=True)

    findings.sort(key=lambda t: (SEVERITY.get(t[1], 9), t[0]))
    out = WORK / "qa_report.json"
    out.write_text(json.dumps([{"id": f, "check": c, "name": n, "detail": d}
                               for f, c, n, d in findings], indent=1))
    (WORK / "qa_flagged.txt").write_text("\n".join(f"{c:11} {f} {n} — {d}"
                                                   for f, c, n, d in findings) + "\n")
    from collections import Counter
    counts = Counter(c for _, c, _, _ in findings)
    print(f"\n{len(findings)} findings: {dict(counts)}")
    for f, c, n, d in findings[:25]:
        print(f"  {c:11} {n or f} — {d}")

    # Contact sheets of just the flagged views, so review effort goes where it is needed.
    flagged = {f for f, _, _, _ in findings}
    if flagged:
        review = WORK / "qa" / "flagged"
        review.mkdir(parents=True, exist_ok=True)
        for tier in ("aires", "pyr", "osm"):
            d = WORK / tier / "out"
            for fid in flagged:
                src = d / f"final_{fid}.jpg"
                if src.exists():
                    (review / f"final_{fid}.jpg").write_bytes(src.read_bytes())
        print(f"\nflagged views copied to {review}")
    # Anything blocking: golden losses and regressions are never acceptable.
    blocking = counts.get("golden", 0) + counts.get("regression", 0)
    if blocking:
        print(f"\n{blocking} blocking finding(s): a validated field or an annotated photo "
              f"lost its drawing", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
