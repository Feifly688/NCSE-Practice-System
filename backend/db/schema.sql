-- Users
CREATE TABLE IF NOT EXISTS `user` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email` VARCHAR(255) NOT NULL,
  `nickname` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('user','admin') NOT NULL DEFAULT 'user',
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subject / category
CREATE TABLE IF NOT EXISTS `subject` (
  `id` SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(64) NOT NULL,
  `slug` VARCHAR(64) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subject_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Source articles
CREATE TABLE IF NOT EXISTS `article` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source` VARCHAR(64) NOT NULL,
  `title` VARCHAR(512) NOT NULL,
  `url` VARCHAR(1024) NOT NULL,
  `publish_time` DATETIME NULL,
  `author` VARCHAR(128) NULL,
  `clean_text` MEDIUMTEXT NOT NULL,
  `fingerprint` VARCHAR(64) NOT NULL,
  `category` VARCHAR(32) DEFAULT 'both' COMMENT '文章分类: verbal-言语, politics-政治, both-通用',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_article_fp` (`fingerprint`),
  KEY `idx_article_source` (`source`),
  KEY `idx_article_publish_time` (`publish_time`),
  KEY `idx_article_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Questions
CREATE TABLE IF NOT EXISTS `question` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `subject_id` SMALLINT UNSIGNED NOT NULL,
  `qtype` VARCHAR(64) NOT NULL,
  `difficulty` TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `passage` TEXT NULL,
  `stem` VARCHAR(1024) NOT NULL,
  `options_json` JSON NOT NULL,
  `answer` VARCHAR(32) NOT NULL,
  `explanation` TEXT NOT NULL,
  `source_article_id` BIGINT UNSIGNED NULL,
  `source_exam` VARCHAR(128) NULL,
  `creator_user_id` BIGINT UNSIGNED NULL,
  `status` ENUM('pending_review','approved','disabled') NOT NULL DEFAULT 'pending_review',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_question_subject_status` (`subject_id`,`status`),
  KEY `idx_question_difficulty` (`difficulty`),
  CONSTRAINT `fk_question_subject` FOREIGN KEY (`subject_id`) REFERENCES `subject`(`id`),
  CONSTRAINT `fk_question_article` FOREIGN KEY (`source_article_id`) REFERENCES `article`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_question_creator` FOREIGN KEY (`creator_user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Practice sessions
CREATE TABLE IF NOT EXISTS `practice_session` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `subject_id` SMALLINT UNSIGNED NOT NULL,
  `mode` VARCHAR(32) NOT NULL DEFAULT 'random',
  `total` INT UNSIGNED NOT NULL DEFAULT 0,
  `correct` INT UNSIGNED NOT NULL DEFAULT 0,
  `duration_sec` INT UNSIGNED NOT NULL DEFAULT 0,
  `score` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` DATETIME NULL,
  `meta_json` JSON NULL,
  `status` ENUM('in_progress','completed') NOT NULL DEFAULT 'in_progress',
  PRIMARY KEY (`id`),
  KEY `idx_session_user` (`user_id`),
  KEY `idx_session_user_id` (`user_id`,`id` DESC),
  KEY `idx_session_status` (`user_id`,`status`),
  CONSTRAINT `fk_session_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`),
  CONSTRAINT `fk_session_subject` FOREIGN KEY (`subject_id`) REFERENCES `subject`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-question answer records
CREATE TABLE IF NOT EXISTS `practice_answer` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` BIGINT UNSIGNED NOT NULL,
  `question_id` BIGINT UNSIGNED NOT NULL,
  `user_answer` VARCHAR(32) NOT NULL,
  `is_correct` TINYINT(1) NOT NULL,
  `time_spent_sec` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_answer_session` (`session_id`),
  KEY `idx_answer_question` (`question_id`),
  CONSTRAINT `fk_answer_session` FOREIGN KEY (`session_id`) REFERENCES `practice_session`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_answer_question` FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Site statistics (key-value)
CREATE TABLE IF NOT EXISTS `site_stats` (
  `stat_key` VARCHAR(64) NOT NULL,
  `stat_value` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stat_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default stats
INSERT IGNORE INTO `site_stats` (`stat_key`, `stat_value`) VALUES
('total_visits', 0),
('today_visits', 0);

-- Seed default subjects
INSERT IGNORE INTO `subject` (`name`,`slug`) VALUES
(_utf8mb4 x'E8A880E8AFADE79086E8A7A3','verbal_comprehension'),
(_utf8mb4 x'E694BFE6B2BB','politics');

-- Wrong book (错题本)
CREATE TABLE IF NOT EXISTS `wrong_book` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `question_id` BIGINT UNSIGNED NOT NULL,
  `wrong_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `mastered` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wb_user_question` (`user_id`,`question_id`),
  KEY `idx_wb_user_mastered` (`user_id`,`mastered`),
  CONSTRAINT `fk_wb_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wb_question` FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Favorites (收藏)
CREATE TABLE IF NOT EXISTS `favorite` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `question_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fav_user_question` (`user_id`,`question_id`),
  CONSTRAINT `fk_fav_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fav_question` FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
