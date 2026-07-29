#!/usr/bin/env python3
"""Render the transferred Guide annotations onto fresh IGN crops.

Faithful reproduction only: the shapes the old photo draws (strip quad, oval, danger
rectangle, direction arrow), nothing invented — no obstacle markers, no legend, no
distance labels. Styling matches field_views.py cmd_render (red outline, rose,
name/credit bar)."""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import field_views as fv  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from transfer_cv import META, OUT  # noqa: E402

PXW, PXH = 975, 1300
RED = (226, 40, 25)
FRAME_M = 900

TR = json.loads((OUT / "transfer.json").read_text())

NAMES = {"bayons": "320 Bayons", "marcoux": "331 Marcoux",
         "st_blaise": "412 St Blaise", "prunieres": "423 Prunieres"}


def bearing_of(a, b):
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


def orient(axis, want_deg):
    """order the axis endpoints so tail->head bearing is nearest the drawn/stated one."""
    a, b = axis
    d1 = abs((bearing_of(a, b) - want_deg + 180) % 360 - 180)
    d2 = abs((bearing_of(b, a) - want_deg + 180) % 360 - 180)
    return (a, b) if d1 <= d2 else (b, a)


def quad_ends(quad):
    """midpoints of the two short sides of a 4-corner quad — its centreline ends."""
    q = quad
    if math.dist(q[0], q[1]) >= math.dist(q[1], q[2]):
        return ([(q[0][0] + q[3][0]) / 2, (q[0][1] + q[3][1]) / 2],
                [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2])
    return ([(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2],
            [(q[2][0] + q[3][0]) / 2, (q[2][1] + q[3][1]) / 2])


def align_quad_to_axis(quad, axis):
    """Rotate the strip quad about its centre so its long axis parallels the measured
    arrow. A tiny drawn sliver (Marcoux: ~110 px) pins the strip's place and size but
    not its angle — one pixel of wobble at the ends is ~2° — while a measured drawn
    arrow pins the bearing exactly. Applied only when the two nearly agree already."""
    a, b = quad_ends(quad)
    delta = ((bearing_of(*axis) - bearing_of(a, b)) + 90) % 180 - 90
    if not 0.5 < abs(delta) < 10:
        return quad
    ce = sum(p[0] for p in quad) / 4
    cn = sum(p[1] for p in quad) / 4
    dr = math.radians(delta)  # positive = clockwise in bearing terms
    return [[ce + (p[0] - ce) * math.cos(dr) + (p[1] - cn) * math.sin(dr),
             cn - (p[0] - ce) * math.sin(dr) + (p[1] - cn) * math.cos(dr)]
            for p in quad]


def draw_arrow(d, to_px, tail_m, head_m, inset=0.12):
    """white direction arrow with a dark stroke, drawn along the given ground line."""
    tx, ty = tail_m[0], tail_m[1]
    hx, hy = head_m[0], head_m[1]
    tail = (tx + (hx - tx) * inset, ty + (hy - ty) * inset)
    head = (hx - (hx - tx) * inset, hy - (hy - ty) * inset)
    t, h = to_px(tail), to_px(head)
    vx, vy = h[0] - t[0], h[1] - t[1]
    ln = math.hypot(vx, vy)
    if ln < 12:
        return
    ux, uy = vx / ln, vy / ln           # unit along, in px space
    px_, py_ = -uy, ux                  # unit across
    hw, hl = 11, 22                     # arrowhead half-width / length
    sw = 3.2                            # shaft half-width
    base = (h[0] - ux * hl, h[1] - uy * hl)
    shaft_end = base
    poly = [
        (t[0] + px_ * sw, t[1] + py_ * sw),
        (shaft_end[0] + px_ * sw, shaft_end[1] + py_ * sw),
        (base[0] + px_ * hw, base[1] + py_ * hw),
        h,
        (base[0] - px_ * hw, base[1] - py_ * hw),
        (shaft_end[0] - px_ * sw, shaft_end[1] - py_ * sw),
        (t[0] - px_ * sw, t[1] - py_ * sw),
    ]
    d.polygon(poly, fill=(255, 255, 255, 235), outline=(10, 15, 25, 255), width=2)


def render(slug):
    tr = TR[slug]
    meta = META[slug]
    # frame centre: middle of everything that must be visible
    pts = []
    for key in ("strip_quad_m", "danger_quad_m", "ellipse_poly_m", "axis_m"):
        pts += tr.get(key, [])
    es = [p[0] for p in pts]
    ns = [p[1] for p in pts]
    ce, cn = (min(es) + max(es)) / 2, (min(ns) + max(ns)) / 2
    clat = meta["lat"] + cn / 111320
    clon = meta["lon"] + ce / (111320 * math.cos(math.radians(meta["lat"])))
    tmp = OUT / f"final_{slug}.crop.jpg"
    crop = fv.ortho_crop(clat, clon, FRAME_M, tmp, "FR")
    mpp = crop["mpp"]

    img = Image.open(tmp).convert("RGB")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    def to_px(p):
        return (PXW / 2 + (p[0] - ce) / mpp, PXH / 2 - (p[1] - cn) / mpp)

    # danger rectangle first, red translucent fill exactly as the Guide drew it
    if "danger_quad_m" in tr:
        d.polygon([to_px(p) for p in tr["danger_quad_m"]],
                  fill=RED + (80,), outline=RED + (255,), width=3)

    if "ellipse_poly_m" in tr:
        d.polygon([to_px(p) for p in tr["ellipse_poly_m"]],
                  outline=RED + (255,), width=4)

    if "strip_quad_m" in tr:
        quad = tr["strip_quad_m"]
        if "drawn_bearing" in tr:  # a measured arrow exists: let it pin the angle
            quad = align_quad_to_axis(quad, tr["axis_m"])
        d.polygon([to_px(p) for p in quad], outline=RED + (255,), width=4)

    # direction arrow only where the Guide drew one (bayons, marcoux, prunieres) —
    # never invented (st_blaise has none and gets none)
    if "axis_m" in tr:
        want = tr.get("drawn_bearing", meta.get("dir"))
        tail, head = orient(tr["axis_m"], want)
        if "drawn_bearing" in tr:
            # the photo carries a literal "<len> m / <bearing>°" label: stretch the
            # extracted line (which stops at the endpoint dots) to the stated length
            L = math.dist(tail, head)
            c = ((tail[0] + head[0]) / 2, (tail[1] + head[1]) / 2)
            k = {"bayons": 261, "marcoux": 250}.get(slug, L) / L / 2
            tail = (c[0] + (tail[0] - c[0]) * 2 * k, c[1] + (tail[1] - c[1]) * 2 * k)
            head = (c[0] + (head[0] - c[0]) * 2 * k, c[1] + (head[1] - c[1]) * 2 * k)
        else:
            # a chunky pointer, not a measured run: keep its drawn position, take the
            # bearing from the notes' stated preferred direction, standard length
            c = ((tail[0] + head[0]) / 2, (tail[1] + head[1]) / 2)
            u = (math.sin(math.radians(want)), math.cos(math.radians(want)))
            tail = (c[0] - u[0] * 75, c[1] - u[1] * 75)
            head = (c[0] + u[0] * 75, c[1] + u[1] * 75)
        if slug == "bayons":
            # the drawn run line doubles as the landing rectangle: 60 m wide around it
            L = math.dist(tail, head)
            ux = (head[0] - tail[0]) / L
            uy = (head[1] - tail[1]) / L
            px_, py_ = -uy, ux
            w2 = 30
            quad = [(tail[0] + px_ * w2, tail[1] + py_ * w2),
                    (head[0] + px_ * w2, head[1] + py_ * w2),
                    (head[0] - px_ * w2, head[1] - py_ * w2),
                    (tail[0] - px_ * w2, tail[1] - py_ * w2)]
            d.polygon([to_px(p) for p in quad], outline=RED + (255,), width=4)
        # the arrow stays where the Guide drew it — for marcoux that is photo 1's
        # 250 m usable segment of the longer marked track photo 0 outlines
        draw_arrow(d, to_px, tail, head)

    # rose + bars, same anatomy as field_views cmd_render
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
        nfont = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
    except OSError:
        font = small = nfont = ImageFont.load_default()
    x, y, r = 56, 70, 36
    d.ellipse([x - r - 7, y - r - 7, x + r + 7, y + r + 7], fill=(10, 15, 25, 140))
    d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255, 220), width=2)
    for ang in range(0, 360, 45):
        hh = math.radians(ang)
        ln = r if ang % 90 == 0 else r * 0.5
        tip = (x + ln * math.sin(hh), y - ln * math.cos(hh))
        bl = (x + 6 * math.sin(hh + math.pi / 2), y - 6 * math.cos(hh + math.pi / 2))
        br = (x + 6 * math.sin(hh - math.pi / 2), y - 6 * math.cos(hh - math.pi / 2))
        d.polygon([tip, bl, br], fill=RED + (255,) if ang == 0 else (255, 255, 255, 235))
    d.text((x, y - r - 9), "N", font=nfont, fill=(255, 255, 255, 255), anchor="mb",
           stroke_width=2, stroke_fill=(10, 15, 25, 255))
    bar_h = 56
    d.rectangle([0, PXH - bar_h, PXW, PXH], fill=(10, 15, 25, 175))
    d.text((14, PXH - bar_h + 8), NAMES[slug], font=font, fill=(255, 255, 255, 255))
    d.text((14, PXH - 20),
           crop["attribution"] + " · Annotations: Guide des Aires de Sécurité",
           font=small, fill=(200, 206, 218, 255))
    out_path = OUT / f"final_{slug}.jpg"
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(
        out_path, quality=90)
    tmp.unlink()
    print(f"rendered {out_path.name}")


if __name__ == "__main__":
    for slug in (sys.argv[1:] or ["bayons", "st_blaise", "prunieres", "marcoux"]):
        render(slug)
