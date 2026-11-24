import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { bunnyState } from "@/lib/bunnyState";

/**
 * The bunny's skeleton contract. Both the placeholder bunny and the Blender
 * GLB must expose these nodes (any may be missing; it just won't move).
 *
 * Axis convention (matches Blender bones, where local +Y runs along the bone):
 *  - head:  X = nod, Y = turn, Z = tilt
 *  - ears:  local +Y runs from base to tip. X = flop forward/back, Z = splay sideways
 *  - arms:  X = swing forward/back, Z = lift outwards
 */
export type Rig = {
  root: THREE.Object3D | null;
  body: THREE.Object3D | null;
  head: THREE.Object3D | null;
  jaw: THREE.Object3D | null;
  earL1: THREE.Object3D | null;
  earL2: THREE.Object3D | null;
  earR1: THREE.Object3D | null;
  earR2: THREE.Object3D | null;
  armL: THREE.Object3D | null;
  armR: THREE.Object3D | null;
};

/** Bone names to use in Blender (aliases are accepted too, see GlbBunny). */
export const BONE_NAMES: Record<keyof Rig, string[]> = {
  root: ["root", "Root"],
  body: ["body", "spine", "Body", "Spine"],
  head: ["head", "Head"],
  jaw: ["jaw", "cheeks", "Jaw", "Cheeks"],
  earL1: ["ear_L_1", "ear.L", "ear.L.001", "earL1", "Ear_L_1"],
  earL2: ["ear_L_2", "ear.L.002", "earL2", "Ear_L_2"],
  earR1: ["ear_R_1", "ear.R", "ear.R.001", "earR1", "Ear_R_1"],
  earR2: ["ear_R_2", "ear.R.002", "earR2", "Ear_R_2"],
  armL: ["arm_L", "arm.L", "armL", "Arm_L"],
  armR: ["arm_R", "arm.R", "armR", "Arm_R"],
};

type Rest = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 };
type Spring = { a: number; v: number };
type EarSprings = { x1: Spring; x2: Spring; z1: Spring; z2: Spring };

const { damp, clamp, lerp } = THREE.MathUtils;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

function stepSpring(s: Spring, target: number, k: number, c: number, force: number, dt: number) {
  const acc = -k * (s.a - target) - c * s.v + force;
  s.v += acc * dt;
  s.a += s.v * dt;
  // Keep things sane if the tab was backgrounded.
  s.a = clamp(s.a, -1.6, 1.6);
  s.v = clamp(s.v, -40, 40);
  return acc;
}

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** Arm poses for the held gestures: [rotX, rotZ (mirrored per side), stretch]. */
export type Poses = {
  wave: [number, number, number];
  sad: [number, number, number];
  nuzzle: [number, number, number];
};

export type RigOptions = {
  /** Flip if a GLB's right ear splays the wrong way. */
  earZSign?: number;
  /** Flip forward/back ear motion (hanging lop ears move the opposite way to upright ears). */
  earXSign?: number;
  /** Scale of ear pose targets (long lop ears need smaller angles). */
  earAmount?: number;
  /** Overall movement scale (GLB might want less). */
  intensity?: number;
  /** How far "sad" swings the ears inward (upright ears flop right down; long lop ears only a little). */
  earSad?: number;
  /** Gesture arm poses tuned to the model's proportions. */
  poses?: Partial<Poses>;
};

const DEFAULT_POSES: Poses = {
  wave: [-2.85, 0.22, 1.35],
  sad: [-2.5, -0.72, 1.8],
  nuzzle: [-1.35, -0.55, 1],
};

/**
 * Procedural animation for every state in the plan:
 * idle (breathing, sway, ear twitch), listening (tilt, ears up), thinking
 * (tilt, one ear droops), talking (volume-driven bob/squish/jaw, ears bounce),
 * tricks (hop / ear flick / wiggle / spin). Ears are damped springs that lag
 * behind the head — the single most "alive" thing on screen.
 */
export function useBunnyAnimator(getRig: () => Rig | null, opts: RigOptions = {}) {
  const earZSign = opts.earZSign ?? 1;
  const earXSign = opts.earXSign ?? 1;
  const earAmt = opts.earAmount ?? 1;
  const earSad = opts.earSad ?? 0.75;
  const poses: Poses = { ...DEFAULT_POSES, ...opts.poses };
  const I = opts.intensity ?? 1;
  const rest = useRef(new Map<THREE.Object3D, Rest>());
  const buf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const st = useRef({
    level: 0,
    slowLevel: 0,
    head: new THREE.Vector3(),
    earLift: 0,
    droopR: 0,
    prevHead: new THREE.Vector3(),
    prevRootY: 0,
    rootVelY: 0,
    nextTwitch: 2 + Math.random() * 4,
    L: { x1: { a: 0, v: 0 }, x2: { a: 0, v: 0 }, z1: { a: 0, v: 0 }, z2: { a: 0, v: 0 } } as EarSprings,
    R: { x1: { a: 0, v: 0 }, x2: { a: 0, v: 0 }, z1: { a: 0, v: 0 }, z2: { a: 0, v: 0 } } as EarSprings,
    lean: 0,
    /** Smoothed gesture weights 0..1. */
    g: { wave: 0, sad: 0, nuzzle: 0 },
  });

  const captureRest = (o: THREE.Object3D | null) => {
    if (!o || rest.current.has(o)) return;
    rest.current.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
  };

  useEffect(() => {
    const map = rest.current;
    return () => map.clear();
  }, []);

  useFrame((state, rawDt) => {
    const rig = getRig();
    if (!rig) return;
    Object.values(rig).forEach(captureRest);
    const dt = Math.min(rawDt, 1 / 20);
    const t = state.clock.elapsedTime;
    const s = st.current;
    const now = performance.now();
    const mode = bunnyState.mode;

    // ---- Reply volume, smoothed over ~80 ms -------------------------------
    let raw = 0;
    const an = bunnyState.analyser;
    if (bunnyState.levelOverride) {
      raw = clamp(bunnyState.levelOverride(), 0, 1);
    } else if (an) {
      if (!buf.current || buf.current.length !== an.fftSize) buf.current = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(buf.current);
      let sum = 0;
      for (let i = 0; i < buf.current.length; i++) {
        const v = (buf.current[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.current.length);
      raw = clamp((rms - 0.008) * 7, 0, 1);
    }
    s.level += (raw - s.level) * (1 - Math.exp(-dt / 0.08));
    s.slowLevel += (s.level - s.slowLevel) * (1 - Math.exp(-dt / 0.35));
    bunnyState.level = s.level;
    const lvl = s.level;
    const syllable = Math.max(0, s.level - s.slowLevel); // spikes on each "word"

    // ---- Mode targets -----------------------------------------------------
    const tgt = new THREE.Vector3(
      0.03 * Math.sin(t * 0.5),
      0.09 * Math.sin(t * 0.31) + 0.03 * Math.sin(t * 0.83),
      0.04 * Math.sin(t * 0.43),
    );
    let earLift = 0;
    let droopR = 0;
    let lean = 0;
    if (mode === "listening") {
      tgt.set(0.1 + 0.02 * Math.sin(t * 1.3), 0.04 * Math.sin(t * 0.4), 0.2);
      earLift = 0.35;
      lean = 0.05;
    } else if (mode === "thinking") {
      tgt.set(-0.12, 0.18 + 0.03 * Math.sin(t * 0.9), -0.14);
      droopR = 0.55;
      earLift = 0.05;
    } else if (mode === "talking") {
      tgt.set(
        0.05 + lvl * 0.1 + syllable * 0.6 + 0.03 * Math.sin(t * 6.5) * lvl,
        0.08 * Math.sin(t * 0.9) + 0.05 * Math.sin(t * 2.1) * lvl,
        0.06 * Math.sin(t * 0.7) + 0.05 * Math.sin(t * 1.9) * lvl,
      );
      earLift = 0.15 + lvl * 0.1;
      lean = 0.02;
    }
    if (!bunnyState.live && mode === "idle") earLift = -0.05; // a bit sleepy when not on a call

    const hk = mode === "talking" ? 10 : 4;
    s.head.x = damp(s.head.x, tgt.x, hk, dt);
    s.head.y = damp(s.head.y, tgt.y, hk * 0.7, dt);
    s.head.z = damp(s.head.z, tgt.z, hk * 0.8, dt);
    s.earLift = damp(s.earLift, earLift, 3, dt);
    s.droopR = damp(s.droopR, droopR, 3, dt);
    s.lean = damp(s.lean, lean, 3, dt);

    // ---- Tricks -------------------------------------------------------------
    let hopY = 0;
    let spinY = 0;
    let wiggleZ = 0;
    let landSquash = 0;
    let flick = 0;
    const tr = bunnyState.trick;
    if (tr) {
      const e = (now - tr.at) / 1000;
      if (tr.type === "hop") {
        // Two little hops.
        const hop = (x: number, h: number) => (x > 0 && x < 1 ? 4 * h * x * (1 - x) : 0);
        hopY = hop(e / 0.42, 0.2) + hop((e - 0.46) / 0.36, 0.12);
        const land = (x: number) => (x > 0 && x < 0.18 ? Math.sin((x / 0.18) * Math.PI) : 0);
        landSquash = land(e - 0.42) * 0.12 + land(e - 0.82) * 0.08 + land(e) * 0.06;
        if (e < 0.05) flick = 1;
        if (e > 1.2) bunnyState.trick = null;
      } else if (tr.type === "ear_flick") {
        if (e < 0.05) flick = 1.4;
        if (e > 0.6) bunnyState.trick = null;
      } else if (tr.type === "wiggle") {
        wiggleZ = Math.sin(e * 28) * 0.14 * Math.max(0, 1 - e / 0.9);
        if (e > 0.9) bunnyState.trick = null;
      } else if (tr.type === "spin") {
        spinY = easeInOut(clamp(e / 1.0, 0, 1)) * Math.PI * 2;
        hopY = Math.sin(clamp(e / 1.0, 0, 1) * Math.PI) * 0.06;
        if (e > 1.05) bunnyState.trick = null;
      }
    }

    // ---- Gestures: held poses, blended in and out smoothly ----------------
    const ge = bunnyState.gesture;
    if (ge && now > ge.until) bunnyState.gesture = null;
    const gw = s.g;
    for (const k of ["wave", "sad", "nuzzle"] as const) {
      gw[k] = damp(gw[k], bunnyState.gesture?.type === k ? 1 : 0, k === "wave" ? 7 : 4, dt);
    }
    // Nuzzle: rub the head side to side, leaning in toward the camera.
    const rub = Math.sin(t * 4.2);
    const headX = s.head.x * (1 - gw.sad * 0.6) + gw.sad * 0.38 + gw.nuzzle * 0.12;
    const headY = s.head.y + gw.nuzzle * 0.14 * Math.sin(t * 4.2 + 0.6);
    const headZ = s.head.z * (1 - gw.sad * 0.5) + gw.wave * 0.12 + gw.nuzzle * 0.22 * rub;

    // ---- Root: sway, hop, spin -------------------------------------------
    if (rig.root) {
      const r = rest.current.get(rig.root)!;
      rig.root.position.copy(r.p);
      rig.root.position.y += hopY * I;
      rig.root.position.z += gw.nuzzle * 0.12 * I;
      _e.set((s.lean + gw.nuzzle * 0.16 + gw.sad * 0.07) * I, spinY + 0.04 * Math.sin(t * 0.37) * I, (0.025 * Math.sin(t * 0.7) + wiggleZ) * I);
      rig.root.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
      const vy = (rig.root.position.y - s.prevRootY) / Math.max(dt, 1e-3);
      const accY = (vy - s.rootVelY) / Math.max(dt, 1e-3);
      s.rootVelY = vy;
      s.prevRootY = rig.root.position.y;
      // Feed vertical acceleration into ears (they flop on landing).
      const f = clamp(accY, -80, 80) * 0.25;
      s.L.z1.v += f * dt;
      s.R.z1.v += f * dt;
      s.L.x1.v -= f * dt * 0.5;
      s.R.x1.v -= f * dt * 0.5;
    }

    // ---- Body: breathing + talking squish + landing squash ----------------
    if (rig.body) {
      const r = rest.current.get(rig.body)!;
      const breath = 0.02 * Math.sin((t * Math.PI * 2) / 3.6);
      const snuggle = gw.nuzzle * 0.025 * (1 + Math.sin(t * 8.4));
      const sy = 1 + breath * I - lvl * 0.04 * I - syllable * 0.25 * I - landSquash - gw.sad * 0.05 - snuggle;
      const sxz = 1 + (1 - sy) * 0.55;
      rig.body.scale.set(r.s.x * sxz, r.s.y * sy, r.s.z * sxz);
    }

    // ---- Head ---------------------------------------------------------------
    if (rig.head) {
      const r = rest.current.get(rig.head)!;
      _e.set(headX * I, headY * I, headZ * I);
      rig.head.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
    }
    // Ears react to the head as actually posed (gestures included).
    const headNow = new THREE.Vector3(headX, headY, headZ);
    const headVel = headNow.clone().sub(s.prevHead).divideScalar(Math.max(dt, 1e-3));
    s.prevHead.copy(headNow);

    // ---- Jaw / cheeks: a soft squash of the lower face timed to volume ------
    if (rig.jaw) {
      const r = rest.current.get(rig.jaw)!;
      const open = lvl * 0.22 + syllable * 0.8;
      rig.jaw.scale.set(r.s.x * (1 + open * 0.15), r.s.y * (1 + open), r.s.z * (1 + open * 0.2));
    }

    // ---- Ears: damped springs following the head --------------------------
    s.nextTwitch -= dt;
    let twitchL = 0;
    let twitchR = 0;
    if (s.nextTwitch <= 0) {
      if (Math.random() < 0.5) twitchL = 1;
      else twitchR = 1;
      s.nextTwitch = 2.5 + Math.random() * 5;
    }
    const talkBounce = mode === "talking" ? syllable * 60 : 0;
    const ear = (sp: EarSprings, side: 1 | -1, n1: THREE.Object3D | null, n2: THREE.Object3D | null, twitch: number, droop: number) => {
      // Ears lag opposite to the head's motion.
      const fx = -headVel.x * 9 - talkBounce - flick * 220 - twitch * 120;
      const fz = -headVel.z * 9 * side + headVel.y * 4 * side + flick * 60;
      // Positive lift pulls ears upright (less splay), droop lets one fall.
      // Sad: both ears flop right down. Nuzzle: ears relax back.
      const lift = s.earLift * (1 - gw.sad) - gw.sad * 0.2;
      const restZ = (-lift * 0.6 + droop * (1 - gw.sad) + gw.sad * earSad + gw.nuzzle * 0.25) * earAmt;
      const restX = (-lift * 0.25 + droop * 0.3 - gw.nuzzle * 0.35 + gw.sad * 0.25) * earAmt;
      const ax1 = stepSpring(sp.x1, restX, 140, 7, fx, dt);
      stepSpring(sp.x2, restX * 0.6, 110, 5, -ax1 * 0.35 + fx * 0.4, dt);
      const az1 = stepSpring(sp.z1, restZ, 120, 6, fz, dt);
      stepSpring(sp.z2, restZ * 0.8, 90, 4.5, -az1 * 0.35 + fz * 0.4, dt);

      const zs = side * earZSign;
      if (n1) {
        const r = rest.current.get(n1)!;
        _e.set(sp.x1.a * earXSign * I, 0, -sp.z1.a * zs * I);
        n1.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
      }
      if (n2) {
        const r = rest.current.get(n2)!;
        _e.set(sp.x2.a * earXSign * I, 0, -sp.z2.a * zs * I);
        n2.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
      }
    };
    ear(s.L, 1, rig.earL1, rig.earL2, twitchL, 0);
    ear(s.R, -1, rig.earR1, rig.earR2, twitchR, s.droopR);

    // ---- Arms: gentle idle swing, little gestures while talking -----------
    const arm = (n: THREE.Object3D | null, side: 1 | -1, phase: number) => {
      if (!n) return;
      const r = rest.current.get(n)!;
      const swing = 0.05 * Math.sin(t * 0.9 + phase) + (mode === "talking" ? 0.25 * lvl * Math.sin(t * 3.2 + phase) : 0);
      const lift = (mode === "listening" ? 0.08 : 0) + hopY * 1.5 + syllable * 0.6;
      let ax = -swing;
      let az = lift * side;
      // Wave (left paw only): paw up right beside the face, little side-to-side waves.
      let stretch = 1;
      if (side === 1 && gw.wave > 0.001) {
        ax = lerp(ax, poses.wave[0], gw.wave);
        az = lerp(az, poses.wave[1] + 0.28 * Math.sin(t * 10.5), gw.wave);
        stretch = lerp(stretch, poses.wave[2], gw.wave);
      }
      // Sad: both paws come up to cover the face (soft plush arms stretch a little).
      ax = lerp(ax, poses.sad[0], gw.sad);
      az = lerp(az, poses.sad[1] * side, gw.sad);
      stretch = lerp(stretch, poses.sad[2], gw.sad);
      // Nuzzle: arms come forward and in, like a cuddle.
      ax = lerp(ax, poses.nuzzle[0] + 0.08 * rub, gw.nuzzle);
      az = lerp(az, poses.nuzzle[1] * side, gw.nuzzle);
      stretch = lerp(stretch, poses.nuzzle[2], gw.nuzzle);
      // Pose angles are absolute; only idle motion is scaled by intensity.
      _e.set(ax, 0, az);
      n.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
      n.scale.set(r.s.x, r.s.y * stretch, r.s.z);
    };
    arm(rig.armL, 1, 0);
    arm(rig.armR, -1, 1.7);
  });
}
