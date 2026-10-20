# NCSE 部署与运维命令清单

生产环境：Cloudflare Pages（前端）+ 云服务器 PM2/MySQL（后端）+ Cloudflare Tunnel

---

## 一、环境信息

| 项 | 值 |
|---|---|
| 前端 | https://ncse-practice-system.pages.dev |
| 前端自定义域名 | https://feincse.us.ci |
| 后端 API | `https://api.feincse.us.ci/api` |
| 服务器 | `ser149595657101`，SSH 用户 `root`，IP 用 `curl -4 ifconfig.me` 查 |
| 项目路径 | `/root/ncse` |
| `.env` 位置 | `/root/ncse/.env`（**仓库根目录，不是 backend/**） |
| 数据库 | `ncse-practice-system`，用户 `ncse`，仅 127.0.0.1 |
| PM2 进程 | `ncse-backend` |
| Tunnel | `feincse`（ID `ee85d89b-2a4c-4dcb-abbb-b18901171631`） |
| 仓库 | https://github.com/Feifly688/NCSE-Practice-System |

---

## 二、.env 读取规则

| 谁 | 从哪读 |
|---|---|
| `backend/src/server.js` | 仓库根目录 `.env` |
| `backend/scripts/*.js` | 仓库根目录 `.env` |
| `backend/src/middleware/auth.js` | `process.env.JWT_SECRET`（依赖 PM2 启动时加载） |

`.env` 内容：

```bash
NODE_ENV=production
APP_PORT=4000
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=ncse
MYSQL_PASSWORD=数据库密码
MYSQL_DATABASE=ncse-practice-system
JWT_SECRET=openssl rand -hex 32 生成
CORS_ORIGIN=https://ncse-practice-system.pages.dev,https://feincse.us.ci
API_KEY=智谱APIKey
BASE_URL=https://open.bigmodel.cn/api/paas/v4
MODEL=glm-4-flash
```

---

## 三、易错点

**1. `VITE_API_BASE_URL` 必须带 `/api`**

`api.js` 的 `baseURL` 替代整个 `/api` 前缀，路由写的是 `/auth/login`：

| 填的值 | 最终请求 | 结果 |
|---|---|---|
| `https://api.feincse.us.ci` | `/auth/login` | 404 |
| `https://api.feincse.us.ci/api` | `/api/auth/login` | 200 |

**2. Tunnel 的 Public Hostname 路径必须留空**

填 `/api` 会变成 `/api/api/xxx`，404。URL 填 `http://localhost:4000`（带协议头）。

**3. `.env` 放错位置**

放 `backend/.env` 会导致 `JWT_SECRET` 静默回退 `dev_local_secret`，数据库连接全 undefined。

**4. PM2 必须带 `NODE_ENV=production`**

不带则 CORS 白名单和静态托管都不生效。

**5. 不要跑 `npm run db:init`**

会 `DROP DATABASE`。生产环境需额外 `ALLOW_DB_DROP=true` 才会执行。

---

## 四、自测（由内到外）

每层失败就停在那层查，不要继续往下。

### 1. MySQL
```bash
mysql -u ncse -p'密码' ncse-practice-system -e "SHOW TABLES;"
```
应列出 9 张表。失败查：`sudo systemctl status mysql`

### 2. 后端进程
```bash
pm2 status
```
`ncse-backend` 须为 `online`。失败查：`pm2 logs ncse-backend --lines 50`

| 日志关键词 | 原因 |
|---|---|
| `ECONNREFUSED 127.0.0.1:3306` | MySQL 没起 |
| `ER_ACCESS_DENIED_ERROR` | `.env` 密码错 |
| `ER_BAD_DB_ERROR` | 库名错或库没建 |
| `WARNING: CORS_ORIGIN is not set` | `.env` 没配 CORS_ORIGIN |
| `Using fallback (insecure)` | JWT_SECRET 没读到 |

### 3. 本地 HTTP
```bash
curl http://127.0.0.1:4000/api/health
curl http://127.0.0.1:4000/api/questions/subjects
```
都应返回 JSON。失败回第 2 层。

### 4. Tunnel
```bash
curl https://api.feincse.us.ci/api/health
```
应返回 `{"ok":true}`。失败按序查：
```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 50 --no-pager
cat /etc/cloudflared/config.yml
```

`config.yml` 应为：
```yaml
tunnel: ee85d89b-2a4c-4dcb-abbb-b18901171631
credentials-file: /root/.cloudflared/ee85d89b-2a4c-4dcb-abbb-b18901171631.json
ingress:
  - hostname: api.feincse.us.ci
    service: http://localhost:4000
  - service: http_status:404
```

### 5. CORS（浏览器测）
打开前端页面，F12 → Console，输入 `allow pasting` 后粘贴：
```js
fetch('https://api.feincse.us.ci/api/health').then(r => r.json()).then(console.log)
```

| 现象 | 原因 |
|---|---|
| 报 CORS policy | `.env` 的 `CORS_ORIGIN` 没配对 |
| Failed to fetch | 网络层不通，回第 4 层 |
| 正常但页面功能废 | 前端 baseURL 错，见易错点 1 |

### 6. 业务链路
网站注册账号 → 登录 → 进 Dashboard → 答题 → 看后台统计。

---

## 五、用户与密码管理

### 账号规则
- `username`（用户名）和 `email`（邮箱）**至少填一个**，两者都能作为登录名
- 登录时输入其中一个 + 密码即可，后端用 `WHERE username = ? OR email = ?` 匹配
- 用户名规则：2-64 字符，仅字母、数字、下划线、连字符、中文
- 用户名和邮箱都设了唯一索引，不可重复

### 通过 SQL 改密码

`user.password_hash` 存的是 bcrypt 哈希，**不可逆，不能直接写明文**。用脚本生成哈希：

```bash
cd /root/ncse/backend

# 1. 只生成哈希（不写库）
node scripts/hash_password.js '新密码'

# 2. 生成并直接写入指定用户（用户名或邮箱均可）
node scripts/hash_password.js '新密码' --apply admin@example.com
```

脚本会输出 `PASSWORD_UPDATED` 和该用户信息。

手动 SQL 方式（把 `<哈希>` 换成上面生成的）：

```bash
mysql -u ncse -p'密码' ncse-practice-system -e "UPDATE user SET password_hash = '<哈希>' WHERE email = '你的邮箱';"
```

### 账号被锁死自愈
```bash
mysql -u ncse -p'密码' ncse-practice-system -e "UPDATE user SET status='active', role='admin' WHERE email='你的邮箱';"
```

### 用户管理规则
- 管理员**不能修改自己**的角色和状态（后端 400 + 前端隐藏按钮）
- 用户**不支持删除**，`DELETE /api/admin/users/:id` 已停用（返回 403），一律用「禁用」代替
- 禁用后用户无法登录，练习记录、错题本等数据保留，可随时重新启用

### 升级已有数据库（加 username 字段）
新部署的库已含该字段；在字段加入前创建的库需执行：
```bash
mysql -u ncse -p'密码' ncse-practice-system < /root/ncse/backend/db/migrations/add_username_login.sql
```

---

## 六、运维命令

### 看状态
```bash
pm2 status
pm2 logs ncse-backend --lines 50
sudo systemctl status cloudflared
sudo systemctl status mysql
sudo ufw status
```

### 改配置后重启
```bash
pm2 restart ncse-backend                              # 改了 .env
sudo systemctl restart cloudflared                    # 改了 Tunnel
sudo systemctl restart mysql                          # 改了 MySQL
```

### 更新代码
```bash
cd ~/ncse
git pull origin main
cd backend
npm install --production          # 只有依赖变了才需要
pm2 restart ncse-backend
```

只改后端，前端不用动（Pages 独立托管）。只有改 `frontend/` 才需推 GitHub 让 Pages 重新构建。

### 备份
```bash
bash /root/ncse/deploy/backup-db.sh
ls -lh ~/backups/
gunzip -c ~/backups/db_20261020_030001.sql.gz | mysql -u ncse -p'密码' ncse-practice-system
```

### 自动备份
```bash
crontab -e
```
添加：
```
0 3 * * * /root/ncse/deploy/backup-db.sh >> /root/backups/backup.log 2>&1
```

### 数据库查询
```bash
mysql -u ncse -p'密码' ncse-practice-system -e "SELECT COUNT(*) FROM question;"
mysql -u ncse -p'密码' ncse-practice-system -e "SELECT COUNT(*) FROM article;"
```

### 建管理员 / 导示例数据
```bash
cd /root/ncse/backend
node scripts/seed_admin.js
node scripts/seed_questions.js      # 非幂等，重复跑会插重复题
node scripts/seed_articles.js
```

---

## 八、故障速查

| 症状 | 查这里 |
|---|---|
| 网站能打开，登录 404 | `VITE_API_BASE_URL` 少 `/api` |
| Console 报 CORS | `.env` 的 `CORS_ORIGIN` |
| 请求 502/503 | `pm2 status` + `systemctl status cloudflared` |
| 服务器重启后全站挂 | `systemctl status pm2-root`，须 `active (exited)` |
| 后台很慢 | `SHOW INDEX FROM question` 确认有 `idx_question_source_article` |
| AI 功能不可用 | `.env` 的 `API_KEY` / `BASE_URL` / `MODEL` |
| 中文乱码 | 导入导出都带 `--default-character-set=utf8mb4` |
| 登录报「账号已被禁用」 | `UPDATE user SET status='active' WHERE email='邮箱'`，见第五节 |

---

## 九、防火墙
```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw enable
sudo ss -tlnp | grep -E '3306|4000'    # 3306 必须为 127.0.0.1
```

4000/3306 都不需要对公网开放，Tunnel 走本地回环。
