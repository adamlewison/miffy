import * as THREE from "three";

/**
 * Keeps Oney solid: after the animation poses her each frame, arms and ears
 * are rotated just enough that no part of them sinks into her head, body,
 * legs (or, for ears, her arms). Paws come to rest *on* her face instead of
 * inside it; ears brush past her arms instead of through them.
 *
 * Data comes from blender/build_oney.py (public/bunny.collision.json):
 *  - signed-distance grids of the head (head-bone space) and body+legs
 *    (body-bone space), in millimetres
 *  - collision spheres along each arm/ear, in their bone's space, already
 *    sized so the rest pose never collides.
 */

type GridJSON = { origin: [number, number, number]; cell: number; dims: [number, number, number]; mm: number[] };
export type CollisionJSON = { head: GridJSON; body: GridJSON; samples: Record<string, [number, number, number, number][]> };

class SdfGrid {
  o: THREE.Vector3;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  d: Float32Array;
  constructor(g: GridJSON) {
    this.o = new THREE.Vector3(...g.origin);
    this.c = g.cell;
    [this.nx, this.ny, this.nz] = g.dims;
    this.d = Float32Array.from(g.mm, (v) => v / 1000);
  }
  private at(i: number, j: number, k: number) {
    return this.d[(i * this.ny + j) * this.nz + k];
  }
  /** Trilinear signed distance (model units); far outside the grid = no contact. */
  sample(p: THREE.Vector3) {
    const fx = (p.x - this.o.x) / this.c;
    const fy = (p.y - this.o.y) / this.c;
    const fz = (p.z - this.o.z) / this.c;
    if (fx < 0 || fy < 0 || fz < 0 || fx > this.nx - 1 || fy > this.ny - 1 || fz > this.nz - 1) return 1;
    const i = Math.min(Math.floor(fx), this.nx - 2);
    const j = Math.min(Math.floor(fy), this.ny - 2);
    const k = Math.min(Math.floor(fz), this.nz - 2);
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(this.at(i, j, k), this.at(i + 1, j, k), tx), l(this.at(i, j + 1, k), this.at(i + 1, j + 1, k), tx), ty),
      l(l(this.at(i, j, k + 1), this.at(i + 1, j, k + 1), tx), l(this.at(i, j + 1, k + 1), this.at(i + 1, j + 1, k + 1), tx), ty),
      tz,
    );
  }
  normal(p: THREE.Vector3, out: THREE.Vector3) {
    const h = this.c * 0.5;
    const s = (dx: number, dy: number, dz: number) => this.sample(_t.set(p.x + dx, p.y + dy, p.z + dz));
    out.set(s(h, 0, 0) - s(-h, 0, 0), s(0, h, 0) - s(0, -h, 0), s(0, 0, h) - s(0, 0, -h));
    return out.lengthSq() > 1e-12 ? out.normalize() : out.set(0, 0, 1);
  }
}

const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();
const _target = new THREE.Vector3();
const _bestP = new THREE.Vector3();
const _bestT = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _qc = new THREE.Quaternion();
const _s = new THREE.Vector3();

type Sample = { p: THREE.Vector3; r: number };
type Sphere = { c: THREE.Vector3; r: number }; // world centre, model-unit radius

export class BunnySolid {
  head: SdfGrid;
  body: SdfGrid;
  samples: Record<string, Sample[]>;
  /** Deepest remaining penetration after the last solve (model units) — for tests. */
  residual = 0;
  /** Deepest penetration before solving, this frame. */
  raw = 0;
  /** Which bone/obstacle holds the residual (debugging). */
  residualWhere = "";
  constructor(json: CollisionJSON) {
    this.head = new SdfGrid(json.head);
    this.body = new SdfGrid(json.body);
    this.samples = Object.fromEntries(
      Object.entries(json.samples).map(([k, v]) => [k, v.map(([x, y, z, r]) => ({ p: new THREE.Vector3(x, y, z), r }))]),
    );
  }

  /**
   * Push one bone's spheres out of the colliders by rotating the bone about its pivot.
   * A few iterations on the deepest contact converge in practice.
   */
  private resolve(
    bone: THREE.Object3D | null,
    samples: Sample[] | undefined,
    grids: [SdfGrid, THREE.Object3D | null][],
    spheres: Sphere[],
    worldScale: number,
    tag = "",
    sphereBias: THREE.Vector3 | null = null,
    iterations = 6,
  ) {
    if (!bone || !samples?.length) return;
    for (let it = 0; it <= iterations; it++) {
      let worst = 0;
      let what = "";
      for (const s of samples) {
        _p.copy(s.p).applyMatrix4(bone.matrixWorld);
        for (const [g, gb] of grids) {
          if (!gb) continue;
          _q.copy(_p);
          gb.worldToLocal(_q);
          const d = g.sample(_q) - s.r;
          if (d < -worst) {
            worst = -d;
            what = `${tag} vs ${g === this.head ? "head" : "body"} (r=${s.r.toFixed(3)}, |p|=${s.p.length().toFixed(3)})`;
            g.normal(_q, _n);
            _target.copy(_q).addScaledVector(_n, -d + 0.002);
            gb.localToWorld(_target);
            _bestP.copy(_p);
            _bestT.copy(_target);
          }
        }
        for (const sp of spheres) {
          const R = (s.r + sp.r) * worldScale;
          const dist = _p.distanceTo(sp.c);
          if (dist < R && R - dist > worst * worldScale) {
            worst = (R - dist) / worldScale;
            what = `${tag} vs arm sphere (|p|=${s.p.length().toFixed(3)})`;
            _n.subVectors(_p, sp.c);
            if (_n.lengthSq() < 1e-12) _n.set(1, 0, 0);
            _n.normalize();
            // Ears get nudged outward/back so an arm swings them aside instead of trapping them against the head.
            if (sphereBias) _n.add(sphereBias).normalize();
            _bestP.copy(_p);
            _bestT.copy(sp.c).addScaledVector(_n, R + 0.002 * worldScale);
          }
        }
      }
      if (it === 0) this.raw = Math.max(this.raw, worst);
      if (it === iterations || worst <= 1e-4) {
        if (worst > this.residual) this.residualWhere = what;
        this.residual = Math.max(this.residual, worst);
        return;
      }
      _a.copy(_bestP);
      bone.worldToLocal(_a);
      _b.copy(_bestT);
      bone.worldToLocal(_b);
      if (_a.lengthSq() < 1e-10 || _b.lengthSq() < 1e-10) return;
      _qc.setFromUnitVectors(_a.normalize(), _b.normalize());
      bone.quaternion.multiply(_qc);
      bone.updateMatrixWorld(true);
    }
  }

  /** Call after the rig has posed every bone for this frame. */
  solve(rig: {
    root: THREE.Object3D | null;
    head: THREE.Object3D | null;
    body: THREE.Object3D | null;
    armL: THREE.Object3D | null;
    armR: THREE.Object3D | null;
    earL1: THREE.Object3D | null;
    earL2: THREE.Object3D | null;
    earR1: THREE.Object3D | null;
    earR2: THREE.Object3D | null;
  }) {
    if (!rig.root) return;
    this.residual = 0;
    this.raw = 0;
    rig.root.updateWorldMatrix(true, true);
    rig.root.matrixWorld.decompose(_t, _qc, _s);
    const ws = _s.x;
    const solid: [SdfGrid, THREE.Object3D | null][] = [
      [this.head, rig.head],
      [this.body, rig.body],
    ];
    // Arms vs head + body
    this.resolve(rig.armL, this.samples.arm_L, solid, [], ws, "arm_L");
    this.resolve(rig.armR, this.samples.arm_R, solid, [], ws, "arm_R");
    // Arm spheres (in their final pose) become obstacles for the ears.
    const armSpheres: Sphere[] = [];
    for (const [bone, key] of [
      [rig.armL, "arm_L"],
      [rig.armR, "arm_R"],
    ] as const) {
      if (!bone) continue;
      for (const s of this.samples[key] ?? []) armSpheres.push({ c: s.p.clone().applyMatrix4(bone.matrixWorld), r: s.r });
    }
    for (const [b1, b2, k, side] of [
      [rig.earL1, rig.earL2, "L", 1],
      [rig.earR1, rig.earR2, "R", -1],
    ] as const) {
      const out = rig.head ? new THREE.Vector3(side, 0, -0.35).transformDirection(rig.head.matrixWorld).multiplyScalar(0.9) : null;
      this.resolve(b1, this.samples[`ear_${k}_1`], solid, armSpheres, ws, `ear_${k}_1`, out);
      this.resolve(b2, this.samples[`ear_${k}_2`], solid, armSpheres, ws, `ear_${k}_2`, out);
    }
  }
}
