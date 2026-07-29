#!/usr/bin/env python3
"""k-sample consensus for the vision pipeline.

analyze NAME  - read demo/variance-style sample JSONs (samples/NAME_s*.json), decide:
                agree (max pairwise centre distance <= GATE_M) -> consensus mean axis
                disagree -> union oval covering every sample axis
render NAME   - final production-style view from the consensus decision:
                agree    -> tight dashed oval on the consensus axis (+ solid run
                            rectangle if a refined run JSON exists)
                disagree -> generous dashed union oval, no run claim
"""
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import field_views as fv  # noqa: E402

ROOT = Path(os.environ.get("FIELD_VIEWS_WORK", "field-views-work"))
SAMPLES = ROOT / "samples"
PX_W, PX_H = 975, 1300
GATE_M = 100.0
RED = (226, 40, 25)

FIELDS = {
    "prunieres": dict(lat=44.5342, lon=6.3633, label="Prunieres"),
    "st_blaise": dict(lat=44.8728, lon=6.6100, label="St Blaise"),
    "bayons": dict(lat=44.3358, lon=6.1633, label="Bayons"),
}


def sample_geometry(pred, mpp=1.85, cdx=0.0, cdy=0.0):
    e1 = cdx + (pred["p1"]["x"] - PX_W / 2) * mpp
    n1 = cdy + (PX_H / 2 - pred["p1"]["y"]) * mpp
    e2 = cdx + (pred["p2"]["x"] - PX_W / 2) * mpp
    n2 = cdy + (PX_H / 2 - pred["p2"]["y"]) * mpp
    return dict(ends=((e1, n1), (e2, n2)), dx=(e1 + e2) / 2, dy=(n1 + n2) / 2,
                hdg=math.degrees(math.atan2(e2 - e1, n2 - n1)) % 180,
                len=math.hypot(e2 - e1, n2 - n1),
                width_m=pred.get("width_m") or 80,
                confidence=pred.get("confidence", 0))


def mean_heading(hdgs):
    # circular mean on the half-circle (headings are mod 180)
    s = sum(math.sin(2 * math.radians(h)) for h in hdgs)
    c = sum(math.cos(2 * math.radians(h)) for h in hdgs)
    return (math.degrees(math.atan2(s, c)) / 2) % 180


def analyze(name):
    files = sorted(SAMPLES.glob(f"{name}_s*.json"))
    geoms = [sample_geometry(json.loads(f.read_text())) for f in files]
    if len(geoms) < 3:
        sys.exit(f"{name}: only {len(geoms)} samples")
    dists = [math.hypot(a["dx"] - b["dx"], a["dy"] - b["dy"])
             for i, a in enumerate(geoms) for b in geoms[i + 1:]]
    hdg = mean_heading([g["hdg"] for g in geoms])
    agree = max(dists) <= GATE_M
    cx = sum(g["dx"] for g in geoms) / len(geoms)
    cy = sum(g["dy"] for g in geoms) / len(geoms)
    out = dict(agree=agree, pairwise_m=[round(d) for d in dists], hdg=round(hdg, 1),
               samples=len(geoms),
               mean_conf=round(sum(g["confidence"] for g in geoms) / len(geoms), 2))
    if agree:
        out.update(dx=round(cx, 1), dy=round(cy, 1),
                   len=round(sum(g["len"] for g in geoms) / len(geoms)),
                   width_m=round(sum(g["width_m"] for g in geoms) / len(geoms)))
    else:
        # Union oval: cover every sample's axis endpoints along the mean axis.
        h = math.radians(hdg)
        ax, ay = math.sin(h), math.cos(h)
        px_, py_ = math.cos(h), -math.sin(h)
        along, perp = [], []
        for g in geoms:
            for (e, n) in g["ends"]:
                along.append((e - cx) * ax + (n - cy) * ay)
                perp.append((e - cx) * px_ + (n - cy) * py_)
        mid_a = (max(along) + min(along)) / 2
        mid_p = (max(perp) + min(perp)) / 2
        out.update(dx=round(cx + mid_a * ax + mid_p * px_, 1),
                   dy=round(cy + mid_a * ay + mid_p * py_, 1),
                   semi_a=round((max(along) - min(along)) / 2 + 40),
                   semi_b=round(max((max(perp) - min(perp)) / 2 + 40,
                                    max(g["width_m"] for g in geoms) / 2 + 40, 90)))
    (ROOT / f"consensus_{name}.json").write_text(json.dumps(out))
    state = "AGREE" if agree else "DISAGREE -> union oval"
    print(f"{name}: {state}  pairwise {out['pairwise_m']} m  hdg {out['hdg']}  "
          f"centre ({out['dx']},{out['dy']})  conf~{out['mean_conf']}")


def render(name):
    from PIL import Image, ImageDraw, ImageFont
    f = FIELDS[name]
    c = json.loads((ROOT / f"consensus_{name}.json").read_text())
    if c["agree"]:
        semi_a = c["len"] / 2 * 1.12
        semi_b = max(c["width_m"] / 2 * 1.2, 55)
    else:
        semi_a, semi_b = c["semi_a"], c["semi_b"]
    frame_w = min(max(semi_a * 2 * 1.5, math.hypot(c["dx"], c["dy"]) * 2.2, 900.0), 2000.0)
    fdx, fdy = c["dx"] / 2, c["dy"] / 2
    clat = f["lat"] + fdy / 111320
    clon = f["lon"] + fdx / (111320 * math.cos(math.radians(f["lat"])))
    crop = ROOT / f"consensus_{name}.crop.jpg"
    mpp = fv.wms_crop(clat, clon, frame_w, crop, "FR")
    img = Image.open(crop).convert("RGB")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    def to_px(e, n):
        return (PX_W / 2 + (e - fdx) / mpp, PX_H / 2 - (n - fdy) / mpp)

    h = math.radians(c["hdg"])
    ax, ay = math.sin(h), math.cos(h)
    px_, py_ = math.cos(h), -math.sin(h)
    pts = [to_px(c["dx"] + semi_a * math.cos(t) * ax + semi_b * math.sin(t) * px_,
                 c["dy"] + semi_a * math.cos(t) * ay + semi_b * math.sin(t) * py_)
           for t in (2 * math.pi * i / 240 for i in range(241))]
    d.polygon(pts, fill=RED + (22,))
    i = 0
    while i < 240:
        d.line(pts[i:i + 11], fill=RED + (255,), width=4)
        i += 16

    run_file = ROOT / f"consensus_{name}_run.json"
    if c["agree"] and run_file.exists():
        r = json.loads(run_file.read_text())
        rh = math.radians(r["hdg"])
        rax, ray = math.sin(rh), math.cos(rh)
        rpx, rpy = math.cos(rh), -math.sin(rh)
        wid = max(r.get("width_m") or 30, 20)
        corners = [to_px(r["dx"] + sa * rax * r["len"] / 2 + sp * rpx * wid / 2,
                         r["dy"] + sa * ray * r["len"] / 2 + sp * rpy * wid / 2)
                   for sa, sp in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
        d.polygon(corners, outline=RED + (255,), width=4)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
        nfont = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
    except OSError:
        font = small = nfont = ImageFont.load_default()
    x, y, r_ = 56, 70, 36
    d.ellipse([x - r_ - 7, y - r_ - 7, x + r_ + 7, y + r_ + 7], fill=(10, 15, 25, 140))
    d.ellipse([x - r_, y - r_, x + r_, y + r_], outline=(255, 255, 255, 220), width=2)
    for ang in range(0, 360, 45):
        hh = math.radians(ang)
        ln = r_ if ang % 90 == 0 else r_ * 0.5
        tip = (x + ln * math.sin(hh), y - ln * math.cos(hh))
        bl = (x + 6 * math.sin(hh + math.pi / 2), y - 6 * math.cos(hh + math.pi / 2))
        br = (x + 6 * math.sin(hh - math.pi / 2), y - 6 * math.cos(hh - math.pi / 2))
        d.polygon([tip, bl, br], fill=RED + (255,) if ang == 0 else (255, 255, 255, 235))
    d.text((x, y - r_ - 9), "N", font=nfont, fill=(255, 255, 255, 255), anchor="mb",
           stroke_width=2, stroke_fill=(10, 15, 25, 255))
    bar_h = 56
    d.rectangle([0, PX_H - bar_h, PX_W, PX_H], fill=(10, 15, 25, 175))
    mode = ("consensus of 3" if c["agree"]
            else f"area of uncertainty (3 samples spread {max(c['pairwise_m'])} m)")
    d.text((14, PX_H - bar_h + 8), f"{f['label']}  ·  {mode}", font=font,
           fill=(255, 255, 255, 255))
    d.text((14, PX_H - 20), "Orthophoto © IGN France (Licence Ouverte)",
           font=small, fill=(200, 206, 218, 255))
    out = ROOT / f"consensus_{name}.jpg"
    Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(out, quality=90)
    crop.unlink()
    print(f"rendered {out.name}")


SAMPLES.mkdir(exist_ok=True)
{"analyze": analyze, "render": render}[sys.argv[1]](sys.argv[2])
