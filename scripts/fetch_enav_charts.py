#!/usr/bin/env python3
"""Authenticated fetch of ENAV AIP Italia aerodrome charts for the pack build.

Runs as its own CI step (Playwright + ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD) and produces
the local directory consumed by build_pack.py --it-vac-dir: one merged <ICAO>.pdf per
aerodrome plus manifest.json {"cycle", "cycleDate", "generatedAt", "charts"}.

How the portal is laid out (mapped by scripts/probe_enav.py v1-v4):
 - default.html lists the published AIRAC cycles as anchors "(A07-26)_2026_07_09\\index.html".
 - Each cycle root is an IDS AIRNAV eAIP frameset; the document tree is eAIP/menu.html.
 - Chart PDFs live under documents/Root/ENAV/Cartografia/AD/AD_2/<GROUP>/<ICAO>/<chart-id>/
   <CHART NAME>.pdf and are only reachable after the Oracle IDCS login.

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
ICAO_IT_RE = re.compile(r"/(LI[A-Z]{2})/")
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


def extract_pdf_links(menu_html: str, menu_url: str) -> list[str]:
    """Absolute chart-PDF URLs from the eAIP menu, query strings stripped."""
    links = []
    for href in re.findall(r"['\"]([^'\"]{4,300}?\.pdf(?:\?[^'\"]{0,160})?)['\"]", menu_html, re.I):
        href = re.sub(r"\?.*$", "", href).replace("\\", "/")
        links.append(urllib.parse.urljoin(menu_url, href))
    return sorted(set(links))


def group_visual_charts(pdf_urls: list[str], codes: set[str] | None) -> dict[str, list[str]]:
    """ICAO -> ordered wanted-chart URLs under the AD_2 tree."""
    by_code: dict[str, list[str]] = {}
    for url in pdf_urls:
        decoded = urllib.parse.unquote(url)
        if "/AD_2" not in decoded:
            continue
        code_match = ICAO_IT_RE.search(decoded)
        if not code_match:
            continue
        code = code_match.group(1)
        if codes and code not in codes:
            continue
        name = decoded.rsplit("/", 1)[-1]
        if not WANTED_CHART_RE.search(name):
            continue
        by_code.setdefault(code, []).append(url)
    return by_code


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

        response = ctx.request.get(menu_url, timeout=60000)
        if response.status != 200:
            print(f"ERROR: menu.html -> {response.status}", file=sys.stderr)
            return 1
        pdf_urls = extract_pdf_links(response.body().decode("utf-8", "replace"), menu_url)
        by_code = group_visual_charts(pdf_urls, codes)
        print(f"{len(pdf_urls)} PDFs in the menu; {len(by_code)} aerodromes with visual charts")

        charts: dict[str, list[str]] = {}
        errors = 0
        for index, code in enumerate(sorted(by_code), start=1):
            if args.max and len(charts) >= args.max:
                break
            chunks = []
            names = []
            for url in by_code[code]:
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
            print(f"[{index}/{len(by_code)}] {code}: {len(chunks)} chart(s)")

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
