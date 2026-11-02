-- ============================================================
-- 粉笔专项练习分类树种子数据
-- 结构照搬粉笔「专项练习」：模块 → 考点/题型 → 知识点
-- 一级模块沿用行测六大模块（与粉笔一致）
-- ============================================================

-- ── 一级：模块（dim=module）────────────────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`) VALUES
  (NULL,1,'政治理论','module-politics','module',10),
  (NULL,1,'常识判断','module-common','module',20),
  (NULL,1,'言语理解与表达','module-verbal','module',30),
  (NULL,1,'数量关系','module-quantity','module',40),
  (NULL,1,'判断推理','module-logic','module',50),
  (NULL,1,'资料分析','module-data','module',60)
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`), `sort_order`=VALUES(`sort_order`), `dim`=VALUES(`dim`);

-- ── 二级：政治理论（考点，dim=topic）──────────────────────
-- 粉笔实测：政治理论 → 马克思主义 / 新思想 / 时事政治 / 毛中特
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 2, t.name, t.slug, t.dim, t.sort_order
FROM (
  SELECT '马克思主义' AS name, 'politics-marxism' AS slug, 'topic' AS dim, 10 AS sort_order
  UNION ALL SELECT '新思想', 'politics-thought', 'topic', 20
  UNION ALL SELECT '时事政治', 'politics-current', 'topic', 30
  UNION ALL SELECT '毛中特', 'politics-maozhong', 'topic', 40
) t
JOIN `question_category` p ON p.slug = 'module-politics'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 二级：常识判断（考点）────────────────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 2, t.name, t.slug, t.dim, t.sort_order
FROM (
  SELECT '政治常识' AS name, 'common-politics' AS slug, 'topic' AS dim, 10 AS sort_order
  UNION ALL SELECT '法律常识', 'common-law', 'topic', 20
  UNION ALL SELECT '经济常识', 'common-economy', 'topic', 30
  UNION ALL SELECT '科技常识', 'common-science', 'topic', 40
  UNION ALL SELECT '人文历史', 'common-history', 'topic', 50
  UNION ALL SELECT '地理国情', 'common-geography', 'topic', 60
) t
JOIN `question_category` p ON p.slug = 'module-common'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 二级：言语理解与表达（题型，dim=qtype）────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 2, t.name, t.slug, t.dim, t.sort_order
FROM (
  SELECT '逻辑填空' AS name, 'verbal-fill' AS slug, 'qtype' AS dim, 10 AS sort_order
  UNION ALL SELECT '片段阅读', 'verbal-reading', 'qtype', 20
  UNION ALL SELECT '语句表达', 'verbal-sentence', 'qtype', 30
  UNION ALL SELECT '篇章阅读', 'verbal-passage', 'qtype', 40
) t
JOIN `question_category` p ON p.slug = 'module-verbal'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 二级：数量关系（题型）────────────────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 2, t.name, t.slug, t.dim, t.sort_order
FROM (
  SELECT '数学运算' AS name, 'quantity-math' AS slug, 'qtype' AS dim, 10 AS sort_order
  UNION ALL SELECT '数字推理', 'quantity-number', 'qtype', 20
) t
JOIN `question_category` p ON p.slug = 'module-quantity'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 二级：判断推理（题型，粉笔实测：图形推理/定义判断/类比推理/逻辑判断）──
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 2, t.name, t.slug, t.dim, t.sort_order
FROM (
  SELECT '图形推理' AS name, 'logic-graphic' AS slug, 'qtype' AS dim, 10 AS sort_order
  UNION ALL SELECT '定义判断', 'logic-definition', 'qtype', 20
  UNION ALL SELECT '类比推理', 'logic-analogy', 'qtype', 30
  UNION ALL SELECT '逻辑判断', 'logic-reasoning', 'qtype', 40
) t
JOIN `question_category` p ON p.slug = 'module-logic'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 二级：资料分析（考点）────────────────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 2, t.name, t.slug, t.dim, t.sort_order
FROM (
  SELECT '增长率' AS name, 'data-growth' AS slug, 'topic' AS dim, 10 AS sort_order
  UNION ALL SELECT '增长量', 'data-increment', 'topic', 20
  UNION ALL SELECT '比重', 'data-proportion', 'topic', 30
  UNION ALL SELECT '平均数', 'data-average', 'topic', 40
  UNION ALL SELECT '倍数与比值', 'data-ratio', 'topic', 50
  UNION ALL SELECT '综合分析', 'data-comprehensive', 'topic', 60
) t
JOIN `question_category` p ON p.slug = 'module-data'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 三级：政治理论 · 马克思主义（知识点）──────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 3, t.name, t.slug, 'knowledge', t.sort_order
FROM (
  SELECT '哲学' AS name, 'marxism-philosophy' AS slug, 'knowledge' AS dim, 10 AS sort_order
  UNION ALL SELECT '政治经济学', 'marxism-economics', 'knowledge', 20
  UNION ALL SELECT '科学社会主义', 'marxism-socialism', 'knowledge', 30
) t
JOIN `question_category` p ON p.slug = 'politics-marxism'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 三级：政治理论 · 新思想（知识点）──────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 3, t.name, t.slug, 'knowledge', t.sort_order
FROM (
  SELECT '习近平新时代中国特色社会主义思想' AS name, 'thought-xi' AS slug, 'knowledge' AS dim, 10 AS sort_order
  UNION ALL SELECT '二十大精神', 'thought-20th', 'knowledge', 20
) t
JOIN `question_category` p ON p.slug = 'politics-thought'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 三级：判断推理 · 图形推理（知识点）────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 3, t.name, t.slug, 'knowledge', t.sort_order
FROM (
  SELECT '位置类' AS name, 'graphic-position' AS slug, 'knowledge' AS dim, 10 AS sort_order
  UNION ALL SELECT '样式类', 'graphic-style', 'knowledge', 20
  UNION ALL SELECT '属性类', 'graphic-attribute', 'knowledge', 30
  UNION ALL SELECT '数量类', 'graphic-quantity', 'knowledge', 40
  UNION ALL SELECT '空间重构', 'graphic-spatial', 'knowledge', 50
  UNION ALL SELECT '立体拼合', 'graphic-3d', 'knowledge', 60
) t
JOIN `question_category` p ON p.slug = 'logic-graphic'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ── 三级：资料分析 · 增长率（知识点）──────────────────────
INSERT INTO `question_category` (`parent_id`,`level`,`name`,`slug`,`dim`,`sort_order`)
SELECT p.id, 3, t.name, t.slug, 'knowledge', t.sort_order
FROM (
  SELECT '基期与现期' AS name, 'growth-base' AS slug, 'knowledge' AS dim, 10 AS sort_order
  UNION ALL SELECT '增长率比较', 'growth-compare', 'knowledge', 20
  UNION ALL SELECT '年均增长率', 'growth-average', 'knowledge', 30
) t
JOIN `question_category` p ON p.slug = 'data-growth'
WHERE NOT EXISTS (SELECT 1 FROM `question_category` q WHERE q.slug = t.slug);

-- ============================================================
-- 试卷分类字典（粉笔历年试卷页的标签栏）
-- ============================================================
-- 地区（粉笔实测标签：安徽 北京 福建 甘肃 广东 广西 贵州 海南 河北 河南 黑龙江
--       湖北 湖南 吉林 江苏 江西 辽宁 内蒙古 宁夏 青海 山东 山西 陕西 上海 四川
--       天津 西藏 新疆 云南 浙江 重庆 + 深圳/广州/政法干警）
-- 用字典表存，便于前端渲染标签栏
CREATE TABLE IF NOT EXISTS `paper_category_dict` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `dim` VARCHAR(32) NOT NULL COMMENT '维度: exam_level/region/paper_type',
  `value` VARCHAR(64) NOT NULL COMMENT '维度值',
  `label` VARCHAR(64) NOT NULL COMMENT '显示名',
  `sort_order` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pcd` (`dim`,`value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `paper_category_dict` (`dim`,`value`,`label`,`sort_order`) VALUES
  ('exam_level','national','国考',10),
  ('exam_level','provincial','省考',20),
  ('exam_level','事业单位','事业单位',30),
  ('exam_level','选调生','选调生',40),
  ('paper_type','推荐','推荐',10),
  ('paper_type','国考模拟题','国考模拟题',20),
  ('paper_type','省考模拟题','省考模拟题',30),
  ('paper_type','历年真题','历年真题',40)
ON DUPLICATE KEY UPDATE `label`=VALUES(`label`), `sort_order`=VALUES(`sort_order`);

-- 各省（粉笔实测顺序）
INSERT INTO `paper_category_dict` (`dim`,`value`,`label`,`sort_order`) VALUES
  ('region','安徽','安徽',10), ('region','北京','北京',20),
  ('region','福建','福建',30), ('region','甘肃','甘肃',40),
  ('region','广东','广东',50), ('region','广西','广西',60),
  ('region','贵州','贵州',70), ('region','海南','海南',80),
  ('region','河北','河北',90), ('region','河南','河南',100),
  ('region','黑龙江','黑龙江',110), ('region','湖北','湖北',120),
  ('region','湖南','湖南',130), ('region','吉林','吉林',140),
  ('region','江苏','江苏',150), ('region','江西','江西',160),
  ('region','辽宁','辽宁',170), ('region','内蒙古','内蒙古',180),
  ('region','宁夏','宁夏',190), ('region','青海','青海',200),
  ('region','山东','山东',210), ('region','山西','山西',220),
  ('region','陕西','陕西',230), ('region','上海','上海',240),
  ('region','四川','四川',250), ('region','天津','天津',260),
  ('region','西藏','西藏',270), ('region','新疆','新疆',280),
  ('region','云南','云南',290), ('region','浙江','浙江',300),
  ('region','重庆','重庆',310),
  ('region','深圳市考','深圳市考',320),
  ('region','广州市考','广州市考',330),
  ('region','政法干警','政法干警',340)
ON DUPLICATE KEY UPDATE `label`=VALUES(`label`), `sort_order`=VALUES(`sort_order`);
