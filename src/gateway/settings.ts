import type { Env } from "../types";

// Everything here is editable from /admin/gateway, so Worker settings only needs the API key.
export interface SettingSpec { name: string; label: string; hint?: string; group: string }
export const SETTINGS: SettingSpec[] = [
  { group: "记忆召回", name: "MEMORY_FILTER_MAX_OUTPUT", label: "每次注入几条记忆", hint: "追加到消息末尾的条数，多了占上下文" },
  { group: "记忆召回", name: "MEMORY_FILTER_MAX_CONTENT_CHARS", label: "每条记忆最长字数" },
  { group: "记忆召回", name: "MEMORY_TOP_K", label: "先从向量库取多少条", hint: "取回来再交给重排模型挑" },
  { group: "记忆召回", name: "MEMORY_FILTER_MAX_CANDIDATES", label: "送进重排的条数" },
  { group: "记忆召回", name: "MEMORY_MIN_SCORE", label: "相似度下限", hint: "只当垃圾闸，精度靠重排。调高会漏掉换了说法的记忆" },
  { group: "记忆召回", name: "MEMORY_FILTER_MIN_SCORE", label: "重排前相似度下限" },
  { group: "记忆召回", name: "MEMORY_INJECT_DECAY_FACTOR", label: "刚注入过的记忆降权", hint: "30 分钟内注入过的排到队尾。填 1 关闭" },
  { group: "记忆召回", name: "MEMORY_AUTHORED_BOOST", label: "亲笔记忆加成", hint: "自己写的记忆排前面。填 1 关闭" },

  { group: "Dream 与日记", name: "DREAM_MODEL", label: "Dream 用的模型" },
  { group: "Dream 与日记", name: "DREAM_TIME_ZONE", label: "按哪个时区分天", hint: "例如 Asia/Singapore" },
  { group: "Dream 与日记", name: "DREAM_MAX_MESSAGES", label: "一轮读多少条对话" },
  { group: "Dream 与日记", name: "DREAM_MEMORY_CONTEXT_LIMIT", label: "一轮参考多少条已有记忆" },
  { group: "Dream 与日记", name: "DREAM_MAX_RUNS", label: "每天最多跑几轮" },
  { group: "Dream 与日记", name: "DREAM_MAX_TOKENS", label: "单轮输出上限" },
  { group: "Dream 与日记", name: "DEDUP_COSINE", label: "记忆去重相似度", hint: "越高越容易判成新记忆，越低越容易被合并" },
  { group: "Dream 与日记", name: "WEEKLY_ROLLUP_DELETE_DAILIES", label: "周记落成后自动删日志", hint: "填 false 走人工审阅，填 true 一条龙" },

  { group: "数据留存", name: "MESSAGES_RETENTION_DAYS", label: "原始对话保留天数", hint: "Dream 抽完记忆后，原文留几天" },

  { group: "模型与线路", name: "AI_GATEWAY_ID", label: "默认 AI Gateway ID", hint: "线路里没写 gateway 时用它" },
  { group: "模型与线路", name: "MEMORY_RERANKER_MODEL", label: "记忆重排模型" },
  { group: "模型与线路", name: "VISION_MODEL", label: "看图模型" },
  { group: "模型与线路", name: "CHAT_MODEL", label: "导盲犬入口的模型", hint: "只给 /v1/guide-dog 用，聊天走网关身份" },
  { group: "模型与线路", name: "PUBLIC_MODEL_NAME", label: "导盲犬对外显示的模型名" },

  { group: "GitHub 日档（可选）", name: "GITHUB_DAILY_REPO", label: "仓库", hint: "owner/repo；留空就是不启用" },
  { group: "GitHub 日档（可选）", name: "GITHUB_DAILY_PATH", label: "仓库里的路径", hint: "默认 archive/daily" },
  { group: "GitHub 日档（可选）", name: "GITHUB_DAILY_NAMESPACE", label: "写进哪个记忆空间" },

  { group: "高级 · 改了要重建向量库", name: "EMBEDDING_MODEL", label: "向量模型" },
  { group: "高级 · 改了要重建向量库", name: "EMBEDDING_DIMENSIONS", label: "向量维度", hint: "必须和 Vectorize 索引一致，对不上就整个召不回" },
  { group: "高级 · 改了要重建向量库", name: "VECTORIZE_INDEX_NAME", label: "Vectorize 索引名" }
];
export const SETTING_NAMES = new Set(SETTINGS.map(s => s.name));

// Credentials stay Worker Secrets; the page only reports whether they exist.
export const SECRET_SPECS: { name: string; label: string }[] = [
  { name: "CHATBOX_API_KEY", label: "主密钥（必填，客户端和本页都用它）" },
  { name: "IM_API_KEY", label: "第二个客户端密钥" },
  { name: "DEBUG_API_KEY", label: "维护密钥（跨记忆空间操作）" },
  { name: "MEMORY_MCP_API_KEY", label: "MCP 密钥" },
  { name: "GUIDE_DOG_API_KEY", label: "导盲犬密钥" },
  { name: "GATEWAY_SECRETS", label: "自定义 HTTP 上游的密钥表（JSON）" },
  { name: "CLOUDFLARE_API_TOKEN", label: "CF REST 线路 / 维护工具用" },
  { name: "GITHUB_DAILY_TOKEN", label: "GitHub 日档只读 PAT" }
];

export function validateSettings(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be an object");
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SETTING_NAMES.has(name)) throw new Error(`Unknown setting: ${name}`);
    if (typeof raw !== "string") throw new Error(`${name}: settings values must be strings`);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > 512) throw new Error(`${name}: value too long`);
    out[name] = trimmed;
  }
  return out;
}
/** Saved settings win over Worker vars; blanks fall through to the deployed defaults. */
export function applySettings(env: Env, settings: Record<string, string> | undefined): Env {
  if (!settings) return env;
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(settings)) if (SETTING_NAMES.has(name)) overrides[name] = value;
  return Object.keys(overrides).length ? { ...env, ...overrides } : env;
}
export function describeSettings(env: Env, settings: Record<string, string>) {
  const source = env as unknown as Record<string, unknown>;
  const groups: { group: string; items: unknown[] }[] = [];
  for (const spec of SETTINGS) {
    const deployed = source[spec.name];
    const group = groups.find(g => g.group === spec.group) || (groups.push({ group: spec.group, items: [] }), groups[groups.length - 1]);
    group.items.push({
      name: spec.name, label: spec.label, hint: spec.hint || "",
      value: settings[spec.name] || "",
      deployed: typeof deployed === "string" ? deployed : ""
    });
  }
  return { groups, secrets: SECRET_SPECS.map(s => ({ ...s, present: !!source[s.name] })) };
}
