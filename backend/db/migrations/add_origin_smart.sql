-- 智能组卷：生成的个人卷落库为 exam_paper（origin='smart'），
-- 仅创建者可见、不进历年试卷列表与筛选
ALTER TABLE `exam_paper`
  MODIFY COLUMN `origin` ENUM('crawl','upload','smart') NULL
  COMMENT '来源：crawl=粉笔爬取 upload=上传 smart=智能组卷（个人卷）';
