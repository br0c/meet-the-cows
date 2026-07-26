#!/usr/bin/env python3
"""Give the app's own code content-addressed filenames in an assembled site.

The shell is served no-store and is always fresh. Its code was not: `src/app.js` and friends went
out under fixed names on `max-age=0, must-revalidate`, and revalidation is answered by whichever
edge node the request lands on. For a few minutes after a deploy those nodes disagree — the same
URL returned two different bodies on alternating fetches — so a pilot could load a brand-new
index.html against the previous build's app.js. Nothing in that pairing is detectable at runtime;
it simply behaves like a version that never existed.

A content hash in the filename removes the failure rather than shortening the window: the new
shell asks for a URL the old build never published, so a stale node cannot answer it with
anything, and the two can no longer be mixed. It also lets the code be cached forever, which
must-revalidate never allowed.

Deliberately last in the build, after the channel rewrite and the icon stamp: hashing seals a
file's bytes, so anything that edits them has to have happened already.

  python scripts/hash_assets.py --dir dist/site
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

# Leaves first: an asset's hash has to cover the hashed names of everything it references, so
# whatever it imports must already have been renamed by the time we read its bytes.
ASSETS = [
    "src/glide-worker.js",
    "src/terrain.js",
    "styles.css",
    "config.js",
    "src/app.js",
]

# How each asset is spelled where it is referenced. Written out rather than pattern-matched: a
# regex that quietly matched nothing would reintroduce exactly the stale pairing this exists to
# prevent, and there are eleven references in total. Every one of these must be found.
REFERENCES = {
    "src/glide-worker.js": [
        ("src/app.js", "'glide-worker.js'"),
        ("service-worker.js", "u('src/glide-worker.js')"),
    ],
    "src/terrain.js": [
        ("src/app.js", "'./terrain.js'"),
        ("service-worker.js", "u('src/terrain.js')"),
    ],
    "styles.css": [
        ("index.html", 'href="styles.css"'),
        ("service-worker.js", "u('styles.css')"),
    ],
    "config.js": [
        ("index.html", 'src="config.js"'),
        ("service-worker.js", "u('config.js')"),
    ],
    "src/app.js": [
        ("index.html", 'src="src/app.js"'),
        ("service-worker.js", "u('src/app.js')"),
    ],
}

# index.html, the manifest and the service worker keep their fixed names — they are how a browser
# finds the app at all, and they are the files served no-store for that reason.
UNHASHED_REFERRERS = ["index.html", "service-worker.js"]


def hashed_name(path: Path) -> str:
    """`app.js` -> `app.<10 hex>.js`, from the bytes as they stand now."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
    return f"{path.stem}.{digest}{path.suffix}"


def rewrite(site: Path, referrer: str, literal: str, old_name: str, new_name: str) -> None:
    path = site / referrer
    if not path.is_file():
        raise SystemExit(f"hash_assets: {referrer} is missing — cannot rewrite {literal}")
    text = path.read_text(encoding="utf-8")
    if literal not in text:
        raise SystemExit(f"hash_assets: {referrer} does not contain {literal} — "
                         "the reference moved and this table did not follow it")
    path.write_text(text.replace(literal, literal.replace(old_name, new_name)), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Assembled site directory")
    args = parser.parse_args()
    site = Path(args.dir)

    renamed = {}
    for asset in ASSETS:
        source = site / asset
        if not source.is_file():
            raise SystemExit(f"hash_assets: {asset} is missing from {site}")
        new_name = hashed_name(source)
        for referrer, literal in REFERENCES[asset]:
            rewrite(site, referrer, literal, source.name, new_name)
        source.rename(source.with_name(new_name))
        renamed[asset] = str(Path(asset).with_name(new_name))
        print(f"{asset} -> {renamed[asset]}", file=sys.stderr)

    # A reference left pointing at a name that no longer exists is a blank page, and it would ship
    # green. Cheap to prove it did not happen: no old spelling survives anywhere that referred to
    # one, and nothing is still sitting under its pre-hash name.
    stale = []
    for referrer in UNHASHED_REFERRERS + list(renamed.values()):
        text = (site / referrer).read_text(encoding="utf-8")
        for asset in ASSETS:
            for where, literal in REFERENCES[asset]:
                if literal in text:
                    stale.append(f"{referrer}: {literal}")
    for asset in ASSETS:
        if (site / asset).exists():
            stale.append(f"{asset} still exists under its old name")
    if stale:
        raise SystemExit("hash_assets: unhashed references survived:\n  " + "\n  ".join(stale))

    print(f"hashed {len(ASSETS)} assets, no stale references", file=sys.stderr)


if __name__ == "__main__":
    main()
