import { mkdir, readFile, writeFile } from "node:fs/promises";

const workerBase = (process.env.AELIOS_BASE_URL || process.env.WORKER_BASE_URL || "").replace(/\/+$/, "");
const apiKey = process.env.AELIOS_API_KEY || process.env.CHATBOX_API_KEY || process.env.MEMORY_MCP_API_KEY;
const cleanupOpenAIBase = normalizeOpenAIBase(
  process.env.CLEANUP_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || ""
);
const cleanupApiKey = process.env.CLEANUP_API_KEY || process.env.OPENAI_API_KEY;
const gatewayBase = normalizeGatewayBase(process.env.AI_GATEWAY_BASE_URL || "");
const gatewayToken = process.env.CF_AIG_TOKEN || process.env.AI_GATEWAY_TOKEN;
const model = process.env.CLEANUP_MODEL || "deepseek/deepseek-v4-flash";
const outputDir = process.env.CLEANUP_OUTPUT_DIR || "backups";
const minChars = Number(process.env.CLEANUP_MIN_CHARS || 900);
const maxRecordsPerBatch = Number(process.env.CLEANUP_BATCH_SIZE || 3);
const maxBatches = readArgNumber("--limit-batches", Infinity);
const modelTries = Number(process.env.CLEANUP_MODEL_TRIES || 3);
const modelTimeoutMs = Number(process.env.CLEANUP_MODEL_TIMEOUT_MS || 90000);
const modelMaxTokens = Number(process.env.CLEANUP_MODEL_MAX_TOKENS || 8000);
const cleanupConcurrency = Math.max(1, Math.min(8, Number(process.env.CLEANUP_CONCURRENCY || 1)));
const cleanupScope = process.env.CLEANUP_SCOPE || (process.argv.includes("--all") ? "all" : "candidates");
const apply = process.argv.includes("--apply");
const allowPartial = process.argv.includes("--allow-partial");
const applyPlanPath = readArgValue("--apply-plan");
const retryErrorsPath = readArgValue("--retry-errors");

if (!workerBase || !apiKey) {
  console.error("Missing AELIOS_BASE_URL and AELIOS_API_KEY.");
  process.exit(1);
}

if (!applyPlanPath && !cleanupOpenAIBase && !gatewayBase) {
  console.error("Missing CLEANUP_OPENAI_BASE_URL or AI_GATEWAY_BASE_URL.");
  process.exit(1);
}

if (!applyPlanPath && cleanupOpenAIBase && !cleanupApiKey) {
  console.error("Missing CLEANUP_API_KEY or OPENAI_API_KEY.");
  process.exit(1);
}

if (!applyPlanPath && !cleanupOpenAIBase && (!gatewayBase || !gatewayToken)) {
  console.error("Missing AI_GATEWAY_BASE_URL and CF_AIG_TOKEN.");
  process.exit(1);
}

function normalizeOpenAIBase(value) {
  return String(value || "")
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
}

function normalizeGatewayBase(value) {
  return String(value || "")
    .replace(/\/+$/, "")
    .replace(/\/compat\/chat\/completions$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/compat$/, "");
}

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

function readArgNumber(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}, tries = 4) {
  let last = "";
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.ok) {
      return text ? JSON.parse(text) : {};
    }
    last = `${response.status}: ${text.slice(0, 500)}`;
    await sleep(800 * (attempt + 1));
  }
  throw new Error(last);
}

async function aelios(path, init = {}) {
  return fetchJson(`${workerBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
}

async function listMemories() {
  const memories = [];
  let cursor = null;

  for (;;) {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const page = await aelios(`/v1/memory?${params}`);
    memories.push(...(page.data || []));
    cursor = page.paging?.cursor || null;
    if (!page.paging?.has_more || !cursor) break;
  }

  return memories;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。.!！?？；;：:“”"'`、\[\]【】（）()<>《》#*_~\-]/g, "");
}

function textShingles(text) {
  const normalized = normalizeText(text);
  const size = normalized.length > 80 ? 3 : 2;
  const shingles = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    shingles.add(normalized.slice(index, index + size));
  }
  return shingles;
}

function overlapSize(left, right) {
  let count = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const item of small) {
    if (large.has(item)) count += 1;
  }
  return count;
}

function relatedScore(left, right) {
  const leftText = normalizeText(left.content);
  const rightText = normalizeText(right.content);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = leftText.length > rightText.length ? leftText : rightText;
  if (shorter.length >= 24 && longer.includes(shorter)) return Math.min(0.98, shorter.length / longer.length + 0.35);

  const leftSet = left._shingles || textShingles(left.content);
  const rightSet = right._shingles || textShingles(right.content);
  if (!leftSet.size || !rightSet.size) return 0;
  const overlap = overlapSize(leftSet, rightSet);
  const union = leftSet.size + rightSet.size - overlap;
  const jaccard = union ? overlap / union : 0;
  const containment = overlap / Math.min(leftSet.size, rightSet.size);
  const sameTheme = themeOf(left) === themeOf(right);
  const sameType = left.type && left.type === right.type;
  const tagOverlap = Array.isArray(left.tags) && Array.isArray(right.tags) && left.tags.some((tag) => right.tags.includes(tag));
  const boost = sameTheme || sameType || tagOverlap ? 1 : 0.72;
  return Math.max(jaccard, containment * 0.82) * boost;
}

function themeOf(memory) {
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  const theme = tags.find((tag) => tag.startsWith("theme-"));
  if (theme) return theme;
  if (tags.includes("project") || memory.type === "project") return "theme-project";
  if (tags.includes("play") || tags.includes("xp")) return "theme-play";
  if (tags.includes("health") || memory.type === "health" || memory.type === "medication") return "theme-health";
  if (tags.includes("relationship") || memory.type === "relationship") return "theme-relationship";
  return "theme-misc";
}

function isCleanupCandidate(memory) {
  return cleanupScope === "all" ? isScannableMemory(memory) : isLongCleanupCandidate(memory);
}

function isScannableMemory(memory) {
  const content = String(memory.content || "");
  if (memory.pinned) return false;
  return content.trim().length > 0;
}

function isLongCleanupCandidate(memory) {
  const content = String(memory.content || "");
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  if (memory.pinned) return false;
  if (memory.source === "daily_digest" && content.length < minChars) return false;
  if (content.length >= minChars) return true;
  if (tags.includes("summary") && content.length >= 500) return true;
  if (tags.some((tag) => tag === "source" || /原文/.test(tag)) && content.length >= 500) return true;
  if (memory.type === "diary" && content.length >= 700) return true;
  return false;
}

function buildBatches(memories) {
  if (cleanupScope === "all") return buildRelatedBatches(memories).slice(0, maxBatches);

  const groups = new Map();
  for (const memory of memories.filter(isCleanupCandidate)) {
    const key = themeOf(memory);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(memory);
  }

  const batches = [];
  for (const [theme, records] of groups) {
    const sorted = [...records].sort((a, b) => {
      const sourceCmp = String(a.source || "").localeCompare(String(b.source || ""));
      if (sourceCmp !== 0) return sourceCmp;
      return String(a.updated_at || "").localeCompare(String(b.updated_at || ""));
    });

    for (let index = 0; index < sorted.length; index += maxRecordsPerBatch) {
      batches.push({
        theme,
        records: sorted.slice(index, index + maxRecordsPerBatch)
      });
    }
  }

  return batches.slice(0, maxBatches);
}

function buildRelatedBatches(memories) {
  const records = memories.filter(isScannableMemory).map((memory) => ({
    ...memory,
    _theme: themeOf(memory),
    _shingles: textShingles(memory.content)
  }));
  const used = new Set();
  const batches = [];
  const sorted = [...records].sort((a, b) => {
    const longDiff = Number(isLongCleanupCandidate(b)) - Number(isLongCleanupCandidate(a));
    if (longDiff !== 0) return longDiff;
    const themeCmp = a._theme.localeCompare(b._theme);
    if (themeCmp !== 0) return themeCmp;
    return String(a.updated_at || "").localeCompare(String(b.updated_at || ""));
  });

  for (const record of sorted) {
    if (used.has(record.id)) continue;
    const neighbors = records
      .filter((candidate) => candidate.id !== record.id && !used.has(candidate.id))
      .map((candidate) => ({ candidate, score: relatedScore(record, candidate) }))
      .filter(({ candidate, score }) => {
        if (score >= 0.46) return true;
        return record._theme === candidate._theme && score >= 0.38;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxRecordsPerBatch - 1)
      .map(({ candidate }) => candidate);

    if (!isLongCleanupCandidate(record) && neighbors.length === 0) continue;
    const batchRecords = [record, ...neighbors].map(({ _theme, _shingles, ...memory }) => memory);
    for (const item of batchRecords) used.add(item.id);
    batches.push({ theme: record._theme, records: batchRecords });
  }

  return batches;
}

async function buildRetryBatches(memories, reportPath) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  return (report.errors || []).flatMap((error) => {
    const records = (error.input_ids || []).flatMap((id) => {
      const memory = memoryById.get(id);
      return memory ? [memory] : [];
    });
    return records.length ? [{ theme: error.theme || themeOf(records[0]), records }] : [];
  }).slice(0, maxBatches);
}

function buildPrompt(batch) {
  const records = batch.records.map((record) => ({
    id: record.id,
    type: record.type,
    source: record.source,
    importance: record.importance,
    tags: record.tags,
    content: record.content
  }));

  return [
    "你是长期记忆库清洗员。你的任务是把旧的长块、多主题块、重复块整理成更小、更稳定、更可检索的长期记忆。",
    "只输出完整可解析 JSON，不要 markdown，不要解释。宁可少写，也不要输出被截断的 JSON。",
    "",
    "清洗规则：",
    "- 不要新增输入里没有的事实。",
    "- 每条输入旧记忆都必须有去向：重写/合并进 replacements，或者放入 keep_ids。",
    "- 如果旧记忆已经短、稳定、单主题、没有明显重复，就不要改写，直接放入 keep_ids。",
    "- 目标是主题压缩，不是切碎。只有跨主题、跨时期、跨关系/项目边界时才拆分。",
    "- 同一观点链、同一段关系状态、同一个项目阶段、同一类偏好可以合并成一条完整记忆。",
    "- 类似内容合并成一条，不要保留同义重复；不要把一个完整观点拆成好几条近邻记忆。",
    "- 如果同批里混有不同主题，不要因为主主题更明显就丢掉次主题；关系、偏好、健康、项目状态各自应有承接。",
    "- 删除临时调试、实现细节噪音、过期流水账、过宽泛的总结标题。",
    "- 普通长期记忆用第二人称写：关于用户用“你……”，关于助手承诺用“我……”。",
    "- 助手角色统一写作“旦九”；不要写“小克”“助手”“AI”。",
    "- 如果旧记忆里已经带有原文、原对话、引用段、对话摘录，就把那一小段原文单独切出来保存为 type=excerpt。",
    "- excerpt 是原文 chunk，不是金句摘抄；不要只挑最有代表性的一句，不要改写，不要概括。",
    "- excerpt 可以保留一整小段对话。只有明显超过 800 个汉字时，才按自然段切成更短 excerpt。",
    "- excerpt 加 tags: [\"original-dialogue\"]，前缀使用“咲咲/旦九对话原文：”或“咲咲原话：”“旦九原话：”；不要写“用户原话”或“助手原话”。",
    "- note 通常 80-180 个汉字，可以容纳一个完整观点链，但不要写成流水账。",
    "- 每批最多输出 6 条 replacements；一般 3 条旧记忆整理成 1-3 条 note，再加必要的原文 excerpt。",
    "- 不要提到 Vectorize、D1、RAG、embedding、数据库等后端实现，除非原记忆本身是在记录 Aelios 项目。",
    "",
    "输出 JSON 结构：",
    JSON.stringify({
      replacements: [
        {
          content: "短而稳定的新记忆",
          type: "note",
          importance: 0.72,
          confidence: 0.86,
          tags: ["theme-example"],
          source_ids: ["old_id"]
        },
        {
          content: "咲咲/旦九对话原文：\n咲咲：原文小段\n旦九：原文小段",
          type: "excerpt",
          importance: 0.8,
          confidence: 0.9,
          tags: ["original-dialogue", "theme-example"],
          source_ids: ["old_id"]
        }
      ],
      delete_ids: ["old_id"],
      keep_ids: ["old_id"],
      notes: "极短说明"
    }),
    "",
    `本批主题：${batch.theme}`,
    "待清洗旧记忆：",
    JSON.stringify(records)
  ].join("\n");
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap JSON.
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callCleanupModel(batch) {
  let lastError = "";
  let lastRaw = null;

  for (let attempt = 0; attempt < modelTries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), modelTimeoutMs);

    try {
      const response = await fetch(cleanupOpenAIBase ? `${cleanupOpenAIBase}/chat/completions` : `${gatewayBase}/compat/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cleanupOpenAIBase
            ? { authorization: `Bearer ${cleanupApiKey}` }
            : { "cf-aig-authorization": `Bearer ${gatewayToken}` })
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "你是严格 JSON 生成器。只输出 JSON。" },
            { role: "user", content: buildPrompt(batch) }
          ],
          temperature: 0,
          max_tokens: modelMaxTokens,
          response_format: { type: "json_object" },
          enable_thinking: false,
          stream: false
        })
      });

      const raw = await response.text();
      if (!response.ok) {
        lastError = `${response.status}: ${raw.slice(0, 500)}`;
        lastRaw = raw.slice(0, 1200);
        await sleep(/429|rate limit|queued/i.test(raw) ? 5000 * (attempt + 1) : 1000 * (attempt + 1));
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastError = `invalid upstream json: ${raw.slice(0, 500)}`;
        lastRaw = raw.slice(0, 1200);
        await sleep(1000 * (attempt + 1));
        continue;
      }

      const message = parsed.choices?.[0]?.message;
      const content = typeof message?.content === "string" ? message.content.trim() : "";
      const reasoningContent = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
      const reasoning = typeof message?.reasoning === "string" ? message.reasoning.trim() : "";
      const thinking = typeof message?.thinking === "string" ? message.thinking.trim() : "";
      const result = extractJson(content || reasoningContent || reasoning || thinking);
      if (result) return { ok: true, result, usage: parsed.usage };

      lastError = "empty_or_invalid_model_output";
      lastRaw = JSON.stringify(parsed).slice(0, 1200);
      await sleep(1000 * (attempt + 1));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, error: lastError, raw: lastRaw };
}

function normalizeReplacementContent(content, type) {
  const normalized = content.replace(/小克/g, "旦九");
  if (type !== "excerpt") return normalized;
  return normalized
    .replace(/用户原话[：:]/g, "咲咲原话：")
    .replace(/助手原话[：:]/g, "旦九原话：")
    .replace(/用户[：:]/g, "咲咲：")
    .replace(/助手[：:]/g, "旦九：")
    .replace(/User[：:]/gi, "咲咲原话：")
    .replace(/Assistant[：:]/gi, "旦九原话：");
}

function normalizePlan(batch, output) {
  const inputIds = new Set(batch.records.map((record) => record.id));
  const replacements = Array.isArray(output.replacements)
    ? output.replacements.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const type = typeof item.type === "string" && item.type.trim() ? item.type.trim() : "note";
        const content = normalizeReplacementContent(typeof item.content === "string" ? item.content.trim() : "", type);
        if (content.length < 8) return [];
        const tags = Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string" && tag.trim()) : [batch.theme];
        if (type === "excerpt" && !tags.includes("original-dialogue")) tags.push("original-dialogue");
        const sourceIds = Array.isArray(item.source_ids)
          ? item.source_ids.filter((id) => typeof id === "string" && inputIds.has(id))
          : [];
        return [
          {
            content,
            type,
            importance: typeof item.importance === "number" ? Math.min(Math.max(item.importance, 0), 1) : 0.65,
            confidence: typeof item.confidence === "number" ? Math.min(Math.max(item.confidence, 0), 1) : 0.82,
            tags,
            source_ids: sourceIds.length ? sourceIds : batch.records.map((record) => record.id)
          }
        ];
      })
    : [];

  const deleteIds = Array.isArray(output.delete_ids)
    ? output.delete_ids.filter((id) => typeof id === "string" && inputIds.has(id))
    : [];
  const keepIds = Array.isArray(output.keep_ids)
    ? output.keep_ids.filter((id) => typeof id === "string" && inputIds.has(id))
    : [];
  const coveredIds = new Set(replacements.flatMap((item) => item.source_ids));
  const safeDeleteIds = deleteIds.filter((id) => coveredIds.has(id));
  const protectedKeepIds = deleteIds.filter((id) => !coveredIds.has(id));
  const resolvedIds = new Set([...coveredIds, ...safeDeleteIds, ...keepIds, ...protectedKeepIds]);
  const autoKeepIds = batch.records.map((record) => record.id).filter((id) => !resolvedIds.has(id));

  return {
    theme: batch.theme,
    input_ids: batch.records.map((record) => record.id),
    replacements,
    delete_ids: [...new Set(safeDeleteIds)],
    keep_ids: [...new Set([...keepIds, ...protectedKeepIds, ...autoKeepIds])],
    notes: typeof output.notes === "string" ? output.notes : ""
  };
}

async function applyPlan(plans) {
  const created = [];
  const deleted = [];

  for (const plan of plans) {
    for (const replacement of plan.replacements) {
      const response = await aelios("/v1/memory", {
        method: "POST",
        body: JSON.stringify({
          type: replacement.type,
          content: replacement.content,
          importance: replacement.importance,
          confidence: replacement.confidence,
          tags: [...new Set(["llm-cleanup", plan.theme, ...replacement.tags])],
          source: "llm_memory_cleanup",
          source_message_ids: replacement.source_ids
        })
      });
      created.push(response.data);
      await sleep(250);
    }
  }

  const deleteIds = [...new Set(plans.flatMap((plan) => plan.delete_ids))];
  for (const id of deleteIds) {
    await aelios(`/v1/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
    deleted.push(id);
    await sleep(250);
  }

  return { created_count: created.length, deleted_count: deleted.length, created, deleted };
}

async function processBatch(batch, index, total) {
  console.log(`cleaning batch ${index + 1}/${total}: ${batch.theme} (${batch.records.length} records)`);
  const output = await callCleanupModel(batch);
  if (!output.ok) {
    return {
      error: {
        batch: index + 1,
        theme: batch.theme,
        input_ids: batch.records.map((record) => record.id),
        error: output.error,
        raw: output.raw
      }
    };
  }
  return {
    plan: normalizePlan(batch, output.result),
    usage: output.usage || {}
  };
}

async function runBatches(batches) {
  const results = new Array(batches.length);
  let nextIndex = 0;
  const workerCount = Math.min(cleanupConcurrency, Math.max(batches.length, 1));
  const delayMs = Number(process.env.CLEANUP_BATCH_DELAY_MS || 1200);

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batches.length) return;
      results[index] = await processBatch(batches[index], index, batches.length);
      await sleep(delayMs);
    }
  });

  await Promise.all(workers);
  return results.filter(Boolean);
}

await mkdir(outputDir, { recursive: true });

if (applyPlanPath) {
  const report = JSON.parse(await readFile(applyPlanPath, "utf8"));
  if (!Array.isArray(report.plans)) {
    throw new Error(`Plan file has no plans array: ${applyPlanPath}`);
  }
  if (Array.isArray(report.errors) && report.errors.length && !allowPartial) {
    throw new Error(`Plan has ${report.errors.length} failed batches. Re-run with --allow-partial if you still want to apply it.`);
  }
  const applyResult = await applyPlan(report.plans);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const applyPath = `${outputDir}/llm-clean-vectorize-apply-${timestamp}.json`;
  await writeFile(applyPath, JSON.stringify(applyResult, null, 2));
  console.log(JSON.stringify({ applyPath, ...applyResult }, null, 2));
  process.exit(0);
}

const memories = await listMemories();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${outputDir}/llm-clean-vectorize-backup-${timestamp}.json`;
await writeFile(backupPath, JSON.stringify({ exported_at: new Date().toISOString(), memories }, null, 2));

const batches = retryErrorsPath ? await buildRetryBatches(memories, retryErrorsPath) : buildBatches(memories);
const exactDuplicateGroups = new Map();
for (const memory of memories) {
  const normalized = normalizeText(memory.content);
  if (!normalized) continue;
  if (!exactDuplicateGroups.has(normalized)) exactDuplicateGroups.set(normalized, []);
  exactDuplicateGroups.get(normalized).push(memory.id);
}

const batchResults = await runBatches(batches);
const plans = batchResults.flatMap((result) => (result.plan ? [result.plan] : []));
const errors = batchResults.flatMap((result) => (result.error ? [result.error] : []));
let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

for (const result of batchResults) {
  const itemUsage = result.usage || {};
  usage.prompt_tokens += itemUsage.prompt_tokens || itemUsage.input_tokens || 0;
  usage.completion_tokens += itemUsage.completion_tokens || itemUsage.output_tokens || 0;
  usage.total_tokens += itemUsage.total_tokens || 0;
}

const exactDuplicateDeletes = [...exactDuplicateGroups.values()]
  .filter((ids) => ids.length > 1)
  .map((ids) => ({ keep: ids[0], delete_ids: ids.slice(1) }));

const report = {
  created_at: new Date().toISOString(),
  apply,
  model,
  workerBase,
  cleanup_scope: cleanupScope,
  cleanup_concurrency: cleanupConcurrency,
  retry_errors_from: retryErrorsPath || null,
  total_memories: memories.length,
  candidate_count: memories.filter(isCleanupCandidate).length,
  batch_count: batches.length,
  backup: backupPath,
  exact_duplicate_groups: exactDuplicateDeletes,
  errors,
  usage,
  plan_summary: {
    replacement_count: plans.reduce((sum, plan) => sum + plan.replacements.length, 0),
    excerpt_count: plans.reduce((sum, plan) => sum + plan.replacements.filter((item) => item.type === "excerpt").length, 0),
    delete_count: new Set(plans.flatMap((plan) => plan.delete_ids)).size,
    keep_count: new Set(plans.flatMap((plan) => plan.keep_ids)).size,
    resolved_input_count: new Set(plans.flatMap((plan) => [...plan.delete_ids, ...plan.keep_ids, ...plan.replacements.flatMap((item) => item.source_ids)])).size
  },
  plans
};

const reportPath = `${outputDir}/llm-clean-vectorize-plan-${timestamp}.json`;
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, backupPath, ...report.plan_summary, errors: errors.length, usage }, null, 2));

if (apply) {
  if (errors.length && !allowPartial) {
    throw new Error(`Generated plan has ${errors.length} failed batches. Re-run with --allow-partial if you still want to apply it.`);
  }
  const applyResult = await applyPlan(plans);
  const applyPath = `${outputDir}/llm-clean-vectorize-apply-${timestamp}.json`;
  await writeFile(applyPath, JSON.stringify(applyResult, null, 2));
  console.log(JSON.stringify({ applyPath, ...applyResult }, null, 2));
}
