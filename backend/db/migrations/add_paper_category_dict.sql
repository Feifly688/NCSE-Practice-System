-- ============================================================
-- 试卷分类字典表（提前建表）
--
-- 缺陷修复：paper_category_dict 原先只在 seed_fenbi_taxonomy.sql 里创建，
-- 而该文件按文件名排序（'seed_' > 'add_'）在所有 add_* 迁移之后执行；
-- 但 add_paper_fenbi_labels.sql 需要向它 INSERT 数据，导致**全新空库**
-- 第一次跑 db:migrate 时报 Table doesn't exist 并整体失败。
--
-- 这里把建表提前到 add_paper_fenbi_labels.sql 之前（'add_paper_c' < 'add_paper_f'），
-- seed 文件里的 CREATE TABLE IF NOT EXISTS 保留不动，重复执行幂等无害。
-- ============================================================
CREATE TABLE IF NOT EXISTS `paper_category_dict` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `dim` VARCHAR(32) NOT NULL COMMENT '维度: exam_level/region/paper_type/fenbi_label',
  `value` VARCHAR(64) NOT NULL COMMENT '维度值',
  `label` VARCHAR(64) NOT NULL COMMENT '显示名',
  `sort_order` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pcd` (`dim`,`value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
