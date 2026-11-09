-- ============================================================
-- 错题间隔重复：给 wrong_book 增加下次复习时间 + 查询索引
--
-- 复习周期按错次分档（粉笔口径）：
--   wrong_count >= 3 高频 → +1 天；= 2 中频 → +7 天；= 1 低频 → +15 天。
-- 答错时由业务 SQL 用 ON DUPLICATE KEY UPDATE 实时重算 next_review_at；
-- 老数据 next_review_at 为 NULL 视为「已到期」，迁移后立即可用。
--
-- 全部语句用 information_schema + PREPARE 写成幂等形式，可重复执行；
-- 列/索引不存在时才 ALTER，否则执行 'DO 0' 空语句。
-- 注意：migrate.js 的 splitStatements 按分号切分，
-- 故 DDL 字符串内部不能出现分号。
-- ============================================================

-- 1. 列：不存在才加
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `wrong_book` ADD COLUMN `next_review_at` DATETIME NULL COMMENT ''下次复习时间'' AFTER `updated_at`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wrong_book' AND COLUMN_NAME = 'next_review_at');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. 索引：不存在才加（列已由上一步保证存在）
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `wrong_book` ADD INDEX `idx_wb_review` (`user_id`, `next_review_at`)',
  'DO 0')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wrong_book' AND INDEX_NAME = 'idx_wb_review');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
