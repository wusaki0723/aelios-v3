import { json } from "../utils/json";
import type { Env } from "../types";

// 必填以「零配置记忆库」为准：README 承诺不配网关、不配模型 key 也能记、召、夜整。
// 网关/维护类变量缺了只降级不报警，否则最小部署的 /health 会一直喊
// missing_configuration，新用户以为自己装坏了（实际只是没开可选功能）。
const requiredTextVars = ["CHATBOX_API_KEY"] as const;

// 缺了只影响对应可选功能：聊天网关（AI_GATEWAY_BASE_URL / CF_AIG_TOKEN /
// CHAT_MODEL / VISION_MODEL）、维护工具（CLOUDFLARE_ACCOUNT_ID / API_TOKEN）。
const optionalTextVars = [
  "AI_GATEWAY_BASE_URL",
  "CF_AIG_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CHAT_MODEL",
  "VISION_MODEL"
] as const;

const requiredBindings = [
  ["d1", "DB"],
  ["workers_ai", "AI"],
] as const;

const optionalBindings = [
  ["vectorize", "VECTORIZE"],
  ["queue", "MEMORY_QUEUE"],
] as const;

export function handleHealth(env: Env): Response {
  const missing_text_vars: string[] = requiredTextVars.filter((name) => !env[name]);
  const missing_optional_text_vars: string[] = optionalTextVars.filter((name) => !env[name]);

  const missing_bindings = requiredBindings
    .filter(([, binding]) => !env[binding])
    .map(([name]) => name);
  const missing_optional_bindings = optionalBindings
    .filter(([, binding]) => !env[binding])
    .map(([name]) => name);
  const ok = missing_text_vars.length === 0 && missing_bindings.length === 0;
  const degraded = missing_optional_bindings.length > 0 || missing_optional_text_vars.length > 0;

  return json(
    {
      ok,
      status: ok ? (degraded ? "degraded" : "ok") : "missing_configuration",
      service: "companion-memory-proxy",
      missing_text_vars,
      missing_optional_text_vars,
      missing_bindings,
      missing_optional_bindings,
      bindings: {
        d1: Boolean(env.DB),
        vectorize: Boolean(env.VECTORIZE),
        queue: Boolean(env.MEMORY_QUEUE)
      }
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}
