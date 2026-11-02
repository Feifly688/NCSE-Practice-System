-- ============================================================
-- 题库统一化：整卷题回流到 question 表
--
-- 背景：practice_answer / wrong_book / favorites 三张表都以外键指向
-- question.id，整卷题（exam_paper_question）若不回流就无法进入
-- 错题本、收藏与练习会话。回流后所有练习统一基于 question 表，
-- 分类树也只需维护一份映射。
-- ============================================================

-- 科目表扩充为行测六大模块（原先只有「言语理解 / 政治」两条）
INSERT INTO `subject` (`name`, `slug`) VALUES
  ('政治理论', 'politics_theory'),
  ('常识判断', 'common_knowledge'),
  ('言语理解与表达', 'verbal_comprehension'),
  ('数量关系', 'quantity_relation'),
  ('判断推理', 'logic_reasoning'),
  ('资料分析', 'data_analysis')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- question 表记录整卷来源
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `question` ADD COLUMN `source_paper_id` BIGINT UNSIGNED NULL COMMENT ''来源整卷 id'' AFTER `exam_paper_id`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'question' AND COLUMN_NAME = 'source_paper_id');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `question` ADD COLUMN `source_paper_seq` INT UNSIGNED NULL COMMENT ''来源整卷中的题号'' AFTER `source_paper_id`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'question' AND COLUMN_NAME = 'source_paper_seq');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `question` ADD COLUMN `section_name` VARCHAR(64) NULL COMMENT ''整卷分区名（模块级分类）'' AFTER `source_paper_seq`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'question' AND COLUMN_NAME = 'section_name');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 按整卷来源查询题目
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `question` ADD KEY `idx_question_source_paper` (`source_paper_id`,`source_paper_seq`)',
  'DO 0')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'question' AND INDEX_NAME = 'idx_question_source_paper');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
