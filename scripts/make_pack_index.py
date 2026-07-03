#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a tiny release index for Meet the Cows data packs.")
    parser.add_argument("--repo", required=True, help="GitHub repo in owner/name form, e.g. br0c/meet-the-cows")
    parser.add_argument("--release-tag", required=True, help="GitHub release tag, e.g. data-latest")
    parser.add_argument("--pack-id", required=True)
    parser.add_argument("--pack-name", required=True)
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    zip_path = args.zip
    if not zip_path.exists():
        raise SystemExit(f"Pack zip does not exist: {zip_path}")

    asset_name = zip_path.name
    base_url = f"https://github.com/{args.repo}/releases/download/{args.release_tag}"
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

    index = {
        "schemaVersion": 1,
        "updatedAt": now,
        "packs": [
            {
                "id": args.pack_id,
                "name": args.pack_name,
                "version": now[:10],
                "url": f"{base_url}/{asset_name}",
                "sha256Url": f"{base_url}/{asset_name}.sha256",
                "sha256": sha256_file(zip_path),
                "sizeBytes": zip_path.stat().st_size,
            }
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
