-- For reference only: the app creates this table automatically on first use.
-- One table: the bunny's long-term memories (extracted facts only, never audio).
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL CHECK (length(fact) BETWEEN 3 AND 400),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories (created_at DESC);
