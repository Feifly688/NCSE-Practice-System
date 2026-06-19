-- 优化：文章列表查询中 LEFT JOIN question 的子查询需要此索引
-- 之前没有索引时，每次加载文章列表都会全表扫描 question 表
ALTER TABLE `question` ADD INDEX `idx_question_source_article` (`source_article_id`);
