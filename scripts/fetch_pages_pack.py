#!/usr/bin/env python3
"""Fetch the currently deployed static Pages data pack.

This is used by app-only deploys. GitHub Pages artifact deployments replace the
whole site, so an app-only artifact still needs a copy of packs/. Instead of
rebuilding the pack, fetch the existing deployed static pack and repackage it
with the updated app shell.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import posixpath
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


USER_AGENT = "MeetTheCowsPagesPackFetcher/1.0"


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch a deployed Meet the Cows Pages data pack.")
    parser.add_argument("--base-url", required=True, help="Deployed Pages base URL, e.g. https://user.github.io/meet-the-cows/")
    parser.add_argument("--pack-id", default="fr-alps")
    parser.add_argument("--output", required=True, type=Path, help="Output packs directory, e.g. data/packs")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    base_url = ensure_trailing_slash(args.base_url)
    pack_index_url = urllib.parse.urljoin(base_url, "packs/packs.json")
    pack_index = fetch_json(pack_index_url)
    packs = pack_index if isinstance(pack_index, list) else pack_index.get("packs", [])
    pack = next((item for item in packs if isinstance(item, dict) and item.get("id") == args.pack_id), None)
    if not pack:
        raise SystemExit(f"ERROR: pack {args.pack_id!r} not found in {pack_index_url}")

    manifest_url = urllib.parse.urljoin(base_url, str(pack.get("manifestUrl") or f"packs/{args.pack_id}/manifest.json"))
    manifest = fetch_json(manifest_url)
    fields_url = urllib.parse.urljoin(manifest_url, str(manifest.get("fieldsUrl") or "fields.json"))
    fields = fetch_json(fields_url)
    if not isinstance(fields, list):
        raise SystemExit(f"ERROR: fields file is not a list: {fields_url}")

    output_root = args.output
    pack_dir = output_root / args.pack_id
    output_root.mkdir(parents=True, exist_ok=True)
    pack_dir.mkdir(parents=True, exist_ok=True)

    write_json(output_root / "packs.json", pack_index)
    write_json(pack_dir / "manifest.json", manifest)
    write_json(pack_dir / "fields.json", fields)

    pack_root_url = manifest_url.rsplit("/", 1)[0] + "/"
    media = collect_media(fields, pack_root_url, pack_dir)
    print(f"Fetching {len(media)} media/doc files from {pack_root_url}", file=sys.stderr)

    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(download_file, url, target): (url, target) for url, target in media}
        for index, future in enumerate(as_completed(futures), start=1):
            url, target = futures[future]
            try:
                future.result()
            except Exception as exc:
                failures.append(f"{url} -> {target}: {exc}")
            if index % 50 == 0 or index == len(futures):
                print(f"  {index}/{len(futures)} files", file=sys.stderr)

    if failures:
        for failure in failures[:40]:
            print(f"ERROR: {failure}", file=sys.stderr)
        if len(failures) > 40:
            print(f"ERROR: ... {len(failures) - 40} more failures", file=sys.stderr)
        return 1

    print(f"Fetched deployed pack into {pack_dir}", file=sys.stderr)
    return 0


def ensure_trailing_slash(value: str) -> str:
    return value if value.endswith("/") else value + "/"


def fetch_json(url: str) -> Any:
    return json.loads(fetch_bytes(url).decode("utf-8"))


def fetch_bytes(url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            time.sleep(1 + attempt)
    raise RuntimeError(f"could not fetch {url}: {last_error}")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def collect_media(fields: list[Any], pack_root_url: str, pack_dir: Path) -> list[tuple[str, Path]]:
    media: dict[Path, str] = {}
    for field in fields:
        if not isinstance(field, dict):
            continue
        for item in field.get("media") or []:
            if not isinstance(item, dict):
                continue
            for key in ("url", "thumbnailUrl"):
                value = str(item.get(key) or "").strip()
                if not value:
                    continue
                url = urllib.parse.urljoin(pack_root_url, value)
                target = pack_dir / relative_pack_path(url, pack_root_url)
                media[target] = url
    return [(url, target) for target, url in sorted(media.items(), key=lambda pair: str(pair[0]))]


def relative_pack_path(url: str, pack_root_url: str) -> Path:
    parsed_url = urllib.parse.urlparse(url)
    parsed_root = urllib.parse.urlparse(pack_root_url)
    url_path = posixpath.normpath(urllib.parse.unquote(parsed_url.path))
    root_path = posixpath.normpath(urllib.parse.unquote(parsed_root.path))
    if not root_path.endswith("/"):
        root_path += "/"
    if not url_path.startswith(root_path):
        raise ValueError(f"media URL is outside pack root: {url}")
    relative = url_path[len(root_path):]
    if not relative or relative.startswith("../") or "/../" in f"/{relative}":
        raise ValueError(f"unsafe media path: {url}")
    return Path(*relative.split("/"))


def download_file(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        return
    data = fetch_bytes(url)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


if __name__ == "__main__":
    raise SystemExit(main())
