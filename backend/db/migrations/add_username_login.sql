-- 为已有数据库添加 username 字段，支持「用户名或邮箱」登录
-- 适用：在 username 字段加入之前创建的库
-- 幂等：重复执行会因列/索引已存在而报错，可忽略

-- 1. 添加 username 列（放在 email 之前）
ALTER TABLE `user`
  ADD COLUMN `username` VARCHAR(64) NULL COMMENT '用户名，登录名，可与邮箱任选其一' AFTER `id`;

-- 2. email 改为可空（允许只填用户名注册）
ALTER TABLE `user`
  MODIFY COLUMN `email` VARCHAR(255) NULL;

-- 3. username 唯一索引
ALTER TABLE `user`
  ADD UNIQUE KEY `uq_user_username` (`username`);
