#!/usr/bin/env python3
"""Authenticated fetch of ENAV AIP Italia aerodrome charts for the pack build.

Runs as its own CI step (Playwright + ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD) and produces
the local directory consumed by build_pack.py --it-vac-dir: one merged <ICAO>.pdf per
aerodrome plus manifest.json {"cycle", "cycleDate", "generatedAt", "charts"}.

How the portal is laid out (mapped by scripts/probe_enav.py v1-v6):
 - default.html lists the published AIRAC cycles as anchors "(A07-26)_2026_07_09\\index.html".
 - Each cycle root is an IDS AIRNAV eAIP frameset; the tree is eAIP/menu.html (11.8MB XHTML,
   single-quoted hrefs) with one AD 2 page per aerodrome: "LI-AD 2 LIPB - BOLZANO 1-it-IT.html"
   (en-GB variants exist and are preferred for stable English chart names).
 - The AD 2 pages link the chart PDFs, which live under documents/Root/ENAV/Cartografia/AD/
   AD_2/<GROUP>/<ICAO>/<chart-id>/<CHART NAME>.pdf; everything past default.html needs the
   Oracle IDCS login.

Only visual, France-VAC-like charts are kept (aerodrome chart + visual approach); instrument
procedures are skipped to keep the packs flyable-size. NOTE: ENAV redistribution permission is
still pending — the output must not be published until it is granted.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

PORTAL = "https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP"
CYCLE_RE = re.compile(r"\((A\d{2}-\d{2})\)_(\d{4})_(\d{2})_(\d{2})")
# France-VAC-like content only: the ICAO aerodrome chart and visual approach/landing charts.
# Instrument procedures (SID/STAR/IAC), parking and obstacle charts are deliberately excluded.
WANTED_CHART_RE = re.compile(
    r"(AERODROME\s+CHART|VISUAL\s+APPROACH|AVVICINAMENTO\s+A\s+VISTA|\bVAC\b)", re.I)


def pick_cycle(cycles: list[str], today: dt.date) -> str:
    """Latest cycle already effective; the earliest future one when none is (mirrors AT)."""
    dated = []
    for cycle in cycles:
        match = CYCLE_RE.search(cycle)
        if match:
            dated.append((dt.date(int(match.group(2)), int(match.group(3)), int(match.group(4))), cycle))
    if not dated:
        return ""
    dated.sort()
    effective = [c for d, c in dated if d <= today]
    return effective[-1] if effective else dated[0][1]


def cycle_date(cycle: str) -> str:
    match = CYCLE_RE.search(cycle)
    return f"{match.group(2)}-{match.group(3)}-{match.group(4)}" if match else ""


def extract_ad2_pages(menu_html: str) -> dict[str, str]:
    """ICAO -> AD 2 page href from the eAIP menu; the en-GB edition wins over it-IT.

    \\s+ matters: certified airports read "LI-AD 2 LIPB - …" but the uncertified aerodromes
    carry a double space ("LI-AD 2  LIDT - …"). Entries without content ([NIL]) point at
    noContent.html and never match."""
    pages: dict[str, str] = {}
    for href, code in re.findall(r"href='(LI-AD 2\s+(LI[A-Z]{2})[^']*?\.html)#", menu_html):
        current = pages.get(code)
        if current is None or ("-en-GB" in href and "-en-GB" not in current):
            pages[code] = href
    return pages


def extract_pdf_links(page_html: str, page_url: str) -> list[str]:
    """Absolute chart-PDF URLs from an AD 2 page, query strings stripped."""
    links = []
    for href in re.findall(r"['\"]([^'\"]{4,300}?\.pdf(?:\?[^'\"]{0,160})?)['\"]", page_html, re.I):
        href = re.sub(r"\?.*$", "", href).replace("\\", "/")
        links.append(urllib.parse.urljoin(page_url, href))
    return sorted(set(links))


def select_visual_charts(pdf_urls: list[str]) -> list[str]:
    """Keep only the France-VAC-like chart PDFs of one aerodrome page, in stable order."""
    return [url for url in pdf_urls
            if WANTED_CHART_RE.search(urllib.parse.unquote(url).rsplit("/", 1)[-1])]


def merge_pdfs(chunks: list[bytes]) -> bytes:
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    for chunk in chunks:
        for page in PdfReader(io.BytesIO(chunk)).pages:
            writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=".cache/enav-charts", help="Output directory (build_pack --it-vac-dir)")
    parser.add_argument("--codes", default="", help="Optional comma-separated ICAO whitelist; default: every AD_2 aerodrome with visual charts")
    parser.add_argument("--max", type=int, default=0, help="Debug limit on aerodromes; 0 means no limit")
    args = parser.parse_args()

    user = os.environ.get("ENAV_ACCOUNT_ID", "")
    password = os.environ.get("ENAV_ACCOUNT_PASSWORD", "")
    if not user or not password:
        print("ERROR: ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD not set", file=sys.stderr)
        return 1
    codes = {c.strip().upper() for c in args.codes.split(",") if c.strip()} or None
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        # Cycle discovery (public page).
        page.goto(f"{PORTAL}/default.html", wait_until="domcontentloaded", timeout=60000)
        cycles = sorted({m.group(0) for m in CYCLE_RE.finditer(page.content())})
        cycle = pick_cycle(cycles, dt.date.today())
        if not cycle:
            print("ERROR: no cycle links found on default.html", file=sys.stderr)
            return 1
        print(f"cycle {cycle} (effective {cycle_date(cycle)}) of {cycles}")
        menu_url = f"{PORTAL}/{cycle}/eAIP/menu.html"

        # First protected request triggers the Oracle IDCS login form.
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

        response = ctx.request.get(menu_url, timeout=90000)
        if response.status != 200:
            print(f"ERROR: menu.html -> {response.status}", file=sys.stderr)
            return 1
        pages = extract_ad2_pages(response.body().decode("utf-8", "replace"))
        targets = sorted(code for code in pages if not codes or code in codes)
        print(f"{len(pages)} AD 2 aerodrome pages in the menu; fetching {len(targets)}")

        charts: dict[str, list[str]] = {}
        errors = 0
        for index, code in enumerate(targets, start=1):
            if args.max and len(charts) >= args.max:
                break
            page_url = f"{PORTAL}/{cycle}/eAIP/{urllib.parse.quote(pages[code])}"
            try:
                page_res = ctx.request.get(page_url, timeout=90000)
                if page_res.status != 200:
                    raise RuntimeError(f"HTTP {page_res.status}")
                page_html = page_res.body().decode("utf-8", "replace")
            except Exception as error:  # noqa: BLE001 - one aerodrome must not sink the fetch
                errors += 1
                print(f"  {code}: AD 2 page: {error}", file=sys.stderr)
                continue
            chart_urls = select_visual_charts(extract_pdf_links(page_html, page_url))
            chunks = []
            names = []
            for url in chart_urls:
                try:
                    res = ctx.request.get(url, timeout=90000)
                    if res.status != 200:
                        raise RuntimeError(f"HTTP {res.status}")
                    chunks.append(res.body())
                    names.append(urllib.parse.unquote(url).rsplit("/", 1)[-1])
                except Exception as error:  # noqa: BLE001 - one chart must not sink the fetch
                    errors += 1
                    print(f"  {code}: {urllib.parse.unquote(url)[-70:]}: {error}", file=sys.stderr)
            if not chunks:
                continue
            try:
                (out_dir / f"{code}.pdf").write_bytes(merge_pdfs(chunks))
            except Exception as error:  # noqa: BLE001
                errors += 1
                print(f"  {code}: merge failed: {error}", file=sys.stderr)
                continue
            charts[code] = names
            print(f"[{index}/{len(targets)}] {code}: {len(chunks)} chart(s)")

        browser.close()

    manifest = {
        "cycle": cycle,
        "cycleDate": cycle_date(cycle),
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "charts": charts,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    total_bytes = sum(f.stat().st_size for f in out_dir.glob("*.pdf"))
    print(f"done: {len(charts)} aerodromes, {total_bytes / 1e6:.1f} MB, {errors} errors -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
