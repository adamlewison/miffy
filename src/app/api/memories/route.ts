import { NextResponse, type NextRequest } from "next/server";
import { bunny } from "@/bunny.config";
import { addMemories, deleteMemory, listMemories, memoryBackend } from "@/lib/memories";
import { OPENAI_BASE, openaiHeaders } from "@/lib/openai";

export const dynamic = "force-dynamic";

type Line = { role: "user" | "assistant"; text: string };

export async function GET() {
  try {
    return NextResponse.json({ backend: memoryBackend, memories: await listMemories(200) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteMemory(id);
  return NextResponse.json({ ok: true });
}

/**
 * Two shapes:
 *  { facts: string[] }       — saved directly (the bunny's remember_this tool)
 *  { transcript: Line[] }    — sent after a call; a cheap model extracts 3–5 facts
 * The transcript itself is discarded after extraction.
 */
export async function POST(req: NextRequest) {
  let body: { facts?: string[]; transcript?: Line[] };
  try {
    // sendBeacon posts text/plain, so parse manually.
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  try {
    if (Array.isArray(body.facts)) {
      await addMemories(body.facts.slice(0, 5).map(String));
      return NextResponse.json({ saved: body.facts.length });
    }
    const lines = (body.transcript ?? []).filter((l) => l && typeof l.text === "string" && l.text.trim());
    if (lines.filter((l) => l.role === "user").length === 0) return NextResponse.json({ saved: 0 });

    const facts = await extractFacts(lines);
    await addMemories(facts);
    return NextResponse.json({ saved: facts.length, facts });
  } catch (err) {
    console.error("[memories]", err);
    return NextResponse.json({ error: "could not save memories" }, { status: 500 });
  }
}

async function extractFacts(lines: Line[]): Promise<string[]> {
  const existing = (await listMemories(50).catch(() => [])).map((m) => `- ${m.fact}`).join("\n") || "(none)";
  const transcript = lines
    .map((l) => `${l.role === "user" ? bunny.ownerName : bunny.name}: ${l.text.trim()}`)
    .join("\n")
    .slice(-12000);

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({
      model: process.env.MEMORY_MODEL || "gpt-5.4-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "memories",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { facts: { type: "array", items: { type: "string" } } },
            required: ["facts"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content: `You maintain the long-term memory of ${bunny.name}, a talking plush bunny, about its owner ${bunny.ownerName}.
From the call transcript, extract 0-5 NEW facts worth remembering for future calls: things about her life, plans, feelings, people, preferences, events, and any new jokes or promises between her and the bunny.
- Family names to use: ${bunny.family.join(" ")}
- Write each fact as a short third-person sentence about her (she is "${bunny.ownerName}"), e.g. "She has a job interview on Friday (said on ${new Date().toDateString()})." Include dates for time-sensitive things.
- Skip small talk, greetings, and anything already in the existing memories.
- Never record anything sensitive like passwords, card numbers or health details beyond what a friend would naturally remember.
- If nothing is worth remembering, return an empty list.`,
        },
        { role: "user", content: `Existing memories:\n${existing}\n\nTranscript:\n${transcript}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`extract failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  return Array.isArray(parsed.facts) ? parsed.facts.slice(0, 5) : [];
}
