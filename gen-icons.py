#!/usr/bin/env python3
"""Generate WebHub app icon (512px) and tray template icon (32px) as PNGs."""
import os, struct, zlib, math

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
os.makedirs(OUT, exist_ok=True)


def png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, w, h, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4])
                   for y in range(h))
    png = (b"\x89PNG\r\n\x1a\n"
           + png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + png_chunk(b"IDAT", zlib.compress(raw, 9))
           + png_chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, f"({w}x{h})")


def rounded_rect(x, y, cx, cy, w, h, r):
    """Return alpha coverage (0..1) of a rounded rectangle at point (x, y)."""
    dx = abs(x - cx) - (w / 2 - r)
    dy = abs(y - cy) - (h / 2 - r)
    if dx > 0 and dy > 0:
        d = math.hypot(dx, dy)
        return max(0.0, min(1.0, r - d + 0.5))
    return 1.0 if (dx <= 0 or dy <= 0) else 0.0


def lerp(a, b, t):
    return a + (b - a) * t


def make_app_icon(size=512):
    """Rounded-square gradient background + white 2x2 app-grid glyph."""
    px = [0] * (size * size * 4)
    top = (91, 66, 232)      # #5B42E8
    bottom = (35, 149, 255)  # #2395FF
    bg_r = size * 0.22
    cell = size * 0.16
    gap = size * 0.085
    cell_r = size * 0.045
    off = (cell * 2 + gap) / 2

    for y in range(size):
        for x in range(size):
            a = rounded_rect(x + 0.5, y + 0.5, size / 2, size / 2, size, size, bg_r)
            if a <= 0:
                continue
            t = (y / size)
            r = lerp(top[0], bottom[0], t)
            g = lerp(top[1], bottom[1], t)
            b = lerp(top[2], bottom[2], t)
            # white glyph
            white = 0.0
            for gx in (0, 1):
                for gy in (0, 1):
                    cx = size / 2 - off + gx * (cell + gap) + cell / 2
                    cy = size / 2 - off + gy * (cell + gap) + cell / 2
                    white = max(white, rounded_rect(x + 0.5, y + 0.5, cx, cy, cell, cell, cell_r))
            r = lerp(r, 255, white)
            g = lerp(g, 255, white)
            b = lerp(b, 255, white)
            i = (y * size + x) * 4
            px[i] = int(r)
            px[i + 1] = int(g)
            px[i + 2] = int(b)
            px[i + 3] = int(a * 255)
    return px


def make_tray_icon(size=32):
    """Black rounded square with 4 transparent holes (template image)."""
    px = [0] * (size * size * 4)
    bg_r = size * 0.30
    cell = size * 0.20
    gap = size * 0.13
    cell_r = size * 0.05
    off = (cell * 2 + gap) / 2
    for y in range(size):
        for x in range(size):
            bg = rounded_rect(x + 0.5, y + 0.5, size / 2, size / 2, size, size, bg_r)
            holes = 0.0
            for gx in (0, 1):
                for gy in (0, 1):
                    cx = size / 2 - off + gx * (cell + gap) + cell / 2
                    cy = size / 2 - off + gy * (cell + gap) + cell / 2
                    holes = max(holes, rounded_rect(x + 0.5, y + 0.5, cx, cy, cell, cell, cell_r))
            a = bg * (1.0 - holes)
            if a <= 0:
                continue
            i = (y * size + x) * 4
            px[i] = 0
            px[i + 1] = 0
            px[i + 2] = 0
            px[i + 3] = int(a * 255)
    return px


if __name__ == "__main__":
    write_png(os.path.join(OUT, "icon.png"), 512, 512, make_app_icon())
    write_png(os.path.join(OUT, "trayTemplate.png"), 32, 32, make_tray_icon())
