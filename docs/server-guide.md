# NCSE 练习系统 - 服务器运维教程

## 📋 目录

1. [服务器基本信息](#1-服务器基本信息)
2. [服务管理](#2-服务管理)
3. [数据库管理](#3-数据库管理)
4. [备份与恢复](#4-备份与恢复)
5. [代码更新](#5-代码更新)
6. [安全配置](#6-安全配置)
7. [故障排查](#7-故障排查)
8. [常用命令速查](#8-常用命令速查)

---

## 1. 服务器基本信息

### 1.1 服务器配置

| 项目 | 值 |
|------|-----|
| 操作系统 | Ubuntu 24.04 |
| 内存 | 2GB+ |
| 硬盘 | 40GB+ |
| SSH 用户 | 普通用户（非 root） |

### 1.2 服务架构

```
用户 → Cloudflare (HTTPS) → Cloudflare Tunnel → 服务器:4000 → Node.js 后端
                                                          ↘ MySQL 3306
```

### 1.3 Docker 容器列表

| 容器名 | 用途 | 端口 |
|--------|------|------|
| ncse-backend | Node.js 后端 | 4000 (本地) |
| mysql-container | MySQL 数据库 | 3306 (本地) |
| cloudflared | Cloudflare 隧道 | - |
| openresty | Nginx 反向代理 | - |

> 注：MySQL 容器名可能因部署方式不同而异，用 `docker ps` 查看实际容器名

---

## 2. 服务管理

### 2.1 查看所有服务状态

```bash
sudo docker ps
```

### 2.2 重启后端服务

```bash
cd ~/NCSE-Practice-System
sudo docker-compose restart backend
```

### 2.3 重启 Cloudflare Tunnel

```bash
sudo docker restart cloudflared
```

### 2.4 查看服务日志

```bash
# 后端日志
sudo docker logs ncse-backend --tail 50

# Cloudflare 日志
sudo docker logs cloudflared --tail 20
```

### 2.5 进入容器调试

```bash
# 进入后端容器
sudo docker exec -it ncse-backend sh

# 进入 MySQL 容器（容器名用 docker ps 查看）
sudo docker exec -it mysql-container mysql -u root -p
```

---

## 3. 数据库管理

### 3.1 连接数据库

```bash
# 容器名用 docker ps 查看
sudo docker exec -it mysql-container mysql -u root -p
```

### 3.2 数据库信息

| 项目 | 值 |
|------|-----|
| 容器名 | 用 `docker ps` 查看 |
| 用户名 | root |
| 数据库名 | ncse-practice-system |
| 端口 | 3306 (仅本地访问) |

### 3.3 常用 SQL 命令

```sql
-- 显示数据库
SHOW DATABASES;

-- 使用数据库
USE ncse-practice-system;

-- 查看表
SHOW TABLES;

-- 查看用户
SELECT id, email, nickname, role FROM user;

-- 修改用户密码（需要先生成 bcrypt 哈希）
UPDATE user SET password_hash = '哈希值' WHERE email = '邮箱';

-- 查看题目数量
SELECT COUNT(*) FROM question;

-- 查看文章数量
SELECT COUNT(*) FROM article;
```

### 3.4 生成密码哈希

在本地项目目录执行：

```bash
cd backend
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('新密码', 10).then(h => console.log(h))"
```

---

## 4. 备份与恢复

### 4.1 手动备份

```bash
~/backup.sh
```

### 4.2 自动备份

已配置 cron 任务，每天凌晨 3 点自动备份：

```bash
# 查看定时任务
crontab -l

# 查看备份文件
ls -lh ~/backups/
```

### 4.3 恢复数据库

```bash
# 方法 1：一键恢复（替换容器名和备份文件名）
gunzip -c ~/backups/db_XXXXXXXX_XXXXXX.sql.gz | sudo docker exec -i mysql-container mysql -u root -p ncse-practice-system

# 方法 2：分步恢复
gunzip ~/backups/db_XXXXXXXX_XXXXXX.sql.gz
sudo docker exec -i mysql-container mysql -u root -p ncse-practice-system < ~/backups/db_XXXXXXXX_XXXXXX.sql
```

### 4.4 迁移到新服务器

```bash
# 旧服务器：导出数据
cd ~/NCSE-Practice-System
./deploy/migrate.sh 导出

# 新服务器：导入数据
./deploy/migrate.sh 导入
```

---

## 5. 代码更新

### 5.1 拉取最新代码

```bash
cd ~/NCSE-Practice-System

# 拉取代码（如果代理有问题，加上 -c 参数）
git -c http.proxy= -c https.proxy= pull origin master
```

### 5.2 重新构建前端

前端是静态文件，修改代码后需要重新构建：

```bash
cd ~/NCSE-Practice-System

# 方式 1：完全重建并重启
sudo docker compose down
sudo docker compose up -d --build

# 方式 2：只重建前端容器
sudo docker compose run --rm frontend-builder
sudo docker compose restart backend
```

### 5.3 重启后端

如果只修改了后端代码，只需重启后端：

```bash
cd ~/NCSE-Practice-System
sudo docker compose restart backend
```

### 5.4 修改服务器配置

如果修改了 `.env` 文件，需要重新创建容器：

```bash
cd ~/NCSE-Practice-System

# 删除旧容器并重建
sudo docker compose down
sudo docker compose up -d
```

### 5.5 更新后验证

```bash
# 检查容器状态
sudo docker ps

# 检查后端日志
sudo docker logs ncse-backend --tail 20

# 测试接口
curl -s http://localhost:4000/api/health
```

---

## 6. 安全配置

### 6.1 防火墙

```bash
# 查看状态
sudo ufw status

# 推荐配置
# 允许：22/tcp (SSH)、80/tcp (HTTP)、443/tcp (HTTPS)
# 拒绝：3306/tcp (MySQL)、4000/tcp (后端)
```

### 6.2 SSH 安全

- Root 登录：建议禁用
- 使用普通用户登录

### 6.3 服务监控

```bash
# 查看监控日志
cat ~/monitor.log

# 监控脚本位置
~/monitor.sh
```

每 5 分钟自动检查后端和 Cloudflare Tunnel 状态。

### 6.4 日志管理

Docker 日志建议配置轮转：
- 最大文件大小：10MB
- 保留份数：3 份

---

## 7. 故障排查

### 7.1 网站无法访问

```bash
# 1. 检查后端服务
curl http://localhost:4000/api/health

# 2. 检查 Cloudflare Tunnel
sudo docker ps | grep cloudflared
sudo docker logs cloudflared --tail 20

# 3. 检查 DNS 解析
nslookup 你的域名
```

### 7.2 Cloudflare Tunnel 不断重启

```bash
# 查看日志
sudo docker logs cloudflared --tail 20

# 重新创建容器（替换 token）
sudo docker rm -f cloudflared
sudo docker run -d --name cloudflared --restart unless-stopped --network host \
  cloudflare/cloudflared tunnel --no-autoupdate run --token 你的token
```

### 7.3 AI 生成功能失败

```bash
# 检查后端日志
sudo docker logs ncse-backend --tail 50 | grep -i "error"

# 测试 MIMO API 连接
sudo docker exec ncse-backend wget -qO- \
  --post-data='{"model":"mimo-v2.5-pro","messages":[{"role":"user","content":"hello"}],"max_tokens":50}' \
  --header="Authorization: Bearer 你的API_KEY" \
  --header="Content-Type: application/json" \
  "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
```

### 7.4 数据库连接失败

```bash
# 检查 MySQL 容器状态
sudo docker ps | grep mysql

# 检查 MySQL 日志
sudo docker logs mysql-container --tail 20

# 测试连接
sudo docker exec -it mysql-container mysql -u root -p -e "SELECT 1"
```

---

## 8. 常用命令速查

### 服务管理

```bash
# 查看所有容器
sudo docker ps

# 重启后端
cd ~/NCSE-Practice-System && sudo docker compose restart backend

# 重启 Cloudflare
sudo docker restart cloudflared

# 查看后端日志
sudo docker logs ncse-backend --tail 50
```

### 数据库

```bash
# 连接数据库（容器名用 docker ps 查看）
sudo docker exec -it mysql-container mysql -u root -p

# 备份数据库
~/backup.sh

# 恢复数据库
gunzip -c ~/backups/备份文件.sql.gz | sudo docker exec -i mysql-container mysql -u root -p ncse-practice-system
```

### 安全

```bash
# 查看防火墙状态
sudo ufw status

# 查看监控日志
cat ~/monitor.log

# 查看定时任务
crontab -l
```

### 调试

```bash
# 进入后端容器
sudo docker exec -it ncse-backend sh

# 进入 MySQL 容器
sudo docker exec -it mysql-container bash

# 测试 API 连接
curl http://localhost:4000/api/health
```

---

## 📞 联系支持

如遇到无法解决的问题，请检查：

1. 服务器状态：`sudo docker ps`
2. 网络连接：`curl -I https://你的域名`
3. 监控日志：`cat ~/monitor.log`

---

*最后更新：2026-05-30*
