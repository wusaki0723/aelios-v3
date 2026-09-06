import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wranglerTomlPath = resolve(root, "wrangler.toml");
const dbName = process.env.CMP_D1_NAME || "companion_memory_proxy";
const dbBinding = process.env.CMP_D1_BINDING || "DB";
const wranglerToml = readFileSync(wranglerTomlPath, "utf8");
function readVectorizeValue(name) {
  const match = wranglerToml.match(/\[\[vectorize\]\]([\s\S]*?)(?=\n\[|$)/);
  return match?.[1]?.match(new RegExp(`${name}\\\\s*=\\\\s*"([^"]+)"`))?.[1];
}
const vectorizeName =
  process.env.CMP_VECTORIZE_NAME || readVectorizeValue("index_name") || "memo-kb";
const vectorizeBinding =
  process.env.CMP_VECTORIZE_BINDING || readVectorizeValue("binding") || "VECTORIZE";
const vectorizeDimensions = process.env.CMP_VECTORIZE_DIMENSIONS || "1024";
const vectorizeMetric = process.env.CMP_VECTORIZE_METRIC || "cosine";
const queueName = process.env.CMP_QUEUE_NAME || "companion-memory";
// Variables that are safe to persist as visible Worker config in wrangler.toml
// [vars]. Credentials are intentionally excluded — they must be provisioned
// via `wrangler secret put <NAME>` (or the Cloudflare Dashboard) so plaintext
// secrets never land in a git-tracked file. Runtime `env.XXX` still resolves
// secrets the same way regardless of whether they live in [vars] or secrets.
const visibleVarNames = [
  "AI_GATEWAY_BASE_URL",
  "CHAT_MODEL",
  "VECTORIZE_INDEX_NAME",
  "ENABLE_MEMORY_RERANKER",
  "MEMORY_RERANKER_MODEL",
  "MEMORY_FILTER_MAX_CANDIDATES",
  "MEMORY_FILTER_MAX_OUTPUT",
  "MEMORY_FILTER_MAX_CONTENT_CHARS",
  "MEMORY_FILTER_MIN_SCORE",
  "DREAM_MODEL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "VISION_MODEL",
  "MEMORY_MIN_SCORE",
  "MEMORY_TOP_K",
  "DREAM_NAMESPACE",
  "DREAM_TIME_ZONE",
  "DREAM_MAX_MESSAGES",
  "DREAM_MAX_RUNS",
  "DREAM_MAX_TOKENS",
  "DREAM_MEMORY_CONTEXT_LIMIT",
  "DEDUP_COSINE",
  "ANTHROPIC_THINKING_ENABLED",
  "ANTHROPIC_THINKING_BUDGET",
  "ANTHROPIC_CACHE_ENABLED",
  "ANTHROPIC_AUTO_CACHE_ENABLED",
  "ANTHROPIC_ROLLING_CACHE_ENABLED",
  "ANTHROPIC_ROLLING_CACHE_WINDOW_SIZE",
  "ANTHROPIC_CACHE_TTL",
  "CUSTOM_ANTHROPIC_MESSAGES_PATH"
];

function run(args, options = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1"
    },
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (options.allowFailure) return result;

  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed`);
  }

  return result;
}

function runJson(args) {
  const result = run(args, { capture: true });
  return JSON.parse(result.stdout);
}

function findDatabase(databases) {
  if (!Array.isArray(databases)) return null;

  return databases.find((database) => {
    if (!database || typeof database !== "object") return false;
    return database.name === dbName || database.database_name === dbName;
  });
}

function getDatabaseId(database) {
  if (!database || typeof database !== "object") return null;
  return database.uuid || database.id || database.database_id || null;
}

function removeTomlArrayBlocks(toml, blockName) {
  const lines = toml.split("\n");
  const output = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === `[[${blockName}]]`) {
      skipping = true;
      continue;
    }

    if (skipping && line.startsWith("[") && line.trim() !== `[[${blockName}]]`) {
      skipping = false;
    }

    if (!skipping) output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function upsertD1Binding(databaseId) {
  const block = [
    "[[d1_databases]]",
    `binding = "${dbBinding}"`,
    `database_name = "${dbName}"`,
    `database_id = "${databaseId}"`,
    ""
  ].join("\n");

  let toml = readFileSync(wranglerTomlPath, "utf8");
  toml = removeTomlArrayBlocks(toml, "d1_databases").trimEnd();
  writeFileSync(wranglerTomlPath, `${toml}\n\n${block}`);
}

function ensureVectorizeBinding() {
  let toml = readFileSync(wranglerTomlPath, "utf8");
  if (toml.includes(`binding = "${vectorizeBinding}"`) && toml.includes(`index_name = "${vectorizeName}"`)) {
    return;
  }

  const block = [
    "",
    "[[vectorize]]",
    `binding = "${vectorizeBinding}"`,
    `index_name = "${vectorizeName}"`,
    ""
  ].join("\n");

  toml = removeTomlArrayBlocks(toml, "vectorize").trimEnd();
  writeFileSync(wranglerTomlPath, `${toml}${block}`);
}

function ensureD1() {
  console.log(`\nChecking D1 database: ${dbName}`);
  let databases = runJson(["d1", "list", "--json"]);
  let database = findDatabase(databases);

  if (!database) {
    console.log(`Creating D1 database: ${dbName}`);
    run(["d1", "create", dbName, "--binding", dbBinding, "--update-config", "--use-remote"], {
      allowFailure: true
    });
    databases = runJson(["d1", "list", "--json"]);
    database = findDatabase(databases);
  }

  const databaseId = getDatabaseId(database);
  if (!databaseId) {
    throw new Error(`Could not find D1 database id for ${dbName}`);
  }

  upsertD1Binding(databaseId);
  console.log(`D1 binding ready: ${dbBinding} -> ${dbName}`);

  console.log("Applying D1 migrations");
  run(["d1", "migrations", "apply", dbName, "--remote"]);
}

function ensureVectorize() {
  console.log(`\nEnsuring Vectorize index: ${vectorizeName}`);

  // 维度闸：Deploy 按钮等外部流程可能已按默认参数预开了同名索引。
  // 维度/度量不对的索引整个记忆管线都接不上，而且创建后改不了——
  // 空的就删掉重建，有数据的只能人来决定，报清楚原因后拒绝继续。
  const existing = run(["vectorize", "get", vectorizeName, "--json"], {
    allowFailure: true,
    capture: true
  });
  if (existing.status === 0) {
    let config = null;
    try {
      config = JSON.parse(existing.stdout);
    } catch {
      // 输出不是 JSON（老版 wrangler 等），闸退化为原来的 create-if-missing 行为。
    }
    const dims = config?.config?.dimensions ?? config?.dimensions;
    const metric = config?.config?.metric ?? config?.metric;
    const mismatch =
      (dims !== undefined && String(dims) !== String(vectorizeDimensions)) ||
      (metric !== undefined && metric !== vectorizeMetric);
    if (mismatch) {
      const info = run(["vectorize", "info", vectorizeName, "--json"], {
        allowFailure: true,
        capture: true
      });
      let vectorCount = null;
      try {
        const parsed = JSON.parse(info.stdout);
        vectorCount = parsed?.vectorCount ?? parsed?.vectorsCount ?? null;
      } catch {
        // 拿不到数量就当有数据，宁可停下也不误删。
      }
      if (vectorCount === 0) {
        console.log(
          `Vectorize index ${vectorizeName} has wrong config (dimensions=${dims}, metric=${metric}) but is empty; recreating with ${vectorizeDimensions}/${vectorizeMetric}`
        );
        run(["vectorize", "delete", vectorizeName, "--force"]);
      } else {
        throw new Error(
          `Vectorize index "${vectorizeName}" exists with dimensions=${dims}, metric=${metric}, ` +
            `but this app needs ${vectorizeDimensions}/${vectorizeMetric}. The index already holds data ` +
            `(vectorCount=${vectorCount ?? "unknown"}), so it will not be deleted automatically. ` +
            `Delete it yourself (wrangler vectorize delete ${vectorizeName}) or set CMP_VECTORIZE_NAME to use a different index, then redeploy.`
        );
      }
    }
  }

  run(
    [
      "vectorize",
      "create",
      vectorizeName,
      `--dimensions=${vectorizeDimensions}`,
      `--metric=${vectorizeMetric}`,
      "--binding",
      vectorizeBinding,
      "--update-config",
      "--use-remote"
    ],
    { allowFailure: true }
  );

  ensureVectorizeBinding();

  // v2: kind 区分 memory | precious | longtail (母帖 #11 第 1 步)。
  // 没有这个 metadata index，按 kind 过滤会全表扫，接不上召回管线。
  const indexes = [
    ["namespace", "string"],
    ["status", "string"],
    ["type", "string"],
    ["pinned", "boolean"],
    ["kind", "string"]
  ];

  for (const [propertyName, type] of indexes) {
    run(
      [
        "vectorize",
        "create-metadata-index",
        vectorizeName,
        `--propertyName=${propertyName}`,
        `--type=${type}`
      ],
      { allowFailure: true }
    );
  }
}

function ensureQueue() {
  console.log(`\nEnsuring Queue: ${queueName}`);
  run(["queues", "create", queueName], { allowFailure: true });
}

function escapeTomlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function ensureVarsHeader(toml) {
  if (toml.includes("[vars]")) return toml;
  return `${toml.trimEnd()}\n\n[vars]\n`;
}

function upsertVarFromEnvironment(name, value) {
  let toml = readFileSync(wranglerTomlPath, "utf8");
  const escaped = escapeTomlString(value);

  if (new RegExp(`^${name}\\s*=`, "m").test(toml)) {
    toml = toml.replace(new RegExp(`^${name}\\s*=\\s*"[^"]*"`, "m"), `${name} = "${escaped}"`);
  } else {
    toml = ensureVarsHeader(toml).replace("[vars]\n", `[vars]\n${name} = "${escaped}"\n`);
  }

  writeFileSync(wranglerTomlPath, toml);
}

function ensureVisibleVars() {
  let changed = 0;

  for (const name of visibleVarNames) {
    const value = process.env[name] || (name === "AI_GATEWAY_BASE_URL" ? process.env.CMP_AI_GATEWAY_BASE_URL : "");
    if (!value) continue;
    upsertVarFromEnvironment(name, value);
    changed += 1;
  }

  if (changed > 0) {
    console.log(`\nVisible Worker variables synced from Cloudflare build env: ${changed}`);
  } else {
    console.log("\nNo visible Worker variables found in build env; leaving wrangler.toml values unchanged.");
  }
}

// CLOUDFLARE_ACCOUNT_ID 不该让人手填：Workers Builds 构建环境本来就带着它，
// 本地部署时 wrangler 登录态里也有。部署时自动写进 [vars]，
// 运行时要用它的功能（Vectorize 对账等维护工具）就直接可用。
function detectAccountId() {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  const who = run(["whoami"], { allowFailure: true, capture: true });
  if (who.status !== 0 || !who.stdout) return null;
  const ids = [...new Set(who.stdout.match(/\b[0-9a-f]{32}\b/g) || [])];
  // 多账号时猜不得，宁可不填。
  return ids.length === 1 ? ids[0] : null;
}

function ensureAccountIdVar() {
  const accountId = detectAccountId();
  if (!accountId) {
    console.log(
      "\nCLOUDFLARE_ACCOUNT_ID not auto-detected (no login or multiple accounts); skipping. Maintenance tools that need it can be configured later in the Dashboard."
    );
    return;
  }
  upsertVarFromEnvironment("CLOUDFLARE_ACCOUNT_ID", accountId);
  console.log(`\nCLOUDFLARE_ACCOUNT_ID auto-filled into [vars] from the deploy environment.`);
}

ensureVisibleVars();
ensureAccountIdVar();
ensureD1();
ensureVectorize();
ensureQueue();

console.log("\nCloudflare resources are ready.");
