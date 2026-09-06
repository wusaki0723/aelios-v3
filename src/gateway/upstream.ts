import type { Env } from "../types";
import { PATHS, resolveSecret, type GatewayConfig, type Identity, type Protocol, type ResolvedModel } from "./config";
import { applyThinkingPolicy, type Body } from "./protocol";

// One call, one upstream. Retries and cross-provider fallback belong to AI Gateway dynamic routes.
export async function callGatewayUpstream(env: Env, config: GatewayConfig, identity: Identity,
  protocol: Protocol, original: Request, body: Body, target: ResolvedModel): Promise<Response> {
  const provider = config.providers[target.provider];
  if (!provider) throw new Error(`Unknown provider: ${target.provider}`);
  const payload = { ...body, model: target.model };
  const headers = new Headers({ "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" });
  for (const name of ["anthropic-version", "anthropic-beta", "openai-beta", "x-stainless-helper-method"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (protocol === "messages" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  for (const [name, value] of Object.entries(provider.headers || {})) headers.set(name, value);
  for (const [name, ref] of Object.entries(provider.secretHeaders || {})) headers.set(name, (ref.prefix || "") + resolveSecret(env, ref.secret));
  applyThinkingPolicy(payload, identity, protocol, headers);
  const endpoint = provider.paths?.[protocol] || PATHS[protocol];
  if (provider.gateway) {
    if (!env.AI) throw new Error("Missing AI binding");
    return env.AI.gateway(provider.gateway).run({
      provider: provider.provider!, endpoint, headers: Object.fromEntries(headers), query: payload
    }, { signal: original.signal });
  }
  const url = provider.baseUrl!.replace(/\/$/, "") + "/" + endpoint;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: original.signal, redirect: "error" });
}
