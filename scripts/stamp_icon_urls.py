#!/usr/bin/env python3
"""Stamp a content hash onto icon URLs in an assembled site.

Caches key on the URL — Cloudflare's edge, the browser's, and iOS's home-screen icon cache, which
deleting the icon does not clear. An icon corrected in place therefore keeps its old address and
nobody sees the correction.

The hash is of the icon's own bytes, not the app version. Versions are deliberately not bumped for
every change, so a version stamp is exactly the wrong key: it would sit still across the icon edits
that most need busting — which is precisely what happened here. A content hash moves when, and only
when, the picture actually changes.

  python scripts/stamp_icon_urls.py --dir dist/site
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

# Only the raster/vector icons a platform installs. og-image is excluded: it is fetched by link
# unfurlers that have no such cache and sometimes choke on query strings.
ICON_PATTERN = re.compile(r'(icons/(?:[\w-]+/)?(?:apple-touch-icon(?:-dark)?|icon-\d+|icon)\.(?:png|svg))(\?v=[^"\']*)?')


def _digest(site: Path, relative: str, cache: dict[str, str]) -> str:
    """Short content hash of an icon file, or 'missing' so a broken reference is visible."""
    if relative not in cache:
        path = site / relative
        cache[relative] = (hashlib.sha256(path.read_bytes()).hexdigest()[:10]
                           if path.is_file() else "missing")
    return cache[relative]


def stamp(value: str, site: Path, cache: dict[str, str]) -> str:
    return ICON_PATTERN.sub(lambda m: f"{m.group(1)}?v={_digest(site, m.group(1), cache)}", value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Assembled site directory")
    args = parser.parse_args()

    site = Path(args.dir)
    cache: dict[str, str] = {}

    index_path = site / "index.html"
    if index_path.is_file():
        html = index_path.read_text(encoding="utf-8")
        stamped = stamp(html, site, cache)
        index_path.write_text(stamped, encoding="utf-8")
        print(f"index.html: {len(ICON_PATTERN.findall(html))} icon reference(s) stamped", file=sys.stderr)

    manifest_path = site / "manifest.webmanifest"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for icon in manifest.get("icons", []):
            if "src" in icon:
                icon["src"] = stamp(icon["src"], site, cache)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
        print(f"manifest: {len(manifest.get('icons', []))} icon src(s) stamped", file=sys.stderr)
    for relative, digest in sorted(cache.items()):
        print(f"  {relative} -> {digest}", file=sys.stderr)


if __name__ == "__main__":
    main()
