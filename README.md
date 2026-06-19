# NCSE 公务员考试刷题系统

公务员考试在线练习平台，支持单选题练习、模拟考试、错题本、收藏、排行榜等功能。

## 环境要求

- Node.js >= 18
- MySQL 8.0

## 快速开始

### 1. 配置数据库

复制 `.env.example` 为 `backend/.env`，填入 MySQL 连接信息：

```
cp .env.example backend/.env
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
│   ├── db/               数据库 schema
│   ├── scripts/          初始化脚本
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
└── .env.example          环境变量模板
```

## 角色权限

- 游客：浏览首页，不能答题
- 用户：答题、查看历史、错题本、收藏、排行榜
- 管理员：题目管理、文章管理、用户管理、AI 生成题目

## 项目配置

### 后端配置 (`backend/.env`)

基于 `deploy/env.example` 或 `.env.example` 创建：

| 变量 | 说明 | 必填 |
|------|------|------|
| `MYSQL_HOST` | MySQL 地址（Docker 部署填容器名） | 是 |
| `MYSQL_PORT` | MySQL 端口，默认 3306 | 是 |
| `MYSQL_USER` | 数据库用户，默认 root | 是 |
| `MYSQL_PASSWORD` | 数据库密码 | 是 |
| `MYSQL_DATABASE` | 数据库名，默认 `ncse-practice-system` | 是 |
| `APP_PORT` | 后端端口，默认 4000 | 否 |
| `JWT_SECRET` | JWT 签名密钥（**必须改为随机强密钥**） | 是 |
| `MIMO_API_KEY` | AI 解析/生题的 API Key（留空禁用 AI 功能） | 否 |
| `MIMO_BASE_URL` | AI API 地址，默认 `https://token-plan-cn.xiaomimimo.com/v1` | 否 |

> 生成随机 JWT 密钥：`openssl rand -hex 32`

### 前端配置 (`frontend/.env`)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_BASE_URL` | API 请求前缀 | `/api` |

开发环境通过 Vite 代理转发到 `http://localhost:4000`（在 `vite.config.js` 中配置）。

## 部署流程

### 方式一：Docker Compose（推荐）

适用于 Linux 服务器，一键启动所有服务：

```bash
# 1. 克隆项目
git clone <项目地址> && cd NCSE-Practice-System

# 2. 配置环境变量
cp deploy/env.example backend/.env
# 编辑 backend/.env，填入数据库密码、JWT_SECRET 等

# 3. 启动全部服务
docker compose up -d
```

服务说明：
- **backend** — Node.js 后端，监听 `127.0.0.1:4000`
- **frontend-builder** — 构建前端静态文件到命名卷 `frontend_dist`，构建后退出
- **MySQL** — 需外部运行（生产环境建议使用托管数据库或独立 MySQL 容器）

访问地址：`http://<服务器IP>:8082`

#### Docker 部署常用命令

```bash
# 查看容器状态
docker ps

# 重启后端
docker compose restart backend

# 查看后端日志
docker logs ncse-backend --tail 50

# 更新代码后重新构建
docker compose down
docker compose up -d --build
```

### 方式二：裸机部署（PM2 + Nginx）

适用于已安装 Node.js 18+ 和 MySQL 8.0 的服务器。

**一键部署脚本：**

```bash
cd deploy
bash deploy.sh
```

脚本自动完成以下步骤：

1. 检查环境（Node.js ≥ 18、npm、MySQL 客户端、Nginx）
2. 从 `deploy/env.example` 生成 `backend/.env`（如不存在）
3. 创建数据库并导入 `db/schema.sql` 表结构
4. 安装前后端依赖
5. 构建前端（输出到 `frontend/dist`）
6. 使用 PM2 启动后端，配置开机自启
7. 配置 Nginx 站点（反向代理到 `127.0.0.1:4000`）
8. 创建默认管理员账号

**手动部署步骤：**

```bash
# 1. 配置
cp deploy/env.example backend/.env
# 编辑 backend/.env 填入数据库密码、JWT_SECRET

# 2. 初始化数据库
cd backend
npm install
npm run db:init          # 创建库和表
npm run seed:admin       # 创建管理员
npm run seed:questions   # （可选）导入示例题目

# 3. 构建前端
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

**Nginx 配置要点（`deploy/nginx.conf`）：**
- `/api/` 请求代理到后端 `127.0.0.1:4000`，AI 接口超时设 600s
- 静态资源（js/css/图片）缓存 7 天
- 前端监听端口 8082（与已有服务不冲突）

### 数据库管理

```bash
# 手动备份
cd ~ && bash backup.sh

# 自动备份（crontab 每天凌晨 3 点）
crontab -l

# 备份文件位置
ls -lh ~/backups/
```

详细运维指南见 [`docs/server-guide.md`](docs/server-guide.md)。

## 相比初始版本的更新

### Bug 修复
- 修复考试模式下仍可暂停计时的问题
- 修复提交失败后计时器停止工作的 bug
- 修复首页显示 404 的路由冲突问题
- 修复 Dashboard 统计加载失败无提示的问题
- 修复用户注册时间显示为 "-" 的问题
- 修复管理员昵称乱码问题
- 修复题目类型显示为英文的问题
- 修复批量删除因外键约束失败的问题

### 新增功能
- 题目搜索（关键词搜索题干/解析）
- 成绩排行榜（Top 50 用户排名）
- 错题导出（生成可打印 HTML）
- 错题本改进：答对自动移出 / 手动移出 / 重做错题不计时
- AI 个性化解析（基于 MIMO 大模型）
- 个人信息独立页面（编辑昵称/邮箱、修改密码）
- 题目批量删除
- 404 页面、ErrorBoundary 错误边界
- Token 过期自动验证

### 安全加固
- 管理员接口增加角色/状态白名单校验
- 昵称长度限制（50字符）、邮箱长度限制（100字符）
- 排行榜不再暴露用户邮箱
- AI 解析接口添加频率限制（每用户 5次/分钟）
- 已禁用用户的 Token 自动失效

### 代码优化
- 提取共享工具函数（parseOptions、cleanOption、formatTime）
- 提取共享数据库连接模块（backend/src/db.js）
- 移除冗余的 console 语句
- 前端表格统一使用 Ant Design Table 组件
