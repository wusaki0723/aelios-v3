#!/usr/bin/env node
/**
 * #35 周块附带的行为测试。
 *
 * 覆盖四条约束：
 *   1. 命中按事实时间归到 ISO 周，同周聚成一块，seed_ids 记全。
 *   2. 闸三延伸：被降权的种子不带它的周（weekly_log 没有 last_injected_at 列，
 *      工单又定了不动 schema，所以周块跟着种子走）。
 *   3. 与 boot 去重靠调用方传 exclude_weeks；这里默认一周都不剔。
 *      （第一版在这儿写死"剔掉最近一周"，2026-08-07 生产验收当场打脸，见第 3 项。）
 *   4. 隔离不变量：周块不进 hits、不 embed、不查向量。
 *
 * Run:  npx tsx scripts/verify-week-blocks.mjs
 * Exit 0 = all checks passed, exit 1 = failure.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { collectWeekBlocks } from "../src/memory/v2/recall.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NS = "default";

// --- 假 D1：只认这两条 SQL 形状，别的一律炸，免得测试悄悄跑偏 ---
function fakeDb(weeklyRows) {
  return {
    prepare(sql) {
      const isList = sql.includes("ORDER BY week DESC");
      const isGet = sql.includes("AND week = ?");
      if (!isList && !isGet) {
        throw new Error(`unexpected SQL in week-block path:\n${sql}`);
      }
      return {
        bind(...args) {
          return {
            async all() {
              const limit = args[1];
              const sorted = [...weeklyRows].sort((a, b) => b.week.localeCompare(a.week));
              return { results: sorted.slice(0, limit) };
            },
            async first() {
              const week = args[1];
              return weeklyRows.find((r) => r.week === week) ?? null;
            }
          };
        }
      };
    }
  };
}

function hit(id) {
  return {
    id,
    content: `content-${id}`,
    type: "event",
    score: 0.5,
    source_layer: "memory",
    source: "extract",
    backed: true,
    kind: "memory"
  };
}

function weekRow(week, start, end, title) {
  return {
    namespace: NS,
    week,
    start_date: start,
    end_date: end,
    title,
    summary: `${title} 的摘要`,
    source_days: 7,
    updated_at: "2026-08-01T00:00:00.000Z"
  };
}

// 三周素材。W32 是表里最新的一周，默认应当照常出块（第 3 项钉这条）。
const ROWS = [
  weekRow("2026-W30", "2026-07-20", "2026-07-26", "第三十周"),
  weekRow("2026-W31", "2026-07-27", "2026-08-02", "第三十一周"),
  weekRow("2026-W32", "2026-08-03", "2026-08-09", "第三十二周")
];

const baseEnv = { DB: fakeDb(ROWS), DREAM_TIME_ZONE: "Asia/Shanghai" };
let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}

// --- 1. 分组 + seed_ids ---
{
  const blocks = await collectWeekBlocks(baseEnv, {
    namespace: NS,
    hits: [hit("a"), hit("b"), hit("c")],
    timeByMemoryId: new Map([
      ["a", "2026-07-28T10:00:00+08:00"], // W31
      ["b", "2026-07-30T22:00:00+08:00"], // W31
      ["c", "2026-07-22T09:00:00+08:00"]  // W30
    ]),
    decayedIds: new Set()
  });
  assert.equal(blocks.length, 2, "两周应各出一块");
  const w31 = blocks.find((b) => b.week === "2026-W31");
  const w30 = blocks.find((b) => b.week === "2026-W30");
  assert.ok(w31 && w30, "W30 / W31 都该在");
  assert.deepEqual(w31.seed_ids.sort(), ["a", "b"], "W31 的种子是 a、b");
  assert.deepEqual(w30.seed_ids, ["c"], "W30 的种子是 c");
  assert.equal(w31.start_date, "2026-07-27");
  assert.equal(w31.end_date, "2026-08-02");
  assert.equal(blocks[0].week, "2026-W31", "命中多的周排前面");
  pass("命中按 ISO 周聚块，seed_ids 与起止日期正确，命中多的周排前");
}

// --- 2. 闸三延伸：降权的种子不带周 ---
{
  const blocks = await collectWeekBlocks(baseEnv, {
    namespace: NS,
    hits: [hit("a"), hit("c")],
    timeByMemoryId: new Map([
      ["a", "2026-07-28T10:00:00+08:00"], // W31
      ["c", "2026-07-22T09:00:00+08:00"]  // W30
    ]),
    decayedIds: new Set(["a"])
  });
  assert.deepEqual(blocks.map((b) => b.week), ["2026-W30"], "被降权的 a 不该带出 W31");
  pass("闸三延伸：近期注入过的种子不再带它那一周");
}

// --- 3. 回归：默认不许剔掉最近一周 ---
// 2026-08-07 生产验收踩的坑：第一版在这儿写死"剔掉最近一周，因为 boot 恒带它"。
// 但 weekly_log 的滚动落后当前日期一两周，"最近一周"往往正是命中最密的那一周，
// 而 hook 走的 /v1/memory/recall 根本不调 boot。结果最有用的块被白扔。
{
  const blocks = await collectWeekBlocks(baseEnv, {
    namespace: NS,
    hits: [hit("d")],
    timeByMemoryId: new Map([["d", "2026-08-05T12:00:00+08:00"]]), // W32 = 表里最新的一周
    decayedIds: new Set()
  });
  assert.deepEqual(
    blocks.map((b) => b.week),
    ["2026-W32"],
    "没传 exclude_weeks 就不许自作主张剔掉最近一周"
  );
  pass("回归：默认不剔最近一周（去重责任在调用方，不在这里猜）");
}

// --- 4. exclude_weeks：调用方点名的周才剔 ---
{
  const blocks = await collectWeekBlocks(baseEnv, {
    namespace: NS,
    hits: [hit("d"), hit("a")],
    timeByMemoryId: new Map([
      ["d", "2026-08-05T12:00:00+08:00"], // W32
      ["a", "2026-07-28T10:00:00+08:00"]  // W31
    ]),
    decayedIds: new Set(),
    excludeWeeks: ["2026-W32"]
  });
  assert.deepEqual(blocks.map((b) => b.week), ["2026-W31"], "点名的 W32 该被剔掉");
  pass("exclude_weeks：调用方点名的周才剔（boot 那层负责传）");
}

// --- 5. 配额 ---
{
  const blocks = await collectWeekBlocks(
    { ...baseEnv, RECALL_WEEK_BLOCK_LIMIT: "1" },
    {
      namespace: NS,
      hits: [hit("a"), hit("c")],
      timeByMemoryId: new Map([
        ["a", "2026-07-28T10:00:00+08:00"],
        ["c", "2026-07-22T09:00:00+08:00"]
      ]),
      decayedIds: new Set()
    }
  );
  assert.equal(blocks.length, 1, "RECALL_WEEK_BLOCK_LIMIT=1 时只出一块");
  pass("配额 RECALL_WEEK_BLOCK_LIMIT 生效");
}

// --- 6. 只认 memory 层命中；longtail 不带周 ---
{
  const longtail = { ...hit("lt1"), source_layer: "longtail", kind: "longtail" };
  const blocks = await collectWeekBlocks(baseEnv, {
    namespace: NS,
    hits: [longtail],
    timeByMemoryId: new Map([["lt1", "2026-07-28T10:00:00+08:00"]]),
    decayedIds: new Set()
  });
  assert.deepEqual(blocks, [], "longtail 命中不带周块");
  pass("只有 memory 层命中带周块");
}

// --- 7. 查不到 weekly_log 的周静默跳过 ---
{
  const blocks = await collectWeekBlocks(baseEnv, {
    namespace: NS,
    hits: [hit("e")],
    timeByMemoryId: new Map([["e", "2026-06-10T10:00:00+08:00"]]), // 库里没有那一周
    decayedIds: new Set()
  });
  assert.deepEqual(blocks, [], "weekly_log 里没有的周不产出块");
  pass("weekly_log 缺失的周静默跳过，不造空块");
}

// --- 8. 隔离不变量：周块不进 hits、不碰向量 ---
{
  const src = readFileSync(resolve(root, "src/memory/v2/recall.ts"), "utf8");
  const fnStart = src.indexOf("export async function collectWeekBlocks");
  assert.ok(fnStart > 0, "collectWeekBlocks 应当是导出的");
  const fnBody = src.slice(fnStart, src.indexOf("\n// 长尾兜底", fnStart));
  assert.ok(!/VECTORIZE|createEmbedding/.test(fnBody), "周块路径不许碰向量");
  assert.ok(
    !/hits\.push|allHits\.push/.test(src),
    "周块不许被 push 进 hits 数组（隔离不变量：日志块不进检索通道）"
  );
  assert.ok(
    /week_blocks: weekBlocks/.test(src),
    "周块必须走独立的 week_blocks 字段返回"
  );
  pass("隔离不变量：不 embed、不查向量、不混进 hits");
}

console.log(`\nweek-blocks: ${checks} checks passed`);
