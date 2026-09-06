CREATE TABLE IF NOT EXISTS gateway_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Operational records are separate from Dream's human/assistant source table.
CREATE TABLE IF NOT EXISTS gateway_exchanges (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  profile TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  upstream_provider TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  completion_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_exchanges_namespace_created
ON gateway_exchanges(namespace, created_at);
