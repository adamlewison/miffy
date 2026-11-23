"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { bunny } from "@/bunny.config";
import { useBunnyCall } from "@/lib/useBunnyCall";
import { CameraIcon, CaptionsIcon, HangupIcon, MicIcon, PhoneIcon } from "./Icons";

const BunnyScene = dynamic(() => import("./bunny/BunnyScene"), { ssr: false });

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Avatar({ size }: { size: number }) {
  // Put a real photo of her at public/bunny-photo.jpg to replace the drawing.
  const [src, setSrc] = useState("/icons/avatar.png");
  useEffect(() => {
    const probe = new Image();
    probe.onload = () => setSrc("/bunny-photo.jpg");
    probe.src = "/bunny-photo.jpg";
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="avatar" src={src} alt={bunny.name} width={size} height={size} style={{ width: size, height: size }} />
  );
}

function Bokeh() {
  const colors = bunny.scene.bokeh;
  const dots = [
    [12, 18, 140], [78, 12, 110], [88, 52, 170], [8, 62, 120], [50, 30, 90], [30, 85, 150], [70, 82, 100], [55, 60, 70],
  ];
  return (
    <div className="bokeh" aria-hidden>
      {dots.map(([x, y, s], i) => (
        <span key={i} style={{ left: `${x}%`, top: `${y}%`, width: s, height: s, background: colors[i % colors.length], animationDelay: `${i * -3.1}s` }} />
      ))}
    </div>
  );
}

export default function CallApp() {
  const call = useBunnyCall();
  const { status } = call;
  const [now, setNow] = useState(() => Date.now());
  const [showCaptions, setShowCaptions] = useState(false);
  const [lastDuration, setLastDuration] = useState<number | null>(null);

  useEffect(() => {
    if (status !== "live") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => {
    if (call.startedAt) setLastDuration(null);
  }, [call.startedAt]);

  const hangUp = () => {
    if (call.startedAt) setLastDuration(Date.now() - call.startedAt);
    call.end();
  };

  // Keep the screen awake during a call.
  useEffect(() => {
    if (status !== "live" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock.request("screen").then((l) => (lock = l)).catch(() => {});
    return () => {
      lock?.release().catch(() => {});
    };
  }, [status]);

  const showScene = status === "ringing" || status === "live";

  return (
    <main
      className={`app status-${status}`}
      style={{ "--bg-top": bunny.scene.backgroundTop, "--bg-bottom": bunny.scene.backgroundBottom } as React.CSSProperties}
    >
      <Bokeh />

      {/* 3D bunny. Mounted while ringing so it's loaded the moment she picks up. */}
      {showScene && (
        <div className={`scene ${status === "live" ? "visible" : ""}`}>
          <BunnyScene />
        </div>
      )}

      {/* ---------- Contact card ---------- */}
      {(status === "idle" || status === "error") && (
        <section className="contact">
          <div className="contact-top">
            <Avatar size={148} />
            <h1>{bunny.name}</h1>
            <p className="sub">plush bunny · home</p>
          </div>
          {call.error && <p className="error">{call.error}</p>}
          <div className="contact-actions">
            <button className="round call" onClick={call.start} aria-label={`Call ${bunny.name}`}>
              <PhoneIcon size={34} />
            </button>
            <span className="label">{status === "error" ? "Try again" : "Call"}</span>
          </div>
        </section>
      )}

      {/* ---------- Ringing ---------- */}
      {status === "ringing" && (
        <section className="ringing">
          <div className="ring-avatar">
            <span className="pulse" />
            <span className="pulse p2" />
            <Avatar size={132} />
          </div>
          <h1>{bunny.name}</h1>
          <p className="sub calling">Calling…</p>
          <div className="controls single">
            <button className="round hangup" onClick={hangUp} aria-label="Cancel call">
              <HangupIcon size={32} />
            </button>
          </div>
        </section>
      )}

      {/* ---------- Live call ---------- */}
      {status === "live" && (
        <section className="live">
          <header className="live-top">
            <span className="name">{bunny.name}</span>
            <span className="timer">{call.startedAt ? fmt(now - call.startedAt) : "0:00"}</span>
          </header>

          {showCaptions && call.captions?.text && (
            <p className={`captions ${call.captions.role}`}>{call.captions.text}</p>
          )}

          <div className="controls">
            <button className={`round glass ${call.muted ? "on" : ""}`} onClick={call.toggleMute} aria-label={call.muted ? "Unmute" : "Mute"}>
              <MicIcon off={call.muted} />
            </button>
            <button className={`round glass ${call.cameraOn ? "on" : ""}`} onClick={call.toggleCamera} aria-label={call.cameraOn ? "Turn camera off" : "Let the bunny see you"}>
              <CameraIcon off={!call.cameraOn} />
            </button>
            <button className={`round glass ${showCaptions ? "on" : ""}`} onClick={() => setShowCaptions((v) => !v)} aria-label="Captions">
              <CaptionsIcon />
            </button>
            <button className="round hangup" onClick={hangUp} aria-label="End call">
              <HangupIcon size={32} />
            </button>
          </div>
        </section>
      )}

      {/* Self-view (always in the DOM during a call so the ref is stable). */}
      <video
        ref={call.videoRef}
        className={`selfview ${status === "live" && call.cameraOn ? "visible" : ""}`}
        playsInline
        muted
        autoPlay
      />

      {/* ---------- Ended ---------- */}
      {status === "ended" && (
        <section className="ended">
          <Avatar size={110} />
          <h1>{bunny.name}</h1>
          <p className="sub">{call.error ? call.error : lastDuration ? `Call ended · ${fmt(lastDuration)}` : "Call ended"}</p>
        </section>
      )}
    </main>
  );
}
