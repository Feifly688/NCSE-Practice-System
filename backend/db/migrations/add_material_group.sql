-- 智能组卷：资料分析材料题组的显式父子结构
-- 一篇资料 = 1 个父级大题（exam_paper_material_group 一行，存材料正文/图表）
-- 其下固定 5 道小题 = exam_paper_question 的 5 行（material_group_id 指向父级）
-- 父级大题不计入卷面题数，子题仍为正常作答/判分题目；其他题型 role=normal 不受影响。

CREATE TABLE IF NOT EXISTS `exam_paper_material_group` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `exam_paper_id` BIGINT UNSIGNED NOT NULL,
  `group_no` INT UNSIGNED NOT NULL COMMENT '卷内材料序号 1..N',
  `title` VARCHAR(255) NULL COMMENT '父级大题标题（材料一…）',
  `passage` LONGTEXT NULL COMMENT '父级大题：材料正文',
  `images` TEXT NULL COMMENT '材料图文件，逗号分隔',
  `question_count` SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_paper_group` (`exam_paper_id`, `group_no`),
  CONSTRAINT `fk_material_group_paper` FOREIGN KEY (`exam_paper_id`)
    REFERENCES `exam_paper` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `exam_paper_question`
  ADD COLUMN `material_group_id` BIGINT UNSIGNED NULL
    COMMENT '所属父级材料大题 id，NULL=普通单题',
  ADD COLUMN `question_role` ENUM('normal','material_child') NOT NULL DEFAULT 'normal'
    COMMENT 'normal=独立题 material_child=材料题组下的小题';

CREATE INDEX `idx_epq_material_group` ON `exam_paper_question` (`material_group_id`);
