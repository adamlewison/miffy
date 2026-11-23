"use client";

import { useEffect, useState } from "react";
import { bunny } from "@/bunny.config";

type M = { id: string; fact: string; created_at: string };

/** See and prune what the bunny remembers. Not linked from the call UI. */
export default function Memories() {
  const [items, setItems] = useState<M[] | null>(null);
  const [backend, setBackend] = useState("");
  const [fact, setFact] = useState("");

  const load = () =>
    fetch("/api/memories")
      .then((r) => r.json())
      .then((j) => {
        setItems(j.memories ?? []);
        setBackend(j.backend ?? "");
      });
  useEffect(() => {
    load();
  }, []);

  const remove = async (id: string) => {
    await fetch(`/api/memories?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fact.trim()) return;
    await fetch("/api/memories", { method: "POST", body: JSON.stringify({ facts: [fact] }) });
    setFact("");
    load();
  };

  return (
    <main className="admin">
      <h1>What {bunny.name} remembers</h1>
      <p>
        The newest 30 are loaded into every call. Storage: <b>{backend || "…"}</b>
        {backend === "memory" && " (temporary — set up Turso to keep these across deploys)"}
      </p>
      <form onSubmit={add} className="row">
        <input value={fact} onChange={(e) => setFact(e.target.value)} placeholder="Add a memory, e.g. She loves strawberry jam." />
        <button className="pill small">Add</button>
      </form>
      {items === null ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No memories yet. They appear after calls.</p>
      ) : (
        <ul className="mem-list">
          {items.map((m) => (
            <li key={m.id}>
              <span>{m.fact}</span>
              <small>{new Date(m.created_at).toLocaleDateString()}</small>
              <button className="link" onClick={() => remove(m.id)} aria-label="Forget">
                forget
              </button>
            </li>
          ))}
        </ul>
      )}
      <p><a href="/">← back to the bunny</a></p>
    </main>
  );
}
