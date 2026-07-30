#!/usr/bin/env python3
"""Automated review of the generated OSM views: flag the ones worth a human's eyes.

A few thousand views is past what anyone checks one at a time, so this reads the tier
index and reports only what looks wrong:

  qa_report.json    every finding, machine-readable
  qa_flagged.txt    field ids worth eyes, worst first
  qa/flagged/       copies of only the flagged views

Checks:
  imagery   no provider served the field, so there is no view
  geometry  the OSM runway has no usable length

    FIELD_VIEWS_WORK=work python3 qa_review.py
"""
import json
import os
from collections import Counter
from pathlib import Path

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
SEVERITY = {"imagery": 0, "geometry": 1}


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
    idx = WORK / "osm" / "out" / "index.json"
    if idx.exists():
        index = json.loads(idx.read_text())
        check_osm(index, findings)
        print(f"osm: {len(index)} views checked", flush=True)
    else:
        print(f"no index at {idx}", flush=True)

    findings.sort(key=lambda t: (SEVERITY.get(t[1], 9), t[0]))
    (WORK / "qa_report.json").write_text(
        json.dumps([{"id": f, "check": c, "name": n, "detail": d}
                    for f, c, n, d in findings], indent=1))
    (WORK / "qa_flagged.txt").write_text(
        "\n".join(f"{c:9} {f} {n} — {d}" for f, c, n, d in findings) + "\n")

    counts = Counter(c for _, c, _, _ in findings)
    print(f"\n{len(findings)} findings: {dict(counts)}")
    for f, c, n, d in findings[:25]:
        print(f"  {c:9} {n or f} — {d}")

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
