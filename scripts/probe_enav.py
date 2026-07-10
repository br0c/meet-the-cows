#!/usr/bin/env python3
"""CI probe v6: dump the chart-PDF links of sample AD 2 aerodrome pages.

v5 decoded eAIP/menu.html (11.8MB XHTML, single-quoted hrefs): 107 aerodromes, one AD 2 page
each ("LI-AD 2 LIPB - BOLZANO 1-it-IT.html"), no PDF links in the menu itself. v6 fetches a
few AD 2 pages and dumps their PDF links to fix the fetcher's chart-name filter. Runs only in
GitHub Actions with ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD; prints structure and statuses,
never credentials.
"""
from __future__ import annotations

import collections
import os
import re
import urllib.parse

from playwright.sync_api import sync_playwright

CYCLE = "(A07-26)_2026_07_09"
BASE = f"https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/{CYCLE}"
EXAMPLE_PDF = (f"{BASE}/documents/Root/ENAV/Cartografia/AD/AD_2/AD_2_PRINCIPALI/LIBF/2-1/"
               "AERODROME%20CHART%20ICAO.pdf")


def fetch(ctx, url: str) -> tuple[int, bytes]:
    res = ctx.request.get(url, timeout=60000)
    return res.status, res.body()


def summarize_tree(text: str) -> None:
    """Dump the shape of whatever document tree the file encodes: PDF paths grouped by
    aerodrome, distinct chart basenames, and a couple of full sample branches."""
    pdf_refs = [re.sub(r"\?.*$", "", p)
                for p in re.findall(r"['\"]([^'\"]{4,260}?\.pdf(?:\?[^'\"]{0,120})?)['\"]", text, re.I)]
    print(f"  {len(pdf_refs)} .pdf refs, {len(set(pdf_refs))} unique")
    decoded = [urllib.parse.unquote(p.replace("\\\\", "/").replace("\\", "/")) for p in set(pdf_refs)]
    ad_refs = [p for p in decoded if "/AD_2" in p or "AD_2" in p]
    print(f"  {len(ad_refs)} under AD_2")
    by_code: dict[str, list[str]] = collections.defaultdict(list)
    for p in ad_refs:
        m = re.search(r"/(LI[A-Z]{2})/", p)
        if m:
            by_code[m.group(1)].append(p)
    print(f"  {len(by_code)} aerodromes with AD_2 PDFs: {' '.join(sorted(by_code))}")
    # Which subtree do codes sit in (PRINCIPALI vs MINORI vs other)?
    subtrees = collections.Counter(re.search(r"AD_2/([^/]+)/", p).group(1)
                                   for p in ad_refs if re.search(r"AD_2/([^/]+)/", p))
    print("  AD_2 subtrees:", dict(subtrees))
    # Distinct chart basenames tell us how to select "France-VAC-like" content.
    names = collections.Counter(p.rsplit("/", 1)[-1] for p in ad_refs)
    print("  top chart basenames:")
    for name, count in names.most_common(40):
        print(f"    {count:4d}  {name}")
    for code in sorted(by_code)[:2]:
        print(f"  full branch {code}:")
        for p in sorted(by_code[code]):
            print(f"    {p}")


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

        print("== login ==")
        page.goto(EXAMPLE_PDF, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("input[type='password']", timeout=30000)
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

        # v5 decoded the menu: single-quoted hrefs, one AD 2 page per aerodrome, e.g.
        # href='LI-AD 2 LIPB - BOLZANO 1-it-IT.html#AD-2-LIPB---BOLZANO-1'. The PDFs must be
        # linked from those pages — fetch a major and a minor one and dump their PDF links.
        print("== menu.html: AD 2 aerodrome pages ==")
        status, body = fetch(ctx, f"{BASE}/eAIP/menu.html")
        menu = body.decode("utf-8", "replace")
        pages: dict[str, str] = {}
        for href, code in re.findall(r"href='(LI-AD 2 (LI[A-Z]{2})[^']*?\.html)#", menu):
            pages.setdefault(code, href)
        print(f"  {status}: {len(pages)} aerodrome pages; sample: {list(pages.values())[:3]}")

        for code in ("LIPB", "LIDT", "LILH"):
            href = pages.get(code)
            print(f"== AD 2 page {code}: {href} ==")
            if not href:
                print("  (not in menu)")
                continue
            try:
                page_url = f"{BASE}/eAIP/{urllib.parse.quote(href)}"
                status, body = fetch(ctx, page_url)
                text = body.decode("utf-8", "replace")
                print(f"  {status}, {len(body):,}B")
                pdfs = sorted({re.sub(r"\?.*$", "", m)
                               for m in re.findall(r"href=['\"]([^'\"]{4,260}?\.pdf(?:\?[^'\"]{0,160})?)['\"]", text, re.I)})
                print(f"  {len(pdfs)} PDF links:")
                for p in pdfs[:30]:
                    print("   ->", urllib.parse.unquote(p))
            except Exception as error:
                print(f"  ERR {error}")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
