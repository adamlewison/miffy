#!/usr/bin/env python3
"""
Solves the arm angles for Oney's gestures, for the current arm shape.
Paste the output into the `poses` option in src/components/bunny/GlbBunny.tsx.

    .bvenv/bin/python tools/solve_poses.py

The rig applies Euler XYZ (three.js order: R = Rx * Ry * Rz) to each arm bone,
whose local axes are world-aligned; poses are [rotX, rotZ (mirrored per side), stretch].
Targets are where the paw tip should end up, relative to the shoulder pivot
(design space: x right, y up, z toward the camera). After changing poses, run
tools/solid.cjs — the collision solve keeps paws on (not in) her face either way,
but a good target means it barely has to.
"""
import os
import sys
from itertools import product

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "blender"))
import build_oney as b  # noqa: E402

TARGETS = {
    "wave": (0.06, 0.32, 0.26),  # paw up beside her cheek, in front of the ear
    "sad": (-0.12, 0.27, 0.27),  # paws over her face (head also bows)
    "nuzzle": (-0.05, -0.12, 0.36),  # arms forward and in, a cuddle
}


def Rx(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def Rz(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


C, ts = b.arm_curve(1)
rest = C[-1] - np.array(b.BONES["arm_L"][0])
print("rest paw tip relative to shoulder:", np.round(rest, 3))
for name, t in TARGETS.items():
    t = np.array(t)
    best = min(
        ((np.linalg.norm(Rx(ax) @ Rz(az) @ rest - t), ax, az) for ax, az in product(np.linspace(-3.1, 0.5, 361), np.linspace(-1.5, 1.5, 151))),
        key=lambda r: r[0],
    )
    print(f"  {name:7s} [{best[1]:.2f}, {best[2]:.2f}, 1.0]   (error {best[0] * 100:.1f} cm)")
