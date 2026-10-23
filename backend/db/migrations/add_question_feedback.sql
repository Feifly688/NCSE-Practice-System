-- 题目评分与反馈表
--
-- 每个用户对每道题的评分是唯一的：同一用户重复评分同一题目时更新原记录
-- （覆盖写入而非累加，保证"当前评分状态"语义清晰）。
--
-- session_id 记录评分发生在哪次练习中，便于后续按练习维度统计；
-- 允许为 NULL 以兼容"从收藏/错题本等非练习入口评分"的场景。
CREATE TABLE IF NOT EXISTS `question_feedback` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `question_id` BIGINT UNSIGNED NOT NULL,
  `session_id` BIGINT UNSIGNED NULL,
  `rating` TINYINT UNSIGNED NOT NULL COMMENT '评分 1-5 星',
  `feedback` TEXT NULL COMMENT '文字反馈，可为空',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- 唯一约束：同一用户对同一题目只保留一条评分记录
  UNIQUE KEY `uk_feedback_user_question` (`user_id`, `question_id`),
  KEY `idx_feedback_question` (`question_id`),
  KEY `idx_feedback_session` (`session_id`),
  CONSTRAINT `fk_feedback_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_feedback_question` FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_feedback_session` FOREIGN KEY (`session_id`) REFERENCES `practice_session`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
