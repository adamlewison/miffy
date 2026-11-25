"use client";

import { useRef, useState } from "react";
import { gateway } from "@ai-sdk/gateway";
import { bunny } from "@/bunny.config";

const GEMINI_VOICES = ["Achernar", "Aoede", "Leda", "Zephyr", "Puck", "Kore"];
const OPENAI_VOICES = ["coral", "marin", "cedar", "shimmer", "sage", "ballad", "verse", "alloy", "ash", "echo"];
const GROK_VOICES = ["ara", "eve"];
const MODELS: { id: string; voices: string[] }[] = [
  { id: "google/gemini-3.8-live-extended-thinking", voices: GEMINI_VOICES },
  { id: "google/gemini-3.8-live", voices: GEMINI_VOICES },
  { id: "openai/gpt-live-1.1", voices: OPENAI_VOICES },
  { id: "openai/gpt-live-1", voices: OPENAI_VOICES },
  { id: "openai/gpt-realtime-2.1", voices: OPENAI_VOICES },
  { id: "openai/gpt-realtime-mini", voices: OPENAI_VOICES },
  { id: "spacexai/grok-voice-3.0", voices: GROK_VOICES },
];
const OUT_RATE = 24000;

type Ev = { type: string; [k: string]: unknown };

/**
 * Test bench: talk to Gemini Live (through the Vercel AI Gateway) as Oney, with
 * the same pitch shifter as the call. Not linked from the call UI. The raw event
 * log is shown so protocol problems are easy to spot.
 */
export default function LiveTest() {
  const [model, setModel] = useState(MODELS[0].id);
  const voices = MODELS.find((m) => m.id === model)?.voices ?? GEMINI_VOICES;
  const pickModel = (id: string) => {
    setModel(id);
    setVoice(MODELS.find((m) => m.id === id)!.voices[0]);
  };
  const [voice, setVoice] = useState("Achernar");
  const [pitch, setPitch] = useState(8);
  const [status, setStatus] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const playCtx = useRef<AudioContext | null>(null);
  const shifter = useRef<AudioWorkletNode | null>(null);
  const micCtx = useRef<AudioContext | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const nextTime = useRef(0);
  const sources = useRef<AudioBufferSourceNode[]>([]);

  const note = (s: string) => setLog((l) => [...l.slice(-60), s]);

  function playPcm(b64: string) {
    const ctx = playCtx.current;
    if (!ctx || !shifter.current) return;
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = ctx.createBuffer(1, n, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      ch[i] = (v << 16 >> 16) / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(shifter.current);
    const t = Math.max(ctx.currentTime + 0.03, nextTime.current);
    src.start(t);
    nextTime.current = t + buf.duration;
    sources.current.push(src);
    src.onended = () => (sources.current = sources.current.filter((s) => s !== src));
  }

  function interrupt() {
    sources.current.forEach((s) => {
      try { s.stop(); } catch {}
    });
    sources.current = [];
    nextTime.current = 0;
  }

  async function start() {
    setStatus("connecting…");
    setLog([]);
    setTranscript("");
    try {
      // iOS needs the AudioContext and mic started from the tap.
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("/pitch-shifter.worklet.js");
      const sh = new AudioWorkletNode(ctx, "pitch-shifter", { processorOptions: { semitones: pitch }, outputChannelCount: [1] });
      sh.connect(ctx.destination);
      await ctx.resume();
      playCtx.current = ctx;
      shifter.current = sh;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      micStream.current = stream;

      const res = await fetch("/api/live-token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, voice }) });
      const info = await res.json();
      if (!res.ok) throw new Error(info.error || `token ${res.status}`);

      const rt = gateway.experimental_realtime(model);
      if (!rt.getWebSocketConfig) throw new Error("model has no browser WebSocket config");
      const cfg = await rt.getWebSocketConfig({ token: info.token, url: info.url });
      const parse = rt.createServerEventParser?.() ?? ((raw: unknown) => rt.parseServerEvent(raw));
      const ws = new WebSocket(cfg.url, cfg.protocols);
      wsRef.current = ws;
      const send = async (ev: Ev) => {
        const out = await rt.serializeClientEvent(ev as never);
        if (out == null) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(typeof out === "string" ? out : JSON.stringify(out));
      };
      let greeted = false;
      const greet = async () => {
        if (greeted) return;
        greeted = true;
        await send({ type: "conversation-item-create", item: { type: "text-message", role: "user", text: "(Miwi just called you and you picked up. Greet her softly and happily, like a little kid pleased to see her, in one or two tiny sentences.)" } });
        await send({ type: "response-create" });
      };

      ws.onopen = async () => {
        note("socket open");
        const startup = rt.capabilities?.startup ?? "session-update";
        await send({ type: startup, config: info.sessionConfig });
        // Some providers never emit session-started; greet anyway after a moment.
        setTimeout(greet, 1500);
      };
      ws.onmessage = async (m) => {
        let raw: unknown;
        try { raw = JSON.parse(typeof m.data === "string" ? m.data : await (m.data as Blob).text()); } catch { note("non-json frame"); return; }
        const hc = rt.getHealthCheckResponse?.(raw);
        if (hc) ws.send(typeof hc === "string" ? hc : JSON.stringify(hc));
        const parsed = parse(raw);
        for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
          const ev = e as Ev;
          if (ev.type === "audio-delta" || ev.type === "audio-chunk") playPcm(ev.delta as string);
          else if (ev.type === "audio-transcript-delta") setTranscript((t) => t + (ev.delta as string));
          else if (ev.type === "transcript-fragment" && ev.speaker === "assistant") setTranscript((t) => t + (ev.delta as string));
          else if (ev.type === "speech-started") interrupt();
          else if (ev.type === "session-started" || ev.type === "session-created") { setStatus("live"); greet(); }
          else if (ev.type === "response-done") setTranscript((t) => t + "\n");
          else if (ev.type === "error") note("ERROR " + JSON.stringify(ev).slice(0, 300));
          if (ev.type !== "audio-delta" && ev.type !== "audio-chunk" && ev.type !== "audio-transcript-delta") note(ev.type);
        }
      };
      ws.onerror = () => note("socket error");
      ws.onclose = (e) => { note(`closed ${e.code} ${e.reason}`); setStatus("ended"); stopMic(); };

      // Mic -> 16 kHz PCM16 -> gateway.
      const mctx = new AudioContext({ sampleRate: info.inputRate ?? 16000 });
      micCtx.current = mctx;
      const msrc = mctx.createMediaStreamSource(stream);
      const proc = mctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const f = ev.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) i16[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
        let s = "";
        const u8 = new Uint8Array(i16.buffer);
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        send({ type: "input-audio-append", audio: btoa(s) });
      };
      msrc.connect(proc);
      proc.connect(mctx.destination);
      setStatus("connected, waiting for her…");
    } catch (err) {
      note("FAILED " + (err as Error).message);
      setStatus("failed");
      stop();
    }
  }

  function stopMic() {
    micStream.current?.getTracks().forEach((t) => t.stop());
    micCtx.current?.close().catch(() => {});
    micStream.current = null;
    micCtx.current = null;
  }

  function stop() {
    wsRef.current?.close();
    wsRef.current = null;
    stopMic();
    interrupt();
    playCtx.current?.close().catch(() => {});
    playCtx.current = null;
    setStatus((s) => (s === "failed" ? s : "idle"));
  }

  const live = status !== "idle" && status !== "failed" && status !== "ended";

  return (
    <main className="admin">
      <h1>Live test: Gemini Live</h1>
      <p>
        Talk to {bunny.name} through the Vercel AI Gateway. Try other models and voices, then raise the pitch. Use headphones to avoid echo. Status: <b>{status}</b>
      </p>
      <label className="row">
        <span>Model</span>
        <select value={model} onChange={(e) => pickModel(e.target.value)} disabled={live}>
          {MODELS.map((m) => <option key={m.id}>{m.id}</option>)}
        </select>
      </label>
      <label className="row">
        <span>Voice</span>
        <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={live}>
          {voices.map((v) => <option key={v}>{v}</option>)}
        </select>
      </label>
      <label className="row">
        <span style={{ whiteSpace: "nowrap" }}>Pitch +{pitch}</span>
        <input type="range" min={0} max={9} step={0.5} value={pitch} onChange={(e) => { const v = Number(e.target.value); setPitch(v); shifter.current?.port.postMessage({ semitones: v }); }} />
      </label>
      <p>
        {live ? <button className="pill" onClick={stop}>Hang up</button> : <button className="pill" onClick={start}>Call</button>}
      </p>
      <h2>What she said</h2>
      <pre style={{ whiteSpace: "pre-wrap" }}>{transcript || "…"}</pre>
      <h2>Events</h2>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{log.join("\n")}</pre>
      <p><a href="/">← back to the bunny</a></p>
    </main>
  );
}
