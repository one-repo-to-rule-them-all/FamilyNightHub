"""Regenerates the GPS-tagged photo fixtures (ADR-0005: GPS stripping is a tested property).

    python -m venv /tmp/fnh-fixtures               # outside the repo; run the rest from frontend/
    /tmp/fnh-fixtures/bin/pip install pillow==12.2.0 pillow-heif==1.8.1
    /tmp/fnh-fixtures/bin/python e2e/fixtures/make_fixtures.py

Writes, next to this file:

- gps.jpg:  2400x1600 JPEG (bigger than the 2048px target, so the resize is exercised) with
            DateTimeOriginal 2026:10:10 19:30:00 and a GPS IFD (lat/long/altitude).
- gps.heic: 1200x800 HEIC with the same EXIF. Chromium can't decode HEIC, so the e2e upload of
            this file goes through the heic-to worker fallback, as a current iPhone would on
            Chrome/Firefox.

The pixels are a plain gradient with a coloured block, so the files stay small. Neither the
script nor its two packages are dependencies of the app; the outputs are committed.
"""

from __future__ import annotations

from pathlib import Path

import pillow_heif
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

GPS_IFD = 0x8825
EXIF_IFD = 0x8769
DATE_TIME_ORIGINAL = 0x9003


def picture(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for x in range(0, width, 8):
        shade = int(255 * x / width)
        draw.rectangle([x, 0, x + 8, height], fill=(shade, 80, 255 - shade))
    draw.rectangle([width // 3, height // 3, width // 2, height // 2], fill=(250, 200, 40))
    return image


def exif() -> Image.Exif:
    data = Image.Exif()
    data[0x010F] = "FNH Test Camera"  # Make
    data.get_ifd(EXIF_IFD)[DATE_TIME_ORIGINAL] = "2026:10:10 19:30:00"
    gps = data.get_ifd(GPS_IFD)
    gps[1] = "N"  # GPSLatitudeRef
    gps[2] = (30.0, 16.0, 1.5)  # GPSLatitude
    gps[3] = "W"  # GPSLongitudeRef
    gps[4] = (97.0, 44.0, 32.25)  # GPSLongitude
    gps[6] = 150.0  # GPSAltitude
    return data


def apple_iloc(data: bytes) -> bytes:
    """Move each item's location from `base_offset` into `extent_offset`, as iPhones lay it out.

    libheif writes base_offset = position, extent_offset = 0. exifr skips base_offset, so on
    libheif's layout it reads the EXIF from byte 0 and gives up; on Apple's it reads it fine.
    Handles exactly what pillow-heif writes: iloc version 0, 4-byte offsets/lengths/bases.
    """
    out = bytearray(data)
    at = out.index(b"iloc") + 4
    version = out[at]
    assert version == 0, version
    sizes = out[at + 4 : at + 6]
    assert sizes == b"\x44\x40", sizes.hex()
    count = int.from_bytes(out[at + 6 : at + 8], "big")
    pos = at + 8
    for _ in range(count):
        pos += 2 + 2  # item_ID, data_reference_index
        base = int.from_bytes(out[pos : pos + 4], "big")
        out[pos : pos + 4] = (0).to_bytes(4, "big")
        pos += 4
        extents = int.from_bytes(out[pos : pos + 2], "big")
        pos += 2
        for _ in range(extents):
            offset = int.from_bytes(out[pos : pos + 4], "big")
            out[pos : pos + 4] = (base + offset).to_bytes(4, "big")
            pos += 8
    return bytes(out)


def main() -> None:
    picture(2400, 1600).save(HERE / "gps.jpg", "JPEG", quality=80, exif=exif().tobytes())
    pillow_heif.register_heif_opener()
    heic = HERE / "gps.heic"
    picture(1200, 800).save(heic, "HEIF", quality=60, exif=exif().tobytes())
    heic.write_bytes(apple_iloc(heic.read_bytes()))
    for name in ("gps.jpg", "gps.heic"):
        reread = Image.open(HERE / name).getexif()
        assert reread.get_ifd(GPS_IFD), f"{name} lost its GPS IFD"
        print(name, (HERE / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
