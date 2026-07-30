#!/usr/bin/env python3
"""The shapes the guides draw, extracted from a photo.

One library for both corpora. The Guide des Aires de Sécurité and the APVV Pyrenees guide
draw the same vocabulary in different inks, and every family here is found the same way in
both — so a fix for one pack is a fix for the other, which copying the code would not have
given us.

Read SHAPE-INVENTORY.md first: it is the catalogue this implements, built by looking at
all 162 Aires photos and 43 APVV captures. Families are gated by DRAWING STYLE, because
the styles are disjoint — a framed photo draws filled strips and rings and never a measured
arrow; a screenshot draws arrows, hazard lines and markers and never a filled strip. Running
an extractor only where its shape can occur removes a class of false positive outright.

Shape priors are load-bearing, not decoration. Recognising ink in the abstract was tried
and measured (see ink.py FINDINGS): a drawn black ring and a hedgerow are identical in
colour and in pen statistics. What separates them is that a drawn ring fits an ellipse and
a hedge does not.
"""
import math

import cv2
import numpy as np

# --------------------------------------------------------------------------- styles
FRAMED = "framed"        # Aires: coloured border, badge, title bar, scale bar
SCREENSHOT = "shot"      # Aires: mapping-tool capture, terrain to the edge
APVV = "apvv"            # Pyrenees: Google Earth capture, black N arrow top-left


def border_spread(img, thickness=6):
    b = np.concatenate([img[:thickness, :].reshape(-1, 3),
                        img[-thickness:, :].reshape(-1, 3),
                        img[:, :thickness].reshape(-1, 3),
                        img[:, -thickness:].reshape(-1, 3)]).astype(np.float32)
    return float(np.median(np.std(b, axis=0)))


def detect_style(img, apvv=False):
    """Which drawing style this photo is in. Border uniformity separates the Aires two
    absolutely: framed sit at 1.2-1.9 colour spread, screenshots at 33-52."""
    if apvv:
        return APVV
    return FRAMED if border_spread(img) < 12 else SCREENSHOT


def window(img, style):
    """Keepout for the guide's own chrome — frame, badges, scale bar, UI pill, N arrow."""
    h, w = img.shape[:2]
    m = np.zeros((h, w), np.uint8)
    if style == FRAMED:
        m[95:-95, 20:-20] = 255
    elif style == APVV:
        m[8:-8, 8:-8] = 255
        m[: int(h * 0.40), : int(w * 0.16)] = 0      # N arrow and its label
    else:
        m[6:-70, 6:-6] = 255
    return m


def is_aerial(img):
    """Is this a vertical aerial view at all?

    529_chauffayer_3 is a ground-level photograph of a field, filed among the aerial views,
    and the pipeline used to try to register it against satellite imagery. A ground shot
    has a horizon, and the measurement is unambiguous: its top fifth is bright (V=238) and
    washed out (S=18) above a bottom eleven times more textured, where every aerial view
    in the corpus sits within 20% of a texture ratio of 1.
    """
    h = img.shape[0]
    top, bottom = img[: h // 5], img[-h // 5:]

    def stat(patch):
        grey = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
        return (float(cv2.Laplacian(grey, cv2.CV_64F).var()),
                float(np.median(hsv[:, :, 1])), float(np.median(hsv[:, :, 2])))

    t_tex, t_sat, t_val = stat(top)
    b_tex, _, _ = stat(bottom)
    sky_above_ground = (b_tex / max(t_tex, 1) > 4) and t_sat < 60 and t_val > 170
    return not sky_above_ground


# ------------------------------------------------------------------------ primitives
def _components(mask, min_area):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            yield i, lab, stats[i, cv2.CC_STAT_AREA]


def _axis(points):
    box = cv2.boxPoints(cv2.minAreaRect(points))
    e01 = np.linalg.norm(box[0] - box[1])
    e12 = np.linalg.norm(box[1] - box[2])
    if e01 >= e12:
        return (box[0] + box[3]) / 2, (box[1] + box[2]) / 2
    return (box[0] + box[1]) / 2, (box[2] + box[3]) / 2


def _ink_bands(img, win):
    """The saturated inks the guides draw in, as separate masks."""
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    bands = {
        "red": (r > 150) & (g < 110) & (b < 110) & (r - g > 55),
        "pink": (r > 205) & (g > 120) & (g < 210) & (b > 110) & (b < 215) & (r - b > 35),
        "blue": (b > 140) & (b - r > 60) & (b - g > 60),
        "orange": (r > 180) & (g > 70) & (g < 165) & (b < 120) & (r - g > 55),
        "yellow": (r > 185) & (g > 165) & (b < 120),
    }
    out = {}
    for name, pred in bands.items():
        m = (pred.astype(np.uint8) * 255) & win
        out[name] = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return out


# --------------------------------------------------------------------------- families
def hazard_lines(img, win, min_frac=0.30):
    """A line ruled right across the frame: a power line or cable. Safety information —
    length relative to the frame is the signature, since no outline or arrow spans a
    third of the image dead straight at constant width."""
    span = min(img.shape[:2])
    out = []
    for band in ("red", "yellow"):
        mask = _ink_bands(img, win)[band]
        for i, lab, area in _components(mask, 90):
            pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
            (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
            long_, short = max(dw, dh), min(dw, dh)
            if long_ < min_frac * span or short > 14 or long_ / max(short, 1) < 15:
                continue
            out.append(np.asarray(_axis(pts), np.float32))
    return out


def point_markers(img, win):
    """Small filled dots marking an obstacle or a reference point."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    amber = (((h > 8) & (h < 32) & (s > 130) & (v > 150)).astype(np.uint8) * 255) & win
    amber = cv2.morphologyEx(amber, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    out = []
    for c in cv2.findContours(amber, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]:
        area = cv2.contourArea(c)
        if not 40 <= area <= 900:
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(c)
        if 3 <= radius <= 22 and area >= 0.55 * math.pi * radius * radius:
            out.append((float(cx), float(cy), float(radius)))
    return out


def circled_points(img, win):
    """A small circle drawn round a feature — a dam, a mast, a pylon."""
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    ink = ((((r > 150) & (g < 120) & (b < 120)) |
            ((r > 170) & (g > 150) & (b < 110))).astype(np.uint8) * 255) & win
    out = []
    cnts, hier = cv2.findContours(ink, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return out
    for i, c in enumerate(cnts):
        if hier[0][i][3] == -1 or len(c) < 5:
            continue
        area = cv2.contourArea(c)
        if not 60 <= area <= 3000:
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(c)
        if 5 <= radius <= 34 and area >= 0.6 * math.pi * radius * radius:
            out.append((float(cx), float(cy), float(radius)))
    return out


def measured_arrows(img, win, min_len_frac=0.16):
    """Direction arrows, each usually labelled with a length and a bearing.

    Grouped by collinearity so a label drawn across the shaft does not split one arrow
    into two, then held to a minimum length: without that floor, every fleck of ink in a
    label became its own arrow and a field came back with eleven runs where it has two.
    """
    # Raised from 0.09: at that floor the flecks of a label each became an arrow and a
    # field came back with eleven runs where it has two. A measured run the guide bothered
    # to draw and label spans a real part of the frame.
    floor = max(min_len_frac * min(img.shape[:2]), 80)
    out = []
    for band, mask in _ink_bands(img, win).items():
        if band in ("orange", "yellow"):
            continue                      # APVV pointer ink, handled as its own family
        groups = []
        comps = sorted(_components(mask, 60), key=lambda t: -t[2])
        for i, lab, _ in comps:
            pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
            (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
            if min(dw, dh) > 30:          # a chunky block is a danger zone, not a line
                continue
            placed = False
            for gp in groups:
                a, b = gp["axis"]
                ux, uy = b[0] - a[0], b[1] - a[1]
                norm = math.hypot(ux, uy) or 1
                ux, uy = ux / norm, uy / norm
                c = pts.mean(axis=0)
                off = abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux)
                along = abs((c[0] - a[0]) * ux + (c[1] - a[1]) * uy)
                if off <= 40 and along <= math.hypot(*(b - a)) + 90:
                    gp["pts"] = np.vstack([gp["pts"], pts])
                    gp["axis"] = _axis(gp["pts"])
                    placed = True
                    break
            if not placed:
                groups.append({"pts": pts, "axis": _axis(pts)})
        for gp in groups:
            a, b = gp["axis"]
            if math.dist(a, b) >= floor:
                out.append(np.asarray(gp["axis"], np.float32))
    return out


def danger_boxes(img, win):
    """A red rectangle over ground to avoid, outlined or translucently filled."""
    mask = _ink_bands(img, win)["red"]
    out = []
    for i, lab, area in _components(mask, 60):
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
        long_, short = max(dw, dh), min(dw, dh)
        if long_ < 25 or short <= 14:
            continue
        if long_ / max(short, 1) >= 15:      # that is a hazard line, not a box
            continue
        out.append(cv2.boxPoints(cv2.minAreaRect(pts)))
    return out


def filled_strips(img, win, s_min=120, max_count=3, min_area=350):
    """A strip painted over the landing ground.

    The saturation floor is what separates ink from grass: measured, St Blaise's fill is
    S=148 and the sunlit meadows that were being traced as strips are S=86. A photo
    yielding a crowd of them is showing terrain, so the set is discarded whole.
    """
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    fill = (((h > 20) & (h < 70) & (s > s_min) & (v > 110)).astype(np.uint8) * 255) & win
    fill = cv2.morphologyEx(fill, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    out = []
    for c in cv2.findContours(fill, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]:
        if cv2.contourArea(c) < min_area:
            continue
        poly = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        out.append(poly.reshape(-1, 2).astype(np.float32))
    return ([], np.zeros_like(fill)) if len(out) > max_count else (out, fill)


def outlined_polygons(img, win, min_area=900):
    """A hand-traced boundary round the landable ground, unfilled.

    The APVV guide draws these in orange and the Aires screenshots in bright yellow-green.
    Traced as the HOLE the outline encloses, so an arrow touching the stroke cannot cut
    the loop open and each separate field is its own hole.
    """
    bands = _ink_bands(img, win)
    mask = cv2.bitwise_or(bands["orange"], bands["yellow"])
    out = []
    cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return out
    for i, c in enumerate(cnts):
        if hier[0][i][3] == -1 or cv2.contourArea(c) < min_area:
            continue
        (_, _), (dw, dh), _ = cv2.minAreaRect(c.astype(np.float32))
        if max(dw, dh) < 30:
            continue
        poly = cv2.approxPolyDP(c, 0.012 * cv2.arcLength(c, True), True)
        out.append(poly.reshape(-1, 2).astype(np.float32))
    if not out:
        return out
    biggest = max(cv2.contourArea(p.astype(np.int32)) for p in out)
    return [p for p in out if cv2.contourArea(p.astype(np.int32)) >= 0.15 * biggest]


def centrelines(img, win, min_len_frac=0.10):
    """Thin yellow lines marking usable runs, single or crossed (211 Artignosc)."""
    mask = _ink_bands(img, win)["yellow"]
    floor = min_len_frac * min(img.shape[:2])
    out = []
    for i, lab, area in _components(mask, 60):
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
        long_, short = max(dw, dh), min(dw, dh)
        if long_ < floor or short > 12 or long_ / max(short, 1) < 6:
            continue
        out.append(np.asarray(_axis(pts), np.float32))
    return out


def drawn_rings(img, win, min_area=1500):
    """An unfilled ring round the landable area, drawn in black.

    Found as the hole it encloses, then held to fitting an ellipse: measured, a drawn ring
    fits to within 7% while a dark terrain loop fits at 17%, and that regularity is the
    only thing separating the two — by colour they are identical (S=54/V=60 against
    S=67/V=58).
    """
    v = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 2]
    bh = cv2.morphologyEx(v, cv2.MORPH_BLACKHAT,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    dark = ((((bh > 25) & (v < 60)) | (v < 42)).astype(np.uint8) * 255) & win
    out = []
    cnts, hier = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return out
    for i, c in enumerate(cnts):
        if hier[0][i][3] == -1 or len(c) < 5 or cv2.contourArea(c) < min_area:
            continue
        (cx, cy), (d1, d2), ang = cv2.fitEllipse(c)
        fitted = math.pi * d1 * d2 / 4
        if fitted and min(d1, d2) >= 40 and 0.93 <= cv2.contourArea(c) / fitted <= 1.07:
            out.append(cv2.ellipse2Poly((round(cx), round(cy)),
                                        (round(d1 / 2), round(d2 / 2)),
                                        round(ang), 0, 360, 5).astype(np.float32))
    if out:
        return out
    # A ring broken by forest or by an arrow crossing it leaves no hole, so fit each dark
    # arc alone and keep it only if the resulting ellipse's PERIMETER comes back painted
    # and the curve is pen-thin. Prunieres is exactly this case and a hole-only detector
    # loses it.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dark)
    probe = cv2.dilate(dark, np.ones((7, 7), np.uint8))
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 80:
            continue
        pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
        if len(pts) < 60:
            continue
        (cx, cy), (d1, d2), ang = cv2.fitEllipse(pts)
        if min(d1, d2) < 40 or max(d1, d2) > 0.9 * min(dark.shape):
            continue
        poly = cv2.ellipse2Poly((round(cx), round(cy)), (round(d1 / 2), round(d2 / 2)),
                                round(ang), 0, 360, 5)
        ok = [(0 <= x < probe.shape[1] and 0 <= y < probe.shape[0]) for x, y in poly]
        if not any(ok):
            continue
        covered = sum(1 for (x, y), k in zip(poly, ok) if k and probe[y, x]) / len(poly)
        perim = math.pi * (3 * (d1 / 2 + d2 / 2)
                           - math.sqrt(max((3 * d1 / 2 + d2 / 2) * (d1 / 2 + 3 * d2 / 2), 0)))
        if covered >= 0.80 and area / max(perim, 1) <= 4.5:
            return [poly.astype(np.float32)]
    return out


# ------------------------------------------------------------------------------ all
def extract(img, style=None, apvv=False):
    """Every drawn mark on the photo, by family, gated to the styles that can carry it.

    Returns (shapes, masks): shapes keyed by family, masks to keep out of registration
    so the drawing never registers itself.
    """
    if style is None:
        style = detect_style(img, apvv)
    win = window(img, style)
    bands = _ink_bands(img, win)

    strips, fill_mask = ([], np.zeros(win.shape, np.uint8))
    rings, polys, arrows, hazards, marks, circles, lines = [], [], [], [], [], [], []

    if style == FRAMED:
        strips, fill_mask = filled_strips(img, win)
        lines = centrelines(img, win)
        rings = drawn_rings(img, win)
    else:
        arrows = measured_arrows(img, win)
        hazards = hazard_lines(img, win)
        marks = point_markers(img, win)
        circles = circled_points(img, win)
        polys = outlined_polygons(img, win)
        if style == SCREENSHOT:
            danger = danger_boxes(img, win)
        else:
            danger = []
    if style == FRAMED:
        danger = []

    shapes = dict(strips=strips, rings=rings, polygons=polys, arrows=arrows,
                  danger=danger, hazards=hazards, markers=marks, circles=circles,
                  centrelines=lines)
    masks = [fill_mask] + list(bands.values())
    return shapes, masks, style


def draw_trace(img, shapes):
    """Verification image: everything extracted, drawn back on the source photo."""
    vis = img.copy()
    for poly in shapes["strips"] + shapes["polygons"]:
        cv2.polylines(vis, [poly.astype(np.int32)], True, (255, 0, 255), 2)
    for quad in shapes["danger"]:
        cv2.polylines(vis, [np.asarray(quad, np.int32)], True, (0, 128, 255), 2)
    for a, b in shapes["arrows"] + shapes["centrelines"]:
        cv2.line(vis, tuple(map(round, a)), tuple(map(round, b)), (255, 255, 0), 2)
    for a, b in shapes["hazards"]:
        cv2.line(vis, tuple(map(round, a)), tuple(map(round, b)), (0, 0, 255), 3)
    for cx, cy, radius in shapes["markers"] + shapes["circles"]:
        cv2.circle(vis, (round(cx), round(cy)), max(round(radius), 4), (0, 255, 255), 2)
    return vis
