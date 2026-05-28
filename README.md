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
