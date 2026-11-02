-- ============================================================
-- 粉笔题库式改造：题目分类树 + 试卷分类 + 日夜模式 + 自定义刷题
-- ============================================================

-- ── 1. 题目分类树（参照粉笔「专项练习」三层结构）────────────
-- level: 1=模块(政治理论/常识判断/…) 2=考点或题型 3=知识点
-- dim  : 分类维度，模块层固定为 'module'；其余按模块不同
--         政治理论 → 'topic'(考点)   判断推理 → 'qtype'(题型)
--         言语理解 → 'qtype'         资料分析 → 'topic'
CREATE TABLE IF NOT EXISTS `question_category` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `parent_id` INT UNSIGNED NULL COMMENT '父分类；NULL 为一级模块',
  `level` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '层级 1/2/3',
  `name` VARCHAR(64) NOT NULL COMMENT '分类名，如 图形推理',
  `slug` VARCHAR(64) NOT NULL COMMENT '英文标识，用于前端路由与筛选',
  `dim` VARCHAR(32) NOT NULL DEFAULT 'module' COMMENT '分类维度: module/topic/qtype/knowledge',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qc_slug` (`slug`),
  KEY `idx_qc_parent` (`parent_id`),
  KEY `idx_qc_level_dim` (`level`,`dim`),
  CONSTRAINT `fk_qc_parent` FOREIGN KEY (`parent_id`) REFERENCES `question_category`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. 题目 ↔ 分类 关联（一张题可挂多个分类）───────────────
-- 池子区分：'question' = 单题练习池，'exam_paper_question' = 整卷题池
CREATE TABLE IF NOT EXISTS `question_category_map` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id` INT UNSIGNED NOT NULL,
  `pool` ENUM('question','exam_paper_question') NOT NULL DEFAULT 'question',
  `ref_id` BIGINT UNSIGNED NOT NULL COMMENT 'question.id 或 exam_paper_question.id',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qcm` (`pool`,`ref_id`,`category_id`),
  KEY `idx_qcm_cat` (`category_id`,`pool`),
  KEY `idx_qcm_ref` (`pool`,`ref_id`),
  CONSTRAINT `fk_qcm_cat` FOREIGN KEY (`category_id`) REFERENCES `question_category`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. 试卷分类（参照粉笔「历年试卷」标签栏）──────────────
-- 分类维度：
--   exam_level  国考 / 省考 / 事业单位 / 选调生 …
--   region      各省（安徽/北京/福建/甘肃/广东/广西/贵州/海南/河北/河南/黑龙江/湖北/湖南/吉林/江苏/江西/辽宁/内蒙古/宁夏/青海/山东/山西/陕西/上海/四川/天津/西藏/新疆/云南/浙江/重庆 + 深圳/广州/政法干警）
--   paper_type  推荐 / 国考模拟题 / 省考模拟题 / 历年真题
CREATE TABLE IF NOT EXISTS `exam_paper_category` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `exam_paper_id` BIGINT UNSIGNED NOT NULL,
  `dim` VARCHAR(32) NOT NULL COMMENT '维度: exam_level/region/paper_type',
  `value` VARCHAR(64) NOT NULL COMMENT '维度值，如 安徽 / 国考 / 推荐',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_epc` (`exam_paper_id`,`dim`,`value`),
  KEY `idx_epc_dim_val` (`dim`,`value`),
  CONSTRAINT `fk_epc_paper` FOREIGN KEY (`exam_paper_id`) REFERENCES `exam_paper`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. 整卷真题元信息（用于列表展示与筛选）──────────────
-- ALTER TABLE ADD COLUMN 不幂等：重复执行报 Duplicate column。
-- 拆成独立的 ALTER，每条用 information_schema 先判存在性 ——
-- 不依赖 DELIMITER（Node 的 mysql2 不支持；mysql CLI 支持但会打断事务）。
SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `exam_paper` ADD COLUMN `exam_level` VARCHAR(32) NULL COMMENT ''考试级别: 国考/省考/事业单位/选调生'' AFTER `year`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_paper' AND COLUMN_NAME = 'exam_level');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `exam_paper` ADD COLUMN `region` VARCHAR(32) NULL COMMENT ''地区: 安徽/北京/… 或 全国'' AFTER `exam_level`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_paper' AND COLUMN_NAME = 'region');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `exam_paper` ADD COLUMN `paper_type` VARCHAR(32) NULL COMMENT ''试卷类型: 推荐/国考模拟题/省考模拟题/历年真题'' AFTER `region`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_paper' AND COLUMN_NAME = 'paper_type');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `exam_paper` ADD COLUMN `difficulty` DECIMAL(3,2) NULL COMMENT ''平均难度 0-5'' AFTER `paper_type`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_paper' AND COLUMN_NAME = 'difficulty');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE `user` ADD COLUMN `theme` ENUM(''light'',''dark'',''system'') NOT NULL DEFAULT ''system'' COMMENT ''主题: light/dark/system'' AFTER `status`',
  'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'theme');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 6. 用户自定义刷题配置（保存上次的刷题参数）────────────
CREATE TABLE IF NOT EXISTS `user_practice_config` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `config_json` JSON NOT NULL COMMENT '刷题参数: 分类/题型/难度/题量/范围',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_upc_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
