-- 智能组卷：按出题年份筛题
-- 题目来源（粉笔真题卷名/考试年份）里带年份，抽取成可索引的数值列
ALTER TABLE `question` ADD COLUMN `year` SMALLINT UNSIGNED NULL
  COMMENT '出题年份（从来源卷名提取）' AFTER `source_exam`;

UPDATE `question`
   SET `year` = CAST(REGEXP_SUBSTR(COALESCE(`source_exam`, ''), '[12][0-9]{3}') AS UNSIGNED)
 WHERE `year` IS NULL AND `source_exam` REGEXP '[12][0-9]{3}';

-- 回流题优先用所属试卷的年份（更准）
UPDATE `question` q
  JOIN `exam_paper` p ON p.`id` = q.`source_paper_id`
   SET q.`year` = p.`year`
 WHERE p.`year` IS NOT NULL;

CREATE INDEX `idx_question_year` ON `question` (`year`);
