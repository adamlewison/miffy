import * as THREE from "three";

/**
 * Terry-cloth look: a procedural loop-pile bump texture, fabric sheen, and a
 * fresnel "fuzz" rim so the silhouette glows softly like plush.
 */

let terryTex: THREE.CanvasTexture | null = null;

function terryTexture() {
  if (terryTex) return terryTex;
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, size, size);
  // Thousands of tiny loops = terry pile.
  for (let i = 0; i < 4200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1.2 + Math.random() * 2.2;
    const v = 110 + Math.floor(Math.random() * 120);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = 0.8 + Math.random();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
  }
  terryTex = new THREE.CanvasTexture(c);
  terryTex.wrapS = terryTex.wrapT = THREE.RepeatWrapping;
  terryTex.repeat.set(5, 5);
  terryTex.anisotropy = 4;
  return terryTex;
}

/** Adds a soft fresnel rim to any standard/physical material. */
export function addFuzzRim(mat: THREE.Material, color = "#fff1dd", strength = 0.35) {
  const m = mat as THREE.MeshStandardMaterial;
  if (!("isMeshStandardMaterial" in m) || m.userData.fuzz) return mat;
  m.userData.fuzz = true;
  const rimColor = new THREE.Color(color);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.fuzzColor = { value: rimColor };
    shader.uniforms.fuzzStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 fuzzColor;\nuniform float fuzzStrength;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          vec3 fuzzV = normalize(vViewPosition);
          float fuzzF = pow(1.0 - saturate(dot(normal, fuzzV)), 2.6);
          totalEmissiveRadiance += fuzzColor * fuzzF * fuzzStrength;
        }`,
      );
  };
  m.needsUpdate = true;
  return mat;
}

export function plush(color: string, opts: { rim?: string; rimStrength?: number; bump?: number } = {}) {
  const col = new THREE.Color(color);
  const mat = new THREE.MeshPhysicalMaterial({
    color: col,
    roughness: 0.92,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: col.clone().lerp(new THREE.Color("#ffffff"), 0.45),
    bumpMap: terryTexture(),
    bumpScale: opts.bump ?? 1.2,
  });
  return addFuzzRim(mat, opts.rim, opts.rimStrength) as THREE.MeshPhysicalMaterial;
}

export function stitch(color = "#2a1f1a") {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
}
