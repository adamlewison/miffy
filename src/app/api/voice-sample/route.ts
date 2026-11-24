import { type NextRequest } from "next/server";
import { bunny } from "@/bunny.config";
import { OPENAI_BASE, openaiHeaders } from "@/lib/openai";

const VOICES = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];

/**
 * Voice audition (used by /voices). Uses the TTS model, which shares voice
 * names with Realtime, so it's a cheap way to compare them. The realtime
 * delivery will differ slightly.
 */
export async function GET(req: NextRequest) {
  const voice = req.nextUrl.searchParams.get("voice") ?? "shimmer";
  if (!VOICES.includes(voice)) return new Response("unknown voice", { status: 400 });
  const text =
    req.nextUrl.searchParams.get("text")?.slice(0, 300) ||
    `${bunny.ownerName}yyy! It's me, ${bunny.name}! I been waiting and waiting all da day! And... and den I did a big hop! I wuv you a hundred much! Heehee!`;

  const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      instructions: `You are a tiny bunny who is a three-year-old little girl. ${bunny.voiceStyle} Pronounce it exactly as written, like a toddler.`,
      response_format: "mp3",
    }),
  });
  if (!res.ok) return new Response(await res.text(), { status: 502 });
  return new Response(res.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" },
  });
}
