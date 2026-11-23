/**
 * Memory store. Uses Supabase (PostgREST over fetch — no SDK needed) when
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set; otherwise falls back to an
 * in-process array so local dev works without any setup.
 *
 * Only extracted facts are ever stored. Never audio, never full transcripts.
 */

export type Memory = { id?: string; fact: string; created_at?: string };

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const memoryBackend = url && key ? "supabase" : "memory";

type G = typeof globalThis & { __bunnyMemories?: Memory[] };
const local = ((globalThis as G).__bunnyMemories ??= []);

function headers(extra: Record<string, string> = {}) {
  return {
    apikey: key!,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function listMemories(limit = 30): Promise<Memory[]> {
  if (memoryBackend === "memory") {
    return local.slice(-limit).reverse();
  }
  const res = await fetch(
    `${url}/rest/v1/memories?select=id,fact,created_at&order=created_at.desc&limit=${limit}`,
    { headers: headers(), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Supabase list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function addMemories(facts: string[]): Promise<void> {
  const clean = facts.map((f) => f.trim()).filter((f) => f.length > 2 && f.length < 400);
  if (!clean.length) return;
  if (memoryBackend === "memory") {
    const now = new Date().toISOString();
    for (const fact of clean) local.push({ id: crypto.randomUUID(), fact, created_at: now });
    return;
  }
  const res = await fetch(`${url}/rest/v1/memories`, {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(clean.map((fact) => ({ fact }))),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status} ${await res.text()}`);
}

export async function deleteMemory(id: string): Promise<void> {
  if (memoryBackend === "memory") {
    const i = local.findIndex((m) => m.id === id);
    if (i >= 0) local.splice(i, 1);
    return;
  }
  const res = await fetch(`${url}/rest/v1/memories?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Supabase delete failed: ${res.status}`);
}
