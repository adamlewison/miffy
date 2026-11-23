"use client";

import { useRef, useState } from "react";
import { bunny } from "@/bunny.config";

const VOICES = ["shimmer", "marin", "coral", "sage", "ballad", "alloy", "verse", "ash", "echo", "cedar"];

/** Audition the built-in voices (plan Phase 2, step 3). Not linked from the call UI. */
export default function Voices() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [text, setText] = useState("");

  const play = (v: string) => {
    audio.current?.pause();
    const a = new Audio(`/api/voice-sample?voice=${v}${text ? `&text=${encodeURIComponent(text)}` : ""}`);
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
        Current voice: <b>{bunny.voice}</b>. Change it in <code>src/bunny.config.ts</code> or with the <code>BUNNY_VOICE</code> env var.
        Samples use the TTS model with the same voice names, so the live call sounds very similar but not identical.
      </p>
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
