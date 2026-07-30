#!/usr/bin/env python3
"""White measured arrows: a working locator, and a detector that does not exist.

DELIBERATELY NOT WIRED IN. Read FINDINGS before using any of this.

Some guides draw a measured run in white with a dark outline instead of in ink —
515 Lus draws two of its four that way (240 m/73.0° and 300 m/68.0°). The coloured
families cannot see them at all, so those runs are simply missing from the view.

    python3 white_arrows.py [photo ...]      # print candidates per photo

FINDINGS (2026-07-30, measured over the 63 screenshot-style photos)
-------------------------------------------------------------------
Locating a white bar is solved. A directional opening — keep only what survives an
opening by a 41 px line at some angle — finds both of Lus' arrows and measures them at
68.7° and 73.3° against the 68.0° and 73.0° the guide letters beside them. Better than
one degree, from pixels alone.

Deciding whether a located bar is a DRAWN ARROW or a ROAD is not solved, and the reason
is structural rather than a matter of tuning. The ink families work because ink is a
colour the ground is not; that argument has no white counterpart, because white is the
colour of roads, bare limestone, rooftops and glare. Everything else available is a shape
test, and somewhere in 63 photos a road is long, straight, thin, outlined, labelled and
headed. Ten separations were measured; each one is quoted with the number that killed it,
so nobody re-runs them:

  1. pale colour threshold alone ......... roads pass trivially
  2. normalised straightness ............. a village blob scores 0.062, a real arrow 0.077
  3. dark outline around the shape ....... real 0.10, road 0.21 — inverted
  4. width constancy along the bar ....... real 0.49/0.61, road 0.14 — inverted
  5. directional opening, 41 px .......... finds both real arrows AND 3-5 roads per photo
  6. glyph cluster adjacent to the bar ... real 2, roads 4-7 — inverted
  7. corridor taper, i.e. an arrowhead ... real 1.3/2.3, roads 1.05-8.27 (junctions)
  8. long straight opening, 81-121 px .... loses both real arrows, keeps the roads
  9. graphic white, V>=254 & S<15 ........ loses one real arrow, keeps 8 roads
 10. interior uniformity of the fill ..... real 80-83 (its own label darkens it), road 69-75

What would actually work is reading the label. Each of these arrows is lettered with its
own length and bearing — "240 m / 73.0°" — which states the answer exactly, where every
test above only infers it. Pair a model reading that text with the locator here, which is
already accurate to a degree, and the family is done: the text says which bars are runs
and what they measure, and the geometry says where they are. That is also the one place a
model earns its keep in this pipeline, since nothing about it is recoverable from pixels.

Until then the family stays missing rather than guessed. A false run points a pilot at
ground nobody surveyed, which is worse than a view with two runs instead of four.
"""
import math
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shapes as sh  # noqa: E402

PHOTOS = Path(__file__).resolve().parents[2] / "data/sources/field-views/guide-photos"


def line_kernel(length, ang_deg):
    k = np.zeros((length, length), np.uint8)
    c = length // 2
    dx, dy = math.cos(math.radians(ang_deg)), -math.sin(math.radians(ang_deg))
    cv2.line(k, (int(c - dx * c), int(c - dy * c)), (int(c + dx * c), int(c + dy * c)), 1, 1)
    return k


def white_bars(img, seg=41, v_min=235, s_max=45, min_len=90, max_width=40):
    """Straight pale bars, as (axis, length_px, bearing_mod180).

    The locator only. It does not claim these are arrows — see FINDINGS.
    """
    win = sh.window(img, sh.detect_style(img))
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    pale = (((hsv[:, :, 1] < s_max) & (hsv[:, :, 2] > v_min)).astype(np.uint8) * 255) & win
    pale = cv2.morphologyEx(pale, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    keep = np.zeros_like(pale)
    for ang in range(0, 180, 10):
        keep = cv2.max(keep, cv2.morphologyEx(pale, cv2.MORPH_OPEN, line_kernel(seg, ang)))
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    out = []
    n, lab, stats, _ = cv2.connectedComponentsWithStats(keep)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 150:
            continue
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
        if max(dw, dh) < min_len or min(dw, dh) > max_width:
            continue
        a, b = sh._pca_axis(pts)
        bearing = math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1]))) % 180
        out.append(((a, b), float(max(dw, dh)), round(bearing, 1)))
    return out


def main():
    names = sys.argv[1:] or ["515_lus_la_croix_haute_2.jpg"]
    for name in names:
        img = cv2.imread(str(PHOTOS / name))
        if img is None:
            print(f"{name}: unreadable")
            continue
        bars = white_bars(img)
        print(f"{name}: {len(bars)} pale bar(s) — CANDIDATES ONLY, not arrows")
        for (a, b), length, bearing in sorted(bars, key=lambda t: -t[1]):
            print(f"    {length:6.0f} px  bearing(mod 180) {bearing:6.1f}  "
                  f"{np.round(a).astype(int).tolist()} -> {np.round(b).astype(int).tolist()}")


if __name__ == "__main__":
    main()
