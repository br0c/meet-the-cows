#!/usr/bin/env python3
"""CI probe v11: full census of chart selection across every AD 2 aerodrome page.

v10 found the gap: AD_2_SECONDARI aerodromes name their whole VAC "AERODROME LANDING CHART",
which the filter missed. With the widened filter, walk ALL AD 2 pages and aggregate (a) how
many charts each aerodrome would now get and (b) every PDF basename the filter still skips —
proving the selection is complete before the production refetch. Runs only in GitHub Actions
with ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD; prints structure and statuses, never credentials.
"""
from __future__ import annotations

import collections
import datetime as dt
import os
import re
import sys
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import fetch_enav_charts as fec  # noqa: E402


def main() -> int:
    user = os.environ.get("ENAV_ACCOUNT_ID", "")
    password = os.environ.get("ENAV_ACCOUNT_PASSWORD", "")
    if not user or not password:
        print("ERROR: credentials not set")
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        page.goto(f"{fec.PORTAL}/default.html", wait_until="domcontentloaded", timeout=60000)
        if fec.login_if_prompted(page, user, password):
            print("logged in (portal entry)")
        listing = ctx.request.get(f"{fec.PORTAL}/default.html", timeout=60000)
        cycles = sorted({m.group(0) for m in fec.CYCLE_RE.finditer(listing.body().decode("utf-8", "replace"))})
        cycle = fec.pick_cycle(cycles, dt.date.today())
        print(f"cycle {cycle}")
        menu_url = f"{fec.PORTAL}/{cycle}/eAIP/menu.html"
        page.goto(menu_url, wait_until="domcontentloaded", timeout=60000)
        if fec.login_if_prompted(page, user, password):
            print("logged in (eAIP)")

        res = ctx.request.get(menu_url, timeout=90000)
        pages = fec.extract_ad2_pages(res.body().decode("utf-8", "replace"))
        print(f"{len(pages)} AD 2 aerodrome pages")

        selected_counts: dict[str, int] = {}
        skipped: collections.Counter[str] = collections.Counter()
        subtree: collections.Counter[str] = collections.Counter()
        errors = 0
        for code in sorted(pages):
            page_url = f"{fec.PORTAL}/{cycle}/eAIP/{urllib.parse.quote(pages[code])}"
            try:
                page_res = ctx.request.get(page_url, timeout=90000)
                if page_res.status != 200:
                    raise RuntimeError(f"HTTP {page_res.status}")
            except Exception as error:  # noqa: BLE001
                errors += 1
                print(f"  {code}: page error {error}")
                continue
            links = fec.extract_pdf_links(page_res.body().decode("utf-8", "replace"), page_url)
            charts = set(fec.select_visual_charts(links))
            selected_counts[code] = len(charts)
            for url in links:
                decoded = urllib.parse.unquote(url)
                m = re.search(r"AD_2/([^/]+)/", decoded)
                if m:
                    subtree[m.group(1)] += 1
                if url not in charts:
                    skipped[decoded.rsplit("/", 1)[-1]] += 1

        zero = sorted(c for c, n in selected_counts.items() if n == 0)
        print(f"\naerodromes with charts: {sum(1 for n in selected_counts.values() if n)}"
              f" / {len(selected_counts)} (errors {errors})")
        print(f"zero-chart aerodromes: {' '.join(zero) or '(none)'}")
        print("AD_2 subtrees seen:", dict(subtree))
        print(f"\ntop skipped basenames ({len(skipped)} distinct):")
        for name, count in skipped.most_common(45):
            print(f"  {count:4d}  {name[:120]}")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
