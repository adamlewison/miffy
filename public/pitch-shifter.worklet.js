/**
 * Real-time pitch shifter for the bunny's voice (AudioWorklet).
 *
 * The built-in Realtime voices are all grown-ups. Shifting the whole voice up
 * a few semitones raises both the pitch AND the formants (the resonances that
 * tell the ear how big the speaker is), which is exactly the difference
 * between an adult and a small child. +4 semitones ≈ +26%, about the gap
 * between an adult woman's vocal tract and a young child's.
 *
 * Algorithm: classic two-tap delay-line ("granular") shifter. Two read heads
 * sweep through a short delay buffer faster than real time and are crossfaded
 * with sin² windows (which always sum to 1) so the wrap-around is inaudible.
 * Latency is about one window (~45 ms). Cheap enough for any phone.
 */

class PitchShifterCore {
  constructor(sampleRate, semitones = 4, windowMs = 45) {
    this.size = Math.round((sampleRate * windowMs) / 1000);
    this.buf = new Float32Array(this.size * 4);
    this.mask = this.buf.length; // not a power of two; use modulo
    this.w = 0;
    this.phase = 0;
    this.setSemitones(semitones);
  }

  setSemitones(st) {
    this.ratio = Math.pow(2, st / 12);
  }

  read(delay) {
    let pos = this.w - delay;
    while (pos < 0) pos += this.mask;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i % this.mask];
    const b = this.buf[(i + 1) % this.mask];
    return a + (b - a) * f;
  }

  process(input, output) {
    const n = input.length;
    const W = this.size;
    // Delay shrinks by (ratio - 1) samples per sample for pitch up.
    const step = (this.ratio - 1) / W;
    for (let k = 0; k < n; k++) {
      this.buf[this.w] = input[k];
      let p1 = this.phase;
      let p2 = p1 + 0.5;
      if (p2 >= 1) p2 -= 1;
      // When ratio > 1 the delay goes W -> 0; when < 1 it goes 0 -> W.
      const d1 = step >= 0 ? (1 - p1) * W + 1 : p1 * W + 1;
      const d2 = step >= 0 ? (1 - p2) * W + 1 : p2 * W + 1;
      const g1 = Math.sin(Math.PI * p1) ** 2;
      const g2 = Math.sin(Math.PI * p2) ** 2;
      output[k] = this.read(d1) * g1 + this.read(d2) * g2;
      this.phase += Math.abs(step);
      if (this.phase >= 1) this.phase -= 1;
      this.w = (this.w + 1) % this.mask;
    }
  }
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class PitchShifterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [];
    }
    constructor(options) {
      super();
      const st = options?.processorOptions?.semitones ?? 4;
      this.cores = [];
      this.st = st;
      this.port.onmessage = (e) => {
        if (typeof e.data?.semitones === "number") {
          this.st = e.data.semitones;
          this.cores.forEach((c) => c.setSemitones(this.st));
        }
      };
    }
    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      if (!input || input.length === 0) return true;
      for (let ch = 0; ch < output.length; ch++) {
        const inCh = input[ch] ?? input[0];
        if (!this.cores[ch]) this.cores[ch] = new PitchShifterCore(sampleRate, this.st);
        if (this.st === 0) output[ch].set(inCh);
        else this.cores[ch].process(inCh, output[ch]);
      }
      return true;
    }
  }
  registerProcessor("pitch-shifter", PitchShifterProcessor);
}

if (typeof module !== "undefined") module.exports = { PitchShifterCore };
