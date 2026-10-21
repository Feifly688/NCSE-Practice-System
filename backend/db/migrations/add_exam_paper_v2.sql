-- 真题模块 v2：整卷结构化存储 + 拆题流水线状态 + 可重拆
--
-- 设计原则：不改动既有表结构与列语义，仅做增量扩展
--   1) exam_paper 增加拆题流水线状态列（parse_status / parse_error / parsed_count / last_parse_at）
--   2) 新增 exam_paper_question：整卷形态下的结构化题目（保持原卷顺序与分区），
--      与分模块去重题库（question 表）互为两种存储形态

ALTER TABLE `exam_paper`
  ADD COLUMN `parse_status` ENUM('pending', 'parsing', 'success', 'partial', 'failed')
    NOT NULL DEFAULT 'pending' COMMENT 'AI 拆题流水线状态' AFTER `status`;

ALTER TABLE `exam_paper`
  ADD COLUMN `parse_error` VARCHAR(500) NULL COMMENT '最近一次拆题失败/部分失败的原因摘要' AFTER `parse_status`;

ALTER TABLE `exam_paper`
  ADD COLUMN `parsed_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'AI 拆出的题目数（整卷形态）' AFTER `parse_error`;

ALTER TABLE `exam_paper`
  ADD COLUMN `last_parse_at` DATETIME NULL COMMENT '最近一次拆题时间' AFTER `parsed_count`;

ALTER TABLE `exam_paper` ADD INDEX `idx_exam_paper_parse_status` (`parse_status`);

-- 整卷结构化题目（完整真题试卷形态）：按原卷顺序与分区保存
CREATE TABLE IF NOT EXISTS `exam_paper_question` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `exam_paper_id` BIGINT UNSIGNED NOT NULL COMMENT '所属试卷',
  `seq` INT UNSIGNED NOT NULL COMMENT '题号（整卷顺序，从 1 开始）',
  `section` VARCHAR(64) NULL COMMENT '分区/模块名，如 常识判断',
  `qtype` VARCHAR(32) NULL COMMENT '题型',
  `difficulty` TINYINT UNSIGNED NULL COMMENT '难度 1-5',
  `passage` MEDIUMTEXT NULL COMMENT '材料/ passage',
  `stem` MEDIUMTEXT NOT NULL COMMENT '题干',
  `options_json` TEXT NOT NULL COMMENT '选项 JSON 数组',
  `answer` VARCHAR(16) NULL COMMENT '答案 A/B/C/D',
  `explanation` MEDIUMTEXT NULL COMMENT '解析',
  `fingerprint` VARCHAR(64) NULL COMMENT '题目指纹（题型+题干+选项+答案）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_epq_paper_seq` (`exam_paper_id`, `seq`),
  KEY `idx_epq_paper` (`exam_paper_id`),
  KEY `idx_epq_fingerprint` (`fingerprint`),
  CONSTRAINT `fk_epq_paper` FOREIGN KEY (`exam_paper_id`) REFERENCES `exam_paper`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
