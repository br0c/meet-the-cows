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


def caption_band(img, pale_frac=0.55, search_frac=0.15):
    """Rows of a white caption banner across the top, or 0 when there is none.

    The guides letter their captions in the same red ink they draw with, so a banner left
    in the window turns "Après la buse: 200m en montée 5%" into arrows, danger boxes and
    circled obstacles — 318 Montgardin was producing six of each out of its caption alone.
    The banner is what a fixed inset cannot be: its depth varies per photo, so it is
    measured. Only a band that starts at the very top counts, so a snowfield further down
    is never mistaken for one.
    """
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    pale = ((hsv[:, :, 1] < 60) & (hsv[:, :, 2] > 205)).mean(axis=1)
    limit = int(h * search_frac)
    rows = [y for y in range(limit) if pale[y] > pale_frac]
    # Ink covering the banner drops those rows below the threshold, so take the last pale
    # row in the search band rather than the first break in a run.
    if not rows or rows[0] > max(6, int(h * 0.03)):
        return 0
    return rows[-1] + 2


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
        m[: caption_band(img)] = 0
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


INK_S_MIN = 70
"""Ink is saturated; ground is not.

The floor sits where the corpus puts it, which is tighter than it looks. 613 Taninges'
pink predicate picks up bare soil and gravel at S=51-62 — one such patch is 494x388 px and
survives every length, straightness and coverage test here, because a field really is long
and really is the right hue. 320 Bayons draws its arrow in a pale salmon at S=74. So the
floor has to pass 74 and stop 62.

Judged per COMPONENT, on its median, not per pixel. The two distributions overlap pixel by
pixel — a threshold between them keeps a scatter of the brightest soil pixels, which then
re-forms into strokes — while the marks themselves separate cleanly: a stroke is ink or it
is ground, and its median says which.

Applied only to the bands that need it. The red and orange predicates already pin their
own channel gaps tightly enough; forcing a floor on them instead ate the anti-aliased edge
of every thin stroke and broke Bayons' arrow into pieces too small to rebuild.
"""
LOOSE_BANDS = ("pink", "blue", "yellow")


def _ink_bands(img, win):
    """The saturated inks the guides draw in, as separate masks."""
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 1]
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
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        if name in LOOSE_BANDS:
            m = _drop_pale_components(m, sat)
        out[name] = m
    return out


def _drop_pale_components(mask, sat_channel, min_area=60):
    """Keep only the marks whose own median saturation says they are ink."""
    keep = np.zeros_like(mask)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask)
    for i in range(1, n):
        sel = lab == i
        if stats[i, cv2.CC_STAT_AREA] < min_area:
            continue
        if np.median(sat_channel[sel]) >= INK_S_MIN:
            keep[sel] = 255
    return keep


# --------------------------------------------------------------------------- families
def hazard_lines(img, win, min_frac=0.30):
    """A line ruled right across the frame: a power line or cable. Safety information —
    length relative to the frame is the signature, since no outline or arrow spans a
    third of the image dead straight at constant width."""
    span = min(img.shape[:2])
    out = []
    for band in ("red", "yellow"):
        mask = _ink_bands(img, win)[band]
        dashes = []
        for i, lab, area in _components(mask, 90):
            pts = np.column_stack(np.nonzero(lab == i))[:, ::-1].astype(np.float32)
            (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
            long_, short = max(dw, dh), min(dw, dh)
            if short > 14:
                continue
            if long_ >= min_frac * span and long_ / max(short, 1) >= 15:
                out.append(np.asarray(_axis(pts), np.float32))
            elif long_ >= 16 and long_ / max(short, 1) >= 2.5:
                dashes.append((pts, _axis(pts)))
        out += _join_dashes(dashes, min_frac * span)
    return out


def _join_dashes(dashes, floor):
    """Chain collinear dashes into the single line they represent.

    A power line is as often drawn dashed as solid — 515 Lus rules its "Ligne El" right
    across the approach in six separate strokes — and a per-component length test drops
    every one of them as too short. Dropping a cable is the most consequential thing this
    library can do, so the dashes are chained and measured as the line they are.
    """
    out, used = [], set()
    for i, (pts_i, axis_i) in enumerate(dashes):
        if i in used:
            continue
        group, axis = [pts_i], axis_i
        used.add(i)
        grew = True
        while grew:
            grew = False
            for j, (pts_j, _) in enumerate(dashes):
                if j in used:
                    continue
                c = pts_j.mean(axis=0)
                # Tight offset, generous gap: dashes of one line sit dead on it with real
                # space between, where a nearby unrelated stroke sits off the line.
                if _near_axis(c, axis, off_tol=12, gap_tol=90):
                    group.append(pts_j)
                    used.add(j)
                    axis = _axis(np.vstack(group))
                    grew = True
        if len(group) >= 3 and math.dist(*axis) >= floor:
            out.append(np.asarray(axis, np.float32))
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


def _taper(pts, slices=5):
    """How much wider the widest slice of a stroke is than its typical width.

    An arrow carries a head: sliced along its length it runs thin, thin, WIDE. A danger
    rectangle is the same width end to end. Measured, that is the whole separation —
    drawn arrows come in at 2.0-3.2 and 320 Bayons' genuine danger strip at 1.06 — and it
    is the only one there is, because a fat arrow (515 Lus draws a 59 px one) is wider
    than some danger boxes and no width threshold can tell those two apart.
    """
    a, b = _axis(pts)
    ux, uy = b[0] - a[0], b[1] - a[1]
    norm = math.hypot(ux, uy) or 1
    ux, uy = ux / norm, uy / norm
    along = (pts[:, 0] - a[0]) * ux + (pts[:, 1] - a[1]) * uy
    perp = (pts[:, 0] - a[0]) * uy - (pts[:, 1] - a[1]) * ux
    lo, hi = float(along.min()), float(along.max())
    if hi - lo < 1:
        return 1.0
    spans = []
    for k in range(slices):
        sel = (along >= lo + (hi - lo) * k / slices) & (along <= lo + (hi - lo) * (k + 1) / slices)
        if sel.sum() > 10:
            spans.append(float(perp[sel].max() - perp[sel].min()))
    if not spans:
        return 1.0
    return max(spans) / max(float(np.median(spans)), 1.0)


HEAD_TAPER = 1.6     # midway between the drawn arrows (2.0+) and the danger boxes (1.1)


def _axis_coverage(pts, axis, bins=10):
    """What fraction of a stroke's length actually carries ink.

    A drawn arrow is inked end to end, give or take the label across its middle. A stroke
    chained to something far away — 613 Taninges' bridge reaching from a run down into the
    red roofs of the village below — leaves most of its span empty, and no length or
    straightness test notices, because the two ends really are collinear.
    """
    a, b = axis
    ux, uy = b[0] - a[0], b[1] - a[1]
    norm = math.hypot(ux, uy) or 1
    ux, uy = ux / norm, uy / norm
    along = (pts[:, 0] - a[0]) * ux + (pts[:, 1] - a[1]) * uy
    lo, hi = float(along.min()), float(along.max())
    if hi - lo < 1:
        return 0.0
    idx = np.clip(((along - lo) / (hi - lo) * bins).astype(int), 0, bins - 1)
    return len(np.unique(idx)) / bins


def _bridge_labels(img, win, mask, reach=31, glyphs="both"):
    """Reconnect a stroke that its own label is drawn across.

    The guides letter each run "330 m / 19.0°" in white with a dark outline, straight over
    the arrow. That splits one stroke into two components, and rebuilding arrows from the
    pieces afterwards by collinearity is guesswork that mis-pairs neighbouring runs. Here
    the glyphs are simply not treated as breaks: label pixels flanked by this band's own
    ink are filled in, which turned 613 Taninges' eight fragments back into its four drawn
    runs and 615 Bonneville's eleven into four.

    Only glyph pixels close to existing ink qualify, so a caption elsewhere in the frame
    never grows a stroke of its own.

    `glyphs` says which lettering breaks THIS mask. Ink is lettered in white with a dark
    outline, so "both" is right for a colour band. A white bar is lettered in dark text and
    must use "dark": filling pale pixels beside a pale mask does not bridge a break, it
    welds the bar to the next road along.
    """
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    dark = hsv[:, :, 2] < 80
    pale = (hsv[:, :, 1] < 70) & (hsv[:, :, 2] > 190)
    sel = dark if glyphs == "dark" else (pale if glyphs == "pale" else (pale | dark))
    glyph = (sel.astype(np.uint8) * 255) & win
    glyph = cv2.dilate(glyph, np.ones((5, 5), np.uint8))
    near = cv2.dilate(mask, np.ones((reach, reach), np.uint8))
    joined = cv2.bitwise_or(mask, cv2.bitwise_and(glyph, near))
    return cv2.morphologyEx(joined, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))


def _near_axis(centre, axis, off_tol=40, gap_tol=90):
    """Is this point both collinear with the segment and close to its extent?

    Both halves matter: collinearity alone merges two parallel runs in neighbouring fields,
    while distance alone merges an arrow with any ink beside it.
    """
    a, b = axis
    ux, uy = b[0] - a[0], b[1] - a[1]
    span = math.hypot(ux, uy) or 1
    ux, uy = ux / span, uy / span
    off = abs((centre[0] - a[0]) * uy - (centre[1] - a[1]) * ux)
    along = (centre[0] - a[0]) * ux + (centre[1] - a[1]) * uy
    return off <= off_tol and max(-along, along - span, 0) <= gap_tol


def measured_arrows(img, win, min_len_frac=0.16, exclude=None):
    """Direction arrows, each usually labelled with a length and a bearing.

    One bridged component, one arrow. There is deliberately no regrouping of separate
    strokes here: rejoining an arrow split by its own label is what _bridge_labels does,
    and it does it from evidence — the glyphs that caused the split — where collinear
    regrouping only guesses. The guess was actively wrong. On 515 Lus it walked from the
    300 m run along a dash of the power line and on to the 275 m run, returning two
    meaningless 320 px axes in a V where the drawing has two arrows at 0° and 15°, each
    of which the bridged components already had exactly right.
    """
    # A measured run the guide bothered to draw and label spans a real part of the frame.
    # Below this floor every fleck of ink in a label became its own arrow.
    floor = max(min_len_frac * min(img.shape[:2]), 80)
    out = []
    for band, mask in _ink_bands(img, win).items():
        if band in ("orange", "yellow"):
            continue                      # APVV pointer ink, handled as its own family
        if exclude is not None:
            mask = cv2.bitwise_and(mask, cv2.bitwise_not(exclude))
        # Connectivity from the bridged mask, geometry from the ink itself: the glyphs
        # only say which pieces belong to one stroke, and must not fatten or lengthen it.
        bridged = _bridge_labels(img, win, mask)
        for i, lab, _ in _components(bridged, 60):
            pts = np.column_stack(np.nonzero((lab == i) & (mask > 0)))[:, ::-1]
            pts = pts.astype(np.float32)
            if len(pts) < 60:
                continue
            (_, _), (dw, dh), _ = cv2.minAreaRect(pts)
            long_, short = max(dw, dh), min(dw, dh)
            if long_ < floor or short > ARROW_W_MAX:
                continue
            # Thin, or fat but headed. 515 Lus draws a 59 px wide arrow over a 300 m run
            # that a width test alone hands to the danger family — that is, it stamps
            # "avoid" on the very ground the guide is pointing at.
            if short > 30 and _taper(pts) < HEAD_TAPER:
                continue
            axis = _pca_axis(pts)
            if _axis_coverage(pts, axis) >= 0.6:
                out.append(np.asarray(_point_at_head(pts, axis), np.float32))
    return out


ARROW_W_MAX = 70
"""No drawn arrow is this wide. The widest genuine one in the corpus is 515 Lus' 59 px
run; the pale blobs that reach this family through the pink band are 125 px across and
would otherwise pass on taper alone."""


def _stroke_mask(shape, axes, width=17):
    """The ink a set of line annotations occupies, so later families skip it.

    A cable is ruled straight across the photo and crosses whatever is under it. Where it
    crosses an arrow the two become one component, and the arrow inherits the crossing's
    width: 515 Lus' 300 m run measured 59 px wide with a 61 px bulge at 70% of its length,
    which is the power line, not an arrowhead — enough to tilt its axis by 15° and point it
    backwards. Claiming the cable first leaves the arrow to be measured on its own.
    """
    m = np.zeros(shape, np.uint8)
    for a, b in axes:
        cv2.line(m, (round(float(a[0])), round(float(a[1]))),
                 (round(float(b[0])), round(float(b[1]))), 255, width)
    return m


def _pca_axis(pts):
    """The stroke's own direction, from its point cloud rather than its bounding box.

    minAreaRect is fitted to the extremes, so a wide arrowhead tilts it: on 515 Lus' fat
    300 m run it reports 344.7° where the guide drew 0.0°, a 15° error on a landing
    direction. The principal axis is fitted to every pixel and gets both of that photo's
    runs right (0.0° and 14.9° against a drawn 0.0° and 15.2°).
    """
    centre = pts.mean(axis=0)
    centred = pts - centre
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    u = vt[0]
    t = centred @ u
    return centre + u * float(t.min()), centre + u * float(t.max())


def _point_at_head(pts, axis):
    """Order the axis tail->head, so the rendered arrow points where the guide pointed.

    The head is the widest slice, which is the same measurement that tells an arrow from a
    danger box. Without this the endpoint order is whatever minAreaRect happened to report
    and half the arrows render backwards — on a landing aid, a reciprocal heading.
    """
    a, b = axis
    ux, uy = b[0] - a[0], b[1] - a[1]
    norm = math.hypot(ux, uy) or 1
    ux, uy = ux / norm, uy / norm
    along = (pts[:, 0] - a[0]) * ux + (pts[:, 1] - a[1]) * uy
    perp = (pts[:, 0] - a[0]) * uy - (pts[:, 1] - a[1]) * ux
    lo, hi = float(along.min()), float(along.max())
    if hi - lo < 1:
        return a, b
    # Which END the head is nearer, not which end it sits on. The guides mark a run's
    # extent with a dot beyond the arrowhead, so the widest slice of 515 Lus' 300 m run
    # is the second of five, not the last — comparing the two end thirds calls that arrow
    # backwards, and a reversed run is a reciprocal landing direction.
    slices = 7
    widths = []
    for k in range(slices):
        sel = ((along >= lo + (hi - lo) * k / slices)
               & (along <= lo + (hi - lo) * (k + 1) / slices))
        widths.append(float(perp[sel].max() - perp[sel].min()) if sel.sum() > 5 else 0.0)
    if not any(widths):
        return a, b
    head_pos = (widths.index(max(widths)) + 0.5) / slices
    return (a, b) if head_pos >= 0.5 else (b, a)



def _on_axis(centre, axes, tol=30):
    """Does this point sit on one of the given line segments?"""
    for a, b in axes:
        ux, uy = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(ux, uy) or 1
        ux, uy = ux / norm, uy / norm
        off = abs((centre[0] - a[0]) * uy - (centre[1] - a[1]) * ux)
        along = (centre[0] - a[0]) * ux + (centre[1] - a[1]) * uy
        if off <= tol and -tol <= along <= norm + tol:
            return True
    return False


def _dedupe_quads(quads):
    """One drawn rectangle, one quad.

    An outlined box is found twice — once as the stroke and once as the hole inside it —
    so the nested pair is collapsed, keeping the outer, since the hole under-states the
    drawn rectangle by a stroke width.
    """
    ordered = sorted(quads, key=lambda q: -cv2.contourArea(np.asarray(q, np.float32)))
    kept = []
    for q in ordered:
        centre = tuple(np.asarray(q, np.float32).mean(axis=0))
        if any(cv2.pointPolygonTest(np.asarray(k, np.float32), centre, False) >= 0
               for k in kept):
            continue
        kept.append(q)
    return kept


def outlined_boxes(img, win, min_area=400):
    """A danger zone the guide OUTLINES instead of filling.

    Hollow, so its two long sides are thin strokes and the arrow family reads them as a
    run: 320 Bayons' danger rectangle was coming back as an arrow straight down its own
    middle. Traced as the hole it encloses, the way rings and field outlines already are,
    and held to being rectangular so a drawn ring never lands here.

    Returns the quads and the ink that drew them, so the arrow family can skip it.
    """
    mask = _ink_bands(img, win)["red"]
    sealed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    quads, ink = [], np.zeros(mask.shape, np.uint8)
    cnts, hier = cv2.findContours(sealed, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return quads, ink
    for i, c in enumerate(cnts):
        area = cv2.contourArea(c)
        if hier[0][i][3] == -1 or area < min_area:
            continue
        rect = cv2.minAreaRect(c.astype(np.float32))
        (_, _), (dw, dh), _ = rect
        if max(dw, dh) < 25 or area < 0.7 * dw * dh:
            continue                       # not a rectangle: a ring or an ink blob
        quads.append(cv2.boxPoints(rect))
        cv2.drawContours(ink, [c], -1, 255, thickness=cv2.FILLED)
    return quads, cv2.dilate(ink, np.ones((15, 15), np.uint8))


def danger_boxes(img, win, arrows=()):
    """A red rectangle over ground to avoid, outlined or translucently filled.

    Arrowheads are excluded by the arrows they belong to. A head is a wide red blob and
    reads as a box on every shape test there is, so the only thing that tells them apart
    is that a head sits on an arrow's own axis. Without this, 613 Taninges came back with
    a red "avoid" rectangle stamped on each of its four landing runs — an invented hazard
    on exactly the ground the guide is pointing at.
    """
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
        if _taper(pts) >= HEAD_TAPER:        # it has a head: an arrow, not a box
            continue
        quad = cv2.boxPoints(cv2.minAreaRect(pts))
        if _on_axis(np.asarray(quad, np.float32).mean(axis=0), arrows):
            continue
        out.append(quad)
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
        out.append(_simplify(c))
    return ([], np.zeros_like(fill)) if len(out) > max_count else (out, fill)


def _simplify(contour, frac=0.02):
    """Reduce a traced contour to its corners without flattening it.

    A tolerance set from the perimeter alone is wider than a landing strip: Canavese's
    runway is 200 px long and 25 px across, so 2% of its perimeter is 9 px and the short
    ends simplify away, leaving a two-point polygon of zero area. Ten photos were losing
    their strip to that — a drawn field arriving as a bare line. The tolerance is now also
    held under a quarter of the shape's own width, which leaves the golden strips
    identical to the pixel.
    """
    (_, _), (dw, dh), _ = cv2.minAreaRect(contour.astype(np.float32))
    eps = min(frac * cv2.arcLength(contour, True), 0.25 * max(min(dw, dh), 1))
    return cv2.approxPolyDP(contour, eps, True).reshape(-1, 2).astype(np.float32)


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
        out.append(_simplify(c, frac=0.012))
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
def extract(img, style=None, apvv=False, labels=None):
    """Every drawn mark on the photo, by family, gated to the styles that can carry it.

    Returns (shapes, masks): shapes keyed by family, masks to keep out of registration
    so the drawing never registers itself.

    `labels` is the run lettering already read off this photo (read_labels.py), passed in
    as plain data. It unlocks the white-arrow family, which pixels alone cannot judge. This
    module never calls a model: the reading is archived per photo and committed, so the
    extraction stays deterministic and a re-run costs nothing.
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
        # Order matters, and each step is why the next one is right: an outlined danger
        # box must be claimed before the arrow family reads its sides as a run; a cable
        # must be claimed before it can weld itself to an arrow it crosses; and the
        # arrows must exist before a filled box can be told from an arrowhead.
        outlined, box_ink = (outlined_boxes(img, win) if style == SCREENSHOT
                             else ([], None))
        hazards = hazard_lines(img, win)
        claimed = _stroke_mask(win.shape, hazards)
        if box_ink is not None:
            claimed = cv2.bitwise_or(claimed, box_ink)
        arrows = measured_arrows(img, win, exclude=claimed)
        if labels and style == SCREENSHOT:
            import white_arrows                       # local: keeps the import optional
            arrows = arrows + white_arrows.arrows_from_labels(img, labels)
        marks = point_markers(img, win)
        circles = circled_points(img, win)
        polys = outlined_polygons(img, win)
        # Suppress against the cables too, not just the arrows: a guide labels a line at
        # its end, and 515 Lus' "Ligne BT" caption sits 27 px past the cable on its own
        # axis, where it was becoming a red "avoid" rectangle over good ground.
        danger = (_dedupe_quads(outlined + danger_boxes(img, win, arrows + hazards))
                  if style == SCREENSHOT else [])
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
