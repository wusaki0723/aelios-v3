-- Aelios memory review candidates.
-- Low-confidence extraction output lands here first so the admin review queue
-- can approve, edit, discard, or merge candidates before they become memory.

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL,
  fact_key TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,
  tags TEXT,
  source_message_ids TEXT,
  source TEXT NOT NULL DEFAULT 'extract',
  status TEXT NOT NULL DEFAULT 'pending',
  target_memory_id TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_namespace_status
ON memory_candidates(namespace, status, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_fact_key
ON memory_candidates(namespace, fact_key) WHERE fact_key IS NOT NULL;
