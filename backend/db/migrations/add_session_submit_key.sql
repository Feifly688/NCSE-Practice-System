-- ============================================================
-- 整卷交卷幂等键：给 practice_session 增加 submit_key，并对
-- (user_id, submit_key) 建唯一索引，用于拦截「同一交卷动作的重复请求」
-- （重复点击 / 刷新 / 网络重试），避免重复历史与错题 wrong_count 虚增。
--
-- 设计要点：
--   · MySQL 唯一索引允许多个 NULL，历史记录 submit_key 为 NULL，不受影响。
--   · 去重维度是 (user_id, submit_key) 而非 (user_id, paper_id)，
--     因此同一用户换一个新 submitKey 仍可主动重做同一张卷。
--   · 全部语句用 information_schema + PREPARE 写成幂等形式，可重复执行；
--     列不存在 / 索引不存在时才 ALTER，否则执行 'DO 0' 空语句。
-- ============================================================

-- 1. 列：不存在才加
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `practice_session` ADD COLUMN `submit_key` VARCHAR(64) NULL COMMENT ''交卷幂等键（同一动作重复提交只落一条）'' AFTER `meta_json`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'practice_session' AND COLUMN_NAME = 'submit_key');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. 唯一索引：不存在才加（列已由上一步保证存在）
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `practice_session` ADD UNIQUE KEY `uq_session_submit_key` (`user_id`, `submit_key`)',
  'DO 0')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'practice_session' AND INDEX_NAME = 'uq_session_submit_key');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
