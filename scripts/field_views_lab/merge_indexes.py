#!/usr/bin/env python3
"""Fold the per-shard indexes into one.

Rendering runs as one job per country so an outage costs only its own shard, and each
shard writes index-<shard>.json to avoid parallel jobs clobbering a shared file. QA and
the contact sheets want the whole set, so this merges them — and reports the per-shard
counts, which is the first thing to look at when a run comes back short.

    FIELD_VIEWS_WORK=work python3 merge_indexes.py
"""
import json
import os
import sys
from pathlib import Path

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))


def main():
    total = 0
    for tier in ("osm",):
        out = WORK / tier / "out"
        if not out.is_dir():
            continue
        shards = sorted(out.glob("index-*.json"))
        merged_path = out / "index.json"
        merged = json.loads(merged_path.read_text()) if merged_path.exists() else {}
        for shard in shards:
            try:
                rows = json.loads(shard.read_text())
            except json.JSONDecodeError as err:      # a shard killed mid-write
                print(f"  {shard.name}: unreadable ({err}) — skipped", file=sys.stderr)
                continue
            print(f"  {shard.name}: {len(rows)} rows")
            merged.update(rows)
        views = len(list(out.glob("final_*.jpg")))
        if shards or merged:
            merged_path.write_text(json.dumps(merged, indent=1))
        print(f"{tier}: {len(merged)} index rows, {views} rendered views"
              + (f" (from {len(shards)} shard(s))" if shards else ""))
        # A gap here means views exist with no index row, or rows with no view — both are
        # worth seeing before QA runs on them.
        if merged and views and abs(views - len(merged)) > 0:
            print(f"  note: {abs(views - len(merged))} mismatch between views and rows",
                  file=sys.stderr)
        total += len(merged)
    print(f"{total} index rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
