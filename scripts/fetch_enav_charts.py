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
procedures are skipped to keep the packs flyable-size. Redistribution: shipped with attribution
to ENAV per the owner's 2026-07-10 decision, based on the eAIP help's distribution terms ("may
be made available on-line … or off-line") and the free self-briefing access.
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
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

PORTAL = "https://onlineservices.enav.it/enavWebPortalStatic/AIP/AIP"
CYCLE_RE = re.compile(r"\((A\d{2}-\d{2})\)_(\d{4})_(\d{2})_(\d{2})")
# Bumped whenever the chart selection changes so a cached charts directory from a previous
# fetcher revision is refetched even within the same AIRAC cycle.
FETCHER_VERSION = 2
# France-VAC-like content only: the ICAO aerodrome chart, the AD_2_SECONDARI aerodromes'
# "AERODROME LANDING CHART" (their whole VAC), and visual approach charts. Instrument
# procedures (SID/STAR/IAC), parking and obstacle charts are deliberately excluded
# ("AERODROME OBSTACLE CHART" does not match: OBSTACLE is not LANDING).
WANTED_CHART_RE = re.compile(
    r"(AERODROME\s+(?:LANDING\s+)?CHART|VISUAL\s+APPROACH|AVVICINAMENTO\s+A\s+VISTA|\bVAC\b)", re.I)


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


def charts_up_to_date(out_dir: Path, cycle: str) -> bool:
    """True when the output directory already holds this cycle's charts fetched by this fetcher
    revision (manifest cycle + fetcherVersion match and every chart file exists) — the nightly
    build can then skip ~250 downloads."""
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - broken manifest -> refetch
        return False
    if manifest.get("cycle") != cycle or manifest.get("fetcherVersion") != FETCHER_VERSION:
        return False
    charts = manifest.get("charts") or {}
    return bool(charts) and all((out_dir / f"{code}.pdf").is_file() for code in charts)


def charts_current_without_browser(out_dir: Path) -> bool:
    """Browserless freshness probe for CI: default.html (the cycle chooser, served before the
    IDCS gate — 'everything past default.html needs the login') is fetched with plain urllib
    and compared against the cached manifest. Any doubt returns False so the browser path runs."""
    try:
        request = urllib.request.Request(f"{PORTAL}/default.html", headers={"User-Agent": "MeetTheCows/0.7"})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8", "replace")
        cycles = sorted({m.group(0) for m in CYCLE_RE.finditer(text)})
        cycle = pick_cycle(cycles, dt.date.today())
        if not cycle:
            print("check-only: no cycle links found (page gated or changed); fetch needed")
            return False
        current = charts_up_to_date(out_dir, cycle)
        print(f"check-only: cycle {cycle}; charts {'current' if current else 'stale or missing'}")
        return current
    except Exception as error:  # noqa: BLE001 - inconclusive probe must fall back to fetching
        print(f"check-only inconclusive ({error}); fetch needed", file=sys.stderr)
        return False


def login_if_prompted(page, user: str, password: str, wait_ms: int = 8000) -> bool:
    """Complete the Oracle IDCS form if the current navigation landed on it. True when a
    login was performed. Gated URLs redirect to the IDCS domain, so this may need a moment
    for the form to appear — hence the bounded wait instead of an immediate query."""
    try:
        page.wait_for_selector("input[type='password']", timeout=wait_ms)
    except Exception:
        return False
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
    return True


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
    parser.add_argument("--force", action="store_true", help="Refetch even when the output directory already holds the current cycle")
    parser.add_argument("--check-only", action="store_true", help="Browserless freshness probe: exit 0 when the cached charts already match the portal's current cycle (CI uses this to skip the Chromium install), 1 when a fetch is needed or the probe is inconclusive")
    args = parser.parse_args()

    codes = {c.strip().upper() for c in args.codes.split(",") if c.strip()} or None
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.check_only:
        return 0 if charts_current_without_browser(out_dir) else 1

    user = os.environ.get("ENAV_ACCOUNT_ID", "")
    password = os.environ.get("ENAV_ACCOUNT_PASSWORD", "")
    if not user or not password:
        print("ERROR: ENAV_ACCOUNT_ID / ENAV_ACCOUNT_PASSWORD not set", file=sys.stderr)
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        # Open the portal (logging in if the entry page is gated), then read the cycle list
        # over the request API — the live page keeps navigating, so page.content() races.
        page.goto(f"{PORTAL}/default.html", wait_until="domcontentloaded", timeout=60000)
        if login_if_prompted(page, user, password):
            print("logged in (portal entry)")
        listing = ctx.request.get(f"{PORTAL}/default.html", timeout=60000)
        cycles = sorted({m.group(0) for m in CYCLE_RE.finditer(listing.body().decode("utf-8", "replace"))})
        cycle = pick_cycle(cycles, dt.date.today())
        if not cycle:
            print("ERROR: no cycle links found on default.html", file=sys.stderr)
            return 1
        print(f"cycle {cycle} (effective {cycle_date(cycle)}) of {cycles}")
        if not args.force and charts_up_to_date(out_dir, cycle):
            print(f"charts in {out_dir} already match cycle {cycle}; nothing to fetch")
            browser.close()
            return 0
        menu_url = f"{PORTAL}/{cycle}/eAIP/menu.html"

        # The eAIP itself is protected: trigger the IDCS login here if it hasn't happened yet.
        page.goto(menu_url, wait_until="domcontentloaded", timeout=60000)
        if login_if_prompted(page, user, password):
            print("logged in (eAIP)")

        response = ctx.request.get(menu_url, timeout=90000)
        if response.status != 200:
            print(f"ERROR: menu.html -> {response.status}", file=sys.stderr)
            return 1
        pages = extract_ad2_pages(response.body().decode("utf-8", "replace"))
        targets = sorted(code for code in pages if not codes or code in codes)
        print(f"{len(pages)} AD 2 aerodrome pages in the menu; fetching {len(targets)}")

        # A full fetch replaces the directory wholesale so charts withdrawn upstream (or ones a
        # previous fetcher revision selected differently) cannot linger in the build's cache.
        # Partial QA runs (--codes/--max) leave existing files alone.
        if not codes and not args.max:
            for stale in out_dir.glob("*.pdf"):
                stale.unlink()
            (out_dir / "manifest.json").unlink(missing_ok=True)

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

    # Degraded-run guard: writing a manifest legitimises the directory for the whole AIRAC
    # cycle (charts_up_to_date trusts it), so a run where most aerodromes failed — transient
    # portal errors, or an expired IDCS session serving login pages with zero chart links —
    # must NOT record itself as complete. Exiting non-zero leaves no manifest, and the next
    # nightly run refetches everything. ~96 of 97 aerodromes have charts on a healthy run.
    if not codes and not args.max and len(charts) < 0.8 * max(1, len(targets)):
        print(f"ERROR: charts for only {len(charts)}/{len(targets)} aerodromes ({errors} hard errors) — "
              f"refusing to write a truncated manifest; the next run will refetch.", file=sys.stderr)
        return 1

    manifest = {
        "cycle": cycle,
        "cycleDate": cycle_date(cycle),
        "fetcherVersion": FETCHER_VERSION,
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "charts": charts,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    total_bytes = sum(f.stat().st_size for f in out_dir.glob("*.pdf"))
    print(f"done: {len(charts)} aerodromes, {total_bytes / 1e6:.1f} MB, {errors} errors -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
