#!/usr/bin/env python3
"""Read the measured-run labels a guide letters beside its arrows.

The guides write the answer on the photo — "240 m / 73.0°" — and that text states a run's
length and bearing where every geometric test only infers them. Reading it is the one job
in this pipeline that pixels cannot do (see white_arrows.py FINDINGS), and it is a narrow
one: read the lettering, return numbers. Nothing here looks for fields, judges terrain or
decides what is landable.

The division of labour is deliberate. This module reads TEXT; the CV locates GEOMETRY. A
model asked for pixel coordinates would be guessing at something `white_arrows.white_bars`
already measures to within a degree, so it is never asked.

Output is archived as data, one JSON per photo under data/sources/field-views/labels/, and
committed. Extraction is one-time — the photos never change — so the renderers read files
and stay deterministic and model-free, CI re-runs cost nothing, and what the model said is
reviewable in a diff rather than re-rolled on every run.

    ANTHROPIC_API_KEY=... python3 read_labels.py            # every photo missing a cache
    ANTHROPIC_API_KEY=... python3 read_labels.py --force 515_lus_la_croix_haute_2.jpg
    python3 read_labels.py --check                          # cache coverage, no API calls
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shapes as sh  # noqa: E402

PHOTOS = Path(__file__).resolve().parents[2] / "data/sources/field-views/guide-photos"
CACHE = Path(__file__).resolve().parents[2] / "data/sources/field-views/labels"
API_URL = "https://api.anthropic.com/v1/messages"
MODEL = os.environ.get("FIELD_VIEWS_LABEL_MODEL", "claude-sonnet-4-5-20250929")

# Bump when the prompt changes meaning, so stale answers are refetched rather than trusted.
#
# v3: the v2 prompt illustrated the format with real measurements copied off one photo, and
# the model filled that template in when it could not read a photo — those exact values came
# back on nine unrelated photos, 25 of 131 labels in all, plus more recombining them. The
# geometric cross-check caught it (75 of 131 readings had no stroke anywhere near them),
# which is why the readings are reviewed before they are committed. No example carries a
# plausible number now, and the model is told to transcribe before it parses.
PROMPT_VERSION = 3

PROMPT = """This is an aerial photo from a glider outlanding guide. Someone has drawn on it
by hand: arrows showing usable landing runs, and beside each arrow they have written that
run's length and its magnetic bearing.

A label sits next to its arrow and reads as a distance in metres and a bearing in degrees,
usually on two lines. The length is in metres. The bearing is 0-360 and is the direction the
arrow points.

TRANSCRIBE, DO NOT INFER. Copy the characters you can actually see. Never estimate a length
from how long the arrow looks, never compute a bearing from its direction on the image, and
never fill in a plausible-looking value. If a label is blurred, cropped or absent, leave it
out. Most photos in this collection carry either no run labels or one; several carry none at
all, and returning an empty list is a correct and expected answer.

The numbers in the schema below are placeholders showing the JSON shape. They are not data
and must never appear in your answer.

Do NOT report:
- captions or notes that are not a run measurement (e.g. "Ligne BT", "Talus",
  "Partie a eviter", or a sentence describing the approach)
- place names, field numbers, scale bars, or any text belonging to the mapping tool
- distances on curved range arcs

For each run label, give the colour of the arrow it belongs to: "white" for a pale arrow
with a dark outline, otherwise "red", "pink", "blue" or "other".

Work in two steps. First, in "seen", list every run label you can literally read, as the
raw characters. Second, parse each one into numbers. If "seen" is empty, "labels" must be
empty too.

Return ONLY a JSON object, no prose, with this shape:

{"seen": ["<the raw characters of each label you can read>"],
 "labels": [{"text": "<raw characters>", "length_m": <number>, "bearing_deg": <number>,
             "arrow": "<white|red|pink|blue|other>"}]}

If the photo carries no run labels at all, return {"seen": [], "labels": []}."""


def _post(payload, key, tries=4):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(API_URL, data=body, headers={
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": key,
    })
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf8", "replace")[:200]
            last = f"HTTP {e.code}: {detail}"
            if e.code not in (408, 429, 500, 502, 503, 529):
                raise RuntimeError(last) from e
        except Exception as e:                      # noqa: BLE001 - transient network
            last = str(e)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"api failed after {tries} attempts: {last}")


def _extract_json(text):
    """The reply should be bare JSON; tolerate a fenced block around it."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError(f"no JSON object in reply: {text[:120]!r}")
    return json.loads(text[start:end + 1])


def _clean(labels):
    """Keep only entries that are actually a run measurement, in range.

    Exact duplicates are dropped. A guide lettering the identical length AND bearing twice
    is far likelier to be the same label transcribed twice than two genuinely identical
    runs, and a spurious second label is how an unlettered road gets promoted to one.
    """
    out, seen = [], set()
    for item in labels if isinstance(labels, list) else []:
        try:
            length = float(item["length_m"])
            bearing = float(item["bearing_deg"]) % 360
        except (KeyError, TypeError, ValueError):
            continue
        # A run the guide bothered to measure; anything outside this is a misread.
        if not 50 <= length <= 3000:
            continue
        key = (round(length, 1), round(bearing, 1))
        if key in seen:
            continue
        seen.add(key)
        out.append({"text": str(item.get("text", ""))[:60],
                    "length_m": round(length, 1),
                    "bearing_deg": round(bearing, 1),
                    "arrow": str(item.get("arrow", "other"))[:10]})
    return out


def read_photo(path, key):
    data = path.read_bytes()
    payload = {
        "model": MODEL,
        "max_tokens": 1024,
        "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.standard_b64encode(data).decode()}},
            {"type": "text", "text": PROMPT},
        ]}],
    }
    reply = _post(payload, key)
    text = "".join(b.get("text", "") for b in reply.get("content", []))
    doc = _extract_json(text)
    seen = doc.get("seen")
    return {
        "photo": path.name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "model": MODEL,
        "prompt_version": PROMPT_VERSION,
        # Kept for audit: the raw characters claimed, beside the parse of them. A reading
        # that cannot show its own transcription is not a reading.
        "seen": [str(s)[:60] for s in seen] if isinstance(seen, list) else [],
        "labels": _clean(doc.get("labels")),
    }


def load(photo_name):
    """Cached labels for a photo, or None. Never calls the API."""
    p = CACHE / f"{Path(photo_name).stem}.json"
    if not p.exists():
        return None
    try:
        doc = json.loads(p.read_text())
    except (ValueError, OSError):
        return None
    return doc.get("labels") if doc.get("prompt_version") == PROMPT_VERSION else None


def wanted():
    """Photos worth reading: the screenshot style is the only one that letters runs."""
    out = []
    for p in sorted(PHOTOS.glob("*.jpg")):
        img = cv2.imread(str(p))
        if img is None or not sh.is_aerial(img):
            continue
        if sh.detect_style(img) == sh.SCREENSHOT:
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("photos", nargs="*", help="photo filenames (default: all screenshots)")
    ap.add_argument("--force", action="store_true", help="refetch even if cached")
    ap.add_argument("--check", action="store_true", help="report coverage, no API calls")
    ap.add_argument("--limit", type=int, default=0, help="cap photos processed")
    args = ap.parse_args()

    photos = [PHOTOS / n for n in args.photos] if args.photos else wanted()
    photos = [p for p in photos if p.exists()]

    if args.check:
        have = [p for p in photos if load(p.name) is not None]
        runs = sum(len(load(p.name) or []) for p in have)
        print(f"{len(have)}/{len(photos)} photos cached, {runs} run labels")
        for p in photos:
            if load(p.name) is None:
                print(f"  missing: {p.name}")
        return 0

    todo = [p for p in photos if args.force or load(p.name) is None]
    if args.limit:
        todo = todo[:args.limit]
    if not todo:
        print(f"nothing to do: all {len(photos)} photos cached")
        return 0

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return 2

    CACHE.mkdir(parents=True, exist_ok=True)
    failures = 0
    print(f"reading {len(todo)} photo(s) with {MODEL}", flush=True)
    for p in todo:
        try:
            doc = read_photo(p, key)
        except Exception as e:                      # noqa: BLE001 - one photo must not stop the run
            failures += 1
            print(f"  {p.name}: FAILED {e}", flush=True)
            continue
        (CACHE / f"{p.stem}.json").write_text(json.dumps(doc, indent=1) + "\n")
        runs = ", ".join(f"{d['length_m']:.0f} m/{d['bearing_deg']:.1f}° ({d['arrow']})"
                         for d in doc["labels"]) or "none"
        print(f"  {p.name}: {runs}", flush=True)
    print(f"done, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
