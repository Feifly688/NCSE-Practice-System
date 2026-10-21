-- 真题功能：完整真题试卷 + 分模块去重题库
--
-- 1) exam_paper：以"完整真题试卷"形态保存原始试卷（爬取的网页正文 / 上传 PDF 提取的文本）
-- 2) question 增加 exam_paper_id（归属试卷）与 fingerprint（题干指纹，用于分模块入库时去重）

CREATE TABLE IF NOT EXISTS `exam_paper` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL COMMENT '试卷标题，如 2024年国考行测真题',
  `year` SMALLINT UNSIGNED NULL COMMENT '真题年份',
  `source` VARCHAR(255) NULL COMMENT '来源：爬取站点名或上传文件名',
  `source_url` VARCHAR(1024) NULL COMMENT '爬取来源 URL，上传方式为空',
  `file_name` VARCHAR(255) NULL COMMENT '上传的 PDF 文件名',
  `origin` ENUM('crawl', 'upload') NOT NULL DEFAULT 'upload' COMMENT '获取方式',
  `raw_text` LONGTEXT NULL COMMENT '整卷文本（完整真题试卷形态）',
  `question_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已拆出并入库的题目数',
  `status` ENUM('pending_review', 'parsed', 'approved', 'disabled') NOT NULL DEFAULT 'pending_review',
  `creator_user_id` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_exam_paper_status` (`status`),
  CONSTRAINT `fk_exam_paper_creator` FOREIGN KEY (`creator_user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- question：关联试卷 + 指纹去重
ALTER TABLE `question` ADD COLUMN `exam_paper_id` BIGINT UNSIGNED NULL COMMENT '所属真题试卷' AFTER `source_exam`;
ALTER TABLE `question` ADD COLUMN `fingerprint` VARCHAR(64) NULL COMMENT '题干指纹，用于去重' AFTER `exam_paper_id`;
ALTER TABLE `question` ADD UNIQUE KEY `uk_question_fingerprint` (`fingerprint`);
ALTER TABLE `question` ADD INDEX `idx_question_exam_paper` (`exam_paper_id`);
