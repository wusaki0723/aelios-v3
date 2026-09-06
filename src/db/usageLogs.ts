import type { TokenUsage } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export async function saveUsageLog(
  db: D1Database,
  input: {
    messageId: string;
    namespace: string;
    provider: string;
    model: string;
    usage?: TokenUsage;
    cacheMode?: string | null;
    cacheTtl?: string | null;
    clientSystemHash?: string | null;
    cacheAnchorBlock?: string | null;
  }
): Promise<void> {
  const usage = input.usage || {};
  await db
    .prepare(
      `INSERT INTO usage_logs (
        id, message_id, namespace, provider, model, input_tokens,
        output_tokens, cache_read_tokens, cache_creation_tokens, cache_mode,
        cache_ttl, client_system_hash, cache_anchor_block, raw_usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId("usage"),
      input.messageId,
      input.namespace,
      input.provider,
      input.model,
      usage.prompt_tokens ?? usage.input_tokens ?? null,
      usage.completion_tokens ?? usage.output_tokens ?? null,
      usage.cache_read_input_tokens ?? null,
      usage.cache_creation_input_tokens ?? null,
      input.cacheMode ?? null,
      input.cacheTtl ?? null,
      input.clientSystemHash ?? null,
      input.cacheAnchorBlock ?? null,
      JSON.stringify(usage),
      nowIso()
    )
    .run();
}
