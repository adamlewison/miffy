import { NextResponse, type NextRequest } from "next/server";
import { gateway } from "@ai-sdk/gateway";
import { listMemories } from "@/lib/memories";
import { buildInstructions } from "@/lib/prompt";

export const dynamic = "force-dynamic";

/**
 * Test bench for Gemini Live through the Vercel AI Gateway (see /live-test).
 * Mints a short-lived gateway token. Google requires the whole session config
 * (instructions, voice) at token time. AI_GATEWAY_API_KEY never leaves the server.
 */
export async function POST(req: NextRequest) {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return NextResponse.json({ error: "AI_GATEWAY_API_KEY is not set" }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as { model?: string; voice?: string };
  const model = body.model || "google/gemini-3.8-live";
  const voice = body.voice || "Aoede";

  let memories: Awaited<ReturnType<typeof listMemories>> = [];
  try {
    memories = await listMemories(30);
  } catch {}
  const instructions = buildInstructions(memories);
  // Gemini wants 16 kHz mic audio; the OpenAI and xAI realtime models want 24 kHz.
  const inputRate = model.startsWith("google/") ? 16000 : 24000;
  const sessionConfig = {
    instructions,
    voice,
    inputAudioFormat: { type: "audio/pcm", rate: inputRate },
    outputAudioFormat: { type: "audio/pcm", rate: 24000 },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  try {
    const { token, url, expiresAt } = await gateway.experimental_realtime.getToken({
      model,
      expiresAfterSeconds: 300,
      sessionConfig,
    });
    return NextResponse.json({ token, url, expiresAt, model, sessionConfig, inputRate });
  } catch (err) {
    console.error("[live-token]", err);
    return NextResponse.json({ error: String((err as Error)?.message ?? err) }, { status: 502 });
  }
}
