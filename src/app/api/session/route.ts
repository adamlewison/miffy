import { NextResponse } from "next/server";
import { bunny } from "@/bunny.config";
import { listMemories } from "@/lib/memories";
import { buildInstructions } from "@/lib/prompt";
import { OPENAI_BASE, openaiHeaders } from "@/lib/openai";

export const dynamic = "force-dynamic";

/**
 * Mints a short-lived Realtime client secret and hands the phone everything it
 * needs to start the call. The real API key never leaves the server.
 */
export async function POST() {
  const model = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
  const voice = process.env.BUNNY_VOICE || bunny.voice;
  const envPitch = Number(process.env.BUNNY_PITCH);
  const pitchSemitones = process.env.BUNNY_PITCH && Number.isFinite(envPitch) ? envPitch : bunny.pitchSemitones;

  let memories: Awaited<ReturnType<typeof listMemories>> = [];
  try {
    memories = await listMemories(30);
  } catch (err) {
    console.error("[session] could not load memories", err);
  }
  const instructions = buildInstructions(memories);

  try {
    const res = await fetch(`${OPENAI_BASE}/realtime/client_secrets`, {
      method: "POST",
      headers: openaiHeaders(),
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model,
          instructions,
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                prompt: `Names: ${bunny.spokenName} (written ${bunny.name}), ${bunny.alsoCalled.join(", ")}, ${bunny.spokenTwinName} (written ${bunny.twinName}), Booba, Mummy, ${bunny.ownerName}, Ads, Adam.`,
              },
              turn_detection: { type: "semantic_vad", eagerness: "high", interrupt_response: true, create_response: true },
            },
            output: { voice },
          },
        },
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[session] OpenAI error", res.status, text);
      return NextResponse.json({ error: "The bunny is asleep (couldn't start a call)." }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json({
      key: data.value as string,
      expiresAt: data.expires_at as number,
      model,
      voice,
      pitchSemitones,
      instructions,
      bunnyName: bunny.name,
      ownerName: bunny.spokenOwnerName, // as she says it, for the pick-up note
    });
  } catch (err) {
    console.error("[session]", err);
    return NextResponse.json({ error: "The bunny is asleep (server not configured)." }, { status: 500 });
  }
}
