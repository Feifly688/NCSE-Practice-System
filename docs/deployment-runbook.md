# NCSE 通用部署与运维手册

本文档仅保留可复用的部署步骤。服务器名称、IP、域名、Tunnel ID、账号、密码和备份路径必须保存在服务器本地的私有运维记录中，不应提交到仓库。

## 部署架构

- 前端：Cloudflare Pages 或 Nginx 静态托管
- 后端：Node.js + PM2
- 数据库：MySQL，仅监听本地回环地址
- 外网访问（可选）：Cloudflare Tunnel

## 环境变量

从 `deploy/env.example` 复制到仓库根目录的 `.env`，再填入真实值。`.env` 绝不能提交。

```bash
cp deploy/env.example .env
```

部署前至少检查：

```bash
NODE_ENV=production
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=<数据库用户>
MYSQL_PASSWORD=<数据库密码>
MYSQL_DATABASE=ncse-practice-system
JWT_SECRET=<openssl rand -hex 32 生成的随机值>
CORS_ORIGIN=https://<前端域名>
ADMIN_USERNAME=<管理员用户名>
ADMIN_PASSWORD=<至少12位随机强密码>
```

管理员可改用 `ADMIN_EMAIL`，但 `ADMIN_USERNAME` 与 `ADMIN_EMAIL` 至少需要配置一个。AI 功能需要额外设置 `API_KEY`、`BASE_URL` 和 `MODEL`。

## 前端配置

Cloudflare Pages 的构建目录为 `frontend`，构建命令为：

```bash
npm install
npm run build
```

前后端不同域时，在 Pages 环境变量中配置：

```bash
VITE_API_BASE_URL=https://<API 域名>/api
```

该值必须包含 `/api`，否则登录等接口会返回 404。

## 后端部署

```bash
cd <项目目录>/backend
npm install --production
NODE_ENV=production pm2 start src/server.js --name ncse-backend --time
pm2 save
```

更新后端代码时：

```bash
git pull origin main
cd backend
npm install --production
pm2 restart ncse-backend
```

仅修改 `frontend/` 时，推送代码后由 Cloudflare Pages 重新构建。

## 连通性检查

按顺序检查，前一层失败时先修复该层：

```bash
# 数据库
mysql -u <数据库用户> -p <数据库名> -e "SHOW TABLES;"

# 后端进程与本地接口
pm2 status
curl http://127.0.0.1:4000/api/health

# 公网 API（替换为实际域名）
curl https://<API 域名>/api/health
```

浏览器中确认注册、登录、进入 Dashboard、答题与后台统计均可用。

## 安全基线

- 不提交 `.env`、日志、IDE/AI 工具配置、数据库备份或用户导出文件。
- MySQL 与应用端口只监听 `127.0.0.1`；不要对公网开放 3306 或 4000。
- 防火墙仅按需开放 SSH 等管理端口。
- 定期执行 `bash deploy/backup-db.sh`，备份文件保存在服务器私有目录。
- 公开仓库中不得记录真实域名、服务器标识、Tunnel 凭据、用户账号或令牌。
