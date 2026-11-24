"use client";

import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BONE_NAMES, useBunnyAnimator, type Rig } from "./rig";
import { applyFur } from "./fur";

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

  // Plush fur (shell rendering) on every fabric part.
  useEffect(() => applyFur(scene), [scene]);

  // Long lop ears hang down: motion directions flip and angles are smaller.
  // Arm poses solved for Oney's proportions (blender/build_oney.py).
  useBunnyAnimator(() => rig, {
    intensity: 1,
    earXSign: -1,
    earAmount: 0.45,
    earSad: 0.2,
    poses: {
      wave: [-2.22, 0.28, 1.0],
      sad: [-1.94, -0.4, 1.0],
      nuzzle: [-0.76, -0.22, 1.0],
    },
  });

  return (
    <group position={offset} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}
