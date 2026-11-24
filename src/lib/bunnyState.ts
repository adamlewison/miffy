/**
 * Shared, mutable animation state. Written by the call logic, read every frame
 * by the 3D rig. Deliberately not React state: it changes 60 times a second.
 */
export type Mode = "idle" | "listening" | "thinking" | "talking";
/** Quick one-shot moves. */
export type Trick = "hop" | "ear_flick" | "wiggle" | "spin" | "giggle";
/** Held poses that ease in, hold, then ease out. */
export type Gesture = "wave" | "sad" | "nuzzle" | "clap" | "cheer" | "shy" | "sleepy";

export const GESTURE_SECONDS: Record<Gesture, number> = { wave: 2.6, sad: 4.5, nuzzle: 3.8, clap: 2.6, cheer: 2.4, shy: 3.4, sleepy: 4.2 };

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
  gesture: null as { type: Gesture; until: number } | null,
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

export function triggerGesture(type: Gesture, seconds = GESTURE_SECONDS[type]) {
  bunnyState.gesture = { type, until: performance.now() + seconds * 1000 };
}
