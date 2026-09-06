-- v4 assembler: track cache anchor metadata in usage_logs
-- These columns let us monitor Claude prompt cache hit rates per request.

ALTER TABLE usage_logs ADD COLUMN client_system_hash TEXT;
ALTER TABLE usage_logs ADD COLUMN cache_anchor_block TEXT;
