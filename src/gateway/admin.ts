import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { invalidateSettingsCache, loadConfig, validateConfig } from "./config";
import { describeSettings } from "./settings";

async function ownerOnly(request: Request, env: Env): Promise<boolean> {
  const auth = await authenticate(request, env);
  return auth.ok && ["CHATBOX_API_KEY", "DEBUG_API_KEY"].includes(auth.keyName);
}
/** Reports the values this Worker was deployed with, so the page can show them as placeholders. */
export async function handleGatewayEnv(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  let settings = {};
  try { settings = (await loadConfig(env)).settings || {}; } catch { settings = {}; }
  return Response.json(describeSettings(env, settings), { headers: { "cache-control": "no-store" } });
}
export async function handleGatewayAdmin(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  try {
    if (request.method === "GET") return Response.json(await loadConfig(env), { headers: { "cache-control": "no-store" } });
    if (request.method !== "PUT") return Response.json({ error: "Use GET or PUT" }, { status: 405, headers: { allow: "GET, PUT" } });
    let config;
    try { config = validateConfig(await request.json()); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid config" }, { status: 400 }); }
    await env.DB.prepare(`INSERT INTO gateway_config (id, config_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .bind(JSON.stringify(config), new Date().toISOString()).run();
    invalidateSettingsCache();
    return Response.json({ ok: true, identities: config.identities.length, settings: Object.keys(config.settings || {}).length });
  } catch { return Response.json({ error: "Configuration store unavailable. Apply D1 migrations first." }, { status: 503 }); }
}
export function gatewayAdminPage(): Response {
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aelios · 记忆网关</title><style>
:root{color-scheme:dark;font:15px/1.6 system-ui;background:#10151b;color:#e4e9ef}body{max-width:1050px;margin:auto;padding:32px 20px}h1{font-size:30px;margin:8px 0}h2{font-size:19px}p{color:#a6b4c3}a{color:#8ad5ca}code{background:#101720;border:1px solid #2c3846;border-radius:5px;padding:1px 5px;font:13px ui-monospace,monospace}section{background:#19212b;border:1px solid #303b49;border-radius:14px;padding:22px;margin:20px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}label{display:block;color:#b8c6d6;font-size:13px;margin:10px 0}input,select,textarea,button{font:inherit;border-radius:7px;border:1px solid #3b4b5e;padding:10px;box-sizing:border-box}input,select,textarea{background:#101720;color:#e4e9ef;width:100%;margin-top:5px}textarea{font:13px/1.6 ui-monospace,monospace;tab-size:2}button{background:#93ded0;color:#122922;cursor:pointer;margin:8px 8px 0 0}button.secondary{background:#293746;color:#e4e9ef}#status{white-space:pre-wrap;color:#93ded0;min-height:26px}small{color:#a6b4c3}details{margin-top:18px}h3{font-size:15px;color:#b8c6d6;margin:18px 0 4px}fieldset{border:1px solid #2c3846;border-radius:10px;padding:6px 16px 16px;margin:14px 0}legend{color:#93ded0;font-size:13px;padding:0 6px}#secrets div{color:#b8c6d6;font-size:13px}#secrets small{color:#6b7c8f;font-family:ui-monospace,monospace}@media(max-width:700px){.grid{grid-template-columns:1fr}body{padding:18px 12px}}
</style><body><small>AELIOS / MEMORY GATEWAY</small><h1>带着记忆，随处接入。</h1><p>一个身份一个地址，模型名原样透传。Chat、Claude Code 和 Codex 使用各自的原生协议，由 Cloudflare AI Gateway 接上游。</p>
<section><label>管理密钥（CHATBOX_API_KEY 或 DEBUG_API_KEY；仅保留在当前页面）<input id="key" type="password" autocomplete="off"></label><button id="load">读取配置</button><button id="example" class="secondary">填入 CF 示例</button><a href="/admin">记忆管理 →</a></section>
<div class="grid"><section><h2>1 · 添加线路</h2><label>线路名称（同时是模型前缀）<input id="providerName" placeholder="anthropic"></label><label>AI Gateway ID<input id="gateway" value="default"></label><label>CF Provider<input id="provider" list="providerList" placeholder="anthropic"><datalist id="providerList"><option value="anthropic"><option value="openai"><option value="compat"><option value="workers-ai"><option value="google-ai-studio"><option value="deepseek"><option value="groq"><option value="mistral"></datalist></label><button id="addProvider">添加到草稿</button><p>上游密钥放在 CF AI Gateway 的 BYOK 里，本网关不碰。轮询和 fallback 用 CF Dynamic Routes，模型名写 <code>compat/dynamic/路由名</code>。</p></section>
<section><h2>2 · 添加身份</h2><label>身份路径<input id="slug" placeholder="companion-a"></label><label>记忆空间<input id="namespace" placeholder="companion-a"></label><label>默认线路（模型名不带已知前缀时使用）<input id="identityProvider" placeholder="anthropic"></label><label>召回方式<select id="memory"><option value="request">每次人类新输入临时召回</option><option value="off">不召回</option></select></label><label>记录对话<select id="record"><option value="true">记录，供 Dream 使用</option><option value="false">不记录</option></select></label><label>Anthropic thinking<select id="thinking"><option value="passthrough">原样透传（思考开启时跳过注入）</option><option value="drop_block">临时注入兼容（线路须支持 beta）</option></select></label><button id="addIdentity">添加到草稿</button></section></div>
<section><h2>3 · 模型规则（可选）</h2><p>按客户端请求的模型名匹配，命中第一条即生效。给 Claude Code 的 haiku、Codex 的小模型关掉召回和记录，最省事。<code>*</code> 是通配符；不含通配符的 match 会出现在 <code>/v1/models</code> 列表里。</p>
<div class="grid"><div><label>身份路径<input id="ruleSlug" placeholder="companion-a"></label><label>匹配模型名<input id="ruleMatch" placeholder="*haiku*"></label><label>改写为（可选，留空即透传）<input id="ruleModel" placeholder="compat/moonshot/kimi-k2"></label></div><div><label>召回<select id="ruleMemory"><option value="">跟随身份</option><option value="off">不召回</option><option value="request">召回</option></select></label><label>记录<select id="ruleRecord"><option value="">跟随身份</option><option value="false">不记录</option><option value="true">记录</option></select></label><button id="addRule">添加到草稿</button></div></div></section>
<section><h2>4 · 环境设置</h2><p>Cloudflare 的 Worker Settings 里只要填 <code>CHATBOX_API_KEY</code> 一个密钥，够你进这个页面就行；其余参数都在这里填。每格留空 = 用部署时的默认值，灰字就是当前生效的值。先在最上面填管理密钥、点「读取配置」，这里才会出现。</p><div id="settings"></div><h3>密钥状态</h3><p>密钥不进数据库，仍在 Worker 的 Settings → Variables and Secrets 里填。</p><div id="secrets"></div></section>
<section><h2>5 · 检查并保存</h2><textarea id="config" rows="22" spellcheck="false" aria-label="网关配置 JSON">{"version":2,"providers":{},"identities":[]}</textarea><button id="save">保存配置</button><div id="status" role="status" aria-live="polite"></div>
<details><summary>接入约定</summary><p>每个身份一个地址：Chatbox 等 OpenAI 兼容客户端填 <code>https://本站/身份/v1</code>；Claude Code 的 ANTHROPIC_BASE_URL 填 <code>https://本站/身份</code>；Codex 的 model_providers base_url 填 <code>https://本站/身份/v1</code> 并设 wire_api = "responses"。不带身份的 <code>/v1</code> 走该密钥的第一个身份。</p>
<p>模型名原样送到上游，只有第一段会被拿去选线路：<code>anthropic/claude-opus-4-5</code> 走 anthropic 线路、模型 <code>claude-opus-4-5</code>；<code>compat/moonshot/kimi-k2</code> 走 compat 线路、模型 <code>moonshot/kimi-k2</code>；前缀不是已配置的线路名时整串原样发给身份的默认线路。</p>
<p>可用 x-aelios-session-id 标识会话，x-aelios-purpose: auxiliary 标记内部任务。Responses 临时记忆使用完整历史和 store:false，不使用上游会话状态。drop_block 允许服务端舍弃前缀不匹配的旧 thinking，仅支持该 beta 的线路可用。临时记忆在工具续轮消失，可能不再影响最终回答。</p></details></section>
<script>
const el=id=>document.getElementById(id),status=message=>el('status').textContent=message;
const draft=()=>JSON.parse(el('config').value),show=config=>el('config').value=JSON.stringify(config,null,2);
function edit(fn){try{const c=draft();fn(c);show(c);status('已更新草稿，保存后生效。')}catch(e){status(e.message)}}
const identity=(c,slug)=>{const i=c.identities.find(i=>i.slug===slug);if(!i)throw Error('先添加身份 '+slug);return i};
function renderEnv(data){const box=el('settings');box.innerHTML='';data.groups.forEach(g=>{const f=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent=g.group;f.appendChild(legend);g.items.forEach(item=>{const l=document.createElement('label');l.textContent=item.label+(item.hint?'　'+item.hint:'');const i=document.createElement('input');i.dataset.name=item.name;i.value=item.value;i.placeholder=item.deployed||'未设置，用代码默认值';i.title=item.name;l.appendChild(i);f.appendChild(l)});box.appendChild(f)});el('secrets').innerHTML=data.secrets.map(x=>'<div>'+(x.present?'✓ ':'— ')+x.label+' <small>'+x.name+'</small></div>').join('')}
const collectSettings=()=>{const out={};document.querySelectorAll('#settings input[data-name]').forEach(i=>{if(i.value.trim())out[i.dataset.name]=i.value.trim()});return out};
async function loadEnv(){const r=await fetch('/api/gateway/env',{headers:{authorization:'Bearer '+el('key').value}});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);renderEnv(data)}
async function api(method){try{let body;if(method==='PUT'){const c=draft();if(document.querySelector('#settings input[data-name]'))c.settings=collectSettings();show(c);body=JSON.stringify(c)}const r=await fetch('/api/gateway/config',{method,headers:{authorization:'Bearer '+el('key').value,'content-type':'application/json'},...(body?{body}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);if(method==='GET'){show(data);await loadEnv()}status(method==='PUT'?'已保存。环境设置最长 10 秒后全网生效；客户端 base URL 用 /身份/v1，模型名随便填。':'已读取配置和环境设置。')}catch(e){status(e.message)}}
el('load').onclick=()=>api('GET');el('save').onclick=()=>api('PUT');
el('addProvider').onclick=()=>edit(c=>{const name=el('providerName').value.trim(),p=el('provider').value.trim();if(!name||!p)throw Error('请填写线路名称和 CF Provider');if(c.providers[name])throw Error('该线路已存在，请在配置中编辑');c.providers[name]={gateway:el('gateway').value.trim(),provider:p,...(p==='anthropic'?{paths:{messages:'v1/messages'}}:{})}});
el('addIdentity').onclick=()=>edit(c=>{const slug=el('slug').value.trim(),namespace=el('namespace').value.trim(),provider=el('identityProvider').value.trim();if(!slug||!namespace||!c.providers[provider])throw Error('请填写身份、记忆空间，并选择已添加的线路');if(c.identities.some(i=>i.slug===slug))throw Error('该身份已存在，请在配置中编辑');c.identities.push({slug,namespace,keys:['CHATBOX_API_KEY'],provider,memory:el('memory').value,record:el('record').value==='true',anthropicThinking:el('thinking').value})});
el('addRule').onclick=()=>edit(c=>{const i=identity(c,el('ruleSlug').value.trim()),match=el('ruleMatch').value.trim();if(!match)throw Error('请填写匹配模型名');const model=el('ruleModel').value.trim(),memory=el('ruleMemory').value,record=el('ruleRecord').value;i.models=i.models||[];i.models.push({match,...(model?{model}:{}),...(memory?{memory}:{}),...(record?{record:record==='true'}:{})})});
el('example').onclick=()=>{show({version:2,providers:{anthropic:{gateway:'default',provider:'anthropic',paths:{messages:'v1/messages'}},openai:{gateway:'default',provider:'openai'},compat:{gateway:'default',provider:'compat'}},identities:[{slug:'companion-a',namespace:'companion-a',keys:['CHATBOX_API_KEY'],provider:'anthropic',memory:'request',record:true,anthropicThinking:'passthrough',models:[{match:'*haiku*',memory:'off',record:false},{match:'anthropic/claude-opus-4-5'}]},{slug:'companion-b',namespace:'companion-b',keys:['CHATBOX_API_KEY'],provider:'openai',memory:'request',record:true,anthropicThinking:'passthrough',models:[{match:'*mini*',memory:'off',record:false}]}]});status('已填入示例草稿。线路名要和 CF AI Gateway 里的 provider 对上，模型 ID 换成你的。')};
</script></body></html>`;
