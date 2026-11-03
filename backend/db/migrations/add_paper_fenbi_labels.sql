-- ============================================================
-- 试卷分类对齐粉笔原版标签栏
--
-- 粉笔「历年试卷」页的标签就是一组扁平的 labelId（subLabels 接口）：
--   推荐 / 国考 / 国考模拟题 / 省考模拟题 / 各省 / 深圳市考 / 广州市考 / 政法干警 / 选调
-- 这里把每个标签作为 dim='fenbi_label' 的字典项（value=粉笔 labelId），
-- 试卷通过 exam_paper_category(dim='fenbi_label', value=labelId) 挂标签，
-- 列表页按原版顺序渲染标签栏、按 labelId 筛选。
-- ============================================================

INSERT INTO `paper_category_dict` (`dim`,`value`,`label`,`sort_order`) VALUES
  ('fenbi_label','1','国考',10),
  ('fenbi_label','2972','国考模拟题',20),
  ('fenbi_label','2906','省考模拟题',30),
  ('fenbi_label','2','安徽',40),
  ('fenbi_label','3','北京',50),
  ('fenbi_label','4','福建',60),
  ('fenbi_label','5','甘肃',70),
  ('fenbi_label','6','广东',80),
  ('fenbi_label','7','广西',90),
  ('fenbi_label','8','贵州',100),
  ('fenbi_label','9','海南',110),
  ('fenbi_label','10','河北',120),
  ('fenbi_label','11','河南',130),
  ('fenbi_label','12','黑龙江',140),
  ('fenbi_label','13','湖北',150),
  ('fenbi_label','14','湖南',160),
  ('fenbi_label','15','吉林',170),
  ('fenbi_label','16','江苏',180),
  ('fenbi_label','17','江西',190),
  ('fenbi_label','18','辽宁',200),
  ('fenbi_label','19','内蒙古',210),
  ('fenbi_label','20','宁夏',220),
  ('fenbi_label','21','青海',230),
  ('fenbi_label','22','山东',240),
  ('fenbi_label','23','山西',250),
  ('fenbi_label','24','陕西',260),
  ('fenbi_label','25','上海',270),
  ('fenbi_label','26','四川',280),
  ('fenbi_label','27','天津',290),
  ('fenbi_label','28','西藏',300),
  ('fenbi_label','29','新疆',310),
  ('fenbi_label','30','云南',320),
  ('fenbi_label','31','浙江',330),
  ('fenbi_label','32','重庆',340),
  ('fenbi_label','2023','深圳市考',350),
  ('fenbi_label','2033','广州市考',360),
  ('fenbi_label','2039','政法干警',370),
  ('fenbi_label','3588','选调',380)
ON DUPLICATE KEY UPDATE `label`=VALUES(`label`), `sort_order`=VALUES(`sort_order`);

-- paper_type 字典清理：扁平标签栏上线后不再按「试卷类型」筛选，
-- 值统一为 历年真题 / 模拟题 两种（列表项上的小标签仍会显示）
DELETE FROM `paper_category_dict` WHERE `dim`='paper_type' AND `value` IN ('推荐','国考模拟题','省考模拟题');
INSERT INTO `paper_category_dict` (`dim`,`value`,`label`,`sort_order`) VALUES
  ('paper_type','历年真题','历年真题',10),
  ('paper_type','模拟题','模拟题',20)
ON DUPLICATE KEY UPDATE `label`=VALUES(`label`), `sort_order`=VALUES(`sort_order`);
