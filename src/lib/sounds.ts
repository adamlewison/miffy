/**
 * All call sounds are synthesised with Web Audio, so there are no audio files
 * to load and everything is unlocked by the single Call tap (iOS requirement).
 */
let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC({ latencyHint: "interactive" });
  }
  return ctx;
}

/** Must be called inside a user gesture on iOS. */
export async function unlockAudio() {
  const c = getAudioContext();
  if (c.state !== "running") await c.resume();
  // Play one silent sample: the classic iOS unlock.
  const b = c.createBuffer(1, 1, 22050);
  const s = c.createBufferSource();
  s.buffer = b;
  s.connect(c.destination);
  s.start(0);
}

function tone(freqs: number[], start: number, dur: number, gain = 0.12, type: OscillatorType = "sine") {
  const c = getAudioContext();
  const g = c.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.02);
  g.gain.setValueAtTime(gain, start + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, start + dur);
  g.connect(c.destination);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(g);
    o.start(start);
    o.stop(start + dur + 0.02);
  }
}

/** Gentle outgoing ring (two soft chimes, pause). Returns a stop function. */
export function startRingback(): () => void {
  const c = getAudioContext();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ring = () => {
    if (stopped) return;
    const t = c.currentTime + 0.05;
    tone([659.25, 987.77], t, 0.38, 0.07);
    tone([783.99, 1174.66], t + 0.45, 0.5, 0.07);
    timer = setTimeout(ring, 2600);
  };
  ring();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function playPickup() {
  const t = getAudioContext().currentTime + 0.02;
  tone([880], t, 0.09, 0.08, "triangle");
  tone([1318.5], t + 0.1, 0.14, 0.08, "triangle");
}

export function playHangup() {
  const t = getAudioContext().currentTime + 0.02;
  tone([659.25], t, 0.12, 0.08, "triangle");
  tone([440], t + 0.14, 0.2, 0.08, "triangle");
}
