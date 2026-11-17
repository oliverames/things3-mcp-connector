"""Draws the connector's icons (public/*.png, favicon.ico). Original artwork for this project, MIT licensed.
Run: python3 scripts/make-icons.py  (needs Pillow)."""
from PIL import Image, ImageDraw
import os

S = 1024
root = os.path.join(os.path.dirname(__file__), "..", "public")
top, bottom = (45, 212, 191), (13, 116, 144)

def master():
    g = Image.new("RGB", (S, S))
    px = g.load()
    for y in range(S):
        t = y / (S - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(S):
            px[x, y] = c
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(g, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # three list rows with a bold check beside the first
    w = int(S * 0.075)
    for k, y in enumerate((0.34, 0.52, 0.70)):
        yy = int(S * y)
        d.rounded_rectangle((int(S * 0.43), yy - w // 2, int(S * 0.80), yy + w // 2), radius=w // 2, fill=(255, 255, 255, 235 if k == 0 else 170))
    pts = [(0.19, 0.345), (0.255, 0.41), (0.34, 0.27)]
    d.line([(int(S * x), int(S * y)) for x, y in pts], fill=(255, 255, 255, 255), width=w, joint="curve")
    for x, y in (pts[0], pts[2]):
        r = w // 2
        d.ellipse((int(S * x) - r, int(S * y) - r, int(S * x) + r, int(S * y) + r), fill=(255, 255, 255, 255))
    for y in (0.52, 0.70):
        r = int(S * 0.045)
        cx, cy = int(S * 0.265), int(S * y)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, 170), width=w // 2)
    return img

m = master()
for name, size in (("icon-1024", 1024), ("icon-512", 512), ("icon-256", 256), ("icon-192", 192), ("apple-touch-icon", 180),
                   ("favicon-96x96", 96), ("favicon-48x48", 48), ("favicon-32x32", 32), ("favicon-16x16", 16)):
    m.resize((size, size), Image.LANCZOS).save(os.path.join(root, name + ".png"), optimize=True)
m.save(os.path.join(root, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
