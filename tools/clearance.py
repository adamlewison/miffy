#!/usr/bin/env python3
"""
Rest-pose clearances of Oney's arms and ears (from the same maths the build uses).
Run after changing arm/ear shapes or positions in blender/build_oney.py, before rebuilding.

    .bvenv/bin/python tools/clearance.py

Rules of thumb (model units ~ metres for a 1.35-tall toy; fur is ~0.013 deep):
  * arms: >= ~0.015 from body/head below the shoulder, so they can lift away cleanly
  * ears: >= ~0.012 from head, >= ~0.02 from arms/body, or the fur visibly merges
Negative = the parts intersect at rest (always a bug).
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "blender"))
import build_oney as b  # noqa: E402

print("ARMS (surface-to-body/head clearance around the arm, worst point)")
C, ts, T, U, V = b.arm_frames(1)
a, bb = b.arm_dims(ts)
for t in (0.3, 0.45, 0.6, 0.75, 0.85, 0.93):
    i = int(np.searchsorted(ts, t))
    worst = 9.0
    for ph in np.linspace(0, 2 * np.pi, 24, endpoint=False):
        P = (C[i] + U[i] * a[i] * np.cos(ph) + V[i] * bb[i] * np.sin(ph))[None]
        worst = min(worst, b.body_parts_sdf(P)[0], b.sdf_radial(b.head, P)[0])
    flag = "  <-- too close" if worst < 0.012 else ""
    print(f"  t={t:.2f}  width={2 * a[i]:.3f}  depth={2 * bb[i]:.3f}  clearance={worst:+.3f}{flag}")

print("EARS (inner edge / centre / outer edge; what each is closest to)")
Ce, te, Te, We, Ne = b.ear_frame(1)
width, thick = b.ear_profile(te)
for t in (0.22, 0.32, 0.42, 0.55, 0.66, 0.77, 0.87, 0.95):
    i = int(np.searchsorted(te, t))
    row = []
    for lat in (-0.45, 0.0, 0.45):
        P = (Ce[i] + We[i] * lat * width[i])[None]
        h, bo, ar = b.sdf_radial(b.head, P)[0], b.body_parts_sdf(P)[0], b.arms_sdf(P)[0]
        m = min(h, bo, ar) - 0.5 * thick[i]
        who = ["head", "body", "arm"][int(np.argmin([h, bo, ar]))]
        row.append(f"{m:+.3f}({who})")
    print(f"  t={t:.2f}  y={Ce[i][1]:.2f}  " + "  ".join(row))
