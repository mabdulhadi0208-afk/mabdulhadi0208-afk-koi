#!/usr/bin/env python3
"""Koi 2.0 glass sounds: tiny procedural WAVs (22.05 kHz, mono, 16-bit), written to assets/sounds/.
Each is a struck-glass voice: a pure tone plus quiet inharmonic overtones (1, 2.32, 4.25, 6.63) with fast decays,
a 2 ms attack and a soft low-pass, peaking around -14 dBFS. Koi only loads them once you turn sounds on.
   python3 tools/make-sounds.py
"""
import math, os, struct, wave, random
SR = 22050
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'sounds'); os.makedirs(OUT, exist_ok=True)
PART = [(1, 1, 1), (2.32, .22, .55), (4.25, .07, .32), (6.63, .025, .2)]

def glass(f, dur, at=0.0, gain=1.0, slide=1.0):
    n = int(SR * (at + dur)); buf = [0.0] * n; s0 = int(SR * at)
    for m, a, dk in PART:
        ph = 0.0
        for i in range(n - s0):
            t = i / SR; fr = f * m * (slide ** (t / dur))
            ph += 2 * math.pi * fr / SR
            env = min(1, t / .002) * math.exp(-t / (dur * dk * .32))
            buf[s0 + i] += a * gain * env * math.sin(ph)
    return buf

def mix(*parts):
    n = max(len(p) for p in parts); out = [0.0] * n
    for p in parts:
        for i, v in enumerate(p): out[i] += v
    return out

def write(name, x, peak=.2):
    # gentle one-pole low-pass, normalise, short fade-out
    y, prev = [], 0.0
    for v in x: prev += .55 * (v - prev); y.append(prev)
    mx = max(1e-9, max(abs(v) for v in y)); k = peak / mx; n = len(y)
    with wave.open(os.path.join(OUT, name + '.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v * k * min(1, (n - i) / (SR * .01)))) * 32767)) for i, v in enumerate(y)))

write('open',   mix(glass(784, .16), glass(1175, .2, at=.035, gain=.8)), .2)
write('tick',   glass(1568, .045, gain=.9), .1)
write('select', glass(1046, .08), .14)
write('launch', mix(glass(988, .14), glass(1319, .18, at=.05, gain=.85), glass(1976, .2, at=.09, gain=.4)), .22)
write('close',  glass(880, .12, slide=.7), .13)
write('page',   glass(1318, .07, slide=1.08), .12)
for f in sorted(os.listdir(OUT)): print(f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
