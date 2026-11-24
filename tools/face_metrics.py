#!/usr/bin/env python3
"""
Oney's face proportions vs the real toy (reference/photos/front.jpg), as fractions of head width.
Run after changing the head or face layout in blender/build_oney.py:

    .bvenv/bin/python tools/face_metrics.py

Real values were measured on the photo (eyes found by colour; head outline, nose and
muzzle read off a 773x799 crop of the head). The photo is slightly turned, so eye
spacing reads ~3% narrow there.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "blender"))
import build_oney as b  # noqa: E402

FUR = 0.013
# Real toy, front photo (px in the head crop): head x 45..715, crown y 30, muzzle bottom y 740.
REAL = {
    "head height / width": (740 - 30) / 670,
    "eye spacing": (610 - 205) / 670,
    "eye width": 71 / 670,
    "eye height": 90 / 670,
    "eye line below crown": (386 - 30) / 670,
    "nose top width": (525 - 320) / 670,
    "nose top below eye line": (460 - 386) / 670,
    "nose tip below eye line": (600 - 386) / 670,
    "muzzle width": (660 - 125) / 670,
    "muzzle top (sides) below eye line": (485 - 386) / 670,
    "muzzle bottom below eye line": (735 - 386) / 670,
}


def P(u, v):
    return b.snap_to_plush(b.head.at_uv(np.array(u, float), np.array(v, float)))


# Head silhouette from the front: widest x of the head surface (+ fur), crown and chin.
D = np.stack(np.meshgrid(np.linspace(-1, 1, 161), np.linspace(-1, 1, 161), indexing="ij"), -1).reshape(-1, 2)
dirs = np.c_[D, np.zeros(len(D))]
dirs = dirs[np.linalg.norm(dirs, axis=1) > 0.2]
S = b.head.at_dir(dirs)
half_w = np.max(np.abs(S[:, 0])) + FUR
crown = b.HEAD_C[1] + b.head_radius(np.array([[0.0, 1.0, 0.0]]))[0] + FUR
hw = 2 * half_w
eyes = [P(*e) for e in b.EYE_UV]
eye_y = np.mean([e[1] for e in eyes])
ru, rv = b.EYE_R
e0 = b.EYE_UV[1]
eye_w = P(e0[0] + ru, e0[1])[0] - P(e0[0] - ru, e0[1])[0]
eye_h = P(e0[0], e0[1] + rv)[1] - P(e0[0], e0[1] - rv)[1]
nose = [P(*p) for p in b.NOSE_POLY]
muz = np.array([P(*p) for p in b.MUZZLE_POLY])
ours = {
    "head height / width": (crown - muz[:, 1].min()) / hw,
    "eye spacing": abs(eyes[1][0] - eyes[0][0]) / hw,
    "eye width": eye_w / hw,
    "eye height": eye_h / hw,
    "eye line below crown": (crown - eye_y) / hw,
    "nose top width": (max(p[0] for p in nose) - min(p[0] for p in nose)) / hw,
    "nose top below eye line": (eye_y - max(p[1] for p in nose)) / hw,
    "nose tip below eye line": (eye_y - min(p[1] for p in nose)) / hw,
    "muzzle width": (muz[:, 0].max() - muz[:, 0].min()) / hw,
    "muzzle top (sides) below eye line": (eye_y - muz[2][1]) / hw,
    "muzzle bottom below eye line": (eye_y - muz[:, 1].min()) / hw,
}
print(f"head width {hw:.3f} (crown y {crown:.3f})\n")
print(f"{'':36s} {'real':>6s} {'Oney':>6s}   diff")
for k in REAL:
    d = ours[k] / REAL[k] - 1
    print(f"{k:36s} {REAL[k]:6.3f} {ours[k]:6.3f}   {d * 100:+5.0f}%{'   <--' if abs(d) > 0.08 else ''}")
