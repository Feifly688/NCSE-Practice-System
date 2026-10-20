# NCSE 部署结构与自测手册

> 本项目当前生产环境信息与逐层自测方法。
> 目标：出问题时能自己按「由内到外」的顺序定位是哪一层断了。

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  用户浏览器                                                  │
│  https://ncse-practice-system.pages.dev                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴────────────────┐
        │                                │
   页面/静态资源                    API 请求（axios baseURL）
        │                                │
        ▼                                ▼
┌───────────────────┐      ┌──────────────────────────────┐
│  Cloudflare Pages │      │  https://api.feincse.us.ci/api│
│  （前端静态托管）  │      │  Cloudflare Tunnel 入口       │
└───────────────────┘      └──────────────┬───────────────┘
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │  cloudflared 进程      │
                              │  出站连接到 Cloudflare │
                              └───────────┬───────────┘
                                          │ localhost:4000
                                          ▼
                              ┌───────────────────────┐
                              │  Node.js (PM2)        │
                              │  ncse-backend         │
                              │  127.0.0.1:4000 (实际 │
                              │  绑 0.0.0.0，靠 ufw挡)│
                              └───────────┬───────────┘
                                          │ 127.0.0.1:3306
                                          ▼
                              ┌───────────────────────┐
                              │  MySQL 8              │
                              │  用户 ncse            │
                              │  库 ncse-practice-system│
                              └───────────────────────┘
```

### 关键点说明

| 层 | 说明 |
|---|---|
| **前后端分离** | 前端在 Cloudflare Pages，后端在云服务器，**完全独立部署** |
| **不通的原因** | `VITE_API_BASE_URL` 替代的是**整个 `/api` 前缀**（见下方「易错点」） |
| **不开放公网端口** | 4000 不对外，靠 cloudflared **出站**连接 Cloudflare，服务器无需公网 IP 映射 |
| **ufw 只开 22** | MySQL、4000 都不需要对公网开放 |

### 目录结构（服务器）

```
/root/ncse/                        ← 项目根目录（git clone 的位置）
├── .env                           ← ⚠️ 环境变量在这里，不在 backend/
├── backend/
│   ├── src/server.js              ← Express 入口
│   ├── src/db.js                  ← MySQL 连接池
│   ├── db/schema.sql              ← 表结构
│   ├── db/migrations/             ← 索引迁移
│   └── scripts/                   ← seed_admin 等运维脚本
├── frontend/                      ← 只有本地构建用，生产由 Pages 托管
└── deploy/
    ├── backup-db.sh               ← 备份脚本
    └── env.example                ← 配置模板

/etc/cloudflared/config.yml        ← Tunnel 配置
/root/.pm2/dump.pm2                ← PM2 进程清单
/root/backups/                     ← 数据库备份
```

---

## 二、环境变量

`.env` 在 **`/root/ncse/.env`**（仓库根目录，不是 `backend/.env`）。

```bash
NODE_ENV=production
APP_PORT=4000
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=ncse
MYSQL_PASSWORD=你的数据库密码
MYSQL_DATABASE=ncse-practice-system
JWT_SECRET=openssl rand -hex 32 生成
CORS_ORIGIN=https://ncse-practice-system.pages.dev,https://feincse.us.ci
API_KEY=智谱 API Key
BASE_URL=https://open.bigmodel.cn/api/paas/v4
MODEL=glm-4-flash
```

**读取规则**（这是最容易踩的坑）：

| 谁读 | 从哪读 |
|---|---|
| `backend/src/server.js` | 仓库根目录 `.env` |
| `backend/scripts/*.js` | 仓库根目录 `.env` |
| `backend/src/middleware/auth.js` | 进程环境变量 `JWT_SECRET` |

> `auth.js` 用的是 `process.env.JWT_SECRET`，依赖 PM2 启动时加载了 `.env`。
> 所以**必须** `NODE_ENV=production pm2 start ...` 这样带环境启动，或者用 ecosystem 文件。

---

## 三、⚠️ 易错点（我们实际踩过的）

### 1. `VITE_API_BASE_URL` 要带 `/api`

```js
// frontend/src/services/api.js
baseURL: import.meta.env.VITE_API_BASE_URL || '/api'
```

`baseURL` 替代的是**整个 `/api` 前缀**，而路由写的是 `/auth/login`：

| 填的值 | 最终请求 | 结果 |
|---|---|---|
| `https://api.feincse.us.ci` | `https://api.feincse.us.ci/auth/login` | ❌ 404 |
| `https://api.feincse.us.ci/api` | `https://api.feincse.us.ci/api/auth/login` | ✅ 200 |

**正确值：`https://api.feincse.us.ci/api`**

### 2. Tunnel 的 Public Hostname 路径要留空

如果填了 `/api`，Cloudflare 会再加一层，变成 `/api/api/xxx`，直接 404。

**路径必须留空。**

### 3. `.env` 放错位置

放 `backend/.env` 的话，`server.js` 读不到，`JWT_SECRET` 静默回退成 `dev_local_secret`，数据库连接全 undefined。

### 4. `PM2` 启动方式不对

必须是 `NODE_ENV=production pm2 start src/server.js --name ncse-backend`。

不带 `NODE_ENV=production` 的话：CORS 白名单不生效、静态托管不生效。

### 5. `npm run db:init` 会删库

那个脚本开头就是 `DROP DATABASE`。生产环境已被拦截（需 `ALLOW_DB_DROP=true`），但别去试。

---

## 四、自测：由内到外逐层验证

**核心原则：从最内层（数据库）往外测，哪一层断了就是哪一层的问题。**

### 第 1 层：MySQL

```bash
mysql -u ncse -p'你的密码' ncse-practice-system -e "SELECT 1; SHOW TABLES;"
```

✅ 期望：返回 `1`，且列出 9 张表：
`article` `favorite` `practice_answer` `practice_session` `question` `site_stats` `subject` `user` `wrong_book`

❌ 失败 → MySQL 没起 / 密码错 / 库没建

```bash
sudo systemctl status mysql              # 看是否 running
sudo ss -tlnp | grep 3306                # 必须是 127.0.0.1:3306
```

### 第 2 层：后端进程

```bash
pm2 status
```

✅ 期望：`ncse-backend` 状态 `online`，重启次数 `↺` 不涨

❌ 失败 → 看日志：

```bash
pm2 logs ncse-backend --lines 50 --nostream
```

常见错误对照：

| 日志内容 | 原因 |
|---|---|
| `ECONNREFUSED 127.0.0.1:3306` | MySQL 没起 |
| `ER_ACCESS_DENIED_ERROR` | `.env` 密码错 |
| `ER_BAD_DB_ERROR` | 库名错 / 库没建 |
| `WARNING: CORS_ORIGIN is not set` | `.env` 里没配 CORS_ORIGIN |
| `Using fallback (insecure)` | JWT_SECRET 没读到 |

### 第 3 层：本地 HTTP

```bash
curl http://127.0.0.1:4000/api/health
```

✅ 期望：`{"ok":true}`

❌ 失败 → 后端没监听，回第 2 层查

顺便验证一个需要读数据库的接口：

```bash
curl http://127.0.0.1:4000/api/questions/subjects
```

✅ 应返回 JSON（含科目列表）。这个能通说明「后端 + 数据库」整条通了。

### 第 4 层：Tunnel

```bash
curl https://api.feincse.us.ci/api/health
```

✅ 期望：`{"ok":true}`

❌ 失败 → 按顺序查：

```bash
# a. cloudflared 活着吗
sudo systemctl status cloudflared

# b. 日志有没有报错
sudo journalctl -u cloudflared -n 50 --no-pager

# c. 配置文件对不对
cat /etc/cloudflared/config.yml
```

`config.yml` 应该长这样：

```yaml
tunnel: ee85d89b-2a4c-4dcb-abbb-b18901171631
credentials-file: /root/.cloudflared/ee85d89b-2a4c-4dcb-abbb-b18901171631.json

ingress:
  - hostname: api.feincse.us.ci
    service: http://localhost:4000
  - service: http_status:404
```

### 第 5 层：CORS

这层只能从浏览器测。打开 `https://ncse-practice-system.pages.dev`，F12 → Console：

```js
fetch('https://api.feincse.us.ci/api/health').then(r => r.json()).then(console.log)
```

✅ 期望：输出 `{ok: true}`

| 现象 | 原因 | 解决 |
|---|---|---|
| 报 `CORS policy` 错误 | `CORS_ORIGIN` 没配对 | 改 `.env` 后 `pm2 restart` |
| 报 `Failed to fetch` | 网络层不通 | 回第 4 层 |
| 输出正常但页面功能废 | 前端 baseURL 错 | 见「易错点 1」 |

### 第 6 层：完整业务链路

前 5 层都过，最后测真实功能：

1. 网站注册一个新账号
2. 登进去看 Dashboard
3. 做几道题，确认能保存
4. 进后台看统计数据

✅ 全过 = 部署完成

❌ 注册失败 → F12 → Network 看请求 URL 和状态码

---

## 五、常用运维命令

### 看状态

```bash
pm2 status                        # 后端进程
pm2 logs ncse-backend --lines 50  # 后端日志
sudo systemctl status cloudflared # Tunnel
sudo systemctl status mysql       # 数据库
sudo ufw status                   # 防火墙
```

### 改配置后重启

```bash
# 改了 .env
pm2 restart ncse-backend

# 改了 Tunnel 配置
sudo systemctl restart cloudflared

# 改了 MySQL 配置
sudo systemctl restart mysql
```

### 更新代码

```bash
cd ~/ncse
git pull origin main
cd backend
npm install --production          # 只有依赖变了才需要
pm2 restart ncse-backend
```

**只改后端，前端不用动**（Pages 独立托管）。只有改 `frontend/` 代码才需要推 GitHub 让 Pages 重新构建。

### 备份

```bash
# 手动备份
bash /root/ncse/deploy/backup-db.sh

# 看备份文件
ls -lh ~/backups/

# 恢复（示例）
gunzip -c ~/backups/db_20261020_030001.sql.gz | mysql -u ncse -p'密码' ncse-practice-system
```

### 自动备份（crontab）

```bash
crontab -e
```

添加：

```
0 3 * * * /root/ncse/deploy/backup-db.sh >> /root/backups/backup.log 2>&1
```

---

## 六、当前生产环境信息

| 项目 | 值 |
|---|---|
| 服务器 | 主机名 `ser149595657101`，SSH 用户 `root` |
| 服务器公网 IP | **用 `curl -4 ifconfig.me` 自己查**（本文档不记录，避免泄露） |
| 操作系统 | Ubuntu（root 用户） |
| 项目路径 | `/root/ncse` |
| 前端地址 | https://ncse-practice-system.pages.dev |
| 前端自定义域名 | https://feincse.us.ci |
| 后端接口 | https://api.feincse.us.ci/api |
| Tunnel 名称 | `feincse` |
| Tunnel ID | `ee85d89b-2a4c-4dcb-abbb-b18901171631` |
| 数据库 | `ncse-practice-system`（MySQL 8，仅本地） |
| 数据库用户 | `ncse` |
| PM2 进程名 | `ncse-backend` |
| 仓库 | https://github.com/Feifly688/NCSE-Practice-System |

---

## 七、故障速查表

| 症状 | 最可能原因 | 先查 |
|---|---|---|
| 网站能打开，登录报错 | `VITE_API_BASE_URL` 少 `/api` | 第 6 层 |
| Console 报 CORS | `CORS_ORIGIN` 没配对 | `.env` |
| 请求 404 | baseURL 错，或 Tunnel 路径填了 `/api` | 第 4、6 层 |
| 请求 502/503 | 后端挂了或 Tunnel 断 | 第 2、4 层 |
| 服务器重启后全站挂 | `pm2 startup` 没配 | `systemctl status pm2-root` |
| 后台很慢 | `add_question_source_index.sql` 没导 | 第 1 层查索引 |
| AI 功能不可用 | `API_KEY` / `BASE_URL` / `MODEL` 没配 | `.env` |
| 数据库被清空 | 有人跑了 `npm run db:init` | —— |

---

*最后更新：2026-10-20*
