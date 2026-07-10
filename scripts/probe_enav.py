#!/usr/bin/env python3
"""CI probe v2: map how the ENAV eAIP enumerates aerodromes and their charts.

v1 proved the IDCS login and that authenticated PDF fetches work. v2 answers the remaining
design question for the Italian fetcher: where is the machine-readable AD 2 / chart index?
Runs only in GitHub Actions with ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD; prints structure
and statuses, never credentials.
"""
from __future__ import annotations

import os
import re

from playwright.sync_api import sync_playwright

CYCLE = "(A07-26)_2026_07_09"
BASE = f"https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/{CYCLE}"
EXAMPLE_PDF = (f"{BASE}/documents/Root/ENAV/Cartografia/AD/AD_2/AD_2_PRINCIPALI/LIBF/2-1/"
               "AERODROME%20CHART%20ICAO.pdf")
# Standard EUROCONTROL eAIP layouts + likely SPA data endpoints.
CANDIDATES = [
    f"{BASE}/html/index.html",
    f"{BASE}/html/index-en-GB.html",
    f"{BASE}/html/eAIP/IT-menu-en-GB.html",
    f"{BASE}/html/eAIP/IT-AD-2.en-GB.html",
    f"{BASE}/index.html",
    f"{BASE}/structure.json",
    f"{BASE}/documents.json",
    "https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/default.html",
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
        print("logged in, landed on:", page.url.split("?")[0][:100])

        print("== candidate index endpoints ==")
        for url in CANDIDATES:
            try:
                res = ctx.request.get(url, timeout=45000)
                body = res.body()
                kind = res.headers.get("content-type", "?")
                print(f"{res.status} {kind:32s} {len(body):>9,}B  {url}")
                if res.status == 200 and (b"html" in body[:200].lower() or "json" in kind):
                    text = body.decode("utf-8", "replace")
                    links = re.findall(r'(?:href|src)="([^"]{4,140})"', text)[:20]
                    for link in links:
                        print("     ->", link)
                    for m in re.findall(r'"[^"]*\.json[^"]*"', text)[:10]:
                        print("     json ref:", m)
            except Exception as error:
                print(f"ERR  {url}: {error}")

        print("== SPA network capture: load default.html and watch requests ==")
        seen: list[str] = []
        page.on("request", lambda r: seen.append(f"{r.method} {r.url}") if "enav" in r.url else None)
        try:
            page.goto("https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/default.html",
                      wait_until="networkidle", timeout=60000)
        except Exception as error:
            print("SPA load issue:", error)
        # give the SPA a moment to fetch its data
        page.wait_for_timeout(5000)
        for line in seen[:60]:
            print("  ", line[:170])
        print(f"({len(seen)} requests total)")

        print("== SPA DOM: links/frames after load ==")
        try:
            frames = [f.url[:120] for f in page.frames]
            print("frames:", frames)
            hrefs = page.eval_on_selector_all("a", "els => els.map(e => e.getAttribute('href')).filter(Boolean).slice(0, 40)")
            for h in hrefs:
                print("   a:", str(h)[:140])
        except Exception as error:
            print("DOM dump issue:", error)

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
