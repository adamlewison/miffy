"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BONE_NAMES, useBunnyAnimator, type Rig } from "./rig";
import { applyFur, defaultShellCount } from "./fur";
import { BunnySolid, type CollisionJSON } from "./collide";

export const BUNNY_GLB = "/bunny.glb";
const TARGET_HEIGHT = 1.42;

/**
 * The real bunny from Blender (Phase 1). Drop a Draco-compressed bunny.glb
 * into /public and it's used automatically. Bones are matched by name — see
 * BONE_NAMES in rig.ts. If the right ear splays the wrong way, flip earZSign.
 */
export function GlbBunny({ url = BUNNY_GLB }: { url?: string }) {
  const gltf = useGLTF(url);

  const { scene, rig, scale, offset } = useMemo(() => {
    const scene = skeletonClone(gltf.scene) as THREE.Group;
    const lower = new Map<string, THREE.Object3D>();
    scene.traverse((o) => {
      lower.set(o.name.toLowerCase(), o);
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.frustumCulled = false; // skinned bounds can be wrong
      }
    });
    const find = (names: string[]) => {
      for (const n of names) {
        const o = scene.getObjectByName(n) ?? lower.get(n.toLowerCase());
        if (o) return o;
      }
      return null;
    };
    const rig = Object.fromEntries(Object.entries(BONE_NAMES).map(([k, names]) => [k, find(names)])) as Rig;
    if (process.env.NODE_ENV !== "production") {
      const missing = Object.entries(rig).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) console.info("[bunny.glb] bones not found (they won't animate):", missing.join(", "));
    }

    // Normalise size and stand it on the floor.
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
    const center = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale);
    return { scene, rig, scale, offset };
  }, [gltf.scene]);

  // Collision data generated alongside the model (blender/build_oney.py).
  const solid = useRef<BunnySolid | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url.replace(/\.glb$/, ".collision.json"))
      .then((r) => (r.ok ? r.json() : null))
      .then((j: CollisionJSON | null) => {
        if (alive && j) {
          solid.current = new BunnySolid(j);
          if (new URLSearchParams(window.location.search).has("debug"))
            (window as unknown as { __oneySolid: BunnySolid }).__oneySolid = solid.current;
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  // Plush fur (shell rendering) on every fabric part.
  // Adaptive quality: if the frame rate sags (a slow phone), quietly drop fur layers
  // until it's smooth again. An explicit ?shells=N in the URL turns this off.
  const [shells, setShells] = useState(defaultShellCount);
  const perf = useRef({ acc: 0, n: 0, since: 0 });
  useFrame((_, dt) => {
    if (new URLSearchParams(window.location.search).has("shells")) return;
    const p = perf.current;
    if (dt > 0.25) return; // tab was hidden / first frames compiling shaders
    p.acc += dt;
    p.n++;
    p.since += dt;
    if (p.since < 3) return;
    const fps = p.n / p.acc;
    p.acc = p.n = p.since = 0;
    const target = window.matchMedia("(pointer: coarse)").matches ? 24 : 40;
    if (fps < target) setShells((s) => (s > 4 ? Math.max(4, Math.round(s * 0.7)) : s));
  });
  useEffect(() => applyFur(scene, shells), [scene, shells]);

  // Long lop ears hang down: motion directions flip and angles are smaller.
  // Arm poses solved for Oney's proportions (blender/build_oney.py).
  useBunnyAnimator(() => rig, {
    intensity: 1,
    earXSign: -1,
    earAmount: 0.45,
    earSad: 0.2,
    earMaxIn: 0.03,
    solid: () => solid.current,
    poses: {
      // Paw comes up in front of the ear, beside her cheek.
      wave: [-1.93, 0.1, 1.0],
      sad: [-1.8, -0.46, 1.0],
      nuzzle: [-0.72, -0.26, 1.0],
      clap: [-0.66, -0.42, 1.0],
      cheer: [-2.2, 0.45, 1.0], // arms up and a bit wide, so the broad ears have room
    },
  });

  return (
    <group position={offset} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}
