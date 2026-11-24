/**
 * Talk to Oney from the command line, exactly as configured for a real call
 * (instructions + voice come from the app's own /api/session), and read what she
 * says back. The check for "is she still a 3-4 year old?".
 *
 *   npx tsx tools/voice-test.mts
 *   npx tsx tools/voice-test.mts --lines "Hi Oney!|What did you do today?" --audio .oney-out/voice
 *   npx tsx tools/voice-test.mts --lines "What's your name?" --audio .oney-out/voice --transcribe
 *
 * Options
 *   --lines "a|b|c"   what Mommy says (default: a short everyday call)
 *   --no-greet        skip the pick-up greeting
 *   --audio DIR       save each reply as WAV: NN.wav (raw voice) and NN-phone.wav (pitch-shifted, as heard on the phone)
 *   --transcribe      re-transcribe her audio (raw and pitch-shifted) with a separate model and no hints —
 *                     how her words actually *sound* (her name should come back as "Wunny", never "Oney"/"Ony").
 *                     Trust the raw line for pronunciation; the shifted voice trips speech-to-text more.
 *
 * Env: ONEY_URL (default http://localhost:3000), BUNNY_PASSCODE, OPENAI_API_KEY (only for --transcribe).
 * Uses the WebSocket transport (works without WebRTC); tool definitions mirror src/lib/useBunnyCall.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { PitchShifterCore } = require("../public/pitch-shifter.worklet.js");

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const has = (k: string) => argv.includes(`--${k}`);
const base = process.env.ONEY_URL || "http://localhost:3000";
const lines = (opt("lines") ?? "What did you do today?|I'm a bit tired, work was hard today.|Booba is coming on Sunday!|I have to go to bed now. Goodnight!").split("|");
const audioDir = opt("audio");
if (audioDir) fs.mkdirSync(audioDir, { recursive: true });

async function login(): Promise<string> {
  if (!process.env.BUNNY_PASSCODE) return "";
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: process.env.BUNNY_PASSCODE }) });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

function wav(samples: Int16Array, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + samples.byteLength, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

function phoneVersion(pcm: Int16Array, semitones: number) {
  const f = Float32Array.from(pcm, (v) => v / 32768);
  const out = new Float32Array(f.length);
  const core = new PitchShifterCore(24000, semitones);
  for (let i = 0; i < f.length; i += 128) core.process(f.subarray(i, i + 128), out.subarray(i, i + 128));
  return Int16Array.from(out, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
}

async function transcribe(file: string) {
  const fd = new FormData();
  fd.append("model", "gpt-4o-transcribe");
  fd.append("file", new Blob([fs.readFileSync(file)], { type: "audio/wav" }), path.basename(file));
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` }, body: fd });
  const j = (await r.json()) as { text?: string; error?: { message: string } };
  return j.text ?? `(transcription failed: ${j.error?.message ?? r.status})`;
}

const cookie = await login();
const res = await fetch(`${base}/api/session`, { method: "POST", headers: cookie ? { cookie } : {} });
if (!res.ok) throw new Error(`/api/session ${res.status}: ${await res.text()}`);
const info = (await res.json()) as { key: string; model: string; voice: string; instructions: string; pitchSemitones: number };

const calls: string[] = [];
const agent = new RealtimeAgent({
  name: "Oney",
  instructions: info.instructions,
  tools: [
    tool({ name: "get_time_of_day", description: "Get her local time, day and part of day.", parameters: z.object({}), execute: async () => (calls.push("get_time_of_day"), { partOfDay: "evening", time: "7:42 pm", weekday: "Tuesday" }) }),
    tool({
      name: "express",
      description: "Move your body on screen, like natural body language. Call it silently before speaking; never mention or describe the movement — she can see it.",
      parameters: z.object({ move: z.enum(["wave", "nuzzle", "sad", "hop", "wiggle", "spin", "ear_flick", "giggle", "clap", "cheer", "shy", "sleepy"]) }),
      execute: async ({ move }) => (calls.push(`express:${move}`), "done"),
    }),
    tool({ name: "remember_this", description: "Save an important fact about her life (plans, feelings, people, events). One short third-person sentence.", parameters: z.object({ fact: z.string() }), execute: async ({ fact }) => (calls.push(`remember:"${fact}"`), "remembered") }),
  ],
});
const session = new RealtimeSession(agent, { transport: "websocket", model: info.model, config: { audio: { output: { voice: info.voice } } } });

let chunks: Buffer[] = [];
let n = 0;
let active = 0;
let lastDone = 0;
let doneCount = 0;
session.on("audio", (e: { data: ArrayBuffer }) => chunks.push(Buffer.from(e.data)));
session.on("transport_event", async (e: { type: string; transcript?: string }) => {
  if (e.type === "response.created") active++;
  if (e.type === "response.output_audio_transcript.done") console.log(`   ONEY: ${e.transcript}${calls.length ? `   [${calls.splice(0).join(", ")}]` : ""}`);
  if (e.type === "response.done") {
    if (audioDir && chunks.length) {
      const b = Buffer.concat(chunks);
      const pcm = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
      const id = String(n++).padStart(2, "0");
      fs.writeFileSync(path.join(audioDir, `${id}.wav`), wav(pcm));
      const phone = path.join(audioDir, `${id}-phone.wav`);
      fs.writeFileSync(phone, wav(phoneVersion(pcm, info.pitchSemitones)));
      if (has("transcribe")) {
        // Raw = how the model actually pronounces it. Phone = after the +pitch shift (speech-to-text
        // is less reliable on the squeaky shifted voice, especially short excited lines).
        console.log(`   (heard, raw voice:   ${await transcribe(path.join(audioDir, `${id}.wav`))})`);
        console.log(`   (heard, phone voice: ${await transcribe(phone)})`);
      }
    }
    chunks = [];
    active = Math.max(0, active - 1);
    lastDone = Date.now();
    doneCount++;
  }
});

/** Wait until she has answered and gone quiet (tool calls can produce several responses per turn). */
async function reply() {
  const start = doneCount;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 200));
    if (doneCount > start && active === 0 && Date.now() - lastDone > 1800) return;
  }
}
await session.connect({ apiKey: info.key, model: info.model });
console.log(`voice=${info.voice} pitch=+${info.pitchSemitones} model=${info.model}\n`);
if (!has("no-greet")) {
  console.log("MOMMY: (calls — Oney picks up)");
  session.transport.sendEvent({
    type: "conversation.item.create",
    item: { type: "message", role: "system", content: [{ type: "input_text", text: "Mommy just called you and you picked up. Silently call get_time_of_day first (don't mention it), then greet her like a super excited little toddler, in one or two tiny sentences — toddler words, no \"good morning/evening\". (You're already waving hello.)" }] },
  });
  session.transport.sendEvent({ type: "response.create" });
  await reply();
}
for (const l of lines) {
  console.log(`MOMMY: ${l}`);
  session.sendMessage(l);
  await reply();
}
session.close();
process.exit(0);
