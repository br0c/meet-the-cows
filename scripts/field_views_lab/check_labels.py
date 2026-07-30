#!/usr/bin/env python3
"""Cross-check what the model read against what the pixels show.

The lettering and the drawing are two independent records of the same run, so they can be
made to check each other. The model reads "275 m / 15.2°"; the CV measures an ink stroke at
14.9°. Agreement is strong evidence for both. Disagreement is the thing to look at, and it
is the only thing worth a human's attention across 63 photos.

These captures are north-up, so a drawn bearing and an image bearing are comparable
directly — 515 Lus letters 0.0° and 15.2° and its ink measures 0.0° and 14.9°.

    python3 check_labels.py            # triage every cached reading
    python3 check_labels.py --all      # show the agreements too

Reports, per label:
  MATCH    a stroke of the right kind sits at that bearing
  NO-GEOM  the guide lettered a run the extractor cannot find — a miss, which is safe:
           the run is simply not drawn. Worth knowing, never worth inventing.
  ORPHAN   a stroke with no label. Expected and harmless for ink (an unlabelled arrow is
           still an arrow); for a pale bar it is exactly the road that must not ship.
"""
import argparse
import math
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_labels  # noqa: E402
import shapes as sh  # noqa: E402
import white_arrows as wa  # noqa: E402

PHOTOS = read_labels.PHOTOS
TOL = 12.0


def _bearing(a, b):
    return math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1]))) % 360


def _err(one, two):
    """Difference between two bearings, as undirected lines."""
    return abs((one - two + 90) % 180 - 90)


def check(photo_name, labels):
    img = cv2.imread(str(PHOTOS / photo_name))
    if img is None:
        return [("ERROR", "unreadable photo")], []
    drawn, _masks, style = sh.extract(img)
    ink = [_bearing(*axis) for axis in drawn["arrows"]]
    pale = [b for _axis, _len, b in wa.white_bars(img)]

    rows, used_ink, used_pale = [], set(), set()
    for d in labels:
        target = float(d["bearing_deg"])
        want_pale = d.get("arrow") == "white"
        pool = pale if want_pale else ink
        used = used_pale if want_pale else used_ink
        best, best_err = None, TOL
        for i, b in enumerate(pool):
            if i in used:
                continue
            e = _err(b, target)
            if e < best_err:
                best, best_err = i, e
        label = f"{d['length_m']:.0f} m / {target:.1f}° ({d.get('arrow')})"
        if best is None:
            rows.append(("NO-GEOM", f"{label} — no {'pale bar' if want_pale else 'ink stroke'}"))
        else:
            used.add(best)
            rows.append(("MATCH", f"{label} vs {pool[best]:.1f}°  (err {best_err:.1f}°)"))

    orphans = []
    for i, b in enumerate(ink):
        if i not in used_ink:
            orphans.append(f"ink stroke at {b:.1f}° has no label")
    for i, b in enumerate(pale):
        if i not in used_pale:
            orphans.append(f"pale bar at {b:.1f}° has no label (a road, unless drawn)")
    return rows, orphans


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--all", action="store_true", help="show matches, not just problems")
    args = ap.parse_args()

    photos = sorted(p.name for p in PHOTOS.glob("*.jpg"))
    totals = {"MATCH": 0, "NO-GEOM": 0, "ERROR": 0}
    pale_orphans = 0
    read = 0
    for name in photos:
        labels = read_labels.load(name)
        if labels is None:
            continue
        read += 1
        rows, orphans = check(name, labels)
        for kind, _ in rows:
            totals[kind] = totals.get(kind, 0) + 1
        pale_orphans += sum(1 for o in orphans if o.startswith("pale bar"))
        interesting = [r for r in rows if r[0] != "MATCH"]
        if interesting or args.all:
            print(f"\n{name}")
            for kind, text in (rows if args.all else interesting):
                print(f"   {kind:8s} {text}")
            if args.all:
                for o in orphans:
                    print(f"   ORPHAN   {o}")

    print(f"\n{read} photo(s) read, {sum(totals.values())} label(s)")
    print(f"   MATCH   {totals['MATCH']}")
    print(f"   NO-GEOM {totals['NO-GEOM']}  (safe: the run is simply not drawn)")
    print(f"   pale bars with no label: {pale_orphans}  (each one a road that did not ship)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
