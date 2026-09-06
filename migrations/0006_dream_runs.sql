CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  date_label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  model TEXT,
  processed_messages INTEGER,
  error TEXT,
  trigger TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dream_runs_namespace_date ON dream_runs (namespace, date_label);