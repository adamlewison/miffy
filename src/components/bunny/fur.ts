import * as THREE from "three";

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

function furMaterial(source: THREE.MeshStandardMaterial, p: FurProfile, h: number, vertexColors = true) {
  const m = new THREE.MeshStandardMaterial({
    color: source.color.clone(),
    roughness: 0.92,
    metalness: 0,
    vertexColors,
    envMapIntensity: 0.85,
  });
  m.name = `${source.name}_fur${h.toFixed(2)}`;
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
          float id1; float id2;
          float d1 = furStrand(P, uFurH, id1);
          float d2 = furStrand(P + vec3(0.5, 0.31, 0.77), uFurH, id2);
          float d = min(d1, d2);
          float id = d1 < d2 ? id1 : id2;
          // variable strand length, tapering radius
          float len = 0.6 + 0.4 * id;
          float hh = uFurH / len;
          if (hh > 1.0) discard;
          float radius = uThick * pow(1.0 - hh, 0.6) * (0.8 + 0.4 * id);
          float aa = fwidth(d) + 1e-4;
          furA = 1.0 - smoothstep(radius - aa, radius + aa, d);
          if (furA < 0.02) discard;
          furShade = mix(uRootDark, 1.0, pow(uFurH, 0.75)) * (0.9 + 0.2 * id);
          furTip = pow(hh, 3.0);
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
        }`,
      );
  };
  m.customProgramCacheKey = () => `oney-fur-${h > 0 ? "shell" : "base"}`;
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
  const mobile = window.matchMedia("(pointer: coarse)").matches;
  return mobile ? 10 : 20;
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
    const baseMat = furMaterial(src, profile, 0, hasColor);
    mesh.material = baseMat;
    created.push(baseMat);

    const n = Math.round(shells * profile.shellScale);
    if (n <= 0) continue;
    const skinned = mesh as THREE.SkinnedMesh;
    for (let i = 1; i <= n; i++) {
      const h = i / n;
      const mat = furMaterial(src, profile, h, hasColor);
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
