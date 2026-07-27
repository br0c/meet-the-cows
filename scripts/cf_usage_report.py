#!/usr/bin/env python3
"""Usage report for meetthecows.org, from Cloudflare's GraphQL Analytics API.

Why a script and not a dashboard: the numbers worth watching here are not "hits on a site".
They are a handful of specific paths whose meaning has to be explained to be useful — one of
them counts app launches only because the app happens to fetch it on every start — and that
explanation belongs next to the query, in version control, rather than in the label of a widget
someone will inherit without context.

It also runs unattended. A weekly summary that arrives is read; a dashboard is visited when
something already feels wrong.

    CLOUDFLARE_API_TOKEN=... python3 scripts/cf_usage_report.py [--days 7] [--markdown]

The token needs, on top of whatever the deploy token already has:
    Zone -> Zone -> Read              (to resolve the zone id from the name)
    Zone -> Analytics -> Read         (to query the dataset)
Deploy tokens are usually Workers-Scripts-only, so this will most likely need its own token or
an added permission; the failure below says which.

Retention and dataset availability follow the zone's plan. Nothing here is destructive: every
call is a read.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
ZONE = os.environ.get("MTC_ZONE", "meetthecows.org")

APP_HOST = f"app.{ZONE}"
DATA_HOST = f"data.{ZONE}"
SITE_HOSTS = (ZONE, f"www.{ZONE}")

# The path the app fetches on every launch (initReleaseNotes in src/app.js), which the service
# worker revalidates in the background even when it answers from cache. It is not a metric
# anybody designed; it is just the one request an opened app reliably makes when it has signal.
LAUNCH_PATH = "/release-notes.json"


def fail(message: str, detail: str = "") -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    if detail:
        print(detail, file=sys.stderr)
    sys.exit(1)


def call(url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload else None
    request = urllib.request.Request(
        url, data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")[:600]
        if error.code in (401, 403):
            fail(f"Cloudflare refused the token (HTTP {error.code}).",
                 "It needs Zone -> Zone -> Read and Zone -> Analytics -> Read.\n" + body)
        fail(f"Cloudflare returned HTTP {error.code}", body)
    except urllib.error.URLError as error:
        fail(f"could not reach Cloudflare: {error}")
    return {}


def zone_id(token: str) -> str:
    result = call(f"{API}/zones?name={ZONE}", token)
    zones = result.get("result") or []
    if not zones:
        fail(f"no zone named {ZONE} is visible to this token.")
    return zones[0]["id"]


def query(token: str, gql: str, variables: dict) -> dict:
    result = call(GRAPHQL, token, {"query": gql, "variables": variables})
    if result.get("errors"):
        fail("the analytics query was rejected.",
             json.dumps(result["errors"], indent=2)
             + "\n\nA dataset can be unavailable on the zone's plan, or outside its retention "
               "window — try a smaller --days.")
    return result.get("data", {}).get("viewer", {}).get("zones", [{}])[0] or {}


# One query, several aliases: hostname totals, the launch proxy, the pack/terrain paths, and the
# country split. Cloudflare bills GraphQL by query, so asking once is both faster and cheaper
# than four round trips.
REPORT = """
query Usage($zone: String!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      byHost: httpRequestsAdaptiveGroups(
        limit: 50
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [count_DESC]
      ) {
        count
        sum { edgeResponseBytes }
        dimensions { clientRequestHTTPHost }
      }
      launches: httpRequestsAdaptiveGroups(
        limit: 10
        filter: {
          datetime_geq: $start, datetime_lt: $end
          clientRequestHTTPHost: $appHost
          clientRequestPath: $launchPath
        }
      ) {
        count
      }
      byStatus: httpRequestsAdaptiveGroups(
        limit: 50
        filter: { datetime_geq: $start, datetime_lt: $end, edgeResponseStatus_geq: 400 }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientRequestHTTPHost edgeResponseStatus }
      }
      byCountry: httpRequestsAdaptiveGroups(
        limit: 12
        filter: { datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $appHost }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientCountryName }
      }
      dataPaths: httpRequestsAdaptiveGroups(
        limit: 25
        filter: { datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $dataHost }
        orderBy: [sum_edgeResponseBytes_DESC]
      ) {
        count
        sum { edgeResponseBytes }
        dimensions { clientRequestPath }
      }
      cache: httpRequestsAdaptiveGroups(
        limit: 20
        filter: { datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $dataHost }
        orderBy: [count_DESC]
      ) {
        count
        sum { edgeResponseBytes }
        dimensions { cacheStatus }
      }
    }
  }
}
"""


def gib(byte_count: float) -> str:
    for unit, size in (("TB", 1e12), ("GB", 1e9), ("MB", 1e6), ("kB", 1e3)):
        if byte_count >= size:
            return f"{byte_count / size:.1f} {unit}"
    return f"{byte_count:.0f} B"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="window to report on (default 7)")
    parser.add_argument("--markdown", action="store_true", help="emit a GitHub-flavoured summary")
    args = parser.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        fail("CLOUDFLARE_API_TOKEN is not set.",
             "Create one at My Profile -> API Tokens with Zone:Read and Analytics:Read.\n"
             "Never paste it into a shell history or a commit — export it, or use a CI secret.")

    end = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - dt.timedelta(days=args.days)
    variables = {
        "zone": zone_id(token),
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "appHost": APP_HOST,
        "dataHost": DATA_HOST,
        "launchPath": LAUNCH_PATH,
    }
    # The aliases take extra variables; declare them so the server accepts the document.
    gql = REPORT.replace(
        "query Usage($zone: String!, $start: Time!, $end: Time!)",
        "query Usage($zone: String!, $start: Time!, $end: Time!, "
        "$appHost: String!, $dataHost: String!, $launchPath: String!)",
    )
    data = query(token, gql, variables)

    out: list[str] = []
    head = out.append
    bullet = (lambda s: head(f"- {s}")) if args.markdown else (lambda s: head(f"  {s}"))

    def section(title: str) -> None:
        head("")
        head(f"## {title}" if args.markdown else f"\n=== {title} ===")

    head(f"# Meet the Cows — {args.days} days to {end:%Y-%m-%d %H:%M} UTC"
         if args.markdown else
         f"Meet the Cows — {args.days} days to {end:%Y-%m-%d %H:%M} UTC")

    section("Traffic by hostname")
    rows = data.get("byHost") or []
    known = {APP_HOST: "the app", DATA_HOST: "packs + terrain",
             ZONE: "landing page", f"www.{ZONE}": "landing page (redirect)"}
    for row in rows:
        host = row["dimensions"]["clientRequestHTTPHost"]
        if host not in known and not host.endswith(ZONE):
            continue
        bullet(f"{host:28} {row['count']:>9,} requests   {gib(row['sum']['edgeResponseBytes']):>9}"
               f"   {known.get(host, '')}")
    if not rows:
        bullet("no data — the window may be outside this plan's retention")

    section("App launches (with signal)")
    launches = sum(r["count"] for r in (data.get("launches") or []))
    bullet(f"{launches:,} fetches of {LAUNCH_PATH} on {APP_HOST}")
    bullet(f"≈ {launches / max(args.days, 1):,.0f} launches a day. Offline launches are invisible "
           "by design, so read this as a floor, never a total.")

    section("Downloads (packs and terrain)")
    total_bytes = 0.0
    buckets: dict[str, dict[str, float]] = {}
    for row in data.get("dataPaths") or []:
        path = row["dimensions"]["clientRequestPath"]
        kind = ("terrain tiles" if "_terrain" in path
                else "field photos / charts" if "/media/" in path or "/docs/" in path
                else "pack data")
        entry = buckets.setdefault(kind, {"count": 0.0, "bytes": 0.0})
        entry["count"] += row["count"]
        entry["bytes"] += row["sum"]["edgeResponseBytes"]
        total_bytes += row["sum"]["edgeResponseBytes"]
    for kind, entry in sorted(buckets.items(), key=lambda kv: -kv[1]["bytes"]):
        bullet(f"{kind:24} {entry['count']:>9,.0f} requests   {gib(entry['bytes']):>9}")
    if total_bytes:
        bullet(f"{'total':24} {'':>9}            {gib(total_bytes):>9}  ← this is the R2 egress bill")

    section("Cache on the data host")
    for row in data.get("cache") or []:
        status = row["dimensions"]["cacheStatus"] or "(none)"
        bullet(f"{status:12} {row['count']:>9,} requests   {gib(row['sum']['edgeResponseBytes']):>9}")
    bullet("A low HIT share here is money: every MISS is a pack served from R2 rather than the edge.")

    section("Errors")
    errors = data.get("byStatus") or []
    if not errors:
        bullet("no 4xx or 5xx in the window")
    for row in errors[:12]:
        d = row["dimensions"]
        bullet(f"{d['clientRequestHTTPHost']:28} {d['edgeResponseStatus']}   {row['count']:>7,}")

    section("Where the app is opened")
    for row in (data.get("byCountry") or [])[:10]:
        bullet(f"{row['dimensions']['clientCountryName']:24} {row['count']:>8,}")
    bullet("Useful for deciding which country pack earns the next bit of work.")

    print("\n".join(out))


if __name__ == "__main__":
    main()
