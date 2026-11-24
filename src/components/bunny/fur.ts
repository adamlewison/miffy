import * as THREE from "three";
import { getQuality } from "./quality";

/**
 * Shell-texture fur for Oney's plush.
 *
 * Each furry mesh is drawn N extra times ("shells"), each pushed a little
 * further out along the skinned normal. In every shell, a fragment survives only
 * if it lies inside a strand: strands come from jittered 3D cell noise sampled
 * on the *rest-pose* surface, so they stay glued to the fabric as she moves.
 * Strands taper towards the tips, lean in random directions and vary in
 * length, which reads as soft terry/plush pile. Roots are shaded darker and tips
 * lighter (self-shadowing); a fresnel rim gives the fuzzy halo. Alpha-to-coverage
 * (with MSAA) anti-aliases strand edges without any sorting.
 *
 * Per-vertex `_furlen` (exported from Blender) scales fur length: 0 under
 * appliqué patches, short near the eyes/nose so the face stays crisp.
 */

export type FurProfile = {
  /** Fur length in model units. */
  length: number;
  /** Strands per unit (cell frequency). */
  density: number;
  /** Shade at the root (self-shadow), 0..1. */
  rootDark: number;
  /** Extra brightness at the tips. */
  tipLight: number;
  /** How much the tips droop under gravity. */
  gravity: number;
  /** Fresnel rim strength. */
  rim: number;
  /** Strand radius (fraction of a cell) at the root. */
  thickness: number;
  /** Multiplier on the shell count (shorter fur needs fewer shells). */
  shellScale: number;
};

// Short, dense, soft terry pile — plush, not shaggy.
const base: FurProfile = {
  length: 0.013,
  density: 270,
  rootDark: 0.66,
  tipLight: 0.1,
  gravity: 0.25,
  rim: 0.22,
  thickness: 0.5,
  shellScale: 1,
};

/** Keyed by Blender material name. null = no fur (eyes, threads). */
export const FUR_PROFILES: Record<string, FurProfile | null> = {
  fur_tan: { ...base },
  fur_cream: { ...base, length: 0.012, rootDark: 0.7, rim: 0.18 },
  fur_beige: { ...base, length: 0.009, density: 300, rootDark: 0.7, shellScale: 0.5, rim: 0.2 },
  fur_piping: { ...base, length: 0.008, density: 320, rootDark: 0.72, shellScale: 0.5, rim: 0.2 },
  fur_nose: { ...base, length: 0.007, density: 360, rootDark: 0.72, tipLight: 0.06, shellScale: 0.5, rim: 0.15 },
  fur_tail: { ...base, length: 0.032, density: 190, gravity: 0.4, rootDark: 0.65, tipLight: 0.15 },
  eye: null,
  eye_shine: null,
  thread: null,
  thread_tan: null,
};

/** Layer used for shells: the main camera renders it, the contact shadow camera doesn't. */
export const FUR_LAYER = 1;

type Uniforms = {
  uFurH: { value: number };
  uFurLen: { value: number };
  uDensity: { value: number };
  uRootDark: { value: number };
  uTipLight: { value: number };
  uGravity: { value: number };
  uRim: { value: number };
  uThick: { value: number };
  uRimColor: { value: THREE.Color };
};

function furMaterial(source: THREE.MeshStandardMaterial, p: FurProfile, h: number, vertexColors = true, lite = false) {
  const m = new THREE.MeshStandardMaterial({
    color: source.color.clone(),
    roughness: 0.92,
    metalness: 0,
    vertexColors,
    envMapIntensity: 0.85,
  });
  m.name = `${source.name}_fur${h.toFixed(2)}`;
  if (lite) m.defines = { ...(m.defines ?? {}), FUR_LITE: "" };
  if (h > 0) {
    m.alphaToCoverage = true;
    m.transparent = false;
  }
  const u: Uniforms = {
    uFurH: { value: h },
    uFurLen: { value: p.length },
    uDensity: { value: p.density },
    uRootDark: { value: p.rootDark },
    uTipLight: { value: p.tipLight },
    uGravity: { value: p.gravity },
    uRim: { value: p.rim },
    uThick: { value: p.thickness },
    uRimColor: { value: new THREE.Color("#fff3e2") },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uFurH;
        uniform float uFurLen;
        uniform float uGravity;
        attribute float _furlen;
        varying vec3 vFurP;
        varying float vFurMask;`,
      )
      .replace(
        "#include <skinning_vertex>",
        `#include <skinning_vertex>
        vFurP = position;
        vFurMask = _furlen;
        {
          float furL = uFurLen * _furlen;
          vec3 g = normalize((inverse(modelMatrix) * vec4(0.0, -1.0, 0.0, 0.0)).xyz);
          transformed += normalize(objectNormal) * furL * uFurH + g * furL * uGravity * uFurH * uFurH;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uFurH;
        uniform float uDensity;
        uniform float uRootDark;
        uniform float uTipLight;
        uniform float uRim;
        uniform float uThick;
        uniform vec3 uRimColor;
        varying vec3 vFurP;
        varying float vFurMask;
        float furHash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        vec3 furHash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
        // Cheap smooth low-frequency noise (0..1): used for tufts and patchy shading.
        float furSoft(vec3 p) {
          return 0.5 + 0.5 * sin(p.x * 1.3 + 1.7 * sin(p.y * 0.9 + 0.6 * sin(p.z * 1.7))) * sin(p.z * 1.1 + 1.3 * sin(p.x * 0.7 + 0.8 * sin(p.y * 1.3)));
        }
        float furStrand(vec3 p, float h, out float id) {
          vec3 c = floor(p);
          vec3 f = fract(p) - 0.5;
          vec3 j = (furHash33(c) - 0.5) * 0.42;
          vec3 lean = (furHash33(c + 17.17) - 0.5) * 0.5 * h;
          id = furHash13(c + 3.7);
          return length(f - j - lean);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float furA = 1.0;
        float furShade;
        float furTip = 0.0;
        if (uFurH > 0.0) {
          if (vFurMask < 0.06) discard;
          // Rotate + gently warp strand space so the cell lattice never lines
          // up with the surface (avoids moiré "fingerprint" rings).
          vec3 P = mat3(0.80, 0.36, -0.48, -0.47, 0.86, -0.18, 0.37, 0.36, 0.86) * vFurP * uDensity;
          P += 0.7 * vec3(sin(P.y * 0.131 + P.z * 0.071), sin(P.z * 0.113 + P.x * 0.057), sin(P.x * 0.097 + P.y * 0.121));
          float id1;
          float d1 = furStrand(P, uFurH, id1);
          #ifdef FUR_LITE
            // Phones: one strand lattice, slightly thicker strands to keep the same coverage.
            float d = d1 * 0.82;
            float id = id1;
          #else
            float id2;
            float d2 = furStrand(P + vec3(0.5, 0.31, 0.77), uFurH, id2);
            float d = min(d1, d2);
            float id = d1 < d2 ? id1 : id2;
          #endif
          // variable strand length, tapering radius
          // Soft tufts: neighbouring strands clump to similar lengths, like real terry pile.
          float tuft = furSoft(vFurP * 38.0);
          float len = (0.6 + 0.4 * id) * (0.82 + 0.3 * tuft);
          float hh = uFurH / len;
          if (hh > 1.0) discard;
          float radius = uThick * pow(1.0 - hh, 0.6) * (0.8 + 0.4 * id);
          float aa = fwidth(d) + 1e-4;
          furA = 1.0 - smoothstep(radius - aa, radius + aa, d);
          if (furA < 0.02) discard;
          furShade = mix(uRootDark, 1.0, pow(uFurH, 0.75)) * (0.88 + 0.24 * id) * (0.93 + 0.14 * tuft);
          // Each strand is a slightly different warm/cool shade, lighter and sun-bleached at the tips.
          diffuseColor.rgb *= mix(vec3(0.95, 0.91, 0.87), vec3(1.05, 1.04, 1.02), id);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.07, 0.98), pow(hh, 2.0) * 0.5);
          furTip = pow(hh, 3.0) * (0.5 + id);
        } else {
          furShade = mix(uRootDark, 1.0, 0.25);
        }
        diffuseColor.rgb *= furShade;
        diffuseColor.a = furA;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          vec3 vv = normalize(vViewPosition);
          float fres = pow(1.0 - saturate(dot(normal, vv)), 2.4);
          totalEmissiveRadiance += uRimColor * fres * uRim * (0.35 + 0.65 * uFurH) * diffuseColor.rgb * 1.6;
          totalEmissiveRadiance += uRimColor * furTip * uTipLight * diffuseColor.rgb;
          // Light scattering through the pile: shadowed fur never goes flat or grey, it glows warm.
          totalEmissiveRadiance += vec3(1.0, 0.82, 0.66) * diffuseColor.rgb * (0.07 + 0.05 * uFurH);
        }`,
      );
  };
  m.customProgramCacheKey = () => `oney-fur-${h > 0 ? "shell" : "base"}${lite ? "-lite" : ""}`;
  return m;
}

function ensureFurAttr(geo: THREE.BufferGeometry) {
  if (!geo.getAttribute("_furlen")) {
    const n = geo.getAttribute("position").count;
    geo.setAttribute("_furlen", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  }
}

export function defaultShellCount() {
  if (typeof window === "undefined") return 16;
  const q = new URLSearchParams(window.location.search).get("shells");
  if (q !== null && !Number.isNaN(Number(q))) return Math.max(0, Math.min(40, Number(q)));
  return getQuality().shells;
}

/**
 * Replaces materials on every mesh in `root` and adds fur shells.
 * Returns a dispose function.
 */
export function applyFur(root: THREE.Object3D, shells = defaultShellCount()) {
  const created: (THREE.Material | THREE.Object3D)[] = [];
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });

  for (const mesh of meshes) {
    const src = (mesh.userData.furSource ??= mesh.material) as THREE.MeshStandardMaterial;
    const name = (src.name || "").replace(/\.\d+$/, "");
    const profile = FUR_PROFILES[name];
    mesh.frustumCulled = false;

    if (profile === undefined || profile === null) {
      // Embroidered eyes / threads: satin, slightly glossy.
      const m = new THREE.MeshPhysicalMaterial({
        color: src.color.clone(),
        roughness: name === "eye" ? 0.38 : 0.7,
        metalness: 0,
        vertexColors: !!mesh.geometry.getAttribute("color"),
        sheen: 0.5,
        sheenRoughness: 0.4,
        sheenColor: new THREE.Color("#ffffff"),
        clearcoat: name === "eye" ? 0.35 : 0,
        clearcoatRoughness: 0.35,
      });
      mesh.material = m;
      created.push(m);
      continue;
    }

    ensureFurAttr(mesh.geometry);
    const hasColor = !!mesh.geometry.getAttribute("color");
    const lite = getQuality().furLite;
    const baseMat = furMaterial(src, profile, 0, hasColor, lite);
    mesh.material = baseMat;
    created.push(baseMat);

    const n = Math.round(shells * profile.shellScale);
    if (n <= 0) continue;
    const skinned = mesh as THREE.SkinnedMesh;
    for (let i = 1; i <= n; i++) {
      const h = i / n;
      const mat = furMaterial(src, profile, h, hasColor, lite);
      let shell: THREE.Mesh;
      if (skinned.isSkinnedMesh) {
        const s = new THREE.SkinnedMesh(mesh.geometry, mat);
        s.bind(skinned.skeleton, skinned.bindMatrix);
        s.bindMode = skinned.bindMode;
        shell = s;
      } else {
        shell = new THREE.Mesh(mesh.geometry, mat);
      }
      shell.name = `${mesh.name}_shell${i}`;
      shell.position.copy(mesh.position);
      shell.quaternion.copy(mesh.quaternion);
      shell.scale.copy(mesh.scale);
      shell.frustumCulled = false;
      shell.renderOrder = i;
      shell.layers.set(FUR_LAYER);
      mesh.parent!.add(shell);
      created.push(shell, mat);
    }
  }

  return () => {
    for (const mesh of meshes) if (mesh.userData.furSource) mesh.material = mesh.userData.furSource;
    for (const c of created) {
      if ((c as THREE.Object3D).isObject3D) (c as THREE.Object3D).removeFromParent();
      else (c as THREE.Material).dispose();
    }
  };
}
