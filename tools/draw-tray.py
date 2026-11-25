#!/usr/bin/env python3
"""Koi 2.0 menu-bar icon frames: macOS template images (black + alpha, so macOS tints them for light and dark
menu bars), 16 pt with @2x (16x16 and 32x32 px). trayFrame0..6Template: the five-petal fan blooms from a closed bud
(0) to the full fan (6, the resting icon). Koi plays 0,1,3,5,6 once when the fan or the popover opens.
Drawn 16x oversize and scaled down so edges stay crisp.   python3 tools/draw-tray.py
"""
import math, os
from PIL import Image, ImageDraw
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
SS = 16

def petal(d, cx, cy, ang, L, W):
    # a petal: widest about 60% out, pointed tip, drawn as a polygon from a smooth outline
    pts = []
    for j in range(41):
        u = j / 40
        w = W * math.sin(math.pi * min(1, u * 1.08)) ** 0.8 * (1 - .25 * u)
        pts.append((u, w))
    outline = [(u * L, w / 2) for u, w in pts] + [(u * L, -w / 2) for u, w in reversed(pts)]
    ca, sa = math.cos(ang), math.sin(ang)
    d.polygon([(cx + x * ca - y * sa, cy + x * sa + y * ca) for x, y in outline], fill=255)

def frame(pt, k):
    W = pt * SS; m = Image.new('L', (W, W), 0); d = ImageDraw.Draw(m)
    t = k / 6; t = 1 - (1 - t) ** 2
    cx, cy = W * .5, W * .82
    spread = math.radians(30 + 62 * t)
    L, PW = W * .6, W * (.19 + .03 * t)
    for i in range(5):
        a = -math.pi / 2 - spread / 2 + spread * i / 4
        petal(d, cx, cy, a, L, PW)
    # carve thin gaps between petals so the fan reads as five blades
    if t > .3:
        for i in range(4):
            a = -math.pi / 2 - spread / 2 + spread * (i + .5) / 4
            ex, ey = cx + L * 1.1 * math.cos(a), cy + L * 1.1 * math.sin(a)
            d.line([(cx, cy), (ex, ey)], fill=0, width=int(W * .045 * min(1, t * 1.6)))
    R = W * .13; d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=0)
    R2 = W * .085; d.ellipse([cx - R2, cy - R2, cx + R2, cy + R2], fill=255)
    return m

for k in range(7):
    for pt, sfx in ((16, ''), (32, '@2x')):
        a = frame(16, k).resize((pt, pt), Image.LANCZOS)
        im = Image.new('RGBA', (pt, pt), (0, 0, 0, 0)); im.putalpha(a)
        im.save(os.path.join(OUT, f'trayFrame{k}Template{sfx}.png'))
print('wrote 7 tray frames (16 pt and @2x) into assets/')
