-- ============================================================
-- 抽题高频筛选组合索引
--
-- 抽题 / 智能组卷 / 分类计数的高频条件形如：
--   WHERE status='approved' AND subject_id = ? AND year >= ?
-- 现有索引只有 (subject_id,status)、(status,qtype)、(year) 单列，
-- 无法同时覆盖「状态 + 模块 + 年份」，年份过滤需要回表。
--
-- 文件名以 add_y 开头，按 migrate.js 的文件名排序在
-- add_question_year.sql（创建 year 列）之后，避免空库首跑报未知列。
-- ============================================================
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `question` ADD INDEX `idx_question_filter` (`status`, `subject_id`, `year`)',
  'DO 0')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'question' AND INDEX_NAME = 'idx_question_filter');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
