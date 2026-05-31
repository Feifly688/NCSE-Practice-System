-- 添加访问量统计表
CREATE TABLE IF NOT EXISTS `site_stats` (
  `stat_key` VARCHAR(64) NOT NULL,
  `stat_value` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stat_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 初始化默认值
INSERT IGNORE INTO `site_stats` (`stat_key`, `stat_value`) VALUES
('total_visits', 0),
('today_visits', 0);
