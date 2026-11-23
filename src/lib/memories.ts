import { createClient, type Client } from "@libsql/client";

/**
 * Memory store. Uses Turso (libSQL) when TURSO_DATABASE_URL is set; otherwise
 * falls back to an in-process array so local dev works without any setup.
 * The table is created automatically on first use.
 *
 * Only extracted facts are ever stored. Never audio, never full transcripts.
 */

export type Memory = { id?: string; fact: string; created_at?: string };

const dbUrl = process.env.TURSO_DATABASE_URL;
export const memoryBackend = dbUrl ? "turso" : "memory";

type G = typeof globalThis & { __bunnyMemories?: Memory[]; __bunnyDb?: Promise<Client> };
const g = globalThis as G;
const local = (g.__bunnyMemories ??= []);

function db(): Promise<Client> {
  g.__bunnyDb ??= (async () => {
    const client = createClient({ url: dbUrl!, authToken: process.env.TURSO_AUTH_TOKEN });
    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS memories (
           id TEXT PRIMARY KEY,
           fact TEXT NOT NULL CHECK (length(fact) BETWEEN 3 AND 400),
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`,
        "CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories (created_at DESC)",
      ],
      "write",
    );
    return client;
  })().catch((err) => {
    g.__bunnyDb = undefined; // retry on the next request
    throw err;
  });
  return g.__bunnyDb;
}

export async function listMemories(limit = 30): Promise<Memory[]> {
  if (memoryBackend === "memory") return local.slice(-limit).reverse();
  const rs = await (await db()).execute({
    sql: "SELECT id, fact, created_at FROM memories ORDER BY created_at DESC LIMIT ?",
    args: [limit],
  });
  return rs.rows.map((r) => ({ id: String(r.id), fact: String(r.fact), created_at: String(r.created_at) }));
}

export async function addMemories(facts: string[]): Promise<void> {
  const clean = facts.map((f) => f.trim()).filter((f) => f.length > 2 && f.length < 400);
  if (!clean.length) return;
  if (memoryBackend === "memory") {
    const now = new Date().toISOString();
    for (const fact of clean) local.push({ id: crypto.randomUUID(), fact, created_at: now });
    return;
  }
  // Distinct timestamps keep ordering stable within one batch.
  const base = Date.now();
  await (await db()).batch(
    clean.map((fact, i) => ({
      sql: "INSERT INTO memories (id, fact, created_at) VALUES (?, ?, ?)",
      args: [crypto.randomUUID(), fact, new Date(base + i).toISOString()],
    })),
    "write",
  );
}

export async function deleteMemory(id: string): Promise<void> {
  if (memoryBackend === "memory") {
    const i = local.findIndex((m) => m.id === id);
    if (i >= 0) local.splice(i, 1);
    return;
  }
  await (await db()).execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] });
}
