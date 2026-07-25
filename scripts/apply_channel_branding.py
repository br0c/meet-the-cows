#!/usr/bin/env python3
"""Re-brand an assembled site as a non-production channel, in place.

Two copies of this app are meant to be installed on the same phone at the same time: the one a
pilot flies with, and the experimental build. If they look alike on the home screen, the wrong
one gets opened at the wrong moment — so the channel build gets its own icon colour, its own
name, and its own theme colour, and none of that is a judgement call made twice in two places.

Run against the assembled output directory, not the repo:

  python scripts/apply_channel_branding.py --dir dist/site --channel next
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Matches icons/next/ produced by scripts/render_icons.mjs. Kept in step by hand: the icons are
# committed artefacts and change roughly never.
CHANNEL_COLOUR = "#b45309"
# Matches the channel icon's ground, which is LIGHT rather than amber — see scripts/render_icons.mjs
# for why iOS forces that. Splash and icon should not disagree about what this build looks like.
CHANNEL_BACKGROUND = "#f8fafc"
ICON_FILES = ("icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png")


def _variant_path(src: str, variant: str) -> str:
    """icons/icon-192.png -> icons/<variant>/icon-192.png, leaving anything else alone."""
    if not src.startswith("icons/") or src.startswith(f"icons/{variant}/"):
        return src
    return f"icons/{variant}/{src[len('icons/'):]}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Assembled site directory to re-brand")
    parser.add_argument("--channel", required=True, help="Channel label, e.g. 'next' or a branch name")
    parser.add_argument("--variant", default="next",
                        help="Icon variant directory under icons/ to promote. Default 'next'.")
    args = parser.parse_args()

    site = Path(args.dir)
    label = args.channel.strip()
    if not label:
        print("--channel must not be empty", file=sys.stderr)
        sys.exit(1)

    # Icons are referenced at their own PATH rather than copied over the production names.
    # Copying kept the URL identical between the two builds, and iOS caches a home-screen icon per
    # URL in a cache that survives uninstalling — so the channel inherited whatever the phone had
    # already rasterised for that address, and no amount of correcting the bytes could dislodge it.
    # A path it has never requested has nothing cached against it.
    variant_dir = site / "icons" / args.variant
    missing = [n for n in ICON_FILES if not (variant_dir / n).is_file()]
    if missing:
        print(f"::warning::{args.variant} icons missing: {', '.join(missing)}", file=sys.stderr)
    print(f"icons referenced from icons/{args.variant}/", file=sys.stderr)

    manifest_path = site / "manifest.webmanifest"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        # short_name is what ends up under the icon, so it carries the label; keep it short enough
        # that a phone does not truncate the part that distinguishes it.
        manifest["name"] = f"Meet The Cows ({label})"
        manifest["short_name"] = f"MTC {label}"
        manifest["theme_color"] = CHANNEL_COLOUR
        # background_color too, not just theme_color: it paints the splash screen and is what a
        # platform composites an icon over. Leaving it at production's navy is how an amber icon
        # ends up reading navy on an iOS home screen.
        manifest["background_color"] = CHANNEL_BACKGROUND
        # A distinct id as well: identity is what a platform uses to decide whether this is the
        # app it already knows. The origins differ, so this is belt and braces — but the whole
        # problem here was a platform reusing something it should not have.
        manifest["id"] = f"/?channel={label}"
        for icon in manifest.get("icons", []):
            icon["src"] = _variant_path(icon.get("src", ""), args.variant)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
        print(f"manifest: {manifest['short_name']}, theme {CHANNEL_COLOUR}, background {CHANNEL_BACKGROUND}",
              file=sys.stderr)

    index_path = site / "index.html"
    if index_path.is_file():
        html = index_path.read_text(encoding="utf-8")
        # iOS takes the home-screen name from this meta in preference to <title>.
        html = re.sub(r'(<meta name="apple-mobile-web-app-title" content=")[^"]*(")',
                      rf'\1MTC {label}\2', html)
        html = re.sub(r'(<meta name="theme-color" content=")[^"]*(")',
                      rf'\1{CHANNEL_COLOUR}\2', html)
        html = re.sub(r"(<title>)[^<]*(</title>)", rf"\1Meet The Cows ({label})\2", html)
        html = re.sub(r'(href=")(icons/[^"]+)(")',
                      lambda m: m.group(1) + _variant_path(m.group(2), args.variant) + m.group(3),
                      html)
        index_path.write_text(html, encoding="utf-8")
        print(f"index.html: title and theme-color set for '{label}'", file=sys.stderr)


if __name__ == "__main__":
    main()
