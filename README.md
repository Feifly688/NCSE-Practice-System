# NCSE 公务员考试刷题系统

公务员考试在线练习平台，支持单选题练习、模拟考试、错题本、收藏、排行榜等功能。

## 环境要求

- Node.js >= 18
- MySQL 8.0

## 快速开始

### 1. 配置数据库

复制 `deploy/env.example` 为**仓库根目录**的 `.env`，填入 MySQL 连接信息：

```
cp deploy/env.example .env
```

### 2. 初始化数据库

```
cd backend
npm install
npm run db:init      # 创建数据库和表
npm run seed:admin   # 创建默认管理员
npm run seed:questions  # 导入示例题目（可选）
```

默认管理员账号：`admin@example.com` / `Admin@12345`

### 3. 启动服务

后端：
```
cd backend
npm run dev            # http://localhost:4000
```

前端（另一个终端）：
```
cd frontend
npm install
npm run dev            # http://localhost:5173
```

## 功能列表

### 用户端
- 注册/登录（JWT 认证，7天有效期）
- 个人仪表盘（统计数据、成绩趋势图）
- 单选题练习（随机出题、题型/难度筛选）
- 模拟考试模式（倒计时、自动交卷）
- 答题进度自动保存、暂停/恢复
- 答题历史记录（分页查看、结果详情）
- 错题本（自动收录错题、按题型统计、手动/自动移出、重做错题、导出打印）
- 题目收藏
- 成绩排行榜
- AI 个性化解析（基于 MIMO API）
- 个人信息编辑、修改密码

### 管理端
- 管理后台首页（题目/用户/文章/练习统计）
- 题目管理（CRUD、批量审核、批量删除、关键词搜索）
- 文章管理（抓取人民日报文章）
- 用户管理（启用/禁用、编辑角色、删除用户）
- AI 自动生成题目（基于文章内容）

## 项目结构

```
├── backend/              Express 后端
│   ├── db/
│   │   ├── schema.sql    表结构
│   │   └── migrations/   增量迁移
│   ├── scripts/          运维脚本
│   │   ├── seed_admin.js      创建初始管理员
│   │   ├── seed_questions.js  导入示例题目
│   │   ├── seed_articles.js   导入示例文章
│   │   ├── hash_password.js   生成 bcrypt 哈希并改密码
│   │   ├── db_ping.js         测试数据库连接
│   │   └── refetch-times.js   重新抓取文章发布时间
│   └── src/
│       ├── db.js         共享数据库连接
│       ├── middleware/    JWT 认证中间件
│       ├── routes/       API 路由
│       └── server.js     入口
├── frontend/             React + Ant Design 前端
│   └── src/
│       ├── components/   公共组件（ErrorBoundary、路由守卫）
│       ├── contexts/     AuthContext
│       ├── layouts/      MainLayout、AdminLayout
│       ├── pages/        页面组件
│       ├── services/     axios 封装
│       └── utils.js      公共工具函数
├── deploy/               部署脚本与配置
├── docs/
│   └── deployment-runbook.md   部署架构与运维命令
└── .env.example          环境变量模板
```

## 角色权限

- 游客：浏览首页，不能答题
- 用户：答题、查看历史、错题本、收藏、排行榜
- 管理员：题目管理、文章管理、用户管理、AI 生成题目

## 项目配置

### 后端配置（仓库根目录 `.env`）

> ⚠️ `.env` 必须放在**仓库根目录**，不是 `backend/.env`。
> `backend/src/server.js` 和 `backend/scripts/*.js` 都从根目录读取，放错位置会导致配置静默失效。

基于 `deploy/env.example` 创建：

| 变量 | 说明 | 必填 |
|------|------|------|
| `MYSQL_HOST` | MySQL 地址 | 是 |
| `MYSQL_PORT` | MySQL 端口，默认 3306 | 是 |
| `MYSQL_USER` | 数据库用户 | 是 |
| `MYSQL_PASSWORD` | 数据库密码 | 是 |
| `MYSQL_DATABASE` | 数据库名，默认 `ncse-practice-system` | 是 |
| `APP_PORT` | 后端端口，默认 4000 | 否 |
| `NODE_ENV` | `production` 时启用 CORS 白名单与静态托管 | 否 |
| `JWT_SECRET` | JWT 签名密钥（**必须改为随机强密钥**） | 是 |
| `CORS_ORIGIN` | 跨域白名单，多个域名用英文逗号分隔。前端与后端不同域时**必填** | 条件 |
| `FRONTEND_DIST` | 前端静态目录；前端部署在 Cloudflare Pages 时留空，后端只提供 `/api` | 否 |
| `API_KEY` | AI 解析/生题的 API Key（留空禁用 AI 功能） | 否 |
| `BASE_URL` | AI API 地址，默认 `https://open.bigmodel.cn/api/paas/v4` | 否 |
| `MODEL` | AI 模型名，如 `glm-4-flash` | 否 |
| `ADMIN_USERNAME` | 初始管理员用户名，与 `ADMIN_EMAIL` 至少留一个 | 否 |
| `ADMIN_EMAIL` | 初始管理员邮箱，默认 `admin@example.com` | 否 |
| `ADMIN_NICKNAME` | 初始管理员昵称，默认 `管理员` | 否 |
| `ADMIN_PASSWORD` | 初始管理员密码，默认 `Admin@12345` | 否 |

> 生成随机 JWT 密钥：`openssl rand -hex 32`
>
> AI 相关变量名是 `API_KEY` / `BASE_URL` / `MODEL`，旧文档里的 `MIMO_API_KEY` / `MIMO_BASE_URL` 已废弃，代码不识别。

### 账号与登录规则

- **用户名（`username`）和邮箱（`email`）至少填一个**，两者都能作为登录名
- 登录时输入其中一个 + 密码即可
- 用户名规则：2-64 字符，仅限字母、数字、下划线、连字符、中文；不可重复
- 邮箱同样不可重复；留空表示该用户只能用用户名登录
- 数据库密码是 bcrypt 哈希，**不可逆**。改密码用：

```bash
cd backend
node scripts/hash_password.js '新密码' --apply 用户名或邮箱
```

### 前端配置 (`frontend/.env`)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_BASE_URL` | API 请求前缀。同源部署用 `/api`；前后端不同域（如 Cloudflare Pages + 独立后端）填后端完整地址，如 `https://api.你的域名` | `/api` |

开发环境通过 Vite 代理转发到 `http://localhost:4000`（在 `vite.config.js` 中配置）。

## 部署流程

### 方式一：裸机部署（PM2 + Nginx）

适用于已安装 Node.js 18+ 和 MySQL 8.0 的服务器。

**一键部署脚本：**

```bash
cd deploy
bash deploy.sh
```

脚本自动完成以下步骤：

1. 检查环境（Node.js ≥ 18、npm、MySQL 客户端、Nginx）
2. 从 `deploy/env.example` 生成仓库根目录的 `.env`（如不存在）
3. 创建数据库并导入 `db/schema.sql` 表结构 + `db/migrations/`
4. 安装前后端依赖
5. 构建前端（输出到 `frontend/dist`）
6. 使用 PM2 启动后端，配置开机自启
7. 配置 Nginx 站点（反向代理到 `127.0.0.1:4000`）
8. 创建默认管理员账号

**手动部署步骤：**

```bash
# 1. 配置（.env 放仓库根目录）
cp deploy/env.example .env
# 编辑 .env 填入数据库密码、JWT_SECRET、CORS_ORIGIN

# 2. 初始化数据库
cd backend
npm install
mysql -u root -p -e "CREATE DATABASE \`ncse-practice-system\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p ncse-practice-system < db/schema.sql
mysql -u root -p ncse-practice-system < db/migrations/add_question_source_index.sql
node scripts/seed_admin.js     # 创建管理员
# node scripts/seed_questions.js  # （可选）导入示例题目

# 3. 构建前端（前端部署在 Cloudflare Pages 时可跳过，由 Pages 自动构建）
cd ../frontend
npm install
npm run build

# 4. 启动后端（PM2）
cd ../backend
npm install -g pm2
NODE_ENV=production pm2 start src/server.js --name ncse-backend --time
pm2 save
pm2 startup             # 开机自启

# 5. 配置 Nginx 反向代理
sudo cp ../deploy/nginx.conf /etc/nginx/sites-available/ncse-practice
sudo ln -sf /etc/nginx/sites-available/ncse-practice /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ 不要在有数据的库上执行 `npm run db:init`，它会先 `DROP DATABASE` 清空所有数据。
> 生产环境该脚本会被 `NODE_ENV=production` 拦截，需额外设置 `ALLOW_DB_DROP=true` 才会执行。

**Nginx 配置要点（`deploy/nginx.conf`）：**
- `/api/` 请求代理到后端 `127.0.0.1:4000`，AI 接口超时设 600s
- 静态资源（js/css/图片）缓存 7 天
- 前端监听端口 8082（与已有服务不冲突）

### 方式二：前端 Cloudflare Pages + 后端独立服务器

前端已在 Cloudflare Pages 部署，后端单独放云服务器时适用。

**为什么不建议用 Pages Functions/Workers 代理 `/api`：**
AI 生题接口后端超时设为 30 分钟（见 `backend/src/routes/generate.js`），
Cloudflare 的代理层会在远小于此的时间内掐断连接，导致生题必失败。
用 Cloudflare Tunnel 直连服务器没有这个限制。

**步骤：**

1. 云服务器按「方式二」部署后端，只监听本地：PM2 启动后确认 `127.0.0.1:4000`
2. 服务器装 `cloudflared` 并配置 Tunnel，Public Hostname 指向 `localhost:4000`
3. 后端 `.env` 配置跨域白名单（**必填**，否则前端请求被浏览器拦截）：
   ```
   CORS_ORIGIN=https://你的项目.pages.dev,https://你的自定义域名
   ```
4. Cloudflare Pages 项目设置环境变量，然后重新部署：
   ```
   VITE_API_BASE_URL=https://api.你的域名
   ```

防火墙建议只开放 22 端口，4000/3306 都不需要对公网开放（Tunnel 走本地回环）。

### 数据库管理

```bash
# 手动备份（裸机 MySQL，自动从仓库根目录 .env 读取连接信息）
bash deploy/backup-db.sh

# Docker 中的 MySQL 备份
DB_CONTAINER=mysql-container bash deploy/backup-db.sh

# 自动备份（crontab 每天凌晨 3 点）
crontab -e
# 添加：0 3 * * * /home/user/ncse/deploy/backup-db.sh >> ~/backups/backup.log 2>&1

# 备份文件位置（保留最近 7 天）
ls -lh ~/backups/
```

当前生产环境（Cloudflare Pages + 云服务器 + PM2 + MySQL + Cloudflare Tunnel）的
架构说明、易错点、自测流程与运维命令见 [`docs/deployment-runbook.md`](docs/deployment-runbook.md)。

## 相比初始版本的更新

在初始版本基础上修复了计时器、路由冲突、统计加载、注册时间显示、昵称乱码、题目类型显示、批量删除外键约束等问题；新增题目搜索、排行榜、错题导出与错题本改进、AI 解析、个人资料页、批量删除、404 页面与错误边界、Token 过期自动验证；并做了管理接口角色白名单校验、昵称与邮箱长度限制、排行榜脱敏、AI 接口频率限制、禁用用户 Token 失效等安全加固，以及共享工具函数与数据库连接模块的抽取。
