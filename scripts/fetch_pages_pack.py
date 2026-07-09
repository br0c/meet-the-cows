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
    parser = argparse.ArgumentParser(description="Fetch the deployed Meet the Cows Pages data packs (all packs + shared media).")
    parser.add_argument("--base-url", required=True, help="Deployed Pages base URL, e.g. https://user.github.io/meet-the-cows/")
    parser.add_argument("--output", required=True, type=Path, help="Output packs directory, e.g. data/packs")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    base_url = ensure_trailing_slash(args.base_url)
    packs_root_url = urllib.parse.urljoin(base_url, "packs/")
    pack_index = fetch_json(urllib.parse.urljoin(packs_root_url, "packs.json"))
    packs = pack_index if isinstance(pack_index, list) else pack_index.get("packs", [])
    if not packs:
        raise SystemExit(f"ERROR: no packs listed in {packs_root_url}packs.json")

    output_root = args.output
    output_root.mkdir(parents=True, exist_ok=True)
    write_json(output_root / "packs.json", pack_index)

    media: dict[Path, str] = {}  # target path -> URL, deduped so shared media is fetched once
    for pack in packs:
        if not isinstance(pack, dict) or not pack.get("id"):
            continue
        pack_id = str(pack["id"])
        manifest_url = urllib.parse.urljoin(base_url, str(pack.get("manifestUrl") or f"packs/{pack_id}/manifest.json"))
        manifest = fetch_json(manifest_url)
        pack_root_url = manifest_url.rsplit("/", 1)[0] + "/"
        fields_url = urllib.parse.urljoin(pack_root_url, str(manifest.get("fieldsUrl") or "fields.json"))
        fields = fetch_json(fields_url)
        if not isinstance(fields, list):
            raise SystemExit(f"ERROR: fields file is not a list: {fields_url}")

        pack_dir = output_root / pack_id
        pack_dir.mkdir(parents=True, exist_ok=True)
        write_json(pack_dir / "manifest.json", manifest)
        write_json(pack_dir / "fields.json", fields)
        for name in ("state.json", "translation-cache.json"):  # small side files, best-effort
            try:
                (pack_dir / name).write_bytes(fetch_bytes(urllib.parse.urljoin(pack_root_url, name)))
            except Exception:
                pass

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
                    rel = packs_relative_path(url, packs_root_url)
                    if rel is not None:
                        media[output_root / rel] = url

    items = [(url, target) for target, url in sorted(media.items(), key=lambda pair: str(pair[0]))]
    print(f"Fetching {len(items)} media/doc files (deduped across {len(packs)} packs)", file=sys.stderr)

    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(download_file, url, target): (url, target) for url, target in items}
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

    print(f"Fetched {len(packs)} deployed packs into {output_root}", file=sys.stderr)
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


def packs_relative_path(url: str, packs_root_url: str) -> Path | None:
    """Path of `url` relative to the packs/ root, so a shared file (packs/_shared/media/…) and a
    per-pack file (packs/<id>/media/…) both land under the output packs dir. None when the URL is
    outside packs/ or the relative path is unsafe."""
    parsed_url = urllib.parse.urlparse(url)
    parsed_root = urllib.parse.urlparse(packs_root_url)
    url_path = posixpath.normpath(urllib.parse.unquote(parsed_url.path))
    root_path = posixpath.normpath(urllib.parse.unquote(parsed_root.path))
    if not root_path.endswith("/"):
        root_path += "/"
    if not url_path.startswith(root_path):
        return None
    relative = url_path[len(root_path):]
    if not relative or ".." in relative.split("/"):
        return None
    return Path(*relative.split("/"))


def download_file(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        return
    data = fetch_bytes(url)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


if __name__ == "__main__":
    raise SystemExit(main())
