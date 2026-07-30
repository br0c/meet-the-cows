#!/usr/bin/env python3
"""Find what a human drew on a photo, without assuming what they drew.

    STATUS: does not work, kept for the measurements. Read the FINDINGS note at the
    bottom before trying this again — the idea is appealing and the corpus refuses it.


Both guides annotate freely: a circle round a landable area, an outlined strip, an arrow
for direction, a mark on an obstacle, sometimes several at once. Asking "is there a quad?
is there a ring? is there an arrow?" needs a detector per family, each with its own
thresholds and each able to fire on terrain by itself — which is how eleven sunlit meadows
became eleven landing strips.

So this asks one question instead: which pixels are INK rather than photograph? That has
answers independent of shape:

  thin      ink is a stroke. A morphological top-hat keeps structures narrower than its
            kernel and suppresses everything wider, so a drawn line survives and a field,
            a meadow or a forest clearing does not — whatever their colour.
  flat      ink is composited, so its colour barely varies along a stroke, while terrain
            of the same hue is textured.
  distinct  ink is either strongly coloured (the guides draw in red, pink, blue, orange,
            yellow-green) or a pure black or white line, and stands out from whatever it
            was drawn over.

What comes back is geometry with no family attached: closed rings of points for anything
that encloses an area, open polylines for anything that does not. An ellipse transfers as
an ellipse, an arrow as an arrow — including its head, which is simply part of the ink.
"""
import math

import cv2
import numpy as np

# Kernel for the top-hat. Must exceed the widest stroke the guides draw (~25 px on the
# APVV captures) and stay well under the smallest terrain feature that could pass for one.
STROKE_KERNEL = 31
MIN_LENGTH_PX = 28          # shorter than this is a label serif or a speck
MIN_AREA_PX = 45


def _tophat(chan, kernel=STROKE_KERNEL):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))
    return cv2.morphologyEx(chan, cv2.MORPH_TOPHAT, k)


def _blackhat(chan, kernel=STROKE_KERNEL):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))
    return cv2.morphologyEx(chan, cv2.MORPH_BLACKHAT, k)


def ink_mask(img, win=None):
    """Binary mask of pixels that look drawn rather than photographed."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)

    # Locally saturated thin structures: any drawn colour, no hue list needed. A whole
    # bright field is wider than the kernel, so the top-hat flattens it away.
    coloured = (_tophat(s) > 45) & (s > 90)

    # Pure dark line over anything (the black rings), and pure light line over anything
    # (white callouts and endpoint dots).
    dark = (_blackhat(v) > 28) & (v < 110)
    light = (_tophat(v) > 55) & (v > 170) & (s < 90)

    mask = ((coloured | dark | light).astype(np.uint8)) * 255
    if win is not None:
        mask &= win
    # Close the gaps a label leaves across a stroke, then drop isolated speckle.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return mask


def _is_flat(img, comp_mask):
    """Ink is composited, so its colour hardly varies along a stroke."""
    px = img[comp_mask > 0]
    if len(px) < 20:
        return False
    return float(np.median(np.std(px.astype(np.float32), axis=0))) < 46


def stroke_stats(comp_mask):
    """How pen-like a component is: (width, width spread, junctions per 100 px of length).

    Colour cannot tell a drawn black ring from a hedgerow — measured on this corpus they
    sit at S=54/V=60 and S=67/V=58, the same to within noise. Structure can. A mark is
    drawn with one pen, so its width barely varies; and it stands alone, while hedges,
    tracks and field boundaries join into networks full of junctions.
    """
    skel = cv2.ximgproc.thinning(comp_mask, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    length = max(int(np.count_nonzero(skel)), 1)
    dist = cv2.distanceTransform(comp_mask, cv2.DIST_L2, 3)
    widths = dist[skel > 0] * 2
    if len(widths) < 5:
        return 0.0, 99.0, 99.0
    # A pixel of the skeleton with three or more skeleton neighbours is a junction.
    nb = cv2.filter2D((skel > 0).astype(np.uint8), -1,
                      np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.uint8))
    junctions = int(np.count_nonzero((skel > 0) & (nb >= 3)))
    return (float(np.median(widths)),
            float(np.std(widths)),
            junctions * 100.0 / length)


def ink_shapes(img, win=None, min_length=MIN_LENGTH_PX):
    """Every drawn mark on the photo, as generic geometry.

    Returns a list of dicts: points (Nx2 float32), closed (bool), stroke_px, colour.
    No shape family is assigned — the caller draws whatever came back.
    """
    mask = ink_mask(img, win)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask)
    shapes = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < MIN_AREA_PX:
            continue
        comp = (lab == i).astype(np.uint8) * 255
        pts = np.column_stack(np.nonzero(comp))[:, ::-1].astype(np.float32)
        (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
        if max(dw, dh) < min_length:
            continue
        if not _is_flat(img, comp):
            continue
        width, spread, junction_rate = stroke_stats(comp)
        # One pen, one stroke: a drawn mark holds its width and does not branch. Terrain
        # that survived the top-hat — a hedge line, a track, a field boundary — fails one
        # or both, because it is part of a network and its width wanders.
        if width < 1.5 or width > 26 or spread > 0.55 * max(width, 1) or junction_rate > 2.2:
            continue

        # A mark that encloses ground is a closed shape; anything else is a line. The hole
        # in the component answers it without caring whether the enclosure is a circle, a
        # rectangle or a hand-drawn blob.
        cnts, hier = cv2.findContours(comp, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        holes = [c for j, c in enumerate(cnts)
                 if hier[0][j][3] != -1 and cv2.contourArea(c) >= 120]
        outer = max(cnts, key=cv2.contourArea)
        if holes:
            biggest = max(holes, key=cv2.contourArea)
            pts_out = cv2.approxPolyDP(biggest, 0.008 * cv2.arcLength(biggest, True), True)
            closed = True
        else:
            pts_out = cv2.approxPolyDP(outer, 0.008 * cv2.arcLength(outer, True), True)
            closed = False
        perim = max(cv2.arcLength(outer, True) / 2, 1)
        shapes.append({
            "points": pts_out.reshape(-1, 2).astype(np.float32),
            "closed": closed,
            "stroke_px": round(area / perim, 1),
            "colour": [int(c) for c in np.median(img[comp > 0], axis=0)],
            "area_px": int(area),
        })
    shapes.sort(key=lambda s: -s["area_px"])
    return shapes, mask


def draw_trace(img, shapes):
    """Verification image: what was taken to be ink, drawn back on the photo."""
    vis = img.copy()
    for s in shapes:
        pts = s["points"].astype(np.int32)
        colour = (255, 0, 255) if s["closed"] else (255, 255, 0)
        cv2.polylines(vis, [pts], s["closed"], colour, 2)
    return vis


# ----------------------------------------------------------------------- FINDINGS
#
# Measured on the Guide corpus, 2026-07-30. The shape-agnostic idea is that ink can be
# recognised as ink — thin, flat, distinct — and its geometry transferred whatever it
# depicts. Three separations were tried and the corpus refused all three:
#
#   colour        A drawn black ring measures S=54 V=60; a hedgerow beside it S=67 V=58.
#                 Prunieres' ring S=77 V=63 against forest S=83 V=67. No threshold exists.
#
#   thinness      A top-hat keeps structures narrower than its kernel, which is every road,
#                 track, hedge and field boundary in an aerial photo, not just the ink.
#
#   pen statistics  Constant width and absence of branching should mark a drawn stroke.
#                 Measured over components containing known ink versus components of pure
#                 terrain: width 5-12 px both, spread 3-8 both, junctions ~35-45 per 100 px
#                 of skeleton both. No separation whatsoever. Worse, the ink components
#                 come back at 150k-270k px because the drawn line touches the terrain
#                 network the mask also caught, so they are not strokes at all by then.
#
# What this says about the working detectors: their shape priors are not an arbitrary
# restriction, they ARE the discriminating signal. A drawn circle is findable precisely
# because it fits an ellipse to within 7% while terrain loops fit at 17%; a drawn strip is
# findable because it is saturated ink at S=148 where meadows sit at S=86. Remove the
# prior and black ink and a hedge are the same pixels.
#
# So "transfer every shape" is better served by covering the shapes the guides actually
# draw — ellipse, quad, polyline, arrow, obstacle mark — and adding to that library, than
# by trying to recognise ink in the abstract. The alternative that could work is a model
# reading the photo, which is a separate decision.
