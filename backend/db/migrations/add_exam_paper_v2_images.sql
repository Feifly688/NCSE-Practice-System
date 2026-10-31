-- 真题整卷：题目区域截图
--
-- 背景：图形推理、几何图、统计图表在 PDF 里是图形对象，文本层只有 "A." "B." "C." "D."，
-- 不把图形裁出来，整卷答题时这些题根本没法作答。
-- 实现：上传时留存原始 PDF，拆题时用 pdftotext -bbox-layout 定位题号区域，
--       pdftoppm 按区域裁剪成 PNG 存到 uploads/papers/paper-images/{paperId}/，
--       这里只记录文件名（逗号分隔多张），由后端静态路由提供访问。

ALTER TABLE `exam_paper_question`
  ADD COLUMN `image_url` VARCHAR(255) NULL COMMENT '题目区域截图文件名（逗号分隔多张）' AFTER `options_json`;
