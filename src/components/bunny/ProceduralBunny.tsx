"use client";

import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useBunnyAnimator, type Rig } from "./rig";
import { plush, stitch } from "./materials";

/**
 * Placeholder bunny built from simple shapes (plan Phase 1, Route B, in code):
 * pear body, round head, long floppy ears, stubby arms, big feet, cream tummy
 * and face, terry-cloth material. Exposes the same rig as the Blender GLB, so
 * swapping in public/bunny.glb needs no animation changes.
 */

const TAN = "#c99f74";
const CREAM = "#f4e7d0";
const PINK = "#e7a19b";

function pearGeometry() {
  const pts = [
    [0.0, 0.0], [0.3, 0.02], [0.44, 0.12], [0.5, 0.3], [0.48, 0.48],
    [0.41, 0.66], [0.31, 0.8], [0.18, 0.9], [0.0, 0.94],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const curve = new THREE.SplineCurve(pts);
  const g = new THREE.LatheGeometry(curve.getPoints(40), 48);
  g.scale(1, 1, 0.86);
  return g;
}

function capsule(r: number, len: number) {
  return new THREE.CapsuleGeometry(r, len, 8, 20);
}

function smileGeometry() {
  // A stitched "w" mouth.
  const c = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.075, 0.012, -0.012),
    new THREE.Vector3(-0.04, -0.016, 0.0),
    new THREE.Vector3(0.0, 0.004, 0.006),
    new THREE.Vector3(0.04, -0.016, 0.0),
    new THREE.Vector3(0.075, 0.012, -0.012),
  ]);
  return new THREE.TubeGeometry(c, 32, 0.0075, 6, false);
}

function Ear({ side, rig1, rig2, tan, cream }: { side: 1 | -1; rig1: (o: THREE.Group) => void; rig2: (o: THREE.Group) => void; tan: THREE.Material; cream: THREE.Material }) {
  const g = useMemo(
    () => ({
      seg1: capsule(0.095, 0.22),
      seg2: capsule(0.09, 0.2),
      in1: capsule(0.058, 0.2),
      in2: capsule(0.054, 0.18),
      joint: new THREE.SphereGeometry(0.095, 24, 16),
    }),
    [],
  );
  // Two segments with a rounded joint so the bend reads as one soft, floppy ear.
  return (
    <group ref={rig1} position={[0.16 * side, 0.66, -0.03]} rotation={[-0.1, 0, -0.3 * side]}>
      <mesh geometry={g.seg1} material={tan} position={[0, 0.16, 0]} scale={[1, 1, 0.42]} />
      <mesh geometry={g.in1} material={cream} position={[0, 0.17, 0.03]} scale={[1, 1, 0.3]} />
      <group ref={rig2} position={[0, 0.31, 0]} rotation={[0.3, 0, -0.5 * side]}>
        <mesh geometry={g.joint} material={tan} scale={[1, 1, 0.42]} />
        <mesh geometry={g.seg2} material={tan} position={[0, 0.14, 0]} scale={[1, 1, 0.42]} />
        <mesh geometry={g.in2} material={cream} position={[0, 0.12, 0.03]} scale={[1, 1, 0.3]} />
      </group>
    </group>
  );
}

export function ProceduralBunny() {
  const rig = useRef<Rig>({
    root: null, body: null, head: null, jaw: null,
    earL1: null, earL2: null, earR1: null, earR2: null, armL: null, armR: null,
  });
  const set = (k: keyof Rig) => (o: THREE.Object3D | null) => {
    rig.current[k] = o;
  };
  useBunnyAnimator(() => rig.current);

  const m = useMemo(
    () => ({
      tan: plush(TAN),
      cream: plush(CREAM, { rimStrength: 0.25 }),
      pink: plush(PINK, { bump: 0.4, rimStrength: 0.15 }),
      dark: stitch(),
      shine: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
      blush: new THREE.MeshBasicMaterial({ color: "#f2a6a0", transparent: true, opacity: 0.35, depthWrite: false }),
    }),
    [],
  );
  const g = useMemo(
    () => ({
      pear: pearGeometry(),
      sphere: new THREE.SphereGeometry(1, 40, 28),
      arm: capsule(0.085, 0.22),
      smile: smileGeometry(),
    }),
    [],
  );

  return (
    <group ref={set("root")}>
      <group ref={set("body")}>
        <mesh geometry={g.pear} material={m.tan} />
        {/* tummy */}
        <mesh geometry={g.sphere} material={m.cream} position={[0, 0.37, 0.31]} scale={[0.31, 0.36, 0.13]} />
        {/* feet */}
        {[1, -1].map((s) => (
          <group key={s} position={[0.22 * s, 0.08, 0.18]} rotation={[0, 0.18 * s, 0]}>
            <mesh geometry={g.sphere} material={m.tan} scale={[0.17, 0.11, 0.27]} />
            <mesh geometry={g.sphere} material={m.cream} position={[0, -0.005, 0.2]} scale={[0.1, 0.075, 0.07]} />
          </group>
        ))}
        {/* tail */}
        <mesh geometry={g.sphere} material={m.cream} position={[0, 0.2, -0.4]} scale={0.1} />
        {/* arms */}
        {([1, -1] as const).map((s) => (
          <group key={s} ref={set(s === 1 ? "armL" : "armR")} position={[0.33 * s, 0.68, 0.08]}>
            <mesh geometry={g.arm} material={m.tan} position={[0.06 * s, -0.15, 0.05]} rotation={[0.35, 0, 0.42 * s]} />
            <mesh geometry={g.sphere} material={m.cream} position={[0.12 * s, -0.27, 0.11]} scale={[0.06, 0.05, 0.05]} />
          </group>
        ))}

        <group ref={set("head")} position={[0, 0.88, 0]}>
          <mesh geometry={g.sphere} material={m.tan} position={[0, 0.33, 0]} scale={[0.46, 0.4, 0.4]} />
          {/* face patch */}
          <mesh geometry={g.sphere} material={m.cream} position={[0, 0.23, 0.29]} scale={[0.29, 0.2, 0.15]} />
          {/* cheeks / lower face — this squashes when talking */}
          <group ref={set("jaw")} position={[0, 0.17, 0.355]}>
            <mesh geometry={g.sphere} material={m.cream} position={[0, -0.01, 0]} scale={[0.17, 0.1, 0.09]} />
            <mesh geometry={g.smile} material={m.dark} position={[0, 0.0, 0.094]} />
          </group>
          {/* nose */}
          <mesh geometry={g.sphere} material={m.pink} position={[0, 0.28, 0.437]} scale={[0.048, 0.034, 0.026]} />
          {/* stitched eyes */}
          {[1, -1].map((s) => (
            <group key={s} position={[0.15 * s, 0.38, 0.37]} rotation={[0, 0.38 * s, 0]}>
              <mesh geometry={g.sphere} material={m.dark} scale={[0.042, 0.05, 0.02]} />
              <mesh geometry={g.sphere} material={m.shine} position={[0.012, 0.018, 0.016]} scale={0.009} />
            </group>
          ))}
          {/* blush */}
          {[1, -1].map((s) => (
            <mesh key={s} geometry={g.sphere} material={m.blush} position={[0.27 * s, 0.25, 0.3]} rotation={[0, 0.7 * s, 0]} scale={[0.06, 0.04, 0.012]} />
          ))}
          <Ear side={1} rig1={set("earL1")} rig2={set("earL2")} tan={m.tan} cream={m.cream} />
          <Ear side={-1} rig1={set("earR1")} rig2={set("earR2")} tan={m.tan} cream={m.cream} />
        </group>
      </group>
    </group>
  );
}
