#!/usr/bin/env python3
"""Generate a test JPEG with EXIF GPS at given coordinates.

For smoke-testing the contribution flow: the intake Worker pre-verifies a submission when the
photo's EXIF GPS is within 1 km of the field, so this creates a photo "taken at" any field.

  python scripts/make_test_photo.py --lat 43.7378 --lon 5.7836 --out /tmp/at-vinon.jpg

The long edge defaults to 2600 px (above the 2560 px contribution minimum). --offset-m shifts
the GPS point roughly north-east so the distance shown in the geo check is non-zero.
"""

from __future__ import annotations

import argparse
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw


def to_dms_rationals(value: float) -> list[tuple[int, int]]:
    """Decimal degrees -> EXIF [(deg,1),(min,1),(sec*1000,1000)] rationals (absolute value)."""
    value = abs(value)
    deg = int(value)
    minutes_f = (value - deg) * 60
    minutes = int(minutes_f)
    seconds_milli = round((minutes_f - minutes) * 60 * 1000)
    return [(deg, 1), (minutes, 1), (seconds_milli, 1000)]


def gps_app1(lat: float, lon: float) -> bytes:
    """APP1 Exif segment: TIFF(II), IFD0 with a GPS-IFD pointer, GPS lat/lon refs + rationals."""
    def rat3(dms: list[tuple[int, int]]) -> bytes:
        return b"".join(struct.pack("<II", num, den) for num, den in dms)

    lat_ref = b"N\x00" if lat >= 0 else b"S\x00"
    lon_ref = b"E\x00" if lon >= 0 else b"W\x00"
    tiff = b"II" + struct.pack("<HI", 42, 8)
    tiff += struct.pack("<H", 1)                          # IFD0: 1 entry
    tiff += struct.pack("<HHII", 0x8825, 4, 1, 26)        # GPS IFD pointer -> offset 26
    tiff += struct.pack("<I", 0)
    tiff += struct.pack("<H", 4)                          # GPS IFD: 4 entries, data at 80
    tiff += struct.pack("<HHI", 0x0001, 2, 2) + lat_ref + b"\x00\x00"
    tiff += struct.pack("<HHII", 0x0002, 5, 3, 80)
    tiff += struct.pack("<HHI", 0x0003, 2, 2) + lon_ref + b"\x00\x00"
    tiff += struct.pack("<HHII", 0x0004, 5, 3, 104)
    tiff += struct.pack("<I", 0)
    tiff += rat3(to_dms_rationals(lat)) + rat3(to_dms_rationals(lon))
    payload = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lat", type=float, required=True, help="Latitude, decimal degrees")
    parser.add_argument("--lon", type=float, required=True, help="Longitude, decimal degrees")
    parser.add_argument("--out", required=True, help="Output JPEG path")
    parser.add_argument("--offset-m", type=float, default=150.0, help="Shift the GPS point ~this far NE (default 150 m)")
    parser.add_argument("--size", type=int, default=2600, help="Long edge in px (default 2600)")
    parser.add_argument("--label", default="test photo", help="Text drawn on the image")
    args = parser.parse_args()

    dlat = args.offset_m / 111_320
    dlon = args.offset_m / (111_320 * math.cos(math.radians(args.lat)))
    lat, lon = args.lat + dlat, args.lon + dlon

    w, h = args.size, int(args.size * 0.62)
    img = Image.new("RGB", (w, h), (72, 108, 62))
    draw = ImageDraw.Draw(img)
    draw.rectangle([w * 0.08, h * 0.55, w * 0.92, h * 0.72], fill=(126, 152, 92))
    draw.text((40, 40), f"{args.label} @ {lat:.5f},{lon:.5f}", fill=(255, 255, 255))
    from io import BytesIO
    buf = BytesIO()
    img.save(buf, "JPEG", quality=60)
    data = buf.getvalue()
    assert data[:2] == b"\xff\xd8"
    Path(args.out).write_bytes(data[:2] + gps_app1(lat, lon) + data[2:])
    print(f"{args.out}: {w}x{h}px, EXIF GPS {lat:.6f},{lon:.6f} (~{args.offset_m:.0f} m offset)")


if __name__ == "__main__":
    main()
