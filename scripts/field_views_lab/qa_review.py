#!/usr/bin/env python3
"""Automated review of the generated OSM views: flag the ones worth a human's eyes.

A few thousand views is past what anyone checks one at a time, and the failure that
matters is quiet — the view looks fine, it is simply drawn round the wrong strip. LSGS
Sion did exactly that: OSM maps a 98 m grass sliver 23 m from the recorded coordinate and
the 2 km paved runway further off, and picking the nearest drew a small box on the grass
beside the runway. Nothing about that render looks broken.

The checks, and why each one is trustworthy:

  imagery        no provider served the field, so there is no view.
  geometry       the matched runway has no usable length.
  better-runway  a much longer runway lay within the same search radius and nothing
                 explains passing over it. Re-reads the candidates the matcher saw and asks
                 whether the choice follows the rule; a shorter runway chosen deliberately
                 — Sion's glider strip over its asphalt — is not a finding.
  short-runway   an airfield drawn with a runway shorter than SHORT_M. Airfields do not
                 have 98 m runways; something else got matched.
  length-mismatch the drawn runway disagrees with the field's stated length by more than
                 MISMATCH_X either way. Weakest of the four and reported last, because the
                 pack's own figure is often wrong — Sion is recorded as 600 m for a runway
                 that is really about 2 km — so this one accuses the data as often as the
                 render, and is a hint rather than a verdict.

Reads matches.json and runways.json from the prepare step when they are present; without
them the two geometric checks are skipped and it still runs.

  qa_report.json    every finding, machine-readable
  qa_flagged.txt    field ids worth eyes, worst first
  qa/flagged/       copies of only the flagged views

    FIELD_VIEWS_WORK=work python3 qa_review.py
"""
import json
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import field_views as fv  # noqa: E402

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))

SEVERITY = {"imagery": 0, "better-runway": 1, "short-runway": 1, "geometry": 2,
            "length-mismatch": 3}

SHORT_M = 250.0
"""Below this, a runway drawn for an airfield is not that airfield's runway.

Sion's mis-picked grass sliver is 98 m. The shortest genuine airfield strips in the pack
are around 270 m (Langatte, 270 m), so the floor sits between the two and is deliberately
nearer the bad case: this check is meant to be quiet.
"""

MISMATCH_X = 2.5
BETTER_X = 1.5
"""How much longer a rival runway must be before not choosing it is a finding.

A little longer is noise — parallel strips, a runway mapped in two pieces. Half again as
long is a different runway, and Sion's rival is twenty times longer.
"""


def _load(name):
    p = WORK / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except ValueError:
        return None


def unexplained_choice(match, stated_m, ways_by_cell, radius=1000.0):
    """A much longer runway inside the radius that nothing justifies passing over.

    Re-derives the candidates from the same runway dump the matcher used, so this is a
    check on the CHOICE rather than a second opinion from somewhere else.

    A shorter runway is often the right answer and must not be flagged for it: LSGS Sion's
    560 m grass strip is deliberately drawn over its 1871 m asphalt because the field is
    recorded as 600 m and this pack is for glider pilots. So the finding is not "a longer
    runway exists" — that is true at every real aerodrome — but "a longer runway exists and
    the stated length does not explain choosing this one".
    """
    chosen = (match.get("osm") or {}).get("len") or 0.0
    base = (round(match["lat"], 1), round(match["lon"], 1))
    cands = []
    for dla in (-0.1, 0, 0.1):
        for dlo in (-0.2, -0.1, 0, 0.1, 0.2):
            for w in ways_by_cell.get((round(base[0] + dla, 1),
                                       round(base[1] + dlo, 1)), []):
                g = fv.runway_geometry(match, w)
                if g and g["dist"] <= radius:
                    cands.append(g)
    if not cands or not chosen:
        return None
    longest = max(cands, key=lambda g: g["len"])
    if longest["len"] <= BETTER_X * chosen:
        return None
    # Would the rule have chosen what was drawn? If so the choice is explained.
    picked = fv.pick_runway(cands, stated_m)
    if picked and abs((picked.get("len") or 0) - chosen) < 1.0:
        return None
    return longest


def check(index, matches, ways, inventory, findings):
    by_id = {m["id"]: m for m in (matches or [])}
    cells = {}
    for w in ways or []:
        if w.get("pts"):
            la, lo = w["pts"][0]
            cells.setdefault((round(la, 1), round(lo, 1)), []).append(w)

    for fid, row in index.items():
        name = row.get("name") or ""
        if not row.get("ok"):
            findings.append((fid, "imagery", name,
                             f"render failed: {str(row.get('note'))[:90]}"))
            continue
        drawn = row.get("len") or 0.0
        if not drawn:
            findings.append((fid, "geometry", name, "matched runway has no length"))
            continue

        field = (inventory or {}).get(fid) or {}
        stated = field.get("lengthM")
        match = by_id.get(fid)
        if match and cells:
            rival = unexplained_choice(match, float(stated) if stated else None, cells)
            if rival:
                findings.append((fid, "better-runway", name,
                                 f"drew {drawn:.0f} m at {match['osm']['dist']:.0f} m, but a "
                                 f"{rival['len']:.0f} m runway sits {rival['dist']:.0f} m "
                                 f"away and nothing explains skipping it"))

        if (field.get("kind") == "airfield" or (match or {}).get("kind") == "airfield") \
                and drawn < SHORT_M:
            findings.append((fid, "short-runway", name,
                             f"airfield drawn with a {drawn:.0f} m runway"))

        if stated:
            stated = float(stated)
            if stated and (drawn > MISMATCH_X * stated or stated > MISMATCH_X * drawn):
                findings.append((fid, "length-mismatch", name,
                                 f"drew {drawn:.0f} m against a stated {stated:.0f} m "
                                 f"(the pack's figure is often the wrong one)"))


def main():
    findings = []
    idx = WORK / "osm" / "out" / "index.json"
    if not idx.exists():
        print(f"no index at {idx}", flush=True)
        return 0
    index = json.loads(idx.read_text())
    matches = _load("matches.json")
    ways = _load("runways.json")
    inv = _load("inventory.json")
    inventory = {f["id"]: f for f in inv} if inv else {}
    if matches is None or ways is None:
        print("matches.json/runways.json absent — skipping the geometric checks", flush=True)

    check(index, matches, ways, inventory, findings)
    print(f"osm: {len(index)} views checked", flush=True)

    findings.sort(key=lambda t: (SEVERITY.get(t[1], 9), t[0]))
    (WORK / "qa_report.json").write_text(
        json.dumps([{"id": f, "check": c, "name": n, "detail": d}
                    for f, c, n, d in findings], indent=1))
    (WORK / "qa_flagged.txt").write_text(
        "\n".join(f"{c:15} {f} {n} — {d}" for f, c, n, d in findings) + "\n")

    counts = Counter(c for _, c, _, _ in findings)
    print(f"\n{len(findings)} findings: {dict(counts)}")
    for f, c, n, d in findings[:25]:
        print(f"  {c:15} {n or f} — {d}")

    flagged = {f for f, _, _, _ in findings}
    if flagged:
        review = WORK / "qa" / "flagged"
        review.mkdir(parents=True, exist_ok=True)
        src_dir = WORK / "osm" / "out"
        for fid in flagged:
            src = src_dir / f"final_{fid}.jpg"
            if src.exists():
                (review / f"final_{fid}.jpg").write_bytes(src.read_bytes())
        print(f"\nflagged views copied to {review}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
