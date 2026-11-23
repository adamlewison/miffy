"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, tool, type RealtimeItem } from "@openai/agents/realtime";
import { z } from "zod";
import { bunnyState, setMode, triggerTrick, type Trick } from "./bunnyState";
import { getAudioContext, playHangup, playPickup, startRingback, unlockAudio } from "./sounds";

export type CallStatus = "idle" | "ringing" | "live" | "ended" | "error";

type SessionInfo = {
  key: string;
  model: string;
  voice: string;
  instructions: string;
  bunnyName: string;
  ownerName: string;
};

const MAX_MINUTES = Number(process.env.NEXT_PUBLIC_MAX_CALL_MINUTES || 20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function partOfDay(h: number) {
  if (h < 5) return "the middle of the night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night-time";
}

function makeTools() {
  return [
    tool({
      name: "get_time_of_day",
      description: "Get her local time, day and part of day, so you can say good morning / goodnight correctly.",
      parameters: z.object({}),
      execute: async () => {
        const d = new Date();
        return {
          time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
          weekday: d.toLocaleDateString([], { weekday: "long" }),
          date: d.toLocaleDateString([], { day: "numeric", month: "long" }),
          partOfDay: partOfDay(d.getHours()),
        };
      },
    }),
    tool({
      name: "do_trick",
      description:
        "Do a little physical trick on screen. Use when excited, celebrating, or when she asks you to do a trick. Keep talking normally while it happens.",
      parameters: z.object({
        trick: z.enum(["hop", "ear_flick", "wiggle", "spin"]).describe("hop = little jump, ear_flick = both ears flick up, wiggle = happy wiggle, spin = a twirl"),
      }),
      execute: async ({ trick }) => {
        triggerTrick(trick as Trick);
        return "done — you did it beautifully";
      },
    }),
    tool({
      name: "remember_this",
      description:
        "Save an important fact about her life to your long-term memory (plans, feelings, people, events, new inside jokes). One short third-person sentence.",
      parameters: z.object({ fact: z.string() }),
      execute: async ({ fact }) => {
        await fetch("/api/memories", {
          method: "POST",
          body: JSON.stringify({ facts: [`${fact} (${new Date().toDateString()})`] }),
        }).catch(() => {});
        return "remembered";
      },
    }),
  ];
}

function transcriptFrom(history: RealtimeItem[]) {
  const lines: { role: "user" | "assistant"; text: string }[] = [];
  for (const item of history) {
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) continue;
    const text = item.content
      .map((c) => ("transcript" in c && c.transcript) || ("text" in c && c.text) || "")
      .join(" ")
      .trim();
    if (text) lines.push({ role: item.role, text });
  }
  return lines;
}

export function useBunnyCall() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [captions, setCaptions] = useState<{ role: "user" | "assistant"; text: string } | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const camRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const historyRef = useRef<RealtimeItem[]>([]);
  const stopRingRef = useRef<(() => void) | null>(null);
  const lastFrameRef = useRef(0);
  const callIdRef = useRef(0);
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Send her current camera frame to the bunny (no response triggered). */
  const sendFrame = useCallback(() => {
    const video = videoRef.current;
    const session = sessionRef.current;
    if (!video || !session || !camRef.current || video.videoWidth === 0) return;
    if (performance.now() - lastFrameRef.current < 4000) return;
    lastFrameRef.current = performance.now();
    const w = 384;
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
    try {
      session.addImage(canvas.toDataURL("image/jpeg", 0.6), { triggerResponse: false });
    } catch (e) {
      console.warn("addImage failed", e);
    }
  }, []);

  const cleanup = useCallback(() => {
    stopRingRef.current?.();
    stopRingRef.current = null;
    try {
      sessionRef.current?.close();
    } catch {}
    sessionRef.current = null;
    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    camRef.current?.getTracks().forEach((t) => t.stop());
    camRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
    }
    bunnyState.analyser = null;
    bunnyState.live = false;
    setMode("idle");
    setMuted(false);
    setCaptions(null);
  }, []);

  const end = useCallback(
    (reason?: string) => {
      const wasLive = !!sessionRef.current;
      callIdRef.current++; // cancels an in-flight start()
      const lines = transcriptFrom(historyRef.current);
      historyRef.current = [];
      if (lines.length) {
        // Facts are extracted server-side; keepalive survives the page closing.
        fetch("/api/memories", { method: "POST", body: JSON.stringify({ transcript: lines }), keepalive: true }).catch(() => {});
      }
      cleanup();
      if (wasLive || reason) playHangup();
      setStartedAt(null);
      if (reason) setError(reason);
      setStatus("ended");
      setTimeout(() => setStatus((s) => (s === "ended" ? "idle" : s)), 2200);
    },
    [cleanup],
  );

  const start = useCallback(async () => {
    const callId = ++callIdRef.current;
    const cancelled = () => callId !== callIdRef.current;
    setError(null);
    setStatus("ringing");

    try {
      // Everything audio-related must be kicked off inside this tap (iOS).
      await unlockAudio();
      const audioEl = audioElRef.current ?? document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "true");
      audioElRef.current = audioEl;
      stopRingRef.current = startRingback();

      const [mic, info] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        }),
        fetch("/api/session", { method: "POST" }).then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Couldn't reach the bunny.");
          return j as SessionInfo;
        }),
        sleep(2600 + Math.random() * 1500), // let it ring a bit, like a real call
      ]);
      if (cancelled()) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      micRef.current = mic;

      const agent = new RealtimeAgent({
        name: info.bunnyName,
        instructions: info.instructions,
        tools: makeTools(),
      });

      const transport = new OpenAIRealtimeWebRTC({
        mediaStream: mic,
        audioElement: audioEl,
        changePeerConnection: (pc) => {
          pc.addEventListener("track", (e) => {
            if (e.track.kind !== "audio") return;
            const ctx = getAudioContext();
            const src = ctx.createMediaStreamSource(e.streams[0] ?? new MediaStream([e.track]));
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.2; // we do our own ~80ms smoothing in the rig
            src.connect(analyser); // not to destination: the <audio> element plays it
            bunnyState.analyser = analyser;
          });
          return pc;
        },
      });

      const session = new RealtimeSession(agent, {
        transport,
        model: info.model,
        config: {
          audio: {
            input: {
              noiseReduction: { type: "near_field" },
              transcription: { model: "gpt-4o-mini-transcribe" },
              turnDetection: { type: "semantic_vad", eagerness: "high", interruptResponse: true, createResponse: true },
            },
            output: { voice: info.voice },
          },
        },
      });
      sessionRef.current = session;

      session.on("history_updated", (h) => {
        historyRef.current = h;
      });
      session.on("transport_event", (ev: { type: string; [k: string]: unknown }) => {
        switch (ev.type) {
          case "input_audio_buffer.speech_started":
            setMode("listening");
            sendFrame();
            break;
          case "input_audio_buffer.speech_stopped":
            setMode("thinking");
            if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
            thinkingTimer.current = setTimeout(() => {
              if (bunnyState.mode === "thinking") setMode("idle");
            }, 7000);
            break;
          case "output_audio_buffer.started":
            setMode("talking");
            break;
          case "output_audio_buffer.stopped":
          case "output_audio_buffer.cleared":
            if (bunnyState.mode === "talking") setMode("idle");
            break;
          case "conversation.item.input_audio_transcription.completed":
            setCaptions({ role: "user", text: String(ev.transcript ?? "") });
            break;
          case "response.output_audio_transcript.done":
            setCaptions({ role: "assistant", text: String(ev.transcript ?? "") });
            break;
        }
      });
      session.on("audio_interrupted", () => setMode("listening"));
      session.on("error", (e) => console.warn("[realtime]", e));

      await session.connect({
        apiKey: info.key,
        model: info.model,
        // The ephemeral key already pins the model; repeating it is harmless and
        // keeps things working behind proxies that rewrite the auth header.
        url: `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(info.model)}`,
      });
      if (cancelled()) {
        session.close();
        return;
      }

      stopRingRef.current?.();
      stopRingRef.current = null;
      playPickup();
      audioEl.play().catch(() => {});
      bunnyState.live = true;
      setStartedAt(Date.now());
      setStatus("live");

      // She picked up — the bunny answers first, like a real call.
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `${info.ownerName} just called you and you picked up. Silently call get_time_of_day first (don't mention it), then greet her warmly and happily in one or two short sentences.`,
            },
          ],
        },
      });
      session.transport.sendEvent({ type: "response.create" });
    } catch (err) {
      if (cancelled()) return;
      console.error(err);
      const msg =
        err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
          ? "The bunny needs the microphone to hear you. Please allow it and try again."
          : err instanceof Error
            ? err.message
            : "The call didn't connect.";
      cleanup();
      setError(msg);
      setStatus("error");
    }
  }, [cleanup, sendFrame]);

  const toggleMute = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const next = !muted;
    s.mute(next);
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(async () => {
    if (camRef.current) {
      camRef.current.getTracks().forEach((t) => t.stop());
      camRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraOn(false);
      return;
    }
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      camRef.current = cam;
      setCameraOn(true);
      // The <video> mounts after state change; attach on next tick.
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = cam;
          videoRef.current.play().catch(() => {});
          lastFrameRef.current = 0;
          setTimeout(sendFrame, 800);
        }
      }, 0);
    } catch (e) {
      console.warn("camera", e);
    }
  }, [sendFrame]);

  // Hard cap on call length, to keep costs predictable.
  useEffect(() => {
    if (status !== "live" || !startedAt) return;
    const t = setTimeout(() => end(), MAX_MINUTES * 60_000);
    return () => clearTimeout(t);
  }, [status, startedAt, end]);

  // Hang up cleanly if the page goes away.
  useEffect(() => {
    const onHide = () => {
      if (sessionRef.current) end();
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      cleanup();
    };
  }, [end, cleanup]);

  return { status, error, muted, cameraOn, startedAt, captions, videoRef, start, end, toggleMute, toggleCamera };
}
