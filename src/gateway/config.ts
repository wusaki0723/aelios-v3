import type { AuthResult, Env } from "../types";
import { validateSettings } from "./settings";

export const PROTOCOLS = ["chat", "messages", "responses"] as const;
export type Protocol = typeof PROTOCOLS[number];
export const PATHS: Record<Protocol, string> = {
  chat: "chat/completions", messages: "messages", responses: "responses"
};
export interface Provider {
  // HTTP base URL includes the version prefix, e.g. /v1.
  baseUrl?: string;
  gateway?: string;
  provider?: string;
  paths?: Partial<Record<Protocol, string>>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, { secret: string; prefix?: string }>;
}
// Rules match the model the client asked for; the first match wins.
export interface ModelRule {
  match: string;
  model?: string;
  memory?: "request" | "off";
  record?: boolean;
}
export interface Identity {
  slug: string;
  namespace: string;
  keys: AuthResult["keyName"][];
  provider: string;
  memory: "request" | "off";
  record: boolean;
  anthropicThinking: "passthrough" | "drop_block";
  maxMemoryChars?: number;
  models?: ModelRule[];
}
export interface GatewayConfig {
  version: 2;
  providers: Record<string, Provider>;
  identities: Identity[];
  settings?: Record<string, string>;
}
export interface ResolvedModel {
  provider: string;
  model: string;
  memory: "request" | "off";
  record: boolean;
}
export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const KEY_NAMES = ["CHATBOX_API_KEY", "IM_API_KEY", "DEBUG_API_KEY", "GUIDE_DOG_API_KEY"];
// Slugs are the first path segment, so they cannot shadow existing entry points.
const RESERVED_SLUGS = ["v1", "api", "admin", "health", "mcp", "memory-mcp", "memory-admin", "guide-dog"];

export function validateConfig(value: unknown): GatewayConfig {
  check(object(value) && value.version === 2, "Gateway config requires version: 2");
  check(object(value.providers), "providers must be an object");
  for (const [name, p] of Object.entries(value.providers)) {
    check(text(name) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) && object(p),
      `Invalid provider name: ${name}. Use the name as the model prefix, so it must not contain a slash.`);
    check(Boolean(p.baseUrl) !== Boolean(p.gateway), `${name}: choose baseUrl or gateway`);
    if (p.baseUrl) {
      const url = new URL(p.baseUrl);
      check(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
        `${name}: baseUrl must be HTTPS without credentials, query or fragment`);
    } else check(text(p.gateway) && text(p.provider), `${name}: gateway and provider are required`);
    if (p.paths !== undefined) {
      check(object(p.paths), `${name}: paths must be an object`);
      for (const [protocol, path] of Object.entries(p.paths)) {
        check(PROTOCOLS.includes(protocol as Protocol) && text(path) &&
          /^[a-zA-Z0-9_/-]+$/.test(path) && !path.startsWith("/"), `${name}: invalid protocol path`);
      }
    }
    for (const field of ["headers", "secretHeaders"] as const) {
      if (p[field] === undefined) continue;
      check(object(p[field]), `${name}: ${field} must be an object`);
      for (const [header, entry] of Object.entries(p[field])) {
        check(/^[a-zA-Z0-9-]+$/.test(header) && !["host", "content-length", "connection", "transfer-encoding"].includes(header.toLowerCase()), `${name}: invalid header`);
        if (field === "headers") {
          check(typeof entry === "string" && !/[\r\n]/.test(entry), `${name}: invalid header value`);
          check(!/authorization|api-key|token|cookie/i.test(header), `${name}: credentials belong in secretHeaders`);
        } else check(object(entry) && text(entry.secret) &&
          (entry.prefix === undefined || typeof entry.prefix === "string" && !/[\r\n]/.test(entry.prefix)), `${name}: invalid secret reference`);
      }
    }
  }
  value.settings = validateSettings(value.settings);
  check(Array.isArray(value.identities), "identities must be an array");
  const slugs = new Set<string>();
  for (const identity of value.identities) {
    check(object(identity) && text(identity.slug) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(identity.slug),
      "Identity requires an ASCII slug used as the base URL path segment (max 64 characters)");
    const where = identity.slug;
    check(!RESERVED_SLUGS.includes(identity.slug.toLowerCase()), `${where}: reserved slug`);
    check(!slugs.has(identity.slug), `Duplicate identity slug: ${where}`);
    slugs.add(identity.slug);
    check(text(identity.namespace) && identity.namespace.length <= 128, `${where}: namespace is required (max 128 characters)`);
    check(Array.isArray(identity.keys) && identity.keys.length && identity.keys.every((k: unknown) => KEY_NAMES.includes(String(k))), `${where}: invalid keys`);
    check(text(identity.provider) && Object.hasOwn(value.providers, identity.provider), `${where}: provider must name a configured provider`);
    check(identity.memory === "request" || identity.memory === "off", `${where}: memory must be request or off`);
    check(typeof identity.record === "boolean", `${where}: record must be boolean`);
    check(["passthrough", "drop_block"].includes(identity.anthropicThinking), `${where}: invalid anthropicThinking`);
    check(identity.maxMemoryChars === undefined || Number.isInteger(identity.maxMemoryChars) && identity.maxMemoryChars >= 256 && identity.maxMemoryChars <= 24000, `${where}: maxMemoryChars must be 256–24000`);
    if (identity.models === undefined) continue;
    check(Array.isArray(identity.models) && identity.models.length <= 64, `${where}: models must be an array of at most 64 rules`);
    for (const rule of identity.models) {
      check(object(rule) && text(rule.match) && rule.match.length <= 200, `${where}: every model rule needs a match pattern`);
      check(rule.model === undefined || text(rule.model) && rule.model.length <= 200, `${where}: invalid model rewrite`);
      check(rule.memory === undefined || rule.memory === "request" || rule.memory === "off", `${where}: rule memory must be request or off`);
      check(rule.record === undefined || typeof rule.record === "boolean", `${where}: rule record must be boolean`);
    }
  }
  return value as unknown as GatewayConfig;
}

let settingsCache: { value: Record<string, string>; expires: number } | null = null;
export function invalidateSettingsCache(): void { settingsCache = null; }
/** Read on every entry point, so keep it cheap; saved edits land within ten seconds. */
export async function loadSettings(env: Env): Promise<Record<string, string>> {
  if (settingsCache && settingsCache.expires > Date.now()) return settingsCache.value;
  let value: Record<string, string> = {};
  try {
    const row = await env.DB.prepare("SELECT config_json FROM gateway_config WHERE id = 1").first<{ config_json: string }>();
    const raw = row?.config_json || env.GATEWAY_CONFIG;
    if (raw) value = validateSettings(JSON.parse(raw).settings);
  } catch { value = {}; }
  settingsCache = { value, expires: Date.now() + 10_000 };
  return value;
}
export async function loadConfig(env: Env): Promise<GatewayConfig> {
  const row = await env.DB.prepare("SELECT config_json FROM gateway_config WHERE id = 1").first<{ config_json: string }>();
  if (row) return validateConfig(JSON.parse(row.config_json));
  if (env.GATEWAY_CONFIG) return validateConfig(JSON.parse(env.GATEWAY_CONFIG));
  return { version: 2, providers: {}, identities: [], settings: {} };
}
export function allowedIdentities(config: GatewayConfig, auth: AuthResult): Identity[] {
  if (!auth.profile.scopes.includes("chat:proxy")) return [];
  return config.identities.filter(i => i.keys.includes(auth.keyName));
}
/** Without a path slug the key falls back to its first identity. */
export function findIdentity(config: GatewayConfig, auth: AuthResult, slug: string | null): Identity | undefined {
  const list = allowedIdentities(config, auth);
  return slug ? list.find(i => i.slug === slug) : list[0];
}
export function matchGlob(pattern: string, value: string): boolean {
  const source = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}
/** The first model segment picks the provider; the rest reaches the upstream untouched. */
export function resolveModel(config: GatewayConfig, identity: Identity, requested: string): ResolvedModel {
  const rule = (identity.models || []).find(r => matchGlob(r.match, requested));
  const model = rule?.model || requested;
  const slash = model.indexOf("/");
  const prefix = slash > 0 ? model.slice(0, slash) : "";
  const routed = prefix !== "" && Object.hasOwn(config.providers, prefix);
  return {
    provider: routed ? prefix : identity.provider,
    model: routed ? model.slice(slash + 1) : model,
    memory: rule?.memory ?? identity.memory,
    record: rule?.record ?? identity.record
  };
}
export function resolveSecret(env: Env, name: string): string {
  const secrets = env.GATEWAY_SECRETS ? JSON.parse(env.GATEWAY_SECRETS) : {};
  const value = Object.hasOwn(secrets, name) ? secrets[name] : (env as unknown as Record<string, unknown>)[name];
  if (!text(value)) throw new Error(`Missing gateway secret: ${name}`);
  return value;
}
