CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  source TEXT,
  client_message_hash TEXT,
  upstream_model TEXT,
  upstream_provider TEXT,
  request_model TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  token_input INTEGER,
  token_output INTEGER,
  cache_mode TEXT,
  cache_ttl TEXT,
  cache_hit INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  raw_usage_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
ON messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_namespace_created
ON messages(namespace, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_hash
ON messages(client_message_hash);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  source TEXT,
  source_message_ids TEXT,
  vector_id TEXT,
  last_recalled_at TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_namespace_status
ON memories(namespace, status);

CREATE INDEX IF NOT EXISTS idx_memories_type
ON memories(type);

CREATE INDEX IF NOT EXISTS idx_memories_pinned
ON memories(pinned);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  memory_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  conversation_id TEXT,
  content TEXT NOT NULL,
  from_message_id TEXT,
  to_message_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  vector_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  value_text TEXT,
  content_type TEXT,
  tags TEXT,
  size_bytes INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_cache_namespace_key
ON cache_entries(namespace, key);

CREATE INDEX IF NOT EXISTS idx_cache_expires
ON cache_entries(expires_at);

CREATE TABLE IF NOT EXISTS processing_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_mode TEXT,
  cache_ttl TEXT,
  raw_usage_json TEXT,
  created_at TEXT NOT NULL
);
