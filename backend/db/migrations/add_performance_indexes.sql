-- 性能索引补齐
--
-- 背景：几处高频查询在数据量上来后会退化成全表扫描
--   1) /api/questions/random、整卷拆题都按 status 过滤，但 question 表只有
--      (subject_id, status) 复合索引，单独按 status / qtype 过滤用不上
--   2) /api/stats/public 的近 7 天趋势按 started_at 范围查，没有索引
--   3) 结果页按 session 取作答记录，practice_answer 只有单列 session_id 索引
--   4) 错题本按 mastered + updated_at 排序分页
--
-- 说明：全部使用 IF NOT EXISTS 的等价写法（通过 information_schema 判断），
--       可安全重复执行；已有同名索引时会跳过。

SET @db = DATABASE();

-- question: 审核状态 + 题型（列表筛选 / 随机出题的过滤条件）
SET @idx = 'idx_question_status_qtype';
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'question' AND INDEX_NAME = @idx),
  'SELECT 1',
  'ALTER TABLE `question` ADD INDEX `idx_question_status_qtype` (`status`, `qtype`)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- question: 指纹唯一化（拆题入库前有大量 fingerprint 判重查询）
SET @idx = 'idx_question_fingerprint';
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'question' AND INDEX_NAME = @idx),
  'SELECT 1',
  'ALTER TABLE `question` ADD INDEX `idx_question_fingerprint` (`fingerprint`)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- practice_session: 按开始时间范围统计（首页近 7 天趋势、今日答题数）
SET @idx = 'idx_session_started_at';
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'practice_session' AND INDEX_NAME = @idx),
  'SELECT 1',
  'ALTER TABLE `practice_session` ADD INDEX `idx_session_started_at` (`started_at`)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- practice_answer: 结果页整卷作答记录（覆盖原单列索引）
SET @idx = 'idx_answer_session_question';
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'practice_answer' AND INDEX_NAME = @idx),
  'SELECT 1',
  'ALTER TABLE `practice_answer` ADD INDEX `idx_answer_session_question` (`session_id`, `question_id`)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- wrong_book: 错题本分页排序（WHERE user_id + mastered ORDER BY updated_at）
SET @idx = 'idx_wb_user_mastered_updated';
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wrong_book' AND INDEX_NAME = @idx),
  'SELECT 1',
  'ALTER TABLE `wrong_book` ADD INDEX `idx_wb_user_mastered_updated` (`user_id`, `mastered`, `updated_at`)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- exam_paper_question: 整卷答题按试卷取题目（ORDER BY seq）
SET @idx = 'idx_epq_paper_seq';
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'exam_paper_question' AND INDEX_NAME = @idx),
  'SELECT 1',
  'ALTER TABLE `exam_paper_question` ADD INDEX `idx_epq_paper_seq` (`exam_paper_id`, `seq`)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
