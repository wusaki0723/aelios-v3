import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { getSseData, splitSseEvents } from "../utils/sseParser";
import { object, type Identity, type Protocol } from "./config";
import { canonical, inputItems, visibleText, type Body, type Turn } from "./protocol";

// Two JSON-escaped text fields plus metadata fit within a Queue message.
const TEXT_LIMIT = 8000;
export interface GatewayExchange {
  type: "gateway_exchange";
  id: string;
  userId: string;
  namespace: string;
  profile: string;
  conversationId: string;
  protocol: Protocol;
  kind: Turn["kind"];
  userText: string;
  assistantText: string;
  model: string;
  provider: string;
  httpStatus: number;
  completion: "complete" | "incomplete" | "failed" | "truncated";
  createdAt: string;
  stream: boolean;
}
export async function prepareExchange(request: Request, body: Body, identity: Identity,
  protocol: Protocol, turn: Turn, source: string): Promise<GatewayExchange> {
  const session = request.headers.get("x-aelios-session-id") || request.headers.get("session_id") ||
    request.headers.get("x-session-id") || body.metadata?.session_id || "unscoped";
  const scope = canonical([identity.namespace, identity.slug, source, session]);
  const conversationId = "gw_" + await sha256Hex(scope);
  const prefix = inputItems(body, protocol).slice(0, turn.index + 1);
  const userId = "gw_user_" + await sha256Hex(canonical([scope, protocol, prefix]));
  const id = "gw_req_" + await sha256Hex(canonical([scope, protocol, turn.kind, body,
    request.headers.get("x-aelios-request-id") || ""]));
  return { type: "gateway_exchange", id, userId, namespace: identity.namespace, profile: identity.slug,
    conversationId, protocol, kind: turn.kind, userText: turn.text.slice(0, TEXT_LIMIT), assistantText: "",
    model: "", provider: "", httpStatus: 0, completion: turn.text.length > TEXT_LIMIT ? "truncated" : "incomplete",
    createdAt: new Date().toISOString(), stream: body.stream === true };
}

export async function persistExchange(env: Env, e: GatewayExchange): Promise<void> {
  const statements = [env.DB.prepare(`INSERT INTO gateway_exchanges
    (id, namespace, profile, conversation_id, protocol, kind, user_text, assistant_text,
     upstream_model, upstream_provider, http_status, completion_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET assistant_text = excluded.assistant_text,
      upstream_model = excluded.upstream_model, upstream_provider = excluded.upstream_provider,
      http_status = excluded.http_status, completion_status = excluded.completion_status
    WHERE gateway_exchanges.completion_status != 'complete'`)
    .bind(e.id, e.namespace, e.profile, e.conversationId, e.protocol, e.kind, e.userText, e.assistantText,
      e.model, e.provider, e.httpStatus, e.completion, e.createdAt)];
  // Auxiliary tasks and incomplete outputs never become relationship memories.
  if (e.kind !== "auxiliary") {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO conversations (id, namespace, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(e.conversationId, e.namespace, e.createdAt, e.createdAt));
    const addMessage = (id: string, role: string, content: string) => statements.push(env.DB.prepare(`INSERT OR IGNORE INTO messages
      (id, conversation_id, namespace, role, content, source, client_message_hash, upstream_model,
       upstream_provider, request_model, stream, finish_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, e.conversationId, e.namespace, role, content, "gateway:" + e.profile, id,
        e.model, e.provider, e.profile, e.stream ? 1 : 0, e.completion, e.createdAt));
    if (e.kind === "human" && e.userText && e.completion !== "truncated") addMessage(e.userId, "user", e.userText);
    if (e.completion === "complete" && e.assistantText) addMessage(e.id + ":assistant", "assistant", e.assistantText);
  }
  await env.DB.batch(statements);
}
export async function dispatchExchange(env: Env, exchange: GatewayExchange): Promise<void> {
  if (env.MEMORY_QUEUE) {
    try { await env.MEMORY_QUEUE.send(exchange); return; }
    catch { console.error("gateway queue send failed; writing exchange directly", { id: exchange.id }); }
  }
  await persistExchange(env, exchange);
}

export class OutputCollector {
  text = "";
  complete = false;
  failed = false;
  truncated = false;
  model = "";
  private rest = "";
  private decoder = new TextDecoder();
  constructor(readonly protocol: Protocol) {}
  private append(text: unknown): void {
    if (typeof text !== "string") return;
    if (this.text.length + text.length > TEXT_LIMIT) this.truncated = true;
    this.text = (this.text + text).slice(0, TEXT_LIMIT);
  }
  json(data: unknown): void {
    if (!object(data)) return;
    if (typeof data.model === "string") this.model = data.model;
    if (this.protocol === "chat") {
      const first = data.choices?.find((c: Body) => c.index === 0) || data.choices?.[0];
      this.append(visibleText(first?.message?.content));
      this.complete = !!first?.finish_reason && !["length", "content_filter"].includes(first.finish_reason);
    } else if (this.protocol === "messages") {
      this.append(visibleText(data.content));
      this.complete = !!data.stop_reason && !["max_tokens", "refusal"].includes(data.stop_reason);
    } else {
      this.append((data.output || []).filter((x: Body) => x.type === "message" && x.role === "assistant")
        .map((x: Body) => visibleText(x.content)).join("\n"));
      this.complete = data.status === "completed";
    }
    this.failed = !!data.error || data.status === "failed";
  }
  chunk(bytes: Uint8Array): void {
    const parsed = splitSseEvents(this.rest + this.decoder.decode(bytes, { stream: true }));
    this.rest = parsed.rest;
    for (const event of parsed.events) this.event(event);
    if (this.rest.length > 128000) { this.rest = ""; this.truncated = true; }
  }
  private event(event: string): void {
    const raw = getSseData(event);
    if (!raw || raw === "[DONE]") return;
    let data: Body;
    try { data = JSON.parse(raw); } catch { return; }
    if (!object(data)) return;
    if (typeof data.model === "string") this.model = data.model;
    if (data.type === "error" || data.error) { this.failed = true; this.complete = false; }
    if (this.protocol === "chat") {
      const c = data.choices?.find((choice: Body) => choice.index === 0);
      this.append(c?.delta?.content);
      if (c?.finish_reason) this.complete = !["length", "content_filter"].includes(c.finish_reason);
    } else if (this.protocol === "messages") {
      if (data.type === "message_start" && data.message?.model) this.model = data.message.model;
      if (data.type === "content_block_start" && data.content_block?.type === "text") this.append(data.content_block.text);
      if (data.type === "content_block_delta" && data.delta?.type === "text_delta") this.append(data.delta.text);
      if (data.type === "message_delta" && ["max_tokens", "refusal"].includes(data.delta?.stop_reason)) this.failed = true;
      if (data.type === "message_stop") this.complete = !this.failed;
    } else {
      if (data.type === "response.output_text.delta") this.append(data.delta);
      if (["response.completed", "response.incomplete", "response.failed"].includes(data.type)) {
        const streamed = this.text;
        this.text = "";
        this.json(data.response);
        if (!this.text) this.text = streamed;
      }
    }
  }
  finish(): void {
    this.rest += this.decoder.decode();
    if (this.rest.trim()) this.event(this.rest);
    this.rest = "";
  }
}

export function observeResponse(upstream: Response, protocol: Protocol, ctx: ExecutionContext,
  onFinish: (collector: OutputCollector, interrupted: boolean) => Promise<void>): Response {
  if (!upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const collector = new OutputCollector(protocol);
  const sse = upstream.headers.get("content-type")?.includes("text/event-stream");
  const decoder = new TextDecoder();
  let json = "";
  let done = false;
  const finish = (interrupted: boolean) => {
    if (done) return;
    done = true;
    try {
      if (sse) collector.finish();
      else if (!collector.truncated) collector.json(JSON.parse(json + decoder.decode()));
    } catch { collector.failed = true; }
    ctx.waitUntil(onFinish(collector, interrupted).catch(() => console.error("gateway exchange recording failed")));
  };
  // Observe with client backpressure: no unbounded tee or wire re-serialization.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { finish(false); controller.close(); return; }
        try {
          if (sse) collector.chunk(item.value);
          else if (!collector.truncated) {
            json += decoder.decode(item.value, { stream: true });
            if (json.length > 256000) { collector.truncated = true; json = ""; }
          }
        } catch { collector.failed = true; }
        controller.enqueue(item.value);
      } catch (error) { finish(true); controller.error(error); }
    },
    async cancel(reason) { finish(true); await reader.cancel(reason); }
  });
  return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}
