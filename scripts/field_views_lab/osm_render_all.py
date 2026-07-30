#!/usr/bin/env python3
"""Render the OSM tier for every matched field.

The bulk of the inventory: a field with an OSM runway inside the match radius gets its
geometry drawn as-is. Deterministic and free, so the only real costs are WMS fetches and
being a good citizen about them — hence a modest worker pool, and resume so a rerun after
a timeout picks up where it stopped rather than refetching thousands of crops.

    FIELD_VIEWS_WORK=work python3 osm_render_all.py --matches work/matches.json
"""
import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import field_views as fv  # noqa: E402

WORK = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
OUT = WORK / "osm" / "out"
LOCK = threading.Lock()


def render_one(entry, out_dir):
    """One OSM-tier view. Returns (id, ok, note)."""
    fid = str(entry["id"])
    path = out_dir / f"final_{fid}.jpg"
    if path.exists() and path.stat().st_size > 0:
        return fid, True, "cached"
    try:
        # cmd_render reads the entry from a file; call the geometry path directly instead
        fv.render_osm_view(entry, str(path))
        return fid, True, "rendered"
    except Exception as err:  # noqa: BLE001 - one field failing must not stop the batch
        return fid, False, str(err)[:160]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--matches", required=True)
    ap.add_argument("--workers", type=int, default=4,
                    help="parallel WMS fetches; keep low, these are public services")
    ap.add_argument("--limit", type=int, default=0, help="stop after N fields (smoke tests)")
    ap.add_argument("--countries", default="",
                    help="comma-separated ISO codes; empty means every country. CI runs one "
                         "shard per country so a provider outage costs only its own shard")
    ap.add_argument("--shard", default="",
                    help="shard name; its index is written separately so parallel shards "
                         "never overwrite one another's results")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    entries = [e for e in json.loads(Path(args.matches).read_text()) if e.get("osm")]
    if args.countries:
        want = {c.strip().upper() for c in args.countries.split(",") if c.strip()}
        entries = [e for e in entries if (e.get("country") or "").upper() in want]
    if args.limit:
        entries = entries[:args.limit]
    index_path = OUT / (f"index-{args.shard}.json" if args.shard else "index.json")
    index = json.loads(index_path.read_text()) if index_path.exists() else {}

    todo = [e for e in entries if str(e["id"]) not in index]
    print(f"{len(entries)} matched fields, {len(todo)} to render", flush=True)
    done = fail = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(render_one, e, OUT): e for e in todo}
        for fut in as_completed(futures):
            e = futures[fut]
            fid, ok, note = fut.result()
            with LOCK:
                index[fid] = {"name": e.get("name"), "country": e.get("country"),
                              "ok": ok, "note": note,
                              "len": round((e["osm"] or {}).get("len", 0)),
                              "hdg": round((e["osm"] or {}).get("hdg", 0))}
                done += ok
                fail += not ok
                if (done + fail) % 25 == 0:
                    index_path.write_text(json.dumps(index, indent=1))
                    print(f"  {done + fail}/{len(todo)} ({fail} failed)", flush=True)
                if not ok:
                    print(f"  FAIL {fid} {e.get('name')}: {note}", flush=True)
    index_path.write_text(json.dumps(index, indent=1))
    print(f"OSM tier: {done} rendered, {fail} failed, {len(index)} total in index")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
