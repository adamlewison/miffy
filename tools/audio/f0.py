#!/usr/bin/env python3
"""
Median pitch (F0) of speech in WAV files — to check Oney sounds like a small child.
A 3-4 year old is roughly 300-400 Hz; an adult woman ~180-220 Hz.

    python3 tools/audio/f0.py .oney-out/voice/*.wav
"""
import sys
import wave

import numpy as np


def f0(path):
    with wave.open(path) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        if w.getnchannels() > 1:
            x = x.reshape(-1, w.getnchannels()).mean(1)
    hop, win, out = int(sr / 100), 1024 if sr <= 24000 else 2048, []
    for i in range(0, len(x) - win, hop):
        f = x[i : i + win] * np.hanning(win)
        if np.sqrt(np.mean(f**2)) < 0.02:
            continue
        ac = np.correlate(f, f, "full")[win - 1 :]
        lo, hi = int(sr / 600), int(sr / 80)
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.4 * ac[0]:
            out.append(sr / k)
    return np.array(out), len(x) / sr


for p in sys.argv[1:]:
    v, dur = f0(p)
    if len(v):
        print(f"{p}: median {np.median(v):.0f} Hz (p25 {np.percentile(v, 25):.0f}, p75 {np.percentile(v, 75):.0f}), {dur:.1f}s")
    else:
        print(f"{p}: no voiced audio")
