-- 用户主题偏好持久化（light / dark / system）
ALTER TABLE `user` ADD COLUMN `theme` VARCHAR(10) NULL DEFAULT NULL
  COMMENT '界面主题偏好: light/dark/system，NULL=未设置（跟随本机）';
