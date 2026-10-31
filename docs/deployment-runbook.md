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
JWT_EXPIRES_IN=7d            # 勾选「记住我」时的 token 有效期
JWT_EXPIRES_SHORT=2h         # 未勾选时的短有效期（公共设备）
CORS_ORIGIN=https://<前端域名>
COOKIE_SAMESITE=none          # ★ 前后端不同域时必须 none，同源部署可留 lax
ADMIN_USERNAME=<管理员用户名>
ADMIN_PASSWORD=<至少12位随机强密码>
```

`JWT_EXPIRES_IN` 与 `JWT_EXPIRES_SHORT` 支持 `s`/`m`/`h`/`d`/`w` 单位（如 `12h`、`30m`）。前端提示文案由后端 `GET /api/auth/session-policy` 动态下发，改这两个变量后前端文案自动同步，**无需改动前端代码**。修改后需重启后端进程；已签发的 token 仍按签发时的有效期执行。

未勾选「记住我」时使用短有效期，登录 2 小时后需重新登录——这是共享电脑场景下的预期行为。

「记住我」同时控制服务端有效期与 Cookie 属性，二者需一致才形成闭环：

| 登录选择 | 服务端 token 有效期 | Cookie 属性 | 关闭浏览器后 |
|---|---|---|---|
| 勾选「记住我」 | `JWT_EXPIRES_IN`（7d） | 带 `Max-Age` 的持久 Cookie | 仍保持登录 |
| 未勾选 | `JWT_EXPIRES_SHORT`（2h） | 会话 Cookie（无 `Max-Age`） | 失效，需重新登录 |

### 登录凭据存放方式（重要）

token 保存在服务端下发的 **httpOnly Cookie**（`ncse_token`）里，前端 JS 读不到。
页面里任何一处 XSS 都偷不走 token——这是从 localStorage 迁到 Cookie 的主要目的。
前端本地只保存昵称、角色、到期时间等展示信息，**不保存任何凭据**。

由此带来的两个必配项：

- `JWT_SECRET` 必须 ≥32 字符。新版后端启动时强校验，不满足会**直接退出并拒绝启动**
  （弱密钥可被离线爆破，进而伪造任意用户甚至管理员的 token）。
  生成方式：`openssl rand -hex 32`。更换密钥会让所有已登录用户需要重新登录。
- `COOKIE_SAMESITE=none`（前后端不同域时）。`SameSite=Lax` 下浏览器对 `<img>` 这类
  **跨站子资源请求不会带 Cookie**，表现为「登录后立刻掉线」「题目截图全部 404/401」。
  `SameSite=none` 强制要求 Secure，生产环境（`NODE_ENV=production`）会自动开启。
  同源部署保持默认 `lax` 即可，安全性最好。

### CSRF 防护

状态变更接口（POST/PUT/PATCH/DELETE）会校验请求来源：

- 带 `Authorization: Bearer` 头的请求豁免（API 客户端、curl、脚本不受影响）
- 浏览器请求按 `Origin` 白名单（与 `CORS_ORIGIN` 同一份列表）+ `Sec-Fetch-Site` 判定

默认拒绝「既没有 Origin 也没有 Sec-Fetch-Site」的请求。若客户端很老、不发这两个头，
可设 `CSRF_TRUST_MISSING_ORIGIN=true` 放行（会略微降低防护强度）。

管理员可改用 `ADMIN_EMAIL`，但 `ADMIN_USERNAME` 与 `ADMIN_EMAIL` 至少需要配置一个。AI 功能需要额外设置 `API_KEY`、`BASE_URL` 和 `MODEL`。

## 日常同步（后端热更新）

代码有更新时，在服务器上执行：

```bash
cd <项目目录>
bash deploy/deploy.sh sync-backend
```

该子命令会依次完成：拉取代码（仅 fast-forward）→ 安装生产依赖 →
**环境变量体检**（JWT_SECRET 强度、跨站部署的 COOKIE_SAMESITE）→
**执行数据库迁移**（幂等）→ 重启 PM2 → 检查进程是否 online。

环境变量体检会在配置有问题时**主动中止**并给出修复指引，
避免出现「服务起不来」或「登录后立刻掉线」这类难排查的现象。

### 数据库迁移

```bash
cd backend && npm run db:migrate
```

按文件名顺序执行 `db/migrations/*.sql`，只做增量语句，重复执行安全。
**切勿在有数据的库上执行 `npm run db:init`**（它会先 DROP DATABASE 清空数据）。

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
