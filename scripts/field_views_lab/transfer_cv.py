#!/usr/bin/env python3
"""Deterministic annotation transfer: the drawn shapes on the old Guide photos are the
truth. Color masks extract them, SIFT+RANSAC registers old photo onto the fresh IGN
crop (similarity transform only), and the geometry is projected and re-rendered. No
model call anywhere.

Stages write verification artifacts into out/:
  trace_<f>.jpg    extracted geometry drawn back onto the old photo (trace fidelity)
  blend_<f>.jpg    warped old photo blended over the current crop (registration fidelity)
  final_<f>.jpg    the rendered field view
  transfer.json    geometry in metres relative to the field datum + registration stats
"""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

import os

# work dir holds <slug>_<n>.jpg old photos, <slug>_current.jpg 1800 m registration
# crops (975x1300, datum centred) and optional <slug>_wide.jpg 4500 m fallbacks
SP = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work")) / "oldphoto"
OUT = SP / "out"
MPP = 1800 / 975            # registration crops: 1800 m wide, 975x1300
DATUM = (487.5, 650.0)      # field lat/lon in registration-crop px

META = {
    "bayons": {"id": 320, "lat": 44.3358333, "lon": 6.1633333, "lengthM": 260, "dir": 215,
               "notes": "SW/NE Prairie. A recce on foot is essential."},
    "marcoux": {"id": 331, "lat": 44.1472167, "lon": 6.2811167, "lengthM": 250, "dir": 190,
                "notes": "010/190 Marked track. Beware of power lines. Do not use #1.",
                "photos": 2},
    "st_blaise": {"id": 412, "lat": 44.8727833, "lon": 6.61, "lengthM": 300, "dir": 50,
                  "notes": "050/230 Very difficult course. Three pits restrict the usable "
                           "length. At the 230, go under the high-voltage line."},
    "prunieres": {"id": 423, "lat": 44.5341667, "lon": 6.3633333, "lengthM": 450, "dir": 310,
                  "notes": "310 Tailwind on the south side of the field. Meadow."},
}


def px2m(p):
    return (round(float(p[0] - DATUM[0]) * MPP, 1), round(float(DATUM[1] - p[1]) * MPP, 1))


# ---------------------------------------------------------------- extraction

def largest_box(mask, min_area=40):
    """min-area rectangle of the largest connected component, as 4 corner points."""
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnts = [c for c in cnts if cv2.contourArea(c) >= min_area]
    if not cnts:
        raise RuntimeError("empty mask")
    c = max(cnts, key=cv2.contourArea)
    return cv2.boxPoints(cv2.minAreaRect(c)), c


def quad_of(mask, min_area=40):
    """4-point polygon of the largest component: approxPolyDP if it lands on 4 vertices,
    min-area rectangle otherwise."""
    box, c = largest_box(mask, min_area)
    approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
    if len(approx) == 4:
        return approx.reshape(4, 2).astype(np.float32)
    return box.astype(np.float32)


def union_box(mask, min_area=30, line_tol=30):
    """min-area rectangle over the mask components collinear with the largest one.
    Label text drawn across an arrow splits it in two; the segments share the arrow's
    axis, while stray same-coloured pixels elsewhere (roofs) sit far off that line."""
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask)
    big = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    if not big:
        raise RuntimeError("empty union mask")
    main = max(big, key=lambda i: stats[i, cv2.CC_STAT_AREA])
    a, b = axis_of(cv2.boxPoints(cv2.minAreaRect(
        np.column_stack(np.nonzero(lab == main))[:, ::-1].astype(np.float32))))
    ux, uy = b - a
    norm = math.hypot(ux, uy)
    ux, uy = ux / norm, uy / norm
    def offline(c):
        return abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux)
    big = [i for i in big if i == main or offline(cent[i]) <= line_tol]
    pts = np.column_stack(np.nonzero(np.isin(lab, big)))[:, ::-1].astype(np.float32)
    return cv2.boxPoints(cv2.minAreaRect(pts))


def axis_of(box):
    """(end_a, end_b) midpoints of the two short sides of a 4-corner box."""
    box = np.asarray(box, np.float32)
    e01 = np.linalg.norm(box[0] - box[1])
    e12 = np.linalg.norm(box[1] - box[2])
    if e01 >= e12:  # 0-1 and 2-3 are the long sides
        return (box[0] + box[3]) / 2, (box[1] + box[2]) / 2
    return (box[0] + box[1]) / 2, (box[2] + box[3]) / 2


def extract_bayons(img):
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    danger = ((r > 140) & (g < 120) & (b < 120)).astype(np.uint8) * 255
    arrow = ((r > 215) & (g > 135) & (g < 205) & (b > 125) & (b < 205)
             & (r - b > 40)).astype(np.uint8) * 255
    arrow = cv2.morphologyEx(arrow, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    dbox, _ = largest_box(danger)
    a, bpt = axis_of(union_box(arrow))
    return {"danger_quad": dbox.tolist(), "axis": [a.tolist(), bpt.tolist()],
            "drawn_bearing": 60.0, "masks": [danger, arrow]}


def extract_st_blaise(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    fill = ((h > 25) & (h < 55) & (s > 80) & (v > 110)).astype(np.uint8) * 255
    fill[:90, :] = 0; fill[-90:, :] = 0; fill[:, :20] = 0; fill[:, -20:] = 0
    fill = cv2.morphologyEx(fill, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    quad = quad_of(fill, min_area=400)
    return {"strip_quad": quad.tolist(), "masks": [fill]}


def extract_marcoux0(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    fill = ((h > 25) & (h < 70) & (s > 40) & (s < 160) & (v > 150)).astype(np.uint8) * 255
    fill[:90, :] = 0; fill[-90:, :] = 0; fill[:, :20] = 0; fill[:, -20:] = 0
    # the strip is tiny and pale; keep only the component nearest the known river-edge spot
    n, lab, stats, cent = cv2.connectedComponentsWithStats(fill)
    best, bestd = None, 1e9
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 120:
            continue
        w_, h_ = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        if max(w_, h_) < 3 * min(w_, h_):     # want an elongated sliver
            continue
        d = math.hypot(cent[i][0] - 370, cent[i][1] - 350)
        if d < bestd:
            best, bestd = i, d
    if best is None:
        raise RuntimeError("marcoux strip not found")
    mask = (lab == best).astype(np.uint8) * 255
    box, _ = largest_box(mask)
    return {"strip_quad": box.tolist(), "masks": [mask]}


def extract_marcoux1(img):
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    arrow = ((b > 140) & (b - r > 60) & (b - g > 60)).astype(np.uint8) * 255
    arrow = cv2.morphologyEx(arrow, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    a, bpt = axis_of(union_box(arrow))
    return {"axis": [a.tolist(), bpt.tolist()], "drawn_bearing": 190.0,
            "masks": [arrow]}


def extract_prunieres(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    win = np.zeros(v.shape, np.uint8)
    win[190:380, 90:260] = 255
    arrow_pre = ((h > 15) & (h < 40) & (s > 30) & (s < 130) & (v > 190)
                 & (win > 0)).astype(np.uint8) * 255
    # the ring is a thin black stroke: blackhat catches it over bright terrain,
    # absolute darkness catches it over forest and water; big dark blobs are terrain
    bh = cv2.morphologyEx(v, cv2.MORPH_BLACKHAT,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    dark = (((bh > 25) & (v < 60)) | (v < 42)).astype(np.uint8) * 255
    dark &= win
    dark &= cv2.bitwise_not(cv2.dilate(arrow_pre, np.ones((7, 7), np.uint8)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dark)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] > 800:
            dark[lab == i] = 0
    pts = np.column_stack(np.nonzero(dark))[:, ::-1].astype(np.float32)
    if len(pts) < 60:
        raise RuntimeError("prunieres ring mask too thin")
    ell = _ransac_ellipse(pts)
    ring = np.zeros(v.shape, np.uint8)
    cv2.ellipse(ring, ell, 255, 2)
    arrow = cv2.morphologyEx(arrow_pre, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    abox, _ = largest_box(arrow, min_area=100)
    a, bpt = axis_of(abox)
    (cx, cy), (d1, d2), ang = ell
    return {"ellipse": {"cx": cx, "cy": cy, "d1": d1, "d2": d2, "angle": ang},
            "axis": [a.tolist(), bpt.tolist()], "masks": [dark, ring, arrow]}


def _ring_dist(ell, P):
    """distances from points to an ellipse outline, ~px."""
    (cx, cy), (d1, d2), ang = ell
    t = math.radians(ang)
    dx, dy = P[:, 0] - cx, P[:, 1] - cy
    u = dx * math.cos(t) + dy * math.sin(t)
    w = -dx * math.sin(t) + dy * math.cos(t)
    a, b = max(d1 / 2, 1e-3), max(d2 / 2, 1e-3)
    r = np.hypot(u / a, w / b)
    return np.abs(r - 1) * min(a, b)


def _ransac_ellipse(pts, iters=3000, tol=3.0, seed=7):
    """ellipse maximizing on-curve support: robust to the ring being partly hidden
    and to residual dark speckles that break a least-squares fit."""
    import random
    rng = random.Random(seed)
    best, bestn = None, 0
    for _ in range(iters):
        try:
            ell = cv2.fitEllipse(pts[rng.sample(range(len(pts)), 6)])
        except cv2.error:
            continue
        (cx, cy), (d1, d2), _ = ell
        if not (60 < d1 < 260 and 60 < d2 < 260 and 90 < cx < 260 and 190 < cy < 380):
            continue
        n = int((_ring_dist(ell, pts) < tol).sum())
        if n > bestn:
            best, bestn = ell, n
    if best is None:
        raise RuntimeError("ellipse RANSAC found nothing")
    for _ in range(3):
        keep = pts[_ring_dist(best, pts) < tol]
        if len(keep) < 40:
            break
        best = cv2.fitEllipse(keep)
    return best


def _ellipse_dist(ell, p):
    """approximate signed distance from point to ellipse outline (0 on the ring)."""
    (cx, cy), (d1, d2), ang = ell
    t = math.radians(ang)
    dx, dy = p[0] - cx, p[1] - cy
    u = dx * math.cos(t) + dy * math.sin(t)
    w = -dx * math.sin(t) + dy * math.cos(t)
    a, b = d1 / 2, d2 / 2
    if a < 1 or b < 1:
        return 1e9
    r = math.hypot(u / a, w / b)
    return (r - 1) * min(a, b)


# -------------------------------------------------------------- registration

def chrome_mask(img, framed):
    """Keypoint-eligible area of an old photo: drop the Guide frame, badges, scale box
    and north arrow (framed style) or the bottom UI pill (screenshot style)."""
    h, w = img.shape[:2]
    m = np.full((h, w), 255, np.uint8)
    if framed:
        m[:95, :] = 0
        m[-95:, :] = 0
        m[:, :20] = 0
        m[:, -20:] = 0
    else:
        m[-70:, :] = 0
    return m


def _gray(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(g)


def _rootsift(desc):
    if desc is None or not len(desc):
        return desc
    desc = desc / (desc.sum(axis=1, keepdims=True) + 1e-7)
    return np.sqrt(desc)


def _attempt(old, cur, kp_mask, prescale):
    """One SIFT+RANSAC pass with the old photo pre-scaled by `prescale`.
    Returns (M in original old px, stats) or None."""
    if prescale != 1:
        old = cv2.resize(old, None, fx=prescale, fy=prescale, interpolation=cv2.INTER_CUBIC)
        kp_mask = cv2.resize(kp_mask, None, fx=prescale, fy=prescale,
                             interpolation=cv2.INTER_NEAREST)
    sift = cv2.SIFT_create(nfeatures=16000)
    k1, d1 = sift.detectAndCompute(_gray(old), kp_mask)
    k2, d2 = sift.detectAndCompute(_gray(cur), None)
    if d1 is None or d2 is None:
        return None
    raw = cv2.BFMatcher().knnMatch(_rootsift(d1), _rootsift(d2), k=2)
    good = [m for m, n in raw if m.distance < 0.82 * n.distance]
    if len(good) < 8:
        return None
    src = np.float32([k1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0,
        maxIters=10000, confidence=0.999)
    if M is None:
        return None
    inl = inl.ravel().astype(bool)
    res = np.linalg.norm((cv2.transform(src, M) - dst).reshape(-1, 2), axis=1)
    rms = float(np.sqrt((res[inl] ** 2).mean()))
    # compose the prescale back out so M maps ORIGINAL old px -> current px
    S = np.array([[prescale, 0, 0], [0, prescale, 0], [0, 0, 1]], np.float64)
    M = (np.vstack([M, [0, 0, 1]]) @ S)[:2]
    stats = {"matches": len(good), "inliers": int(inl.sum()), "rms_px": round(rms, 2),
             "rms_m": round(rms * MPP, 1), "prescale": prescale,
             "scale": round(float(np.hypot(M[0, 0], M[0, 1])), 4),
             "rot_deg": round(math.degrees(math.atan2(M[1, 0], M[0, 0])), 2)}
    return M, stats


def _acceptable(stats):
    # 20+ inliers, or a tight small consensus: 12 similarity-consistent points at
    # sub-2.5 px residual do not happen by accident.
    return stats["inliers"] >= 20 or (stats["inliers"] >= 12 and stats["rms_px"] <= 2.5)


def register(old, cur, framed, ann_masks, label, prescales=(1, 1.5, 2, 3, 4, 5)):
    """Similarity transform old px -> current px via SIFT + RANSAC, searching over
    pre-scale hypotheses when the two images' ground resolutions are far apart."""
    kp_mask = chrome_mask(old, framed)
    for am in ann_masks:  # drawn overlays must not become keypoints
        kp_mask &= cv2.bitwise_not(cv2.dilate(am, np.ones((9, 9), np.uint8)))
    best = None
    for f in prescales:
        got = _attempt(old, cur, kp_mask, f)
        if got and (best is None or got[1]["inliers"] > best[1]["inliers"]):
            best = got
        if best and best[1]["inliers"] >= 40:
            break  # unambiguous; skip the remaining hypotheses
    if best is None or not _acceptable(best[1]):
        raise RuntimeError(f"{label}: no acceptable registration "
                           f"(best {best[1] if best else 'none'})")
    return best


def apply_m(M, pts):
    pts = np.asarray(pts, np.float32).reshape(-1, 1, 2)
    return cv2.transform(pts, M).reshape(-1, 2)


# ------------------------------------------------------------------- driver

FIELDS = {
    "bayons": {"framed": False, "extract": extract_bayons},
    "st_blaise": {"framed": True, "extract": extract_st_blaise},
    "prunieres": {"framed": True, "extract": extract_prunieres},
    "marcoux": None,  # two photos, handled explicitly
}


def blend_check(old, cur, M, path):
    warped = cv2.warpAffine(old, M, (cur.shape[1], cur.shape[0]))
    blend = cv2.addWeighted(cur, 0.5, warped, 0.5, 0)
    # checker strips make misregistration pop
    stripe = blend.copy()
    for y0 in range(0, cur.shape[0], 64):
        band = slice(y0, min(y0 + 32, cur.shape[0]))
        stripe[band] = warped[band] if (y0 // 64) % 2 == 0 else cur[band]
    cv2.imwrite(str(path), np.hstack([blend, stripe]))


def trace_check(old, ext, path):
    vis = old.copy()
    if "danger_quad" in ext:
        cv2.polylines(vis, [np.asarray(ext["danger_quad"], np.int32)], True, (255, 0, 255), 2)
    if "strip_quad" in ext:
        cv2.polylines(vis, [np.asarray(ext["strip_quad"], np.int32)], True, (255, 0, 255), 2)
    if "ellipse" in ext:
        e = ext["ellipse"]
        cv2.ellipse(vis, ((e["cx"], e["cy"]), (e["d1"], e["d2"]), e["angle"]),
                    (255, 0, 255), 2)
    if "axis" in ext:
        a, b = ext["axis"]
        cv2.line(vis, tuple(map(round, a)), tuple(map(round, b)), (255, 0, 255), 2)
        cv2.circle(vis, tuple(map(round, a)), 5, (255, 0, 255), 2)
    cv2.imwrite(str(path), vis)


def transfer_field(slug):
    cur = cv2.imread(str(SP / f"{slug}_current.jpg"))
    out = {"slug": slug}
    if slug == "marcoux":
        o0 = cv2.imread(str(SP / "marcoux_0.jpg"))
        o1 = cv2.imread(str(SP / "marcoux_1.jpg"))
        e0, e1 = extract_marcoux0(o0), extract_marcoux1(o1)
        trace_check(o0, e0, OUT / "trace_marcoux_0.jpg")
        trace_check(o1, e1, OUT / "trace_marcoux_1.jpg")
        M0, s0 = register(o0, cur, True, e0.pop("masks"), "marcoux_0")
        M1, s1 = register(o1, cur, False, e1.pop("masks"), "marcoux_1")
        blend_check(o0, cur, M0, OUT / "blend_marcoux_0.jpg")
        blend_check(o1, cur, M1, OUT / "blend_marcoux_1.jpg")
        out["registration"] = {"photo0": s0, "photo1": s1}
        out["strip_quad_m"] = [px2m(p) for p in apply_m(M0, e0["strip_quad"])]
        axis = apply_m(M1, e1["axis"])
        out["axis_m"] = [px2m(p) for p in axis]
        out["drawn_bearing"] = e1["drawn_bearing"]
        return out
    spec = FIELDS[slug]
    old = cv2.imread(str(SP / f"{slug}_0.jpg"))
    ext = spec["extract"](old)
    trace_check(old, ext, OUT / f"trace_{slug}.jpg")
    masks = ext.pop("masks")
    try:
        M, stats = register(old, cur, spec["framed"], masks, slug)
    except RuntimeError:
        # Fall back to a wider crop of the same datum: more shared ground features
        # (the standard crop may be dominated by water or forest), then compose the
        # exact wide->standard scaling. WIDE_M metres wide, same 975x1300 canvas.
        wide_path = SP / f"{slug}_wide.jpg"
        if not wide_path.exists():
            raise
        WIDE_M = 4500
        wide = cv2.imread(str(wide_path))
        M_w, stats = register(old, wide, spec["framed"], masks, f"{slug}(wide)")
        k = (WIDE_M / 975) / MPP
        C = np.array([[k, 0, DATUM[0] * (1 - k)], [0, k, DATUM[1] * (1 - k)], [0, 0, 1]])
        M = (C @ np.vstack([M_w, [0, 0, 1]]))[:2]
        stats["via"] = f"wide {WIDE_M} m crop"
        stats["rms_m"] = round(stats["rms_px"] * (WIDE_M / 975), 1)
        blend_check(old, wide, M_w, OUT / f"blend_{slug}_wide.jpg")
    blend_check(old, cur, M, OUT / f"blend_{slug}.jpg")
    out["registration"] = stats
    if "danger_quad" in ext:
        out["danger_quad_m"] = [px2m(p) for p in apply_m(M, ext["danger_quad"])]
    if "strip_quad" in ext:
        out["strip_quad_m"] = [px2m(p) for p in apply_m(M, ext["strip_quad"])]
    if "axis" in ext:
        out["axis_m"] = [px2m(p) for p in apply_m(M, ext["axis"])]
    if "drawn_bearing" in ext:
        out["drawn_bearing"] = ext["drawn_bearing"]
    if "ellipse" in ext:
        # project a dense sampling of the drawn ring: no ellipse-angle bookkeeping,
        # provably the same curve the old photo carries
        e = ext["ellipse"]
        poly = cv2.ellipse2Poly((round(e["cx"]), round(e["cy"])),
                                (round(e["d1"] / 2), round(e["d2"] / 2)),
                                round(e["angle"]), 0, 360, 5)
        out["ellipse_poly_m"] = [px2m(p) for p in apply_m(M, poly.astype(np.float32))]
    return out


def main():
    OUT.mkdir(exist_ok=True)
    slugs = sys.argv[1:] or ["bayons", "st_blaise", "prunieres", "marcoux"]
    results = {}
    for slug in slugs:
        try:
            results[slug] = transfer_field(slug)
            print(f"{slug}: OK  {json.dumps(results[slug]['registration'])}")
        except Exception as err:  # noqa: BLE001 - report and continue with the rest
            results[slug] = {"slug": slug, "error": str(err)}
            print(f"{slug}: FAILED  {err}")
    path = OUT / "transfer.json"
    merged = json.loads(path.read_text()) if path.exists() else {}
    merged.update(results)
    path.write_text(json.dumps(merged, indent=1))
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
