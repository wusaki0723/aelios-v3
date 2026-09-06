-- Aelios 记忆库 v2 (母帖 #11 第 4 步)
-- 昨天日志：dream 每天跑完写一条，boot 冷启动取"昨天"那条。
-- 单独放 0004：0003 已在部分环境成功记录，不能再往已应用迁移里追加表。

CREATE TABLE IF NOT EXISTS daily_log (
  namespace TEXT NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, date)
);
