-- LMC-5 E 轴 (第一期，只取核心两列)：
--   authored_by        谁亲手写的这条记忆 (主 agent 署名)。蒸馏链 (dream/judge/extract) 永远不写此列。
--   response_tendency  这条记忆命中时的响应倾向 (亲笔附带的"该怎么用"一句话)。同样只许亲手写。
-- 落在 memories 本体，沿用 0007 (fact_key/version_status) 的先例：编号迁移只跑一次，幂等性由 d1 migrations 保证。
ALTER TABLE memories ADD COLUMN authored_by TEXT;
ALTER TABLE memories ADD COLUMN response_tendency TEXT;
