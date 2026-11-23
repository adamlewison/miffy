"use client";

import * as THREE from "three";
import { useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BONE_NAMES, useBunnyAnimator, type Rig } from "./rig";
import { addFuzzRim } from "./materials";

export const BUNNY_GLB = "/bunny.glb";
const TARGET_HEIGHT = 1.55;

/**
 * The real bunny from Blender (Phase 1). Drop a Draco-compressed bunny.glb
 * into /public and it's used automatically. Bones are matched by name — see
 * BONE_NAMES in rig.ts. If the right ear splays the wrong way, flip earZSign.
 */
export function GlbBunny({ url = BUNNY_GLB }: { url?: string }) {
  const gltf = useGLTF(url, true);

  const { scene, rig, scale, offset } = useMemo(() => {
    const scene = skeletonClone(gltf.scene) as THREE.Group;
    const lower = new Map<string, THREE.Object3D>();
    scene.traverse((o) => {
      lower.set(o.name.toLowerCase(), o);
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => addFuzzRim(m));
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

  useBunnyAnimator(() => rig, { intensity: 0.9 });

  return (
    <group position={offset} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}
