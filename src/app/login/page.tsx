"use client";

import { useState } from "react";
import { bunny } from "@/bunny.config";

export default function Login() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: code }),
    });
    if (r.ok) {
      window.location.href = "/";
    } else {
      const j = await r.json().catch(() => ({}));
      setErr(j.error || "Hmm, that didn't work.");
      setBusy(false);
    }
  }

  return (
    <main className="app status-idle" style={{ "--bg-top": bunny.scene.backgroundTop, "--bg-bottom": bunny.scene.backgroundBottom } as React.CSSProperties}>
      <form className="login" onSubmit={submit}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="avatar" src="/icons/avatar.png" alt="" width={120} height={120} />
        <h1>Who&apos;s calling?</h1>
        <p className="sub">Say the magic word to call {bunny.name}.</p>
        <input
          type="password"
          inputMode="text"
          autoComplete="current-password"
          placeholder="Magic word"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
        />
        {err && <p className="error">{err}</p>}
        <button className="pill" disabled={busy || !code}>
          {busy ? "Checking…" : "Come in"}
        </button>
      </form>
    </main>
  );
}
