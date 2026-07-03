#!/usr/bin/env python3
import argparse
import datetime as dt
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Write a static packs.json index for GitHub Pages.")
    parser.add_argument("--pack-id", required=True)
    parser.add_argument("--pack-name", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    index = {
        "schemaVersion": 1,
        "updatedAt": now,
        "packs": [
            {
                "id": args.pack_id,
                "name": args.pack_name,
                "manifestUrl": f"packs/{args.pack_id}/manifest.json",
            }
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
