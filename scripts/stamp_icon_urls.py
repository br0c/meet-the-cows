#!/usr/bin/env python3
"""Stamp the app version onto icon URLs in an assembled site.

iOS caches a home-screen icon per URL, in a system cache that deleting the home-screen icon does
NOT clear. Re-installing from the same address therefore reuses whatever it rasterised the first
time — so a corrected icon can be served correctly, verified byte for byte, and still not appear
on the phone of the person who reported the problem.

Changing the URL is the only reliable way to make it look again. The version is enough: icons
only ever change alongside a release, and re-fetching a 6 KB PNG on upgrade costs nothing.

  python scripts/stamp_icon_urls.py --dir dist/site --version 0.9.0-beta
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Only the raster/vector icons a platform installs. og-image is excluded: it is fetched by link
# unfurlers that have no such cache and sometimes choke on query strings.
ICON_PATTERN = re.compile(r'(icons/(?:[\w-]+/)?(?:apple-touch-icon(?:-dark)?|icon-\d+|icon)\.(?:png|svg))(\?v=[^"\']*)?')


def stamp(value: str, version: str) -> str:
    return ICON_PATTERN.sub(lambda m: f"{m.group(1)}?v={version}", value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Assembled site directory")
    parser.add_argument("--version", required=True, help="App version to stamp")
    args = parser.parse_args()

    site = Path(args.dir)
    version = args.version.strip()
    if not version:
        print("--version must not be empty", file=sys.stderr)
        sys.exit(1)

    index_path = site / "index.html"
    if index_path.is_file():
        html = index_path.read_text(encoding="utf-8")
        stamped = stamp(html, version)
        index_path.write_text(stamped, encoding="utf-8")
        print(f"index.html: {len(ICON_PATTERN.findall(html))} icon reference(s) stamped", file=sys.stderr)

    manifest_path = site / "manifest.webmanifest"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for icon in manifest.get("icons", []):
            if "src" in icon:
                icon["src"] = stamp(icon["src"], version)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
        print(f"manifest: {len(manifest.get('icons', []))} icon src(s) stamped", file=sys.stderr)


if __name__ == "__main__":
    main()
