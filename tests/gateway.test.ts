import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { invalidateSettingsCache, validateConfig } from "../src/gateway/config";
import { appendMemory, classifyTurn, canonical } from "../src/gateway/protocol";
import { OutputCollector, observeResponse, persistExchange, prepareExchange, dispatchExchange } from "../src/gateway/record";

// Test actual production modules and SQL, replacing only external bindings.
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let db: any, env: any, ctx: any;
let pending: Promise<unknown>[], calls: any[], queue: any[];
const identity = () => ({ slug: "partner", namespace: "partner-a", keys: ["CHATBOX_API_KEY"],
  provider: "primary", memory: "request", record: true, anthropicThinking: "drop_block",
  models: [{ match: "*haiku*", memory: "off", record: false }, { match: "listed-model" }] });
function config(identities = [identity()]) {
  return { version: 2, providers: { primary: { gateway: "default", provider: "compat" }, backup: { gateway: "backup", provider: "compat" } }, identities };
}
function setConfig(c: any) { env.GATEWAY_CONFIG = JSON.stringify(c); }
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync("migrations/" + file, "utf8"));
  db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  }, async batch(statements: any[]) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  invalidateSettingsCache();
  calls = []; queue = []; pending = [];
  ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", IM_API_KEY: "im-key", MEMORY_MCP_API_KEY: "mcp-key",
    MEMORY_QUEUE: { async send(e: any) { queue.push(e); } },
    AI: { gateway(id: string) { return { async run(input: any) {
      calls.push({ id, ...input });
      if (input.endpoint === "responses") return Response.json({ model: "gpt-test", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Response reply" }] }] });
      if (input.endpoint.endsWith("messages")) return Response.json({ model: "claude-test", content: [{ type: "thinking", thinking: "do not record" }, { type: "text", text: "Claude reply" }], stop_reason: "end_turn" });
      return Response.json({ model: "actual", choices: [{ index: 0, message: { content: "你好，记住了。" }, finish_reason: "stop" }] });
    } }; } } };
  setConfig(config());
});
function request(path: string, body?: any, headers: any = {}, method = body ? "POST" : "GET") {
  return new Request("https://aelios.test" + path, { method,
    headers: { authorization: "Bearer owner-key", "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function run(path: string, body?: any, headers?: any) {
  const response = await worker.fetch(request(path, body, headers), env, ctx);
  const text = await response.text(); await Promise.all(pending);
  return { response, text };
}
function count(table: string) { return sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n; }
function precious(namespace: string, content: string) {
  sqlite.prepare("INSERT INTO precious (id, namespace, content, created_at) VALUES (?, ?, ?, ?)").run(namespace, namespace, content, "2026-09-06");
}

test("migrations, native chat recall, namespace isolation, original text and Queue dedup", async () => {
  precious("partner-a", "喜欢 Cloudflare"); precious("partner-b", "other identity private memory");
  const body = { model: "partner", messages: [{ role: "user", content: "我们喜欢什么？" }], extra_future_field: { opaque: true } };
  const { response } = await run("/v1/chat/completions", body);
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-aelios-memory"), "injected");
  assert.match(calls[0].query.messages[0].content, /喜欢 Cloudflare/);
  assert.doesNotMatch(calls[0].query.messages[0].content, /other identity/);
  assert.deepEqual(calls[0].query.extra_future_field, body.extra_future_field);
  assert.equal(queue[0].userText, "我们喜欢什么？"); assert.equal(queue[0].completion, "complete");
  await persistExchange(env, queue[0]); await persistExchange(env, queue[0]);
  assert.equal(count("gateway_exchanges"), 1); assert.equal(count("messages"), 2);
  const continuation = { model: "partner", messages: [...body.messages,
    { role: "assistant", content: null, tool_calls: [{ id: "t", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t", content: "result" }] };
  await run("/v1/chat/completions", continuation);
  assert.deepEqual(calls[1].query.messages, continuation.messages);
  assert.equal(queue[1].kind, "tool"); assert.equal(queue[1].userText, "");
});
test("Anthropic tool_result is not human; client beta, signatures, tools and cache survive", async () => {
  const body = { model: "partner", max_tokens: 1000, tools: [{ name: "t", input_schema: { type: "object" } }],
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "opaque" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Not me", cache_control: { type: "ephemeral" } }] }] };
  const { response } = await run("/v1/messages", body, { "anthropic-beta": "client-beta" });
  assert.equal(response.status, 200); assert.deepEqual(calls[0].query.messages, body.messages);
  assert.deepEqual(calls[0].query.tools, body.tools);
  assert.equal(calls[0].query.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
  assert.match(calls[0].headers["anthropic-beta"], /client-beta/);
  assert.match(calls[0].headers["anthropic-beta"], /thinking-binding-controls/);
  assert.equal(calls[0].headers.authorization, undefined); assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.equal(queue[0].kind, "tool"); assert.equal(queue[0].assistantText, "Claude reply");
});
test("Responses string input, tool outputs and encrypted reasoning; reject hidden server history", async () => {
  await run("/v1/responses", { model: "partner", input: "你好", store: true });
  assert.equal(calls[0].query.store, false); assert.equal(queue[0].userText, "你好");
  const input = [{ type: "reasoning", encrypted_content: "opaque" }, { type: "function_call_output", call_id: "t", output: "done" }];
  await run("/v1/responses", { model: "partner", input, include: ["reasoning.encrypted_content"] });
  assert.deepEqual(calls[1].query.input, input); assert.equal(queue[1].kind, "tool");
  const { response } = await run("/v1/responses", { model: "partner", input: "next", previous_response_id: "resp_previous" });
  assert.equal(response.status, 400); assert.equal(calls.length, 2);
});
test("append after multimodal blocks without modifying cache markers or original request", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image", source: { data: "opaque" } }, { type: "text", text: "看这个", cache_control: { type: "ephemeral" } }] }] };
  const before = structuredClone(body); const out = appendMemory(body, "messages", "memory");
  assert.deepEqual(body, before); assert.deepEqual(out.messages[0].content.slice(0, 2), before.messages[0].content);
  assert.equal(out.messages[0].content[2].text, "memory");
  assert.equal(classifyTurn({ messages: [{ role: "user", content: [{ type: "tool_result", content: "result" }, { type: "text", text: "Also do this" }] }] }, "messages").kind, "human");
});
test("path picks the identity; keys gate it and the bare path falls back to the first one", async () => {
  const other = { ...identity(), slug: "other", namespace: "partner-b", keys: ["IM_API_KEY"] };
  setConfig(config([identity(), other]));
  const models = await run("/v1/models");
  assert.deepEqual(JSON.parse(models.text).data.map((m: any) => m.id), ["listed-model"]);
  assert.match(models.response.headers.get("cache-control")!, /no-store/);
  const scoped = await run("/partner/v1/chat/completions", { model: "any-model", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(scoped.response.headers.get("x-aelios-identity"), "partner");
  assert.equal(queue[0].namespace, "partner-a");
  // Another key's identity stays unreachable, and a body namespace cannot override it.
  assert.equal((await run("/other/v1/chat/completions", { model: "any-model", messages: [] })).response.status, 403);
  await run("/v1/chat/completions", { model: "any-model", namespace: "partner-b", messages: [{ role: "user", content: "Hi again" }] });
  assert.equal(queue[1].namespace, "partner-a");
  const im = await run("/other/v1/chat/completions", { model: "any-model", messages: [{ role: "user", content: "Hi" }] }, { authorization: "Bearer im-key" });
  assert.equal(im.response.headers.get("x-aelios-identity"), "other");
  assert.equal((await run("/v1/chat/completions", { model: "any-model", messages: [] }, { authorization: "Bearer mcp-key" })).response.status, 403);
});
test("auxiliary and incomplete replies do not become Dream sources", async () => {
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Generate title" }] }, { "x-aelios-purpose": "auxiliary" });
  await persistExchange(env, queue[0]); assert.equal(count("messages"), 0);
  await persistExchange(env, { ...queue[0], id: "incomplete", kind: "human", userText: "real question", assistantText: "half reply", completion: "incomplete" });
  assert.equal(count("messages"), 1); assert.equal(sqlite.prepare("SELECT role FROM messages").get()!.role, "user");
});
test("retry hashes ignore key order but distinguish later repeated words and sessions", async () => {
  const a = { model: "partner", messages: [{ role: "user", content: "Hi" }] };
  const b = { messages: [{ content: "Hi", role: "user" }], model: "partner" };
  const make = (body: any, session = "one") => prepareExchange(request("/v1/chat/completions", body, { "x-aelios-session-id": session }), body, identity() as any, "chat", classifyTurn(body, "chat"), "chatbox");
  assert.equal((await make(a)).id, (await make(b)).id);
  assert.notEqual((await make(a)).id, (await make(a, "two")).id);
  assert.notEqual((await make(a)).userId, (await make({ ...a, messages: [...a.messages, { role: "assistant", content: "Hello" }, ...a.messages] })).userId);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});
test("model passthrough: first segment routes, rules rewrite, mute recall and recording", async () => {
  precious("partner-a", "喜欢 Cloudflare");
  setConfig(config([{ ...identity(), models: [
    { match: "*haiku*", memory: "off", record: false },
    { match: "cheap", model: "backup/moonshot/kimi-k2" }
  ] }]));
  const ask = (model: string) => run("/v1/chat/completions", { model, messages: [{ role: "user", content: "Hi " + model }] });
  await ask("primary/gpt-9");
  assert.deepEqual([calls[0].id, calls[0].query.model], ["default", "gpt-9"]);
  // A configured provider name only ever eats one segment; the rest is the upstream's own naming.
  await ask("backup/openai/gpt-9");
  assert.deepEqual([calls[1].id, calls[1].query.model], ["backup", "openai/gpt-9"]);
  // An unknown prefix is part of the model name, not a route.
  await ask("openai/gpt-9");
  assert.deepEqual([calls[2].id, calls[2].query.model], ["default", "openai/gpt-9"]);
  await ask("cheap");
  assert.deepEqual([calls[3].id, calls[3].query.model], ["backup", "moonshot/kimi-k2"]);
  assert.equal(queue.length, 4);
  const small = await ask("claude-3-5-haiku-20241022");
  assert.equal(small.response.headers.get("x-aelios-memory"), "off");
  assert.equal(calls[4].query.model, "claude-3-5-haiku-20241022");
  assert.doesNotMatch(JSON.stringify(calls[4].query.messages), /Cloudflare/);
  assert.equal(queue.length, 4);
});
test("SSE byte-exact Unicode and CRLF boundaries; no thinking in observed text", async () => {
  const raw = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"secret"}}\r\n\r\n' +
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好🌸"}}\r\n\r\n' +
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
  const bytes = new TextEncoder().encode(raw); let offset = 0; let observed: any;
  const source = new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } });
  const response = observeResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), "messages", ctx, async (out, interrupted) => { observed = { text: out.text, complete: out.complete, interrupted }; });
  assert.equal(await response.text(), raw); await Promise.all(pending);
  assert.deepEqual(observed, { text: "你好🌸", complete: true, interrupted: false });
});
test("Responses terminal snapshot does not duplicate deltas; broken stream stays incomplete", () => {
  const out = new OutputCollector("responses");
  const event = (data: any) => out.chunk(new TextEncoder().encode("data: " + JSON.stringify(data) + "\n\n"));
  event({ type: "response.output_text.delta", delta: "Hello" });
  event({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }] } });
  assert.equal(out.text, "Hello"); assert.equal(out.complete, true);
  const broken = new OutputCollector("chat");
  broken.chunk(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
  broken.finish(); assert.equal(broken.complete, false);
});
test("cancellation cancels upstream and records interrupted state", async () => {
  let cancelled = false; let interrupted = false;
  const source = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n')); }, cancel() { cancelled = true; } });
  const response = observeResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), "chat", ctx, async (_, flag) => { interrupted = flag; });
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); await Promise.all(pending);
  assert.equal(cancelled, true); assert.equal(interrupted, true);
});
test("admin configuration validation, D1 precedence and owner-only writes", async () => {
  assert.equal((await worker.fetch(request("/api/gateway/config", config(), {}, "PUT"), env, ctx)).status, 200);
  env.GATEWAY_CONFIG = "invalid env overridden by D1";
  assert.equal(JSON.parse((await run("/api/gateway/config")).text).identities[0].slug, "partner");
  assert.equal((await worker.fetch(request("/api/gateway/config", config(), { authorization: "Bearer im-key" }, "PUT"), env, ctx)).status, 401);
  const bad = config(); (bad.providers.primary as any).headers = { authorization: "inline-secret" };
  assert.throws(() => validateConfig(bad), /secretHeaders/);
});
test("HTTP upstream receives configured secret only, preserving unknown fields and response bytes", async () => {
  const c: any = config(); c.providers.primary = { baseUrl: "https://upstream.test/v1", secretHeaders: { authorization: { secret: "UPSTREAM", prefix: "Bearer " } } };
  setConfig(c); env.GATEWAY_SECRETS = JSON.stringify({ UPSTREAM: "provider-key" });
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://upstream.test/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer provider-key");
    assert.deepEqual(JSON.parse(init?.body as string).future, { keep: true });
    return new Response(' {"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]} ', { headers: { "content-type": "application/json" } });
  };
  try { const result = await run("/v1/chat/completions", { model: "partner", messages: [], future: { keep: true } }); assert.match(result.text, /^ /); }
  finally { globalThis.fetch = previous; }
});
test("thinking passthrough skips memory; explicit disabled thinking allows injection", async () => {
  precious("partner-a", "Cloudflare fan");
  setConfig(config([{ ...identity(), anthropicThinking: "passthrough" }]));
  const body = { model: "partner", messages: [{ role: "user", content: "Hi" }], thinking: { type: "adaptive" } };
  assert.equal((await run("/v1/messages", body)).response.headers.get("x-aelios-memory"), "thinking-passthrough");
  assert.deepEqual(calls[0].query.thinking, body.thinking); assert.deepEqual(calls[0].query.messages, body.messages);
  assert.equal((await run("/v1/messages", { ...body, thinking: { type: "disabled" } })).response.headers.get("x-aelios-memory"), "injected");
});
test("Queue failure falls back to D1; successful duplicate cannot overwrite complete record", async () => {
  await run("/v1/chat/completions", { model: "partner", messages: [{ role: "user", content: "Hi" }] });
  env.MEMORY_QUEUE.send = async () => { throw Error("queue unavailable"); };
  await dispatchExchange(env, queue[0]);
  await persistExchange(env, { ...queue[0], assistantText: "different retry" });
  assert.equal(count("gateway_exchanges"), 1); assert.equal(count("messages"), 2);
  assert.equal(sqlite.prepare("SELECT assistant_text FROM gateway_exchanges").get()!.assistant_text, "你好，记住了。");
});

test("settings edited in the admin page override deployment vars everywhere", async () => {
  const withSettings = { ...config(), settings: { CHAT_MODEL: "chosen-in-admin", MEMORY_FILTER_MAX_OUTPUT: " 5 ", DREAM_TIME_ZONE: "" } };
  assert.equal((await worker.fetch(request("/api/gateway/config", withSettings, {}, "PUT"), env, ctx)).status, 200);
  invalidateSettingsCache();
  // Blank stays unset, whitespace is trimmed, and the value reaches unrelated handlers.
  const saved = JSON.parse((await run("/api/gateway/config")).text).settings;
  assert.deepEqual(saved, { CHAT_MODEL: "chosen-in-admin", MEMORY_FILTER_MAX_OUTPUT: "5" });
  const health = JSON.parse((await run("/health")).text);
  assert.equal(health.missing_optional_text_vars.includes("CHAT_MODEL"), false);
  assert.equal(health.missing_optional_text_vars.includes("VISION_MODEL"), true);
  // The env report shows the saved value next to what the Worker was deployed with.
  env.VISION_MODEL = "deployed-vision";
  const report = JSON.parse((await run("/api/gateway/env")).text);
  const items = report.groups.flatMap((g: any) => g.items);
  assert.deepEqual(items.find((i: any) => i.name === "CHAT_MODEL").value, "chosen-in-admin");
  assert.deepEqual(items.find((i: any) => i.name === "VISION_MODEL"), { name: "VISION_MODEL", label: "看图模型", hint: "", value: "", deployed: "deployed-vision" });
  assert.equal(report.secrets.find((x: any) => x.name === "CHATBOX_API_KEY").present, true);
  assert.equal(report.secrets.find((x: any) => x.name === "DEBUG_API_KEY").present, false);
  assert.equal((await worker.fetch(request("/api/gateway/env", undefined, { authorization: "Bearer im-key" }), env, ctx)).status, 401);
  assert.throws(() => validateConfig({ ...config(), settings: { DB: "hijacked" } }), /Unknown setting/);
});
