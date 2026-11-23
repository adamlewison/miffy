"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { bunny } from "@/bunny.config";
import { bunnyState, setMode, triggerTrick, type Mode, type Trick } from "@/lib/bunnyState";

const BunnyScene = dynamic(() => import("@/components/bunny/BunnyScene"), { ssr: false });

/** Fake speech envelope: syllables ~5/s with phrase pauses. */
function fakeSpeech() {
  const t = performance.now() / 1000;
  const phrase = Math.sin(t * 0.9) > -0.6 ? 1 : 0;
  const syl = Math.max(0, Math.sin(t * 2 * Math.PI * 4.6) * 0.6 + Math.sin(t * 2 * Math.PI * 2.3) * 0.4);
  return phrase * (0.25 + 0.75 * syl);
}

/**
 * Animation test bench (not linked from the call UI). Use it to tune the
 * states in rig.ts or to check a new bunny.glb without making a call.
 */
export default function Preview() {
  const [mode, setM] = useState<Mode>("idle");
  const [live, setLive] = useState(true);

  useEffect(() => {
    bunnyState.live = live;
  }, [live]);
  useEffect(() => {
    setMode(mode);
    bunnyState.levelOverride = mode === "talking" ? fakeSpeech : null;
    return () => {
      bunnyState.levelOverride = null;
    };
  }, [mode]);

  const modes: Mode[] = ["idle", "listening", "thinking", "talking"];
  const tricks: Trick[] = ["hop", "ear_flick", "wiggle", "spin"];
  return (
    <main className="app" style={{ "--bg-top": bunny.scene.backgroundTop, "--bg-bottom": bunny.scene.backgroundBottom } as React.CSSProperties}>
      <div className="scene visible">
        <BunnyScene />
      </div>
      <div className="preview-bar">
        <div>
          {modes.map((m) => (
            <button key={m} className={`pill small ${m === mode ? "" : "ghost"}`} onClick={() => setM(m)}>
              {m}
            </button>
          ))}
        </div>
        <div>
          {tricks.map((t) => (
            <button key={t} className="pill small ghost" onClick={() => triggerTrick(t)}>
              {t}
            </button>
          ))}
          <button className="pill small ghost" onClick={() => setLive((v) => !v)}>
            {live ? "on call" : "sleepy"}
          </button>
        </div>
      </div>
    </main>
  );
}
