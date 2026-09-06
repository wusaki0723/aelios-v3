import { object, type Identity, type Protocol } from "./config";

export type Body = Record<string, any>;
export function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(p => object(p) && ["text", "input_text", "output_text"].includes(p.type) && typeof p.text === "string")
    .map(p => p.text).join("\n");
}
export function inputItems(body: Body, protocol: Protocol): Body[] {
  if (protocol === "responses") return typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  return body.messages;
}
export function validateBody(body: unknown, protocol: Protocol): asserts body is Body {
  if (!object(body) || typeof body.model !== "string") throw new Error("A model name is required");
  const items = inputItems(body, protocol);
  if (!Array.isArray(items) || !items.every(object)) throw new Error(protocol === "responses" ? "input must be a string or item array" : "messages must be an array of objects");
}
export interface Turn { kind: "human" | "tool" | "auxiliary"; text: string; index: number }
export function classifyTurn(body: Body, protocol: Protocol, auxiliary = false): Turn {
  const items = inputItems(body, protocol);
  const index = items.length - 1;
  const last = items[index];
  if (auxiliary || !last) return { kind: "auxiliary", text: "", index };
  if (last.role === "tool" || /_call_output$/.test(last.type || "")) return { kind: "tool", text: "", index };
  if (last.role !== "user" || last.type && !["message", "input_message"].includes(last.type)) return { kind: "auxiliary", text: "", index };
  const text = visibleText(last.content);
  const blocks = Array.isArray(last.content) ? last.content : [];
  const tool = blocks.some(p => object(p) && p.type === "tool_result");
  if (tool && !text.trim()) return { kind: "tool", text: "", index };
  return { kind: "human", text, index };
}
export function appendMemory(body: Body, protocol: Protocol, patch: string): Body {
  const copy = structuredClone(body);
  if (!patch) return copy;
  if (protocol === "responses" && typeof copy.input === "string") {
    copy.input += "\n\n" + patch;
    return copy;
  }
  const items = inputItems(copy, protocol);
  const last = items[items.length - 1];
  // Preserve every original content block and client cache_control marker.
  if (typeof last.content === "string") last.content += "\n\n" + patch;
  else last.content = [...(last.content || []), { type: protocol === "responses" ? "input_text" : "text", text: patch }];
  return copy;
}
// Encrypted reasoning stays allowed; only server-owned history breaks request-only memory.
export function hasServerState(body: Body, protocol: Protocol): boolean {
  return protocol === "responses" && !!(body.previous_response_id || body.conversation ||
    inputItems(body, protocol).some(item => item.type === "item_reference"));
}
export function applyThinkingPolicy(body: Body, identity: Identity, protocol: Protocol, headers: Headers): void {
  if (protocol !== "messages" || identity.anthropicThinking !== "drop_block" || body.thinking?.type === "disabled") return;
  body.thinking = { type: "adaptive", ...body.thinking,
    block_binding: { ...body.thinking?.block_binding, prefix_mismatch_behavior: "drop_block" } };
  const betas = new Set((headers.get("anthropic-beta") || "").split(",").map(s => s.trim()).filter(Boolean));
  betas.add("thinking-binding-controls-2026-08-01");
  headers.set("anthropic-beta", [...betas].join(","));
}
// Fingerprints sort object keys without rewriting request payloads.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
