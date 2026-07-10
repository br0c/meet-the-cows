#!/usr/bin/env python3
"""CI probe: validate the ENAV eAIP login flow and map the static chart URL structure.

Runs only in GitHub Actions (workflow_dispatch) with ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD
from repo secrets. Prints structure findings and HTTP statuses — never the credentials.
Artifacts: a screenshot of the (unfilled) login page for flow debugging.
"""
from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

EXAMPLE_PDF = ("https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/"
               "(A07-26)_2026_07_09/documents/Root/ENAV/Cartografia/AD/AD_2/"
               "AD_2_PRINCIPALI/LIBF/2-1/AERODROME%20CHART%20ICAO.pdf")
# Candidate index/listing URLs to map how aerodromes and their charts can be enumerated.
PROBE_URLS = [
    EXAMPLE_PDF,
    EXAMPLE_PDF.rsplit("/", 1)[0] + "/",                     # 2-1 folder
    EXAMPLE_PDF.rsplit("/", 2)[0] + "/",                     # LIBF folder
    EXAMPLE_PDF.rsplit("/", 3)[0] + "/",                     # AD_2_PRINCIPALI folder
    EXAMPLE_PDF.rsplit("/", 4)[0] + "/",                     # AD_2 folder
    "https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/",
    "https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/(A07-26)_2026_07_09/",
    "https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/(A07-26)_2026_07_09/documents/",
]


def main() -> int:
    user = os.environ.get("ENAV_ACCOUNT_ID", "")
    password = os.environ.get("ENAV_ACCOUNT_PASSWORD", "")
    if not user or not password:
        print("ERROR: ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD not set")
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        print("== step 1: hit the example PDF anonymously (expect SSO redirect) ==")
        page.goto(EXAMPLE_PDF, wait_until="domcontentloaded", timeout=60000)
        print("landed on:", page.url.split("?")[0])
        page.screenshot(path="enav-login-page.png")

        print("== step 2: locate login form ==")
        page.wait_for_selector("input[type='password']", timeout=30000)
        inputs = page.eval_on_selector_all(
            "input", "els => els.map(e => ({type: e.type, name: e.name, id: e.id}))")
        print("inputs on login page:", inputs)
        user_sel = None
        for candidate in ("input[type='email']", "input[type='text']", "input[name*='user' i]", "input[id*='user' i]"):
            if page.query_selector(candidate):
                user_sel = candidate
                break
        if not user_sel:
            print("ERROR: no username input found")
            return 1
        page.fill(user_sel, user)
        page.fill("input[type='password']", password)
        page.keyboard.press("Enter")
        try:
            page.wait_for_load_state("networkidle", timeout=45000)
        except Exception:
            pass
        print("after login, landed on:", page.url.split("?")[0])

        print("== step 3: authenticated probes ==")
        for url in PROBE_URLS:
            try:
                res = ctx.request.get(url, timeout=60000)
                body = res.body()
                kind = res.headers.get("content-type", "?")
                head = body[:200].decode("utf-8", "replace").replace("\n", " ") if not body.startswith(b"%PDF") else "%PDF..."
                print(f"{res.status} {kind:40s} {len(body):>9,}B  {url}")
                if "html" in kind and b"Index of" in body[:2000]:
                    print("        ^^ DIRECTORY LISTING ENABLED")
                if url != EXAMPLE_PDF and b"href" in body[:5000]:
                    print("        head:", head[:180])
            except Exception as error:
                print(f"ERR  {url}: {error}")

        print("== step 4: portal AIP index (how the UI enumerates aerodromes) ==")
        for url in ("https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP/default.html",
                    "https://www.enav.it/services/list"):
            try:
                res = ctx.request.get(url, timeout=60000)
                print(f"{res.status} {res.headers.get('content-type', '?')} {url}")
            except Exception as error:
                print(f"ERR  {url}: {error}")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
