/**
 * One place for everything that trades looks for speed.
 *
 * Phones get the "lite" tier: a lower-poly model, fewer fur layers with a cheaper strand shader, a
 * lower pixel ratio, no floor shadow (the FaceTime shot never shows the floor),
 * and less frequent camera tracking on a smaller image. If even that sags, the renderer drops fur layers
 * and resolution on its own (see GlbBunny.tsx / BunnyScene.tsx).
 *
 * Override for testing: ?quality=lite or ?quality=high.
 */
export type Quality = {
  tier: "lite" | "high";
  /** Fur shells to start with (the adaptive monitor may lower it). */
  shells: number;
  /** Fewest shells the adaptive monitor will go down to. */
  minShells: number;
  /** Cheaper fur shader (one strand lattice instead of two). */
  furLite: boolean;
  /** Max device pixel ratio. */
  dpr: number;
  /** Frame-rate cap. */
  fps: number;
  /** Soft contact shadow under her (only visible in full-body views). */
  contactShadows: boolean;
  /** Milliseconds between camera analyses (face and hands alternate). */
  visionIntervalMs: number;
  /** Camera resolution asked for (the trackers downscale anyway). */
  cameraWidth: number;
  /** Which model file: phones get a lower-poly body (same shape, same skeleton). */
  glb: string;
};

let cached: Quality | null = null;

export function getQuality(): Quality {
  if (cached) return cached;
  const ssr = typeof window === "undefined";
  const q = ssr ? null : new URLSearchParams(window.location.search).get("quality");
  const touch = !ssr && window.matchMedia("(pointer: coarse)").matches;
  const fullBody = !ssr && new URLSearchParams(window.location.search).has("view");
  const lite = q ? q === "lite" : touch;
  cached = lite
    ? { tier: "lite", shells: 4, minShells: 2, furLite: true, dpr: 1.3, fps: 30, contactShadows: fullBody, visionIntervalMs: 380, cameraWidth: 480, glb: "/bunny-lite.glb" }
    : { tier: "high", shells: 20, minShells: 4, furLite: false, dpr: 2, fps: 60, contactShadows: true, visionIntervalMs: 125, cameraWidth: 640, glb: "/bunny.glb" };
  return cached;
}
