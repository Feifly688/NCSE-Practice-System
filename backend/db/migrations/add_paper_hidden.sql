-- ============================================================
-- 隐藏粉笔模拟卷：保留数据、用户端不可见
--   · is_hidden=1 的卷：历年试卷列表/详情/作答全部排除
--   · 其回流题置为 archived：退出专项练习题池（历史记录不受影响）
-- 真题卷全部保留。管理端（/admin/exam-papers）不受影响，仍可见可管理。
-- ============================================================

ALTER TABLE `exam_paper`
  ADD COLUMN `is_hidden` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '用户端隐藏标记：1=模拟卷等不下发';

UPDATE `exam_paper` SET `is_hidden` = 1 WHERE `paper_type` = '模拟题';

-- question.status 是枚举，先补 'archived' 再归档模拟卷的回流题
ALTER TABLE `question`
  MODIFY COLUMN `status`
  ENUM('pending_review','approved','disabled','archived') NOT NULL DEFAULT 'pending_review'
  COMMENT 'approved=已上架 archived=所属卷被隐藏下架';

UPDATE `question` q
  JOIN `exam_paper` p ON p.`id` = q.`source_paper_id`
   SET q.`status` = 'archived'
 WHERE p.`is_hidden` = 1 AND q.`status` = 'approved';

-- 兜底：早期手动导入的卷 paper_type 还是「国考模拟题/省考模拟题」等旧值，
-- 或标题带「模考/模拟」但类型列不准 —— 一律隐藏并统一类型值
UPDATE `exam_paper`
   SET `is_hidden` = 1, `paper_type` = '模拟题'
 WHERE `is_hidden` = 0
   AND (`paper_type` IN ('模拟题','国考模拟题','省考模拟题')
        OR `title` LIKE '%模考%' OR `title` LIKE '%模拟%');

UPDATE `question` q
  JOIN `exam_paper` p ON p.`id` = q.`source_paper_id`
   SET q.`status` = 'archived'
 WHERE p.`is_hidden` = 1 AND q.`status` = 'approved';
