/**
 * Shared, mutable animation state. Written by the call logic, read every frame
 * by the 3D rig. Deliberately not React state: it changes 60 times a second.
 */
export type Mode = "idle" | "listening" | "thinking" | "talking";
export type Trick = "hop" | "ear_flick" | "wiggle" | "spin";

export const bunnyState = {
  mode: "idle" as Mode,
  modeSince: 0,
  /** Analyser on the bunny's reply audio (set once the call connects). */
  analyser: null as AnalyserNode | null,
  /** Smoothed reply volume 0..1, updated by the rig each frame. */
  level: 0,
  /** Test hook: if set, used instead of the analyser (see /preview). */
  levelOverride: null as null | (() => number),
  trick: null as { type: Trick; at: number } | null,
  /** True while on a live call — used to make the bunny "look" at the camera. */
  live: false,
};

export function setMode(mode: Mode) {
  if (bunnyState.mode === mode) return;
  bunnyState.mode = mode;
  bunnyState.modeSince = performance.now();
}

export function triggerTrick(type: Trick = "hop") {
  bunnyState.trick = { type, at: performance.now() };
}
