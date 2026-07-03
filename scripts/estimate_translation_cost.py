#!/usr/bin/env python3
"""Estimate the DeepL character cost of the next pack build WITHOUT spending any budget.

Run this BEFORE pushing (a push triggers the real build). It scrapes the streckenflug
entries and runs the exact note-building pipeline, but with DeepL swapped for a character
counter — so no API calls are made and nothing is billed. If a translation cache exists it
is honoured, so the estimate reflects only the *new* text the next build would translate.

Examples:
  python scripts/estimate_translation_cost.py                 # full, honours .cache
  python scripts/estimate_translation_cost.py --max-detail 30 # quick sample
Exit code 2 if the projected cost exceeds the remaining lifetime budget.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pack as bp  # noqa: E402


def current_usage() -> tuple[int, int] | None:
    key = os.environ.get("DEEPL_API_KEY", "")
    if not key:
        return None
    url = "https://api-free.deepl.com/v2/usage" if key.strip().endswith(":fx") else "https://api.deepl.com/v2/usage"
    try:
        request = urllib.request.Request(url, headers={"Authorization": f"DeepL-Auth-Key {key}"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        return int(data.get("character_count", 0)), int(data.get("character_limit", 0))
    except Exception as error:  # noqa: BLE001
        print(f"(DeepL /usage check failed: {error})", file=sys.stderr)
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--countries", nargs="+", default=["FR", "CH", "IT"])
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--max-detail", type=int, default=0, help="0 = all entries; set small for a quick sample")
    parser.add_argument("--cache", default=".cache/translation-cache.json", help="Translation cache to honour so the estimate is incremental")
    args = parser.parse_args()

    recorded = {"chars": 0, "calls": 0}

    def recorder(text: str) -> str:
        recorded["chars"] += len(text)
        recorded["calls"] += 1
        return "EN:" + text  # passthrough; note-building still works, but nothing is billed

    bp.deepl_translate = recorder  # no network, no spend

    cache_path = Path(args.cache)
    if cache_path.exists():
        bp.load_translation_cache(cache_path)
        print(f"Honouring {len(bp._TRANSLATION_CACHE)} cached translations from {cache_path} (incremental estimate)")
    else:
        print(f"No cache at {cache_path}: estimating a COLD first build (worst case)")

    scratch = Path(".cache/estimate")
    (scratch / "raw").mkdir(parents=True, exist_ok=True)
    (scratch / "media").mkdir(parents=True, exist_ok=True)

    usage = current_usage()
    started = time.time()
    fields = bp.load_streckenflug_fields(
        bp.STRECKENFLUG_LIST_URL,
        scratch / "raw",
        workers=args.workers,
        media_dir=scratch / "media",
        pack_id="estimate",
        countries=args.countries,
        max_detail=args.max_detail,
        include_images=False,
    )
    elapsed = time.time() - started
    field_count = max(len(fields), 1)
    limit = usage[1] if usage else 1_000_000

    print()
    print(f"Scanned {len(fields)} streckenflug fields in {elapsed:.0f}s")
    print(f"Projected NEW DeepL characters for the next build: {recorded['chars']:,}")
    print(f"  = {recorded['chars'] / limit * 100:.1f}% of the {limit:,}-char lifetime budget")
    print(f"  DeepL calls: {recorded['calls']}  |  avg {recorded['chars'] / field_count:.0f} chars/field")

    exit_code = 0
    if usage:
        used, limit = usage
        remaining = limit - used
        projected_pct = (used + recorded["chars"]) / limit * 100 if limit else 0
        print(f"Current usage: {used:,}/{limit:,} ({used / limit * 100:.1f}% used); after this build ~= {projected_pct:.1f}%")
        if recorded["chars"] > remaining:
            print("\nWARNING: projected cost EXCEEDS the remaining lifetime budget. Do not push.")
            exit_code = 2
    if exit_code == 0:
        print("\nOK: projected cost is within budget.")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
