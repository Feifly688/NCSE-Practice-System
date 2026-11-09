-- 用户主题偏好持久化（light / dark / system）
--
-- 注意：add_fenbi_taxonomy.sql 已按 information_schema 幂等添加过 theme
-- （ENUM('light','dark','system') NOT NULL DEFAULT 'system'），且按文件名排序
-- 先于本文件执行。原实现是无条件 ADD COLUMN，必然报 Duplicate column name
-- 被 migrate.js 当成「已应用」跳过 —— 属于永不生效的死迁移，且其声明的
-- VARCHAR(10) NULL 与真实列类型不一致。
--
-- 这里改成「列缺失才兜底补齐」，类型与 add_fenbi_taxonomy.sql 严格对齐，
-- 保证只跑本迁移的环境也得到一致的列定义；已存在的环境执行 'DO 0' 空语句。
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `user` ADD COLUMN `theme` ENUM(''light'',''dark'',''system'') NOT NULL DEFAULT ''system'' COMMENT ''主题: light/dark/system'' AFTER `status`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'theme');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
