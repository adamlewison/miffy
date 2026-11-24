#!/usr/bin/env python3
"""
Side-by-side contact sheet, for comparing renders with each other or with the
reference photos (reference/photos/*.jpg).

    python3 tools/sheet.py OUT.png reference/photos/front.jpg .oney-out/front.png [...]
    python3 tools/sheet.py OUT.png --crop 0.47,0.32,0.70,0.48 reference/photos/held-paw.jpg  .oney-out/paw.png

--crop x0,y0,x1,y1 (fractions of width/height) applies to the image right after it.
The photos are 1932x2576; use fractions, not pixels.  Needs Pillow (pip install pillow).
"""
import sys
from PIL import Image

H = 520


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        print(__doc__)
        sys.exit(2)
    out, rest = a[0], a[1:]
    ims, crop = [], None
    i = 0
    while i < len(rest):
        if rest[i] == "--crop":
            crop = [float(x) for x in rest[i + 1].split(",")]
            i += 2
            continue
        im = Image.open(rest[i]).convert("RGB")
        if crop:
            w, h = im.size
            im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
            crop = None
        w, h = im.size
        ims.append(im.resize((max(1, int(w * H / h)), H)))
        i += 1
    W = sum(im.width for im in ims) + 6 * (len(ims) - 1)
    sheet = Image.new("RGB", (W, H), "white")
    x = 0
    for im in ims:
        sheet.paste(im, (x, 0))
        x += im.width + 6
    sheet.save(out)
    print(out)


if __name__ == "__main__":
    main()
