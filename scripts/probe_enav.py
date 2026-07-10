#!/usr/bin/env python3
"""CI probe v10: find where ENAV publishes the VAC for minor aerodromes.

The production fetch attached charts to 28 of 63 eligible Italian fields; aerodromes like
LILB (Alzate) and LILC (Calcinate del Pesce) have AD 2 pages but no chart matched the visual
filter, while ENAV does publish a VAC for them in a different tree (owner's report). v10:
 1. dumps EVERY PDF link on those AD 2 pages (was the name just missed by the filter?);
 2. maps the portal's other product trees from the public self-briefing page and the portal
    root, looking for a VFR/VAC product alongside AIP/AIP.
Runs only in GitHub Actions with ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD; prints structure
and statuses, never credentials.
"""
from __future__ import annotations

import datetime as dt
import os
import re
import sys
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import fetch_enav_charts as fec  # noqa: E402

SAMPLE_CODES = ("LILB", "LILC", "LILH")
SELF_BRIEFING = "https://www.enav.it/en/what-we-do/we-manage-italian-airspace/self-briefing"
STATIC_ROOT = "https://onlineservices.enav.it/enavWebPortalStatic"
# Likely product roots next to AIP/AIP (the cycle chooser lives at <product>/default.html).
ROOT_GUESSES = [
    f"{STATIC_ROOT}/AIP/VFR/default.html",
    f"{STATIC_ROOT}/VFR/VFR/default.html",
    f"{STATIC_ROOT}/VFR/default.html",
    f"{STATIC_ROOT}/GUIDAVFR/default.html",
    f"{STATIC_ROOT}/AIP/default.html",
    f"{STATIC_ROOT}/default.html",
]


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

        print("== portal entry + login ==")
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

        print("== 1. full PDF lists of the sample AD 2 pages ==")
        res = ctx.request.get(menu_url, timeout=90000)
        pages = fec.extract_ad2_pages(res.body().decode("utf-8", "replace"))
        for code in SAMPLE_CODES:
            href = pages.get(code)
            print(f"-- {code}: {href}")
            if not href:
                continue
            page_url = f"{fec.PORTAL}/{cycle}/eAIP/{urllib.parse.quote(href)}"
            page_res = ctx.request.get(page_url, timeout=90000)
            if page_res.status != 200:
                print(f"   page -> HTTP {page_res.status}")
                continue
            links = fec.extract_pdf_links(page_res.body().decode("utf-8", "replace"), page_url)
            print(f"   {len(links)} PDF links (ALL, unfiltered):")
            for url in links:
                print("    ->", urllib.parse.unquote(url))

        print("== 2. self-briefing product links (public page) ==")
        try:
            sb = ctx.request.get(SELF_BRIEFING, timeout=60000)
            text = sb.body().decode("utf-8", "replace")
            print(f"   {sb.status}, {len(text):,}B")
            hrefs = sorted({h for h in re.findall(r'href="([^"]{8,200})"', text)
                            if "onlineservices" in h or "Static" in h or "vfr" in h.lower()
                            or "briefing" in h.lower() or "aip" in h.lower()})
            for h in hrefs[:40]:
                print("    ->", h)
        except Exception as error:
            print(f"   ERR {error}")

        print("== 3. product root guesses ==")
        for url in ROOT_GUESSES:
            try:
                res = ctx.request.get(url, timeout=45000)
                body = res.body()
                print(f"   {res.status} {len(body):>9,}B  {url}")
                if res.status == 200:
                    text = body.decode("utf-8", "replace")
                    for h in re.findall(r"href=['\"]([^'\"]{2,160})['\"]", text)[:15]:
                        print("        ->", h)
            except Exception as error:
                print(f"   ERR  {url}: {error}")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
