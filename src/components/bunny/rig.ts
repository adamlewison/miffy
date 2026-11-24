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
  chest: THREE.Object3D | null;
  head: THREE.Object3D | null;
  jaw: THREE.Object3D | null;
  earL1: THREE.Object3D | null;
  earL2: THREE.Object3D | null;
  earL3: THREE.Object3D | null;
  earR1: THREE.Object3D | null;
  earR2: THREE.Object3D | null;
  earR3: THREE.Object3D | null;
  armL: THREE.Object3D | null;
  armR: THREE.Object3D | null;
  pawL: THREE.Object3D | null;
  pawR: THREE.Object3D | null;
  footL: THREE.Object3D | null;
  footR: THREE.Object3D | null;
  tail: THREE.Object3D | null;
  eyeL: THREE.Object3D | null;
  eyeR: THREE.Object3D | null;
  nose: THREE.Object3D | null;
};

/** Bone names to use in Blender (aliases are accepted too, see GlbBunny). */
export const BONE_NAMES: Record<keyof Rig, string[]> = {
  root: ["root", "Root"],
  body: ["body", "spine", "Body", "Spine"],
  chest: ["chest", "Chest"],
  head: ["head", "Head"],
  jaw: ["jaw", "cheeks", "Jaw", "Cheeks"],
  earL1: ["ear_L_1", "ear.L", "ear.L.001", "earL1", "Ear_L_1"],
  earL2: ["ear_L_2", "ear.L.002", "earL2", "Ear_L_2"],
  earL3: ["ear_L_3"],
  earR1: ["ear_R_1", "ear.R", "ear.R.001", "earR1", "Ear_R_1"],
  earR2: ["ear_R_2", "ear.R.002", "earR2", "Ear_R_2"],
  earR3: ["ear_R_3"],
  armL: ["arm_L", "arm.L", "armL", "Arm_L"],
  armR: ["arm_R", "arm.R", "armR", "Arm_R"],
  pawL: ["paw_L"],
  pawR: ["paw_R"],
  footL: ["foot_L"],
  footR: ["foot_R"],
  tail: ["tail", "Tail"],
  eyeL: ["eye_L"],
  eyeR: ["eye_R"],
  nose: ["nose", "Nose"],
};

type Rest = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 };
type Spring = { a: number; v: number };
type EarSprings = { x1: Spring; x2: Spring; x3: Spring; z1: Spring; z2: Spring; z3: Spring };

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

const zeroSprings = (): EarSprings => ({
  x1: { a: 0, v: 0 },
  x2: { a: 0, v: 0 },
  x3: { a: 0, v: 0 },
  z1: { a: 0, v: 0 },
  z2: { a: 0, v: 0 },
  z3: { a: 0, v: 0 },
});

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** Arm poses for the held gestures: [rotX, rotZ (mirrored per side), stretch]. */
export type Poses = {
  wave: [number, number, number];
  sad: [number, number, number];
  nuzzle: [number, number, number];
  clap: [number, number, number];
  cheer: [number, number, number];
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
  /** Max inward swing (rad) — long lop ears hang beside the cheeks and must never cross the face. */
  earMaxIn?: number;
  /** Solid-body collision (keeps arms and ears out of her head/body). */
  solid?: () => { solve: (rig: Rig) => void } | null;
  /** Gesture arm poses tuned to the model's proportions. */
  poses?: Partial<Poses>;
};

const DEFAULT_POSES: Poses = {
  wave: [-2.85, 0.22, 1.35],
  sad: [-2.5, -0.72, 1.8],
  nuzzle: [-1.35, -0.55, 1],
  clap: [-1.2, -0.5, 1],
  cheer: [-2.6, 0.6, 1.1],
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
  const earMaxIn = opts.earMaxIn ?? Infinity;
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
    L: zeroSprings(),
    R: zeroSprings(),
    lean: 0,
    /** Smoothed gesture weights 0..1. */
    g: { wave: 0, sad: 0, nuzzle: 0, clap: 0, cheer: 0, shy: 0, sleepy: 0 },
    // Face life: blinks, eye gaze, nose sniffs, tail and foot springs.
    nextBlink: 1.5 + Math.random() * 2,
    blinkAt: -10,
    blinkDouble: false,
    nextGaze: 1,
    gaze: new THREE.Vector2(),
    gazeTgt: new THREE.Vector2(),
    nextSniff: 2,
    sniffAt: -10,
    pawL: { a: 0, v: 0 } as Spring,
    pawR: { a: 0, v: 0 } as Spring,
    happy: 0,
    chestLag: { a: 0, v: 0 } as Spring,
    nextFoot: 4,
    footAt: -10,
    footSide: 1,
    nextFidget: 6 + Math.random() * 6,
    fidget: null as null | { type: 'curious' | 'shuffle' | 'shiver' | 'stretch'; at: number },
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
    // Eyes lead, the head follows a beat later: looking left makes her head turn a little too.
    tgt.y += s.gaze.x * 0.07;
    tgt.x -= s.gaze.y * 0.05;
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

    // ---- Idle fidgets: tiny unprompted things a living toy does ---------------
    s.nextFidget -= dt;
    if (s.nextFidget <= 0) {
      s.nextFidget = 7 + Math.random() * 9;
      if (mode === "idle" || mode === "listening") {
        const kinds = ["curious", "shuffle", "shiver", "stretch"] as const;
        s.fidget = { type: kinds[Math.floor(Math.random() * kinds.length)], at: t };
      }
    }
    let fCur = 0; // curious tilt, with ears perking
    let fShuf = 0; // weight shift side to side
    let fShiv = 0;
    let fStretch = 0;
    if (s.fidget) {
      const fe = t - s.fidget.at;
      const dur = s.fidget.type === "shiver" ? 0.7 : s.fidget.type === "stretch" ? 2.2 : 2.0;
      const env = fe < dur ? Math.sin((fe / dur) * Math.PI) ** 0.6 : 0;
      if (s.fidget.type === "curious") fCur = env;
      else if (s.fidget.type === "shuffle") fShuf = env * Math.sin(fe * 2.4);
      else if (s.fidget.type === "shiver") fShiv = env * Math.sin(fe * 55);
      else fStretch = env;
      if (fe > dur) s.fidget = null;
    }

    // ---- Tricks -------------------------------------------------------------
    let hopY = 0;
    let spinY = 0;
    let wiggleZ = 0;
    let landSquash = 0;
    let flick = 0;
    let laugh = 0;
    const tr = bunnyState.trick;
    if (tr) {
      const e = (now - tr.at) / 1000;
      if (tr.type === "hop") {
        // Two little hops.
        const hop = (x: number, h: number) => (x > 0 && x < 1 ? 4 * h * x * (1 - x) : 0);
        // Anticipation: crouch first (0.14 s), then spring.
        const e2 = e - 0.14;
        hopY = hop(e2 / 0.42, 0.2) + hop((e2 - 0.46) / 0.36, 0.12);
        const land = (x: number) => (x > 0 && x < 0.18 ? Math.sin((x / 0.18) * Math.PI) : 0);
        const crouch = e < 0.14 ? Math.sin((e / 0.14) * Math.PI * 0.5) * 0.1 : 0;
        landSquash = land(e2 - 0.42) * 0.12 + land(e2 - 0.82) * 0.08 + crouch;
        if (e < 0.05) flick = 1;
        if (e > 1.35) bunnyState.trick = null;
      } else if (tr.type === "ear_flick") {
        if (e < 0.05) flick = 1.4;
        if (e > 0.6) bunnyState.trick = null;
      } else if (tr.type === "wiggle") {
        wiggleZ = Math.sin(e * 28) * 0.14 * Math.max(0, 1 - e / 0.9);
        if (e > 0.9) bunnyState.trick = null;
      } else if (tr.type === "giggle") {
        // Shoulders shaking, eyes squeezed shut, a couple of tiny bounces.
        laugh = Math.min(1, e / 0.12) * Math.max(0, Math.min(1, (1.7 - e) / 0.35));
        hopY = Math.max(0, Math.sin(e * 15)) * 0.018 * laugh;
        wiggleZ = Math.sin(e * 24) * 0.05 * laugh;
        if (e < 0.05) flick = 0.6;
        if (e > 1.7) bunnyState.trick = null;
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
    for (const k of ["wave", "sad", "nuzzle", "clap", "cheer", "shy", "sleepy"] as const) {
      gw[k] = damp(gw[k], bunnyState.gesture?.type === k ? 1 : 0, k === "wave" || k === "clap" ? 7 : 4, dt);
    }
    const clapPhase = Math.max(0, Math.sin(t * 13)); // 0..1 pulse; paws meet at 1
    // Happiness (0..1) drives eye squints, tail wags and foot wiggles.
    const happyT = clamp(laugh + gw.cheer + gw.nuzzle * 0.7 + gw.clap * 0.8 + (mode === "talking" ? 0.25 + lvl * 0.4 : 0) + (tr?.type === "hop" || tr?.type === "wiggle" ? 0.8 : 0), 0, 1);
    s.happy = damp(s.happy, happyT, 5, dt);
    // Nuzzle: rub the head side to side, leaning in toward the camera.
    const rub = Math.sin(t * 4.2);
    const headX =
      fCur * 0.06 - fStretch * 0.2 + s.head.x * (1 - gw.sad * 0.6) + gw.sad * 0.38 + gw.nuzzle * 0.12 + gw.sleepy * (0.3 + 0.04 * Math.sin(t * 0.8)) + gw.shy * 0.2 - laugh * 0.16 - gw.cheer * 0.12 + gw.clap * 0.04;
    const headY = s.head.y + gw.nuzzle * 0.14 * Math.sin(t * 4.2 + 0.6) - gw.shy * 0.22;
    const headZ = fCur * 0.3 + s.head.z * (1 - gw.sad * 0.5) + gw.wave * 0.12 + gw.nuzzle * 0.22 * rub + gw.shy * 0.24 + laugh * 0.05 * Math.sin(t * 24) + gw.cheer * 0.1 * Math.sin(t * 7) + gw.sleepy * 0.1;

    // ---- Root: sway, hop, spin -------------------------------------------
    if (rig.root) {
      const r = rest.current.get(rig.root)!;
      rig.root.position.copy(r.p);
      rig.root.position.y += hopY * I;
      rig.root.position.z += gw.nuzzle * 0.12 * I;
      _e.set((s.lean + gw.nuzzle * 0.16 + gw.sad * 0.07) * I, spinY + 0.04 * Math.sin(t * 0.37) * I + fShuf * 0.04, (0.025 * Math.sin(t * 0.7) + wiggleZ + fShuf * 0.05 + fShiv * 0.012) * I);
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
      const ph = (t * Math.PI * 2) / 3.6;
      const breath = 0.02 * Math.sin(ph + 0.55 * Math.sin(ph)) * (1 + 0.3 * Math.sin(t * 0.21)) + fStretch * 0.025;
      const snuggle = gw.nuzzle * 0.025 * (1 + Math.sin(t * 8.4));
      const sy = 1 + breath * I + gw.sleepy * 0.015 * Math.sin(t * 1.4) - lvl * 0.04 * I - syllable * 0.25 * I - landSquash - gw.sad * 0.05 - snuggle;
      const sxz = 1 + (1 - sy) * 0.55;
      rig.body.scale.set(r.s.x * sxz, r.s.y * sy, r.s.z * sxz);
    }

    // ---- Chest (spine): breathes, leans into moves, and the head follows through ----
    if (rig.chest) {
      const r = rest.current.get(rig.chest)!;
      const bx = 0.022 * Math.sin((t * Math.PI * 2) / 3.6 - 0.4) - syllable * 0.12 + gw.sad * 0.1 + gw.shy * 0.07 - gw.cheer * 0.05 + gw.sleepy * 0.08 - laugh * 0.04;
      // A soft lag spring: the chest settles a beat behind the head's motion.
      stepSpring(s.chestLag, bx, 60, 9, 0, dt);
      _e.set(s.chestLag.a * 0.5 * I, gw.nuzzle * 0.06 * rub * I, (0.012 * Math.sin(t * 0.55) + gw.shy * 0.04 + wiggleZ * 0.5) * I);
      rig.chest.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
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
      const yawn = gw.sleepy * clamp(Math.sin(t * 0.9) * 1.6, 0, 1) * 0.9;
      const open = lvl * 0.22 + syllable * 0.8 + yawn + laugh * 0.3 * Math.abs(Math.sin(t * 12));
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
    const ear = (
      sp: EarSprings,
      side: 1 | -1,
      n1: THREE.Object3D | null,
      n2: THREE.Object3D | null,
      n3: THREE.Object3D | null,
      twitch: number,
      droop: number,
    ) => {
      // Ears lag opposite to the head's motion.
      const fx = -headVel.x * 9 - talkBounce - flick * 220 - twitch * 120 - gw.clap * clapPhase * 30;
      const fz = -headVel.z * 9 * side + headVel.y * 4 * side + flick * 60 + laugh * Math.sin(t * 26) * 90;
      // Positive lift pulls ears upright (less splay), droop lets one fall.
      // Sad: both ears flop right down. Nuzzle: ears relax back.
      const lift = (s.earLift + fCur * 0.3) * (1 - gw.sad) - gw.sad * 0.2 + gw.cheer * 0.3;
      const sway = 0.035 * Math.sin(t * 0.63 + side * 1.9) + 0.02 * Math.sin(t * 1.37 + side);
      const restZ = (sway - lift * 0.6 + droop * (1 - gw.sad) + gw.sad * earSad + gw.nuzzle * 0.25 + gw.sleepy * 0.2 + gw.shy * 0.15) * earAmt;
      const restX = (-lift * 0.25 + droop * 0.3 - gw.nuzzle * 0.35 + gw.sad * 0.25 + gw.sleepy * 0.2) * earAmt;
      const ax1 = stepSpring(sp.x1, restX, 140, 7, fx, dt);
      const ax2 = stepSpring(sp.x2, restX * 0.6, 110, 5, -ax1 * 0.35 + fx * 0.4, dt);
      stepSpring(sp.x3, restX * 0.4, 90, 3.6, -ax2 * 0.4 + fx * 0.3, dt);
      const az1 = stepSpring(sp.z1, restZ, 120, 6, fz, dt);
      const az2 = stepSpring(sp.z2, restZ * 0.8, 90, 4.5, -az1 * 0.35 + fz * 0.4, dt);
      stepSpring(sp.z3, restZ * 0.6, 70, 3.4, -az2 * 0.4 + fz * 0.3, dt);

      const zs = side * earZSign;
      const bone = (n: THREE.Object3D | null, x: number, z: number, inMax: number) => {
        if (!n) return;
        const r = rest.current.get(n)!;
        _e.set(x * earXSign * I, 0, -Math.min(z, inMax) * zs * I);
        n.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
      };
      bone(n1, sp.x1.a, sp.z1.a, earMaxIn);
      bone(n2, sp.x2.a, sp.z2.a, earMaxIn * 0.5);
      // The tip curls and flutters a little more than the rest.
      bone(n3, sp.x3.a * 1.4, sp.z3.a * 1.4, earMaxIn * 0.35);
    };
    ear(s.L, 1, rig.earL1, rig.earL2, rig.earL3, twitchL, 0);
    ear(s.R, -1, rig.earR1, rig.earR2, rig.earR3, twitchR, s.droopR);

    // ---- Arms + paws: gentle idle swing, little gestures while talking -----
    const arm = (n: THREE.Object3D | null, pawN: THREE.Object3D | null, side: 1 | -1, phase: number, pawSp: Spring) => {
      if (!n) return;
      const r = rest.current.get(n)!;
      const swing = 0.05 * Math.sin(t * 0.9 + phase) + (mode === "talking" ? 0.25 * lvl * Math.sin(t * 3.2 + phase) : 0);
      const lift = (mode === "listening" ? 0.08 : 0) + hopY * 1.5 + syllable * 0.6 + laugh * 0.12 * Math.abs(Math.sin(t * 12));
      let ax = -swing;
      let az = lift * side;
      let pawX = 0;
      let pawZ = 0;
      // Wave (left paw only): the whole arm lifts, then the paw waves from the wrist.
      let stretch = 1;
      if (side === 1 && gw.wave > 0.001) {
        ax = lerp(ax, poses.wave[0], gw.wave);
        az = lerp(az, poses.wave[1] + 0.1 * Math.sin(t * 10.5), gw.wave);
        stretch = lerp(stretch, poses.wave[2], gw.wave);
        pawZ += gw.wave * 0.5 * Math.sin(t * 10.5 + 0.8);
        pawX += gw.wave * 0.12;
      }
      // Sad: both paws come up to cover the face (soft plush arms stretch a little).
      ax = lerp(ax, poses.sad[0], gw.sad);
      az = lerp(az, poses.sad[1] * side, gw.sad);
      stretch = lerp(stretch, poses.sad[2], gw.sad);
      // Shy: paws creep up toward the cheeks, rubbing a little.
      ax = lerp(ax, poses.sad[0] * 0.55, gw.shy);
      az = lerp(az, poses.sad[1] * 0.4 * side, gw.shy);
      pawX += gw.shy * 0.25 * Math.sin(t * 5 + phase);
      // Nuzzle: arms come forward and in, like a cuddle.
      ax = lerp(ax, poses.nuzzle[0] + 0.08 * rub, gw.nuzzle);
      az = lerp(az, poses.nuzzle[1] * side, gw.nuzzle);
      stretch = lerp(stretch, poses.nuzzle[2], gw.nuzzle);
      pawX -= gw.nuzzle * 0.25;
      // Clap: both paws swing together in front of her chest.
      ax = lerp(ax, poses.clap[0] + 0.12 * clapPhase, gw.clap);
      az = lerp(az, (poses.clap[1] - 0.12 * clapPhase) * side, gw.clap);
      pawX -= gw.clap * 0.2;
      // Cheer: arms thrown up and out.
      ax = lerp(ax, poses.cheer[0] + 0.12 * Math.sin(t * 9 + phase), gw.cheer);
      az = lerp(az, (poses.cheer[1] + 0.12 * Math.sin(t * 9 + phase)) * side, gw.cheer);
      stretch = lerp(stretch, poses.cheer[2], gw.cheer);
      // Sleepy: arms slowly stretch out and up in a yawn.
      const yawn = gw.sleepy * clamp(Math.sin(t * 0.9) * 1.6, 0, 1);
      ax = lerp(ax, -2.2, yawn * 0.7);
      az = lerp(az, 0.5 * side, yawn * 0.7);
      // Pose angles are absolute; only idle motion is scaled by intensity.
      _e.set(ax, 0, az);
      n.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
      n.scale.set(r.s.x, r.s.y * stretch, r.s.z);
      if (pawN) {
        // The paw trails the arm like a floppy wrist: a spring on the arm's swing.
        stepSpring(pawSp, 0, 90, 5, -(ax + swing) * 6 + (az - lift * side) * 0, dt);
        const pr = rest.current.get(pawN)!;
        _e.set(pawSp.a * 0.35 + pawX + (mode === "talking" ? 0.15 * lvl * Math.sin(t * 7 + phase) : 0), 0, pawZ * side * 0 + pawZ);
        pawN.quaternion.copy(pr.q).multiply(_q.setFromEuler(_e));
      }
    };
    arm(rig.armL, rig.pawL, 1, 0, s.pawL);
    arm(rig.armR, rig.pawR, -1, 1.7, s.pawR);

    // ---- Face life: blinks, eye gaze and nose sniffs ------------------------
    s.nextBlink -= dt;
    if (s.nextBlink <= 0) {
      s.blinkAt = t;
      s.blinkDouble = Math.random() < 0.2;
      s.nextBlink = 2 + Math.random() * 4.5;
    }
    const be = t - s.blinkAt;
    // One quick blink (0.22 s), sometimes followed by a second.
    const blinkCurve = (x: number) => (x > 0 && x < 0.22 ? Math.sin((x / 0.22) * Math.PI) : 0);
    let blink = Math.max(blinkCurve(be), s.blinkDouble ? blinkCurve(be - 0.3) : 0);
    // Slow sleepy lids, happy squints (^ ^) and sad droop.
    const squint = clamp(laugh * 0.9 + gw.cheer * 0.45 + gw.shy * 0.5 + s.happy * 0.18 + gw.nuzzle * 0.5, 0, 0.9);
    const sleepyLid = gw.sleepy * (0.55 + 0.4 * Math.sin(t * 0.9) ** 2);
    blink = Math.max(blink, squint, sleepyLid, gw.sad * 0.45);
    s.nextGaze -= dt;
    if (s.nextGaze <= 0) {
      s.nextGaze = 0.8 + Math.random() * 2.8;
      if (Math.random() < 0.35) s.nextBlink = Math.min(s.nextBlink, 0.08);
      if (mode === "thinking") s.gazeTgt.set(0.7 * (Math.random() < 0.5 ? 1 : -1), 1);
      else if (mode === "talking" || mode === "listening") s.gazeTgt.set((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.5);
      else s.gazeTgt.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.0);
    }
    s.gaze.x = damp(s.gaze.x, s.gazeTgt.x, 14, dt);
    s.gaze.y = damp(s.gaze.y, s.gazeTgt.y, 14, dt);
    for (const [eye, side] of [
      [rig.eyeL, 1],
      [rig.eyeR, -1],
    ] as const) {
      if (!eye) continue;
      const r = rest.current.get(eye)!;
      // Squash the eye shut from the top and bottom about its centre (a happy squint rides a little high).
      const k = 1 - 0.93 * blink;
      eye.scale.set(r.s.x * (1 + 0.1 * blink), r.s.y * k, r.s.z);
      eye.position.set(r.p.x + s.gaze.x * 0.003 + 0 * side, r.p.y + s.gaze.y * 0.0025 + squint * 0.004, r.p.z);
    }
    if (rig.nose) {
      const r = rest.current.get(rig.nose)!;
      s.nextSniff -= dt;
      if (s.nextSniff <= 0) {
        s.sniffAt = t;
        s.nextSniff = (mode === "listening" ? 1.5 : 3) + Math.random() * 4;
      }
      const se = t - s.sniffAt;
      const sniff = se > 0 && se < 0.7 ? Math.sin(se * 36) * Math.sin((se / 0.7) * Math.PI) : 0;
      const hum = mode === "talking" ? lvl * 0.4 * Math.sin(t * 18) : 0;
      rig.nose.scale.set(r.s.x * (1 + 0.07 * (sniff + hum)), r.s.y * (1 + 0.1 * (sniff + hum)), r.s.z);
      rig.nose.position.set(r.p.x, r.p.y + 0.002 * (sniff + hum), r.p.z);
    }

    // ---- Tail and feet: the little things that make her feel alive ----------
    if (rig.tail) {
      const r = rest.current.get(rig.tail)!;
      const wag = (0.06 + 0.5 * s.happy) * Math.sin(t * (9 + 8 * s.happy)) + flick * 0.1;
      _e.set(0.05 * Math.sin(t * 5) * s.happy + hopY * 2, wag, 0);
      rig.tail.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
    }
    s.nextFoot -= dt;
    if (s.nextFoot <= 0) {
      s.footAt = t;
      s.footSide = Math.random() < 0.5 ? 1 : -1;
      s.nextFoot = 4 + Math.random() * 6;
    }
    const fe = t - s.footAt;
    const tap = fe > 0 && fe < 0.5 ? Math.sin(fe * 18) * Math.sin((fe / 0.5) * Math.PI) : 0;
    for (const [foot, side] of [
      [rig.footL, 1],
      [rig.footR, -1],
    ] as const) {
      if (!foot) continue;
      const r = rest.current.get(foot)!;
      const kick = s.happy * 0.14 * Math.sin(t * 7 + (side === 1 ? 0 : Math.PI)) + (s.footSide === side ? tap * 0.12 : 0) - hopY * 1.2 - landSquash * 0.5;
      _e.set(kick, 0, (side * (laugh * 0.1 * Math.sin(t * 22))) );
      foot.quaternion.copy(r.q).multiply(_q.setFromEuler(_e));
    }

    // ---- Solid body: nothing passes through anything else ------------------
    opts.solid?.()?.solve(rig);
  });
}
