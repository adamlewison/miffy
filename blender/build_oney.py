#!/usr/bin/env python3
"""
Builds Oney — the 3D plush bunny — as public/bunny.glb, using Blender's Python
API (bpy) headless. Every shape is modelled from the reference photos of the
real toy as sewn plush panels:

  * big egg-shaped head with a centre seam, cream muzzle patch, mustard
    triangle nose, stitched mouth, embroidered eyes with highlights
  * long lop ears (tan outside, beige velour inside, cream piping)
  * pear-shaped sitting body, big cream tummy with a chest fold
  * arms with cream paw tips + stitch, big feet with cream soles + toe stitches
  * cream pom-pom tail

Run (needs `pip install bpy`, Python 3.13):
    python blender/build_oney.py --out public/bunny.glb [--renders DIR]

The rig matches src/components/bunny/rig.ts (bone names + world-aligned
bone axes, so the same procedural animation code drives it). Per-vertex
`_furlen` (fur length mask) and `Color` (baked ambient occlusion) attributes
feed the fur shader in src/components/bunny/fur.ts.

Design space used below: x = right, y = up, z = toward the camera; the toy sits
on y = 0 and is ~1.35 units tall (head top). Converted to Blender's z-up on the
way in, and back to y-up by the glTF exporter.
"""

import argparse
import math
import os
import sys

import numpy as np
import bpy
import bmesh

# ----------------------------------------------------------------------------
# Small maths helpers
# ----------------------------------------------------------------------------


def to_bl(P):
    P = np.asarray(P, float)
    return np.stack([P[..., 0], -P[..., 2], P[..., 1]], -1)


def sstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def norm(v):
    v = np.asarray(v, float)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def srgb_to_linear(hexstr):
    c = np.array([int(hexstr[i : i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def catmull_rom(ctrl, n):
    """Centripetal-ish uniform Catmull-Rom through ctrl points, n samples, plus arc-length t in [0,1]."""
    P = np.asarray(ctrl, float)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    segs = len(P) - 3
    out = []
    for i in range(segs):
        p0, p1, p2, p3 = P[i : i + 4]
        for u in np.linspace(0, 1, 40, endpoint=False):
            u2, u3 = u * u, u * u * u
            out.append(
                0.5
                * (
                    2 * p1
                    + (-p0 + p2) * u
                    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
                    + (-p0 + 3 * p1 - 3 * p2 + p3) * u3
                )
            )
    out.append(P[-2])
    out = np.array(out)
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(out, axis=0), axis=1))]
    s = d / d[-1]
    ts = np.linspace(0, 1, n)
    res = np.stack([np.interp(ts, s, out[:, k]) for k in range(3)], -1)
    return res, ts, d[-1]


# ----------------------------------------------------------------------------
# Colours (sRGB, sampled from the photos and nudged a touch cuter/cleaner)
# ----------------------------------------------------------------------------

COLORS = {
    "fur_tan": "#b8865a",
    "fur_cream": "#e6dac2",
    "fur_beige": "#d2bb98",
    "fur_piping": "#efe6d4",
    "fur_nose": "#a87430",
    "fur_tail": "#ece3d0",
    "eye": "#0d0b0a",
    "eye_shine": "#fbfaf6",
    "thread": "#7a5735",
    "thread_tan": "#a8784c",  # paw finger stitches: tan, just deeper than the fur
}

# ----------------------------------------------------------------------------
# Geometry builders
# ----------------------------------------------------------------------------


def cube_sphere(n):
    """Uniform quad sphere (unit directions) and outward quad faces."""
    axes = [
        ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
        ((0, 0, 1), (0, 1, 0), (-1, 0, 0)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((1, 0, 0), (0, 0, 1), (0, -1, 0)),
        ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
    ]
    V, F = [], []
    g = np.linspace(-1, 1, n + 1)
    for a, b, c in axes:
        a, b, c = map(np.array, (a, b, c))
        base = len(V)
        for t in g:
            for s in g:
                V.append(c + a * s + b * t)
        for j in range(n):
            for i in range(n):
                v0 = base + j * (n + 1) + i
                F.append((v0, v0 + 1, v0 + n + 2, v0 + n + 1))
    V = np.array(V, float)
    x, y, z = V.T
    V = np.stack(
        [
            x * np.sqrt(1 - y * y / 2 - z * z / 2 + y * y * z * z / 3),
            y * np.sqrt(1 - z * z / 2 - x * x / 2 + z * z * x * x / 3),
            z * np.sqrt(1 - x * x / 2 - y * y / 2 + x * x * y * y / 3),
        ],
        -1,
    )
    key = np.round(V * 1e6).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    newV = V[first]
    F = [tuple(int(inv[k]) for k in f) for f in F]
    return newV, F


class Radial:
    """A star-shaped surface: centre + direction * radius(direction), optional local rotation."""

    def __init__(self, center, radius_fn, R=None):
        self.c = np.asarray(center, float)
        self.radius_fn = radius_fn
        self.R = np.eye(3) if R is None else np.asarray(R, float)

    def at_dir(self, d_local):
        d_local = norm(d_local)
        r = self.radius_fn(d_local)
        return self.c + (d_local * r[..., None]) @ self.R.T

    def front_dir(self, u, v):
        u, v = np.asarray(u, float), np.asarray(v, float)
        w = np.sqrt(np.maximum(1 - u * u - v * v, 1e-4))
        return np.stack([u, v, w], -1)

    def at_uv(self, u, v):
        return self.at_dir(self.front_dir(u, v))

    def local_dir_of(self, P):
        return norm((np.asarray(P) - self.c) @ self.R)

    def mesh(self, n):
        D, F = cube_sphere(n)
        return self.at_dir(D), F, D


def uv_normal(fn, u, v, eps=1e-3):
    Pu = (fn(u + eps, v) - fn(u - eps, v)) / (2 * eps)
    Pv = (fn(u, v + eps) - fn(u, v - eps)) / (2 * eps)
    return norm(np.cross(Pu, Pv))


def smooth_polygon(pts, iters=4):
    P = np.asarray(pts, float)
    for _ in range(iters):  # Chaikin corner cutting
        Q = 0.75 * P + 0.25 * np.roll(P, -1, 0)
        R = 0.25 * P + 0.75 * np.roll(P, -1, 0)
        P = np.stack([Q, R], 1).reshape(-1, 2)
    return P


def outline_from_polygon(poly, center, iters=4):
    P = smooth_polygon(poly, iters) - np.asarray(center)
    ang = np.arctan2(P[:, 1], P[:, 0])
    rad = np.hypot(P[:, 0], P[:, 1])
    order = np.argsort(ang)
    ang, rad = ang[order], rad[order]
    ang = np.r_[ang - 2 * np.pi, ang, ang + 2 * np.pi]
    rad = np.r_[rad, rad, rad]

    def fn(th):
        th = np.mod(np.asarray(th) + np.pi, 2 * np.pi) - np.pi
        r = np.interp(th, ang, rad)
        return r * np.cos(th), r * np.sin(th)

    return fn


def ellipse_outline(ru, rv, power=2.0):
    def fn(th):
        c, s = np.cos(th), np.sin(th)
        e = 2.0 / power
        return ru * np.sign(c) * np.abs(c) ** e, rv * np.sign(s) * np.abs(s) ** e

    return fn


def patch(surface_uv, center, outline, height_fn, rings=14, segs=72):
    """
    A puffy appliqué patch that hugs a parametric surface. surface_uv(u,v) -> P.
    Polar grid around `center` (in u,v), boundary given by outline(theta) -> (du,dv).
    height_fn(rho, u, v) -> offset along the surface normal.
    Returns verts, faces, rho (0 centre .. 1 edge), (u, v).
    """
    cu, cv = center
    us, vs, rhos = [cu], [cv], [0.0]
    th = np.linspace(0, 2 * np.pi, segs, endpoint=False)
    ou, ov = outline(th)
    for k in range(1, rings + 1):
        rho = k / rings
        rho_s = rho ** 0.85  # slightly denser near the rim
        us += list(cu + rho_s * ou)
        vs += list(cv + rho_s * ov)
        rhos += [rho] * segs
    us, vs, rhos = map(np.array, (us, vs, rhos))
    P = surface_uv(us, vs)
    N = uv_normal(surface_uv, us, vs)
    P = P + N * height_fn(rhos, us, vs)[:, None]
    F = []
    for s in range(segs):
        F.append((0, 1 + s, 1 + (s + 1) % segs))
    for k in range(rings - 1):
        a, b = 1 + k * segs, 1 + (k + 1) * segs
        for s in range(segs):
            s1 = (s + 1) % segs
            F.append((a + s, b + s, b + s1, a + s1))
    # Orientation: make faces point along N.
    tri = F[1]
    fn = np.cross(P[tri[1]] - P[tri[0]], P[tri[2]] - P[tri[0]])
    if np.dot(fn, N[tri[0]]) < 0:
        F = [tuple(reversed(f)) for f in F]
    return P, F, rhos, (us, vs)


def puffy(t, base=-0.0015, edge_soft=5.0):
    """Height profile: tucked at the rim, softly domed inside."""

    def h(rho, u, v):
        return base + (t - base) * np.sqrt(np.clip(1 - rho**edge_soft, 0, 1))

    return h


def tube(centers, radii, segs=14, cap_start=True, cap_end=True, ref=(0, 0, 1), section=None):
    """Tube along a polyline with rotation-minimising frames. radii: per-ring scalar.
    section(phi, i) -> (a, b) multipliers for non-circular sections."""
    C = np.asarray(centers, float)
    n = len(C)
    T = norm(np.gradient(C, axis=0))
    ref = np.asarray(ref, float)
    U = norm(np.cross(T[0], ref) if abs(np.dot(T[0], norm(ref))) < 0.95 else np.cross(T[0], [1, 0, 0]))
    Us = [U]
    for i in range(1, n):  # parallel transport
        u = Us[-1] - T[i] * np.dot(Us[-1], T[i])
        Us.append(norm(u))
    Us = np.array(Us)
    Ws = np.cross(T, Us)
    phi = np.linspace(0, 2 * np.pi, segs, endpoint=False)
    V, F = [], []
    for i in range(n):
        r = radii[i]
        for p in phi:
            a, b = (math.cos(p), math.sin(p)) if section is None else section(p, i)
            V.append(C[i] + r * (a * Us[i] + b * Ws[i]))
    for i in range(n - 1):
        for s in range(segs):
            s1 = (s + 1) % segs
            F.append((i * segs + s, i * segs + s1, (i + 1) * segs + s1, (i + 1) * segs + s))
    V = np.array(V)
    if cap_start:
        V = np.vstack([V, C[0] - T[0] * radii[0] * 0.0])
        ci = len(V) - 1
        for s in range(segs):
            F.append((ci, (s + 1) % segs, s))
    if cap_end:
        V = np.vstack([V, C[-1]])
        ci = len(V) - 1
        base = (n - 1) * segs
        for s in range(segs):
            F.append((ci, base + s, base + (s + 1) % segs))
    return V, F


# ----------------------------------------------------------------------------
# Scene setup
# ----------------------------------------------------------------------------


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.unit_settings.system = "METRIC"
    return scn


MATS = {}


def make_materials():
    for name, hexc in COLORS.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        lin = srgb_to_linear(hexc)
        if name == "fur_tan":
            lin = np.ones(3)  # the plush body carries its colours per vertex (tan + cream paw tips)
        bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
        rough = {"eye": 0.45, "eye_shine": 0.5, "thread": 0.75, "thread_tan": 0.85}.get(name, 0.95)
        bsdf.inputs["Roughness"].default_value = rough
        if name.startswith("fur_"):
            # Fabric sheen for the preview renders; three.js does its own fur.
            for key in ("Sheen Weight", "Sheen"):
                if key in bsdf.inputs:
                    bsdf.inputs[key].default_value = 0.6
                    break
        # Multiply the baked AO colour attribute into base colour so the glTF
        # exporter carries COLOR_0.
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Color"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[6].default_value = (*lin, 1.0)
        nt.links.new(attr.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        MATS[name] = m


PARTS = []  # (obj, material)


def from_bl_obj(obj):
    co = np.zeros(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    B = co.reshape(-1, 3)
    return np.stack([B[:, 0], B[:, 2], -B[:, 1]], -1)


def set_weights(obj, weights):
    nv = len(obj.data.vertices)
    for g, w in weights.items():
        w = np.broadcast_to(np.asarray(w, float), (nv,))
        vg = obj.vertex_groups.get(g) or obj.vertex_groups.new(name=g)
        for i in np.nonzero(w > 1e-4)[0]:
            vg.add([int(i)], float(w[i]), "REPLACE")


def decimate_and_smooth(obj, target_tris):
    me = obj.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    mod = obj.modifiers.new("dec", "DECIMATE")
    mod.ratio = min(1.0, target_tris / max(tris, 1))
    mod.use_collapse_triangulate = True
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bm = bmesh.new()
    bm.from_mesh(me)
    for _ in range(3):  # iron out voxel steps
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()


def add_part(name, V, F, mat, weights, furlen=None, smooth=True, recalc=False):
    V = np.asarray(V, float)
    me = bpy.data.meshes.new(name)
    me.from_pydata(to_bl(V).tolist(), [], [list(f) for f in F])
    me.validate(clean_customdata=False)
    me.update()
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
    me.polygons.foreach_set("use_smooth", [smooth] * len(me.polygons))
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(MATS[mat])
    nv = len(me.vertices)
    for g, w in weights.items():
        w = np.broadcast_to(np.asarray(w, float), (nv,))
        vg = obj.vertex_groups.get(g) or obj.vertex_groups.new(name=g)
        for i in np.nonzero(w > 1e-4)[0]:
            vg.add([int(i)], float(w[i]), "REPLACE")
    fl = np.ones(nv) if furlen is None else np.broadcast_to(np.asarray(furlen, float), (nv,))
    a = me.attributes.new("_furlen", "FLOAT", "POINT")
    a.data.foreach_set("value", np.clip(fl, 0, 2).astype(np.float32))
    if mat == "fur_tan":  # tan parts carry their colour per vertex (material base is white)
        alb = me.color_attributes.new("Albedo", "FLOAT_COLOR", "POINT")
        tan = srgb_to_linear(COLORS["fur_tan"])
        alb.data.foreach_set("color", np.tile(np.r_[tan, 1.0], nv).astype(np.float32))
    PARTS.append((obj, mat))
    return obj


# ----------------------------------------------------------------------------
# Oney
# ----------------------------------------------------------------------------

# --- Head ------------------------------------------------------------------
HEAD_C = np.array([0.0, 1.05, 0.01])


def head_radius(d):
    dx, dy, dz = d[..., 0], d[..., 1], d[..., 2]
    rx = 0.292 * (1 - 0.09 * dy) + 0.016 * np.exp(-(((dy + 0.25) / 0.3) ** 2))  # egg + cheeks
    ry = 0.285
    rz = 0.275
    r = 1 / np.sqrt((dx / rx) ** 2 + (dy / ry) ** 2 + (dz / rz) ** 2)
    muzzle = 0.034 * np.exp(-((dx / 0.34) ** 2 + ((dy + 0.33) / 0.26) ** 2)) * np.clip(dz, 0, 1) ** 1.5
    cheeks = 0.012 * np.exp(-(((np.abs(dx) - 0.55) / 0.2) ** 2 + ((dy + 0.2) / 0.3) ** 2)) * np.clip(dz, 0, 1)
    seam_w = np.maximum(sstep(-0.22, -0.02, dy), sstep(0.15, -0.15, dz))
    seam = -0.0065 * np.exp(-((dx / 0.03) ** 2)) * seam_w
    # Soft panel puffs either side of the seam (plush stuffing pushes out).
    puff = 0.004 * np.exp(-(((np.abs(dx) - 0.3) / 0.25) ** 2)) * sstep(-0.1, 0.4, dy)
    return r + muzzle + cheeks + seam + puff


head = Radial(HEAD_C, head_radius)

EYE_UV = [(-0.5, 0.02), (0.5, 0.02)]
EYE_R = (0.078, 0.098)
MUZZLE_C = (0.0, -0.5)
MUZZLE_POLY = [
    (-0.6, -0.14), (-0.7, -0.38), (-0.6, -0.64), (-0.36, -0.8), (0.0, -0.86), (0.36, -0.8), (0.6, -0.64),
    (0.7, -0.38), (0.6, -0.14), (0.42, -0.13), (0.2, -0.18), (0.0, -0.24), (-0.2, -0.18), (-0.42, -0.13),
]
NOSE_POLY = [(-0.27, -0.1), (0.27, -0.1), (0.0, -0.52)]
NOSE_C = (0.0, -0.24)
MOUTH_TOP = -0.52


def poly_dist(poly, center, u, v):
    """Normalised 'radius' of (u,v) relative to a star-shaped polygon outline: <1 inside."""
    fn = outline_from_polygon(poly, center, 4)
    du, dv = np.asarray(u) - center[0], np.asarray(v) - center[1]
    th = np.arctan2(dv, du)
    ou, ov = fn(th)
    return np.hypot(du, dv) / np.maximum(np.hypot(ou, ov), 1e-6)


def in_ellipse(u, v, c, r, p=2.0):
    return (np.abs((u - c[0]) / r[0]) ** p + np.abs((v - c[1]) / r[1]) ** p) ** (1 / p)


# --- Body --------------------------------------------------------------------
BODY_C = np.array([0.0, 0.375, -0.03])


def body_radius(d):
    dx, dy, dz = d[..., 0], d[..., 1], d[..., 2]
    rx = 0.325 * (1 - 0.15 * dy)
    rz = 0.295 * (1 - 0.1 * dy)
    ry = 0.385
    r = 1 / np.sqrt((dx / rx) ** 2 + (dy / ry) ** 2 + (dz / rz) ** 2)
    belly = 0.03 * np.exp(-((dx / 0.5) ** 2 + ((dy + 0.1) / 0.45) ** 2)) * np.clip(dz, 0, 1)
    bottom = -0.05 * sstep(-0.72, -1.0, dy)
    seam = -0.005 * np.exp(-((dx / 0.03) ** 2)) * sstep(0.1, -0.25, dz)
    return r + belly + bottom + seam


body = Radial(BODY_C, body_radius)
TUMMY_C, TUMMY_R = (0.0, -0.1), (0.7, 0.76)

# --- Legs & feet -----------------------------------------------------------------


def ellipsoid(radii):
    rx, ry, rz = radii

    def fn(d):
        return 1 / np.sqrt((d[..., 0] / rx) ** 2 + (d[..., 1] / ry) ** 2 + (d[..., 2] / rz) ** 2)

    return fn


def foot_radius(d):
    base = ellipsoid((0.14, 0.15, 0.17))(d)
    return base + 0.01 * np.clip(d[..., 2], 0, 1) ** 3  # round, padded toe end


def thigh(side):
    return Radial((0.17 * side, 0.16, 0.16), ellipsoid((0.14, 0.135, 0.24)), rot_y(0.2 * side))


def foot(side):
    R = rot_y(0.26 * side) @ rot_x(-0.8)  # toes up and outwards: soles face the camera
    return Radial((0.235 * side, 0.155, 0.42), foot_radius, R)


# --- Ears ------------------------------------------------------------------------


def ear_frame(side):
    ctrl = np.array(
        [
            [0.11, 1.3, -0.045],
            [0.215, 1.325, -0.03],
            [0.31, 1.24, -0.005],
            [0.37, 1.04, 0.015],
            [0.418, 0.78, 0.015],
            [0.428, 0.52, 0.015],
            [0.418, 0.36, 0.015],
        ]
    )
    ctrl[:, 0] *= side
    n = 64
    C, ts, _ = catmull_rom(ctrl, n)
    T = norm(np.gradient(C, axis=0))
    # The ear lies over the crown (outer face up) then twists as it falls so
    # its outer face looks out and forward, like the real toy.
    up = np.array([0.35 * side, 0.94, 0.0])
    out = np.array([0.86 * side, 0.0, 0.5])
    k = sstep(0.06, 0.34, ts)[:, None]
    face_ref = norm(up * (1 - k) + out * k)
    W = norm(np.cross(T, face_ref))
    N = norm(np.cross(W, T))
    N = N * np.sign(np.sum(N * face_ref, axis=1, keepdims=True))
    W = norm(np.cross(N, T))
    return C, ts, T, W, N


EAR_CUP = 0.055  # the ear is cupped around the head: edges curl inward


def ear_profile(ts):
    width = 0.1 + 0.14 * np.sin(np.clip(ts / 0.6, 0, 1) * np.pi / 2)
    thick = 0.042 * (1 - 0.4 * ts) + 0.006
    tip = np.where(ts > 0.84, np.sqrt(np.clip(1 - ((ts - 0.84) / 0.16) ** 2, 0, 1)), 1.0)
    return width * np.maximum(tip, 0.0), thick * np.maximum(tip, 0.0) ** 0.7


def ear_mesh(side, segs=28):
    C, ts, T, W, N = ear_frame(side)
    width, thick = ear_profile(ts)
    phi = np.linspace(0, 2 * np.pi, segs, endpoint=False)
    V, F, Tparam, inner = [], [], [], []
    for i in range(len(C)):
        for p in phi:
            c, s = math.cos(p), math.sin(p)
            lat = 0.5 * width[i] * math.copysign(abs(c) ** 0.6, c)
            nrm = 0.5 * thick[i] * math.copysign(abs(s) ** 0.75, s)
            cup = -EAR_CUP * (lat / max(0.5 * width[i], 1e-4)) ** 2 * min(1.0, ts[i] / 0.25)
            V.append(C[i] + W[i] * lat + N[i] * (nrm + cup))
            Tparam.append(ts[i])
            inner.append(s < -0.15)  # the -N side faces the head: beige lining
    for i in range(len(C) - 1):
        for s in range(segs):
            s1 = (s + 1) % segs
            F.append((i * segs + s, i * segs + s1, (i + 1) * segs + s1, (i + 1) * segs + s))
    return np.array(V), F, np.array(Tparam), np.array(inner), (C, ts, W, N, width, thick)


def ear_lining(side, frame):
    """Beige velour lining on the inner face + cream piping around it."""
    C, ts, W, N, width, thick = frame
    sel = ts > 0.04
    rows = np.nonzero(sel)[0]
    cols = 15
    lat = np.linspace(-1, 1, cols)
    V, F, Tparam = [], [], []
    for i in rows:
        for l in lat:
            half = 0.5 * width[i] * 0.86
            x = l * half
            # inner face sits at -thick/2 (minus cup); hover just above it
            cup = -EAR_CUP * (l * 0.86) ** 2 * min(1.0, ts[i] / 0.25)
            depth = -0.5 * thick[i] * (1 - abs(l) ** 4) ** 0.6 + cup - 0.0025
            V.append(C[i] + W[i] * x + N[i] * depth)
            Tparam.append(ts[i])
    for r in range(len(rows) - 1):
        for c in range(cols - 1):
            a = r * cols + c
            F.append((a, a + cols, a + cols + 1, a + 1))
    V = np.array(V)
    # face it toward -N
    fn = np.cross(V[F[0][1]] - V[F[0][0]], V[F[0][2]] - V[F[0][0]])
    if np.dot(fn, -N[rows[0]]) < 0:
        F = [tuple(reversed(f)) for f in F]
    # piping: along both long edges and round the tip
    def edge(sgn, i):
        cup = -EAR_CUP * 0.92**2 * min(1.0, ts[i] / 0.25)
        return C[i] + W[i] * (sgn * 0.5 * width[i] * 0.92) + N[i] * (-0.5 * thick[i] * 0.25 + cup)

    edge_l = [edge(-1, i) for i in rows]
    edge_r = [edge(1, i) for i in rows]
    pts = np.array(edge_l + edge_r[::-1])
    pts_t = np.r_[ts[rows], ts[rows][::-1]]
    return V, F, np.array(Tparam), pts, pts_t


# --- Arms ------------------------------------------------------------------------


def arm_curve(side):
    # Hangs just clear of the tummy (touching only at the shoulder) so the arm can lift away cleanly.
    ctrl = np.array([[0.17, 0.74, 0.05], [0.255, 0.645, 0.14], [0.28, 0.52, 0.212], [0.27, 0.42, 0.258], [0.256, 0.37, 0.27]])
    ctrl[:, 0] *= side
    C, ts, L = catmull_rom(ctrl, 40)
    return C, ts


def arm_frames(side):
    """Arm centreline with a frame: T down the arm, U sideways (outward), V forward."""
    C, ts = arm_curve(side)
    T = norm(np.gradient(C, axis=0))
    fwd = np.array([0.0, 0.0, 1.0])
    V = norm(fwd - T * (T @ fwd)[:, None])
    U = norm(np.cross(V, T))
    U = U * np.sign(U[:, :1] * side + 1e-9)
    return C, ts, T, U, V


def arm_dims(ts):
    """
    The real arms are two sewn panels, front and back: a soft, flattened tube whose
    broad face looks forward, widening into a rounded mitten paw.
    Returns half-width side-to-side (along U) and half-thickness front-to-back (along V).
    """
    width = 0.064 + 0.008 * ts + 0.016 * np.exp(-(((ts - 0.8) / 0.12) ** 2))
    thick = 0.046 + 0.004 * ts + 0.008 * np.exp(-(((ts - 0.82) / 0.1) ** 2))
    width, thick = width, thick
    end = np.where(ts > 0.84, np.sqrt(np.clip(1 - ((ts - 0.84) / 0.16) ** 2, 0, 1)), 1.0)
    start = np.where(ts < 0.1, 0.82 + 0.18 * ts / 0.1, 1.0)
    k = end * start
    return width * k, thick * k


def paw_stitch_lines(side):
    """Two finger stitches across the front of the paw, slanting gently (surface points)."""
    C, ts, T, U, V = arm_frames(side)
    a_, b_ = arm_dims(ts)

    def lerp(arr, t):
        return np.array([np.interp(t, ts, arr[:, k]) for k in range(arr.shape[1])]) if arr.ndim == 2 else np.interp(t, ts, arr)

    lines = []
    for t0 in (0.83, 0.9):
        pts, nrm = [], []
        for ph in np.linspace(math.radians(138), math.radians(62), 24):
            tt = t0 + 0.03 * (ph - math.radians(100))
            Ci, Ui, Vi = lerp(C, tt), norm(lerp(U, tt)), norm(lerp(V, tt))
            ai, bi = lerp(a_, tt), lerp(b_, tt)
            pts.append(Ci + Ui * ai * math.cos(ph) + Vi * bi * math.sin(ph))
            nrm.append(norm(Ui * math.cos(ph) / ai + Vi * math.sin(ph) / bi))
        lines.append((np.array(pts), np.array(nrm)))
    return lines


def arm_radii(ts):
    a, b = arm_dims(ts)
    return np.maximum(a, b)


PALM = np.array([-0.94, 0.34])  # the cream underside panel faces in toward the tummy (in U,V)


# --- Weights ---------------------------------------------------------------------

BONES = {
    # name: (head position in design space, parent)
    "root": ((0, 0, 0), None),
    "body": ((0, 0.05, 0), "root"),
    "head": ((0, 0.78, 0.0), "body"),
    "jaw": ((0, 0.93, 0.2), "head"),
    "arm_L": ((0.23, 0.71, 0.08), "body"),
    "arm_R": ((-0.23, 0.71, 0.08), "body"),
}


def jaw_weight(P):
    """Lower muzzle squashes with the voice."""
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    return sstep(0.92, 0.85, y) * sstep(0.12, 0.2, z) * np.exp(-((x / 0.2) ** 2))


def head_weights(P):
    j = jaw_weight(P)
    return {"head": 1 - j, "jaw": j}


# ----------------------------------------------------------------------------
# One continuous plush body (head + body + arms + legs), like a real stuffed toy
# ----------------------------------------------------------------------------


def smin(a, b, k):
    """Polynomial smooth minimum: a soft, sewn-looking fillet where parts meet."""
    k = np.maximum(k, 1e-6)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def sdf_radial(rad, P):
    d = P - rad.c
    r = np.linalg.norm(d, axis=-1)
    dl = (d @ rad.R) / np.maximum(r, 1e-9)[..., None]
    return r - rad.radius_fn(dl)


def sdf_arm(side, P):
    """
    Distance to the flattened, mitten-pawed arm (a sweep of ellipsoids along the
    centreline, using an ellipsoid distance approximation); also returns t.
    """
    C, ts, T, U, V = arm_frames(side)
    a_, b_ = arm_dims(ts)
    best = np.full(len(P), 1e9)
    tbest = np.zeros(len(P))
    for i in range(len(C) - 1):
        ab = C[i + 1] - C[i]
        u = np.clip(((P - C[i]) @ ab) / (ab @ ab), 0, 1)
        q = C[i] + u[:, None] * ab
        a = np.maximum(a_[i] * (1 - u) + a_[i + 1] * u, 1e-3)
        b = np.maximum(b_[i] * (1 - u) + b_[i + 1] * u, 1e-3)
        c = np.minimum(a, b) * 0.9
        D = P - q
        du, dv, dt = D @ U[i], D @ V[i], D @ T[i]
        k0 = np.sqrt((du / a) ** 2 + (dv / b) ** 2 + (dt / c) ** 2)
        k1 = np.sqrt((du / a**2) ** 2 + (dv / b**2) ** 2 + (dt / c**2) ** 2)
        d = k0 * (k0 - 1) / np.maximum(k1, 1e-9)
        better = d < best
        best = np.where(better, d, best)
        tbest = np.where(better, ts[i] * (1 - u) + ts[i + 1] * u, tbest)
    return best, tbest


def plush_fields(P):
    """All part distances for points P (N,3). Far-away parts get a large value."""
    out = {}
    out["head"] = sdf_radial(head, P)
    out["body"] = sdf_radial(body, P)
    for side in (1, -1):
        out[f"thigh{side}"] = sdf_radial(thigh(side), P)
        out[f"foot{side}"] = sdf_radial(foot(side), P)
        d, t = sdf_arm(side, P)
        out[f"arm{side}"], out[f"armt{side}"] = d, t
    return out


def plush_sdf(f):
    legs = np.minimum(smin(f["thigh1"], f["foot1"], 0.03), smin(f["thigh-1"], f["foot-1"], 0.03))
    trunk = smin(f["body"], legs, 0.035)
    s = smin(f["head"], trunk, 0.07)  # soft neck: head is sewn on, not stacked
    for side in (1, -1):
        # Arms blend into the shoulder; further down they only touch the tummy.
        k = 0.05 * (1 - sstep(0.12, 0.35, f[f"armt{side}"])) + 0.004
        s = smin(f[f"arm{side}"], s, k)
    return s


def plush_weights(P, f, with_arms=True):
    """Smooth skin-weight field shared by the body and everything sewn onto it."""
    d_body = np.minimum.reduce([f["body"], f["thigh1"], f["thigh-1"], f["foot1"], f["foot-1"]])
    w = {}
    arm_total = np.zeros(len(P))
    if with_arms:
        for side, bone in ((1, "arm_L"), (-1, "arm_R")):
            t = f[f"armt{side}"]
            diff = d_body - f[f"arm{side}"]
            near_shoulder = sstep(0.0, 0.22, t) * sstep(-0.03, 0.03, diff)
            down_arm = sstep(-0.004, 0.004, diff)
            wa = np.where(t < 0.3, near_shoulder, down_arm * sstep(0.2, 0.3, t) + near_shoulder * (1 - sstep(0.2, 0.3, t)))
            # Only points actually on (or right next to) the arm belong to it — never the face or tummy.
            wa = wa * sstep(0.035, 0.008, f[f"arm{side}"]) * (1 - sstep(-0.02, 0.02, d_body - f["head"]))
            wa = np.clip(wa, 0, 1) * (1 - arm_total)
            w[bone] = wa
            arm_total += wa
    wh = sstep(-0.045, 0.045, d_body - f["head"]) * (1 - arm_total)
    j = jaw_weight(P) * wh
    w["head"] = wh - j
    w["jaw"] = j
    w["body"] = np.clip(1 - arm_total - wh, 0, 1)
    return w


def plush_normal(P, eps=1e-3):
    g = np.zeros_like(P)
    for k in range(3):
        e = np.zeros(3)
        e[k] = eps
        g[:, k] = plush_sdf(plush_fields(P + e)) - plush_sdf(plush_fields(P - e))
    return norm(g)


def snap_to_plush(P, iters=3):
    """Project points onto the merged plush surface (patches must hug the real body, not the ideal parts)."""
    shape = np.shape(P)
    P = np.asarray(P, float).reshape(-1, 3)
    for _ in range(iters):
        d = plush_sdf(plush_fields(P))
        P = P - d[:, None] * plush_normal(P)
    return P.reshape(shape)


def on_plush(surface_uv):
    return lambda u, v: snap_to_plush(surface_uv(u, v))


def attached_weights(P):
    """Weights for patches/threads/eyes sewn onto the head or body (no arm pull)."""
    return plush_weights(P, plush_fields(P), with_arms=False)


def build_plush_body(voxel=0.0055):
    from skimage.measure import marching_cubes

    lo = np.array([-0.52, -0.03, -0.42])
    hi = np.array([0.52, 1.38, 0.68])
    shape = np.ceil((hi - lo) / voxel).astype(int) + 1
    xs = [lo[i] + np.arange(shape[i]) * voxel for i in range(3)]
    vol = np.empty(shape, np.float32)
    for ix, x in enumerate(xs[0]):  # slice by slice to bound memory
        Y, Z = np.meshgrid(xs[1], xs[2], indexing="ij")
        P = np.stack([np.full(Y.size, x), Y.ravel(), Z.ravel()], -1)
        vol[ix] = plush_sdf(plush_fields(P)).reshape(Y.shape)
    V, F, _, _ = marching_cubes(vol, 0.0, spacing=(voxel,) * 3)
    V = V + lo
    print(f"[oney] marching cubes: {len(V)} verts, {len(F)} tris")
    return V, F


def finish_plush_body(V):
    """Per-vertex skin weights, fur mask and albedo (cream paw tips) for the merged body."""
    f = plush_fields(V)
    w = plush_weights(V, f)
    fl = np.ones(len(V))
    albedo = np.tile(srgb_to_linear(COLORS["fur_tan"]), (len(V), 1))
    cream = srgb_to_linear(COLORS["fur_cream"])

    owner_names = ["head", "body", "thigh1", "thigh-1", "foot1", "foot-1", "arm1", "arm-1"]
    owner = np.argmin(np.stack([f[n] for n in owner_names]), axis=0)

    # Face: muzzle / eyes / nose are appliqué patches, fur kept short there.
    HD = head.local_dir_of(V)
    hu, hv = HD[:, 0], HD[:, 1]
    hfront = (HD[:, 2] > 0.05) & (owner == 0)
    m_muz = poly_dist(MUZZLE_POLY, MUZZLE_C, hu, hv)
    fl = np.where(hfront, np.minimum(fl, sstep(0.9, 1.04, m_muz)), fl)
    for e in EYE_UV:
        d = in_ellipse(hu, hv, e, EYE_R)
        fl = np.where(hfront, np.minimum(fl, 0.08 + 0.92 * sstep(1.0, 1.9, d)), fl)
    nose_d = poly_dist(NOSE_POLY, NOSE_C, hu, hv)
    fl = np.where(hfront, np.minimum(fl, sstep(0.95, 1.45, nose_d)), fl)

    # Tummy patch
    BD = body.local_dir_of(V)
    bfront = (BD[:, 2] > 0.05) & (owner == 1)
    fl = np.where(bfront, np.minimum(fl, sstep(0.93, 1.05, in_ellipse(BD[:, 0], BD[:, 1], TUMMY_C, TUMMY_R, 2.2))), fl)

    # Soles
    for k, side in ((4, 1), (5, -1)):
        D = foot(side).local_dir_of(V)
        on = (owner == k) & (D[:, 2] > 0.1)
        fl = np.where(on, np.minimum(fl, sstep(0.92, 1.05, in_ellipse(D[:, 0], D[:, 1], (0, 0.0), (0.86, 0.9), 2.4))), fl)

    # Cream paw tips (same fabric piece, so a colour change rather than a separate mesh)
    # Stitched finger creases on the paws: short pile along the stitch lines.
    for side in (1, -1):
        for pts, _ in paw_stitch_lines(side):
            d = np.min(np.linalg.norm(V[:, None, :] - pts[None, :, :], axis=2), axis=1)
            fl = np.minimum(fl, 0.25 + 0.75 * sstep(0.004, 0.016, d))

    # Cream underside panel: the inner side of the paw (a crescent from the front) and the tip's underside.
    for k, side in ((6, 1), (7, -1)):
        t = f[f"armt{side}"]
        C, ts, T, U, Vf = arm_frames(side)
        idx = np.clip(np.searchsorted(ts, t), 0, len(ts) - 1)
        D = norm(V - C[idx])
        palm = norm(PALM[0] * U[idx] + PALM[1] * Vf[idx])
        s = np.sum(D * palm, axis=1)
        tip_under = sstep(0.9, 0.95, t) * sstep(-0.6, -0.2, s)
        c = np.maximum(sstep(0.68, 0.74, t) * sstep(0.32, 0.5, s), tip_under) * (owner == k)
        albedo = albedo * (1 - c[:, None]) + cream[None, :] * c[:, None]

    return w, fl, albedo


# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------


def build():
    # One continuous stuffed body: head, body, arms, legs blended like sewn fabric.
    PV, PF = build_plush_body()
    obj = add_part("plush", PV, PF, "fur_tan", {}, None, recalc=True)
    decimate_and_smooth(obj, target_tris=44000)
    V = from_bl_obj(obj)
    w, fl, albedo = finish_plush_body(V)
    set_weights(obj, w)
    obj.data.attributes["_furlen"].data.foreach_set("value", np.clip(fl, 0, 2).astype(np.float32))
    alb = obj.data.color_attributes["Albedo"]
    HEAD_UV = on_plush(head.at_uv)
    BODY_UV = on_plush(body.at_uv)
    alb.data.foreach_set("color", np.c_[albedo, np.ones(len(albedo))].astype(np.float32).ravel())

    # Muzzle patch (cream), with the nose and mouth area kept short.
    def muzzle_h(rho, u, v):
        return puffy(0.007)(rho, u, v)

    MV, MF, mr, (mu, mv) = patch(HEAD_UV, MUZZLE_C, outline_from_polygon(MUZZLE_POLY, MUZZLE_C, 4), muzzle_h, rings=14, segs=90)
    mfl = 0.15 + 0.85 * sstep(0.95, 1.5, poly_dist(NOSE_POLY, NOSE_C, mu, mv))
    mouth_d = np.hypot(mu / 0.14, (mv - MOUTH_TOP + 0.11) / 0.1)
    mfl = np.minimum(mfl, 0.3 + 0.7 * sstep(0.7, 1.3, mouth_d))
    mfl = np.minimum(mfl, 0.4 + 0.6 * sstep(1.0, 0.85, mr))  # shorter right at the sewn edge
    add_part("muzzle", MV, MF, "fur_cream", attached_weights(MV), mfl)

    def on_muzzle(u, v):
        return HEAD_UV(u, v) + uv_normal(HEAD_UV, u, v) * 0.006

    # Nose: rounded inverted triangle in velvet
    NV, NF, nr, _ = patch(
        lambda u, v: HEAD_UV(u, v),
        NOSE_C,
        outline_from_polygon(NOSE_POLY, NOSE_C, 2),  # crisper corners
        puffy(0.026, base=0.005, edge_soft=3.0),
        rings=12,
        segs=72,
    )
    add_part("nose", NV, NF, "fur_nose", attached_weights(NV), 0.5 + 0.5 * (1 - nr))

    # Mouth stitch: line down from the nose tip, then a soft little smile.
    def thread_on(surface_uv, uv_pts, lift, name, weights_fn, r=0.0032):
        uv = np.asarray(uv_pts, float)
        dense = np.array([np.interp(np.linspace(0, len(uv) - 1, 40), np.arange(len(uv)), uv[:, k]) for k in range(2)]).T
        P = surface_uv(dense[:, 0], dense[:, 1]) + uv_normal(surface_uv, dense[:, 0], dense[:, 1]) * lift
        V, F = tube(P, np.full(len(P), r), segs=8)
        add_part(name, V, F, "thread", weights_fn(V), 0.0)

    m0 = MOUTH_TOP
    thread_on(HEAD_UV, [(0, m0 + 0.02), (0, m0 - 0.09)], 0.0085, "mouth_line", attached_weights, r=0.0026)
    thread_on(HEAD_UV, [(-0.13, m0 - 0.1), (-0.07, m0 - 0.125), (-0.02, m0 - 0.115), (0, m0 - 0.09)], 0.0085, "mouth_l", attached_weights, r=0.0026)
    thread_on(HEAD_UV, [(0.13, m0 - 0.1), (0.07, m0 - 0.125), (0.02, m0 - 0.115), (0, m0 - 0.09)], 0.0085, "mouth_r", attached_weights, r=0.0026)

    # Eyes: glossy embroidered satin ovals with a stitched highlight
    for i, (eu, ev) in enumerate(EYE_UV):
        EV, EF, _, _ = patch(HEAD_UV, (eu, ev), ellipse_outline(*EYE_R), puffy(0.0075, base=0.001, edge_soft=2.5), rings=8, segs=48)
        add_part(f"eye{i}", EV, EF, "eye", attached_weights(EV), 0.0)
        su, sv = eu + 0.022, ev + 0.034
        SV, SF, _, _ = patch(HEAD_UV, (su, sv), ellipse_outline(0.019, 0.021), puffy(0.0115, base=0.0085), rings=4, segs=24)
        add_part(f"eye_shine{i}", SV, SF, "eye_shine", attached_weights(SV), 0.0)

    # Tummy

    def tummy_h(rho, u, v):
        fold = -0.007 * np.exp(-(((v - 0.36) / 0.035) ** 2)) * (1 - rho**4)  # chest fold
        return puffy(0.009)(rho, u, v) + fold

    TV, TF, tr, _ = patch(BODY_UV, TUMMY_C, ellipse_outline(*TUMMY_R, 2.2), tummy_h, rings=14, segs=80)
    add_part("tummy", TV, TF, "fur_cream", attached_weights(TV), 0.45 + 0.55 * sstep(1.0, 0.86, tr))

    # Soles, toe stitches
    for side in (1, -1):
        ft = foot(side)
        SV, SF, sr, _ = patch(on_plush(ft.at_uv), (0, 0.0), ellipse_outline(0.86, 0.9, 2.4), puffy(0.008), rings=12, segs=64)
        add_part(f"sole{side}", SV, SF, "fur_cream", {"body": 1.0}, 0.5 + 0.5 * sstep(1.0, 0.85, sr))
        for tu in (-0.28, 0.28):
            thread_on(on_plush(ft.at_uv), [(tu, 0.84), (tu * 0.92, 0.42)], 0.0135, f"toe{side}{tu}", lambda V: {"body": 1.0}, r=0.0034)

    # Tail pom-pom
    tail = Radial((0, 0.2, -0.325), ellipsoid((0.085, 0.08, 0.07)))
    V, F, _ = tail.mesh(12)
    add_part("tail", V, F, "fur_tail", {"body": 1.0})

    # Paw stitches (the arms themselves are part of the plush body)
    for side, bone in ((1, "arm_L"), (-1, "arm_R")):
        # Two little "finger" stitches across the tan front of the paw, pulled tight
        # into creases (the fur mask shortens the pile along them).
        for j, (pts, nrm) in enumerate(paw_stitch_lines(side)):
            V, F = tube(pts + nrm * 0.0035, np.full(len(pts), 0.0022), segs=8)
            add_part(f"paw_stitch{side}{j}", V, F, "thread_tan", {bone: 1.0}, 0.0)

    # Ears + linings + piping
    ear_info = {}
    for side, tag in ((1, "L"), (-1, "R")):
        V, F, tp, inner, frame = ear_mesh(side)
        w2 = sstep(0.3, 0.62, tp)
        wh = 1 - sstep(0.0, 0.1, tp)
        w1 = (1 - w2) * (1 - wh)
        efl = np.where(inner & (tp > 0.06), 0.0, 1.0)
        add_part(f"ear{tag}", V, F, "fur_tan", {f"ear_{tag}_1": w1, f"ear_{tag}_2": w2, "head": wh}, efl, recalc=True)
        LV, LF, lt, pipe, pipe_t = ear_lining(side, frame)
        w2 = sstep(0.3, 0.62, lt)
        wh = 1 - sstep(0.0, 0.1, lt)
        add_part(f"lining{tag}", LV, LF, "fur_beige", {f"ear_{tag}_1": (1 - w2) * (1 - wh), f"ear_{tag}_2": w2, "head": wh}, 0.8)
        PV, PF = tube(pipe, np.full(len(pipe), 0.0085), segs=10, cap_start=True, cap_end=True)
        pt = np.r_[np.repeat(pipe_t, 10), pipe_t[0], pipe_t[-1]]
        w2 = sstep(0.3, 0.62, pt)
        wh = 1 - sstep(0.0, 0.1, pt)
        add_part(f"piping{tag}", PV, PF, "fur_piping", {f"ear_{tag}_1": (1 - w2) * (1 - wh), f"ear_{tag}_2": w2, "head": wh}, 0.6)
        C, ts = frame[0], frame[1]
        ear_info[tag] = (C[0], C[np.searchsorted(ts, 0.45)])
    BONES["ear_L_1"] = (tuple(ear_info["L"][0]), "head")
    BONES["ear_L_2"] = (tuple(ear_info["L"][1]), "ear_L_1")
    BONES["ear_R_1"] = (tuple(ear_info["R"][0]), "head")
    BONES["ear_R_2"] = (tuple(ear_info["R"][1]), "ear_R_1")


# ----------------------------------------------------------------------------
# Collision data for the browser: she must behave like one solid toy
# ----------------------------------------------------------------------------


def body_parts_sdf(P):
    return np.minimum.reduce([sdf_radial(body, P)] + [sdf_radial(x(side), P) for side in (1, -1) for x in (thigh, foot)])


def arms_sdf(P):
    out = np.full(len(P), 9.0)
    for side in (1, -1):
        d, _ = sdf_arm(side, P)
        out = np.minimum(out, d)
    return out


def sdf_grid(fn, lo, hi, cell, pivot):
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    dims = np.ceil((hi - lo) / cell).astype(int) + 1
    xs = [lo[i] + np.arange(dims[i]) * cell for i in range(3)]
    X, Y, Z = np.meshgrid(*xs, indexing="ij")
    d = np.clip(fn(np.stack([X, Y, Z], -1).reshape(-1, 3)), -0.25, 0.25)
    return {
        "origin": np.round(lo - np.asarray(pivot), 4).tolist(),
        "cell": cell,
        "dims": dims.tolist(),  # index = (ix * ny + iy) * nz + iz
        "mm": np.round(d * 1000).astype(int).tolist(),
    }


def collision_data(report=True):
    """
    Distance grids for the head (in head-bone space) and body+legs (body-bone space),
    plus collision spheres along each arm and ear (in their bone's space). Each sphere's
    radius is capped by its clearance in the rest pose, so standing still never collides.
    """
    head_piv = np.array(BONES["head"][0])
    body_piv = np.array(BONES["body"][0])
    data = {
        "head": sdf_grid(lambda P: sdf_radial(head, P), HEAD_C - 0.36, HEAD_C + 0.36, 0.03, head_piv),
        "body": sdf_grid(body_parts_sdf, (-0.5, -0.06, -0.42), (0.5, 0.86, 0.66), 0.03, body_piv),
        "samples": {},
    }
    fur = 0.012

    def clearance(P, exclude_arms=False):
        d = np.minimum(sdf_radial(head, P), body_parts_sdf(P))
        return d if exclude_arms else np.minimum(d, arms_sdf(P))

    for side, bone in ((1, "arm_L"), (-1, "arm_R")):
        C, ts = arm_curve(side)
        r = arm_radii(ts)
        piv = np.array(BONES[bone][0])
        out = []
        for t in (0.3, 0.42, 0.55, 0.68, 0.8, 0.9, 0.97):
            i = int(np.searchsorted(ts, t))
            P = C[i]
            free = float(clearance(P[None], exclude_arms=True)[0])
            rad = min(r[i] + fur, free - 0.002)
            if report:
                print(f"[collide] {bone} t={t:.2f} clearance={free - r[i]:+.3f}")
            if rad > 0.02:
                out.append([*np.round(P - piv, 4).tolist(), round(rad, 4)])
        data["samples"][bone] = out
    for side, tag in ((1, "L"), (-1, "R")):
        C, ts, T, W, N = ear_frame(side)
        width, thick = ear_profile(ts)
        p1 = np.array(BONES[f"ear_{tag}_1"][0])
        p2 = np.array(BONES[f"ear_{tag}_2"][0])
        s1, s2 = [], []
        worst = 9.0
        for t in (0.22, 0.32, 0.42, 0.55, 0.66, 0.77, 0.87, 0.95):
            i = int(np.searchsorted(ts, t))
            for lat in (-0.36, 0.0, 0.36):
                P = C[i] + W[i] * lat * width[i]
                free = float(clearance(P[None])[0])
                worst = min(worst, free - 0.5 * thick[i])
                rad = min(0.5 * thick[i] + fur, free - 0.002)
                if rad <= 0.012:
                    continue
                if t < 0.45:
                    s1.append([*np.round(P - p1, 4).tolist(), round(rad, 4)])
                else:
                    s2.append([*np.round(P - p2, 4).tolist(), round(rad, 4)])
        if report:
            print(f"[collide] ear_{tag} worst rest clearance={worst:+.3f} samples={len(s1)}+{len(s2)}")
        data["samples"][f"ear_{tag}_1"] = s1
        data["samples"][f"ear_{tag}_2"] = s2
    return data


def join_by_material():
    groups = {}
    for obj, mat in PARTS:
        groups.setdefault(mat, []).append(obj)
    joined = []
    for mat, objs in groups.items():
        for o in bpy.context.scene.objects:
            o.select_set(False)
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
                bpy.ops.object.join()
        objs[0].name = mat
        objs[0].data.name = mat
        joined.append(objs[0])
    return joined


def bake_ao(objs, samples=96):
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scn.world = world
    # A floor so the bottom gets contact darkening.
    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, -0.002))
    floor = bpy.context.active_object
    scn.render.bake.target = "VERTEX_COLORS"
    scn.render.bake.use_clear = True
    albedos = {}
    for o in objs:  # stash per-vertex colours first so the bake has a single target
        me = o.data
        if "Albedo" in me.color_attributes:
            a = np.zeros(len(me.vertices) * 4, np.float32)
            me.color_attributes["Albedo"].data.foreach_get("color", a)
            albedos[o.name] = a.reshape(-1, 4)[:, :3].copy()
            me.color_attributes.remove(me.color_attributes["Albedo"])
    for o in objs:
        me = o.data
        if "Color" not in me.color_attributes:
            me.color_attributes.new("Color", "BYTE_COLOR", "POINT")
        me.color_attributes.active_color = me.color_attributes["Color"]
        for x in scn.objects:
            x.select_set(False)
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.bake(type="AO")
        # remap: soften, keep it plush (no dirty black)
        col = me.color_attributes["Color"]
        arr = np.zeros(len(col.data) * 4, np.float32)
        col.data.foreach_get("color", arr)
        arr = arr.reshape(-1, 4)
        ao = arr[:, 0]
        ao = 0.5 + 0.5 * np.clip(ao, 0, 1) ** 0.8
        # gentle neighbourhood blur for smoothness
        arr[:, 0] = arr[:, 1] = arr[:, 2] = ao
        arr[:, 3] = 1.0
        if o.name in albedos:
            arr[:, :3] *= albedos[o.name]
        col.data.foreach_set("color", arr.ravel())
    bpy.data.objects.remove(floor)


def build_armature(objs):
    arm = bpy.data.armatures.new("OneyRig")
    rig = bpy.data.objects.new("OneyRig", arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    for o in bpy.context.scene.objects:
        o.select_set(o is rig)
    bpy.ops.object.mode_set(mode="EDIT")
    order = ["root", "body", "head", "jaw", "ear_L_1", "ear_L_2", "ear_R_1", "ear_R_2", "arm_L", "arm_R"]
    for name in order:
        pos, parent = BONES[name]
        p = to_bl(np.array(pos))
        eb = arm.edit_bones.new(name)
        eb.head = p.tolist()
        eb.tail = (p + np.array([0, 0, 0.08])).tolist()  # all bones point up: world-aligned local axes
        eb.roll = 0.0
        if parent:
            eb.parent = arm.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in objs:
        o.parent = rig
        mod = o.modifiers.new("Armature", "ARMATURE")
        mod.object = rig
    return rig


def export(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    for o in bpy.context.scene.objects:  # make "Color" both active and render colour, or it isn't exported
        if o.type == "MESH" and "Color" in o.data.color_attributes:
            ca = o.data.color_attributes
            idx = list(ca).index(ca["Color"])
            ca.active_color_index = idx
            ca.render_color_index = idx
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_skins=True,
        export_animations=False,
        export_yup=True,
        export_normals=True,
        export_attributes=True,
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        # The pip `bpy` wheel ships without the Draco library, so compression is off (the
        # GLB is ~2.7 MB uncompressed, fine). Turn this on if you build with full Blender.
        export_draco_mesh_compression_enable=False,
        export_draco_mesh_compression_level=7,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_color_quantization=8,
        export_draco_generic_quantization=10,
        export_materials="EXPORT",
        export_def_bones=False,
        export_leaf_bone=False,
    )


def render_previews(outdir, objs):
    os.makedirs(outdir, exist_ok=True)
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.samples = 48
    try:
        scn.cycles.use_denoising = True
    except Exception:
        pass
    scn.render.resolution_x, scn.render.resolution_y = 600, 760
    scn.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in scn.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    world = scn.world or bpy.data.worlds.new("w")
    scn.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.82, 0.78, 0.74, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    for loc, energy, size in (((-2.5, -3.5, 3.2), 450, 3), ((3, -2.5, 1.5), 120, 3), ((0, 3, 2.5), 300, 2)):
        bpy.ops.object.light_add(type="AREA", location=to_bl(np.array([loc[0], loc[2], -loc[1]])).tolist())
        L = bpy.context.active_object
        L.data.energy = energy
        L.data.size = size
        d = -np.array(L.location)
        L.rotation_euler = _look_rot(d)
    target = np.array([0, 0.72, 0.0])
    views = {"front": (0, 0.85, 3.6), "side": (2.6, 0.95, 2.4), "back": (0, 0.95, -3.6), "three_q": (-1.9, 0.9, 3.0), "face": (0, 1.05, 1.6)}
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scn.camera = cam
    for name, pos in views.items():
        p = to_bl(np.array(pos))
        cam.location = p.tolist()
        tgt = to_bl(np.array([0, 1.0, 0.05])) if name == "face" else to_bl(target)
        cam.rotation_euler = _look_rot(tgt - p)
        cam.data.lens = 70 if name == "face" else 50
        scn.render.filepath = os.path.join(outdir, f"{name}.png")
        bpy.ops.render.render(write_still=True)


def _look_rot(direction):
    from mathutils import Vector

    return Vector(direction).to_track_quat("-Z", "Y").to_euler()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/bunny.glb")
    ap.add_argument("--renders", default=None)
    ap.add_argument("--no-bake", action="store_true")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])

    reset_scene()
    make_materials()
    build()
    objs = join_by_material()
    if not args.no_bake:
        bake_ao(objs)
    else:
        for o in objs:
            c = o.data.color_attributes.new("Color", "BYTE_COLOR", "POINT")
            arr = np.ones(len(c.data) * 4, np.float32)
            if "Albedo" in o.data.color_attributes:
                o.data.color_attributes["Albedo"].data.foreach_get("color", arr)
                o.data.color_attributes.remove(o.data.color_attributes["Albedo"])
            c.data.foreach_set("color", arr)
            o.data.color_attributes.active_color = o.data.color_attributes["Color"]
    rig = build_armature(objs)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    print(f"[oney] meshes={len(objs)} triangles={tris}")
    export(args.out)
    import json

    col_path = os.path.splitext(args.out)[0] + ".collision.json"
    with open(col_path, "w") as fh:
        json.dump(collision_data(), fh, separators=(",", ":"))
    print(f"[oney] wrote {col_path} ({os.path.getsize(col_path) / 1e3:.0f} kB)")
    print(f"[oney] wrote {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB)")
    if args.renders:
        render_previews(args.renders, objs)
        print(f"[oney] renders in {args.renders}")


if __name__ == "__main__":
    main()
