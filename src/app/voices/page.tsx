"use client";

import { useRef, useState } from "react";
import { bunny } from "@/bunny.config";

const VOICES = ["coral", "sage", "ballad", "marin", "shimmer", "alloy", "verse", "ash", "echo", "cedar"];

/**
 * Audition the voices (not linked from the call UI). Samples are played through
 * the same pitch shifter as the call, so this is how she'll really sound.
 * Samples use the TTS model with the same voice names, so delivery is close to
 * the live call but not identical.
 */
export default function Voices() {
  const ctxRef = useRef<AudioContext | null>(null);
  const shifterRef = useRef<AudioWorkletNode | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pitch, setPitch] = useState<number>(bunny.pitchSemitones);

  async function graph() {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("/pitch-shifter.worklet.js");
      const shifter = new AudioWorkletNode(ctx, "pitch-shifter", { processorOptions: { semitones: pitch }, outputChannelCount: [1] });
      shifter.connect(ctx.destination);
      ctxRef.current = ctx;
      shifterRef.current = shifter;
    }
    await ctxRef.current.resume();
    return { ctx: ctxRef.current, shifter: shifterRef.current! };
  }

  const changePitch = (v: number) => {
    setPitch(v);
    shifterRef.current?.port.postMessage({ semitones: v });
  };

  const play = async (v: string) => {
    audio.current?.pause();
    const { ctx, shifter } = await graph();
    const a = new Audio(`/api/voice-sample?voice=${v}${text ? `&text=${encodeURIComponent(text)}` : ""}`);
    ctx.createMediaElementSource(a).connect(shifter);
    audio.current = a;
    setPlaying(v);
    a.onended = () => setPlaying(null);
    a.onerror = () => setPlaying(null);
    a.play().catch(() => setPlaying(null));
  };

  return (
    <main className="admin">
      <h1>Voice audition</h1>
      <p>
        Current: <b>{bunny.voice}</b>, shifted <b>+{bunny.pitchSemitones}</b> semitones. Change them in <code>src/bunny.config.ts</code>{" "}
        (or the <code>BUNNY_VOICE</code> / <code>BUNNY_PITCH</code> env vars).
      </p>
      <label className="row">
        <span style={{ whiteSpace: "nowrap" }}>Pitch +{pitch}</span>
        <input type="range" min={0} max={7} step={0.5} value={pitch} onChange={(e) => changePitch(Number(e.target.value))} />
      </label>
      <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>0 = original grown-up voice · 3 = subtle · 4 = little girl · 6+ = squeaky toy</p>
      <textarea placeholder="Optional custom line…" value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <ul className="voice-list">
        {VOICES.map((v) => (
          <li key={v}>
            <button className="pill small" onClick={() => play(v)}>
              {playing === v ? "▶︎ playing…" : "▶︎ play"}
            </button>
            <span>{v}</span>
            {v === bunny.voice && <em>current</em>}
          </li>
        ))}
      </ul>
      <p><a href="/">← back to the bunny</a></p>
    </main>
  );
}
