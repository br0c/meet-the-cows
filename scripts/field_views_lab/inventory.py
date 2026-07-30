#!/usr/bin/env python3
"""Build the merged field inventory the view generators consume.

Reads every pack published on a data channel and unions their fields by id, so one file
describes the whole inventory regardless of how packs slice it. Written for CI, where the
alternative — rebuilding packs from source just to list fields — costs an hour.

    python3 inventory.py --channel dev --out work/inventory.json
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

BASE = "https://data.meetthecows.org"
USER_AGENT = "meet-the-cows field views (github.com/br0c/meet-the-cows)"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--channel", default="dev", help="'prod' or 'dev' (default dev)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    prefix = "" if args.channel == "prod" else f"{args.channel}/"
    index = get_json(f"{BASE}/{prefix}packs/packs.json")
    seen, merged = set(), []
    for pack in index["packs"]:
        fields = get_json(f"{BASE}/{prefix}packs/{pack['id']}/fields.json")
        fields = fields["fields"] if isinstance(fields, dict) else fields
        new = 0
        for f in fields:
            if f["id"] in seen:
                continue
            seen.add(f["id"])
            merged.append(f)
            new += 1
        print(f"{pack['id']}: {len(fields)} fields, {new} new", file=sys.stderr)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(merged))
    from collections import Counter
    print(f"{len(merged)} fields -> {args.out} "
          f"{dict(Counter(f.get('country') or '?' for f in merged))}", file=sys.stderr)


if __name__ == "__main__":
    main()
