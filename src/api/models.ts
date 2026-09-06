import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { findIdentity, loadConfig } from "../gateway/config";

/** Models are passthrough, so the list only advertises the wildcard-free rules as client hints. */
export async function handleModels(request: Request, env: Env, slug: string | null = null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  let config;
  try { config = await loadConfig(env); }
  catch { return openAiError("Gateway configuration unavailable. Apply migrations.", 503); }

  const identity = findIdentity(config, auth, slug);
  if (!identity) return openAiError("No identity available for this key. Configure /admin/gateway.", 403);

  return json(
    {
      object: "list",
      data: (identity.models || [])
        .filter(rule => !rule.match.includes("*"))
        .map(rule => (
          {
            id: rule.match,
            object: "model",
            created: 0,
            owned_by: identity.slug
          }
        ))
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
