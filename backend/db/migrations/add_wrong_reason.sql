-- 粉笔式错题归因：错因标签 + 错次分档（错次复用 wrong_count，不新增列）
-- 取值：concept=概念不清 calculation=计算失误 reading=审题不清 time=时间不够 other=其他
ALTER TABLE `wrong_book`
  ADD COLUMN `reason_tag` VARCHAR(16) NULL
  COMMENT '错题归因: concept/calculation/reading/time/other';
