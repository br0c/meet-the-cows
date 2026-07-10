#!/usr/bin/env python3
"""CI probe v8: end-to-end dry-run of the Italian chart fetcher on sample aerodromes.

v1-v7 mapped the portal (IDCS login, cycle list on default.html, 11.8MB eAIP/menu.html tree,
per-aerodrome AD 2 pages carrying the chart PDF links, double-space quirk for uncertified
aerodromes). v8 exercises scripts/fetch_enav_charts.py's real functions against one certified
airport and two uncertified aerodromes, printing the selected chart names, sizes and merged
page counts — the go/no-go check before wiring the fetch into CI. Runs only in GitHub Actions
with ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD; prints structure and statuses, never credentials.
"""
from __future__ import annotations

import os
import re
import sys
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import fetch_enav_charts as fec  # noqa: E402

SAMPLE_CODES = ("LIPB", "LIDT", "LILH")  # Bolzano (certified), Trento + Voghera (uncertified)


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

        print("== cycle discovery ==")
        page.goto(f"{fec.PORTAL}/default.html", wait_until="domcontentloaded", timeout=60000)
        cycles = sorted({m.group(0) for m in fec.CYCLE_RE.finditer(page.content())})
        import datetime as dt
        cycle = fec.pick_cycle(cycles, dt.date.today())
        print(f"cycles {cycles} -> picked {cycle} (effective {fec.cycle_date(cycle)})")
        menu_url = f"{fec.PORTAL}/{cycle}/eAIP/menu.html"

        print("== login ==")
        page.goto(menu_url, wait_until="domcontentloaded", timeout=60000)
        if page.query_selector("input[type='password']"):
            for candidate in ("input[type='email']", "input[type='text']"):
                if page.query_selector(candidate):
                    page.fill(candidate, user)
                    break
            page.fill("input[type='password']", password)
            page.keyboard.press("Enter")
            try:
                page.wait_for_load_state("networkidle", timeout=45000)
            except Exception:
                pass
        print("logged in")

        print("== menu -> AD 2 pages ==")
        res = ctx.request.get(menu_url, timeout=90000)
        pages = fec.extract_ad2_pages(res.body().decode("utf-8", "replace"))
        print(f"{res.status}: {len(pages)} AD 2 aerodrome pages")
        print("codes:", " ".join(sorted(pages)))

        for code in SAMPLE_CODES:
            href = pages.get(code)
            print(f"== {code}: {href} ==")
            if not href:
                print("  (no AD 2 page)")
                continue
            page_url = f"{fec.PORTAL}/{cycle}/eAIP/{urllib.parse.quote(href)}"
            page_res = ctx.request.get(page_url, timeout=90000)
            if page_res.status != 200:
                print(f"  page -> HTTP {page_res.status}")
                continue
            links = fec.extract_pdf_links(page_res.body().decode("utf-8", "replace"), page_url)
            charts = fec.select_visual_charts(links)
            print(f"  {len(links)} PDF links, {len(charts)} selected as visual:")
            chunks = []
            for url in charts:
                name = urllib.parse.unquote(url).rsplit("/", 1)[-1]
                chart_res = ctx.request.get(url, timeout=90000)
                body = chart_res.body()
                print(f"   {chart_res.status} {len(body):>9,}B  {name}")
                if chart_res.status == 200:
                    chunks.append(body)
            if chunks:
                try:
                    merged = fec.merge_pdfs(chunks)
                    from pypdf import PdfReader
                    import io
                    n_pages = len(PdfReader(io.BytesIO(merged)).pages)
                    print(f"  merged: {len(merged):,}B, {n_pages} pages")
                except Exception as error:  # pypdf may be missing in older workflow revisions
                    print(f"  merge skipped: {error}")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
