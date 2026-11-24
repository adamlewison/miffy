"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { getQuality } from "@/components/bunny/quality";
import { reactLocally, VisionWatcher, type VisionEvent } from "@/lib/vision";
import { bunny } from "@/bunny.config";
import { bunnyState, setMode, triggerGesture, triggerTrick, type Gesture, type Mode, type Trick } from "@/lib/bunnyState";

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
  // ?hold=1 keeps gestures on for a minute (for screenshots / tuning).
  const [hold] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("hold"));

  useEffect(() => {
    bunnyState.live = live;
  }, [live]);

  // Camera test: she reacts to what she sees, exactly as on a call (minus speaking).
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cam, setCam] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  const [scores, setScores] = useState("");
  useEffect(() => {
    if (!cam) return;
    let w: VisionWatcher | null = null;
    let stream: MediaStream | null = null;
    let alive = true;
    const onEvent = (e: VisionEvent) => {
      reactLocally(e);
      console.log("[vision event]", e);
      setSeen((xs) => [...xs.slice(-5), e]);
    };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: getQuality().cameraWidth }, height: { ideal: Math.round((getQuality().cameraWidth * 3) / 4) } } }).then(async (s) => {
      if (!alive) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      const v = videoRef.current!;
      v.srcObject = s;
      await v.play().catch(() => {});
      w = new VisionWatcher(v, onEvent);
      (window as unknown as { __oneyVision: VisionWatcher }).__oneyVision = w;
      w.start().then(() => console.log("[vision] ready"), (err) => console.warn("[vision] failed", err));
    });
    const iv = setInterval(() => {
      const sc = w?.logic.scores;
      if (sc) setScores(`face ${sc.face ? "yes" : "no"} · smile ${sc.smile.toFixed(2)} · sad ${sc.sad.toFixed(2)} · hand ${sc.hand || "-"}`);
    }, 300);
    return () => {
      alive = false;
      clearInterval(iv);
      w?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [cam]);
  useEffect(() => {
    setMode(mode);
    bunnyState.levelOverride = mode === "talking" ? fakeSpeech : null;
    return () => {
      bunnyState.levelOverride = null;
    };
  }, [mode]);

  const modes: Mode[] = ["idle", "listening", "thinking", "talking"];
  const tricks: Trick[] = ["hop", "ear_flick", "wiggle", "spin", "giggle"];
  const gestures: Gesture[] = ["wave", "sad", "nuzzle", "clap", "cheer", "shy", "sleepy"];
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
          {gestures.map((g) => (
            <button key={g} className="pill small ghost" onClick={() => triggerGesture(g, hold ? 60 : undefined)}>
              {g}
            </button>
          ))}
          <button className={`pill small ${cam ? "" : "ghost"}`} onClick={() => setCam((v) => !v)}>
            camera
          </button>
          <button className="pill small ghost" onClick={() => setLive((v) => !v)}>
            {live ? "on call" : "sleepy"}
          </button>
        </div>
      </div>
      <video ref={videoRef} className={`selfview ${cam ? "visible" : ""}`} playsInline muted autoPlay />
      {cam && (
        <p className="vision-debug">
          {scores}
          <br />
          {seen.join(" → ")}
        </p>
      )}
    </main>
  );
}
