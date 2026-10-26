#!/bin/bash
# ============================================
# 公务员考试刷题系统 - 一键部署脚本
# 适用环境: Ubuntu 24.04, 已安装 Node.js + MySQL + Nginx
# 用法: bash deploy.sh
# ============================================

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 项目路径（脚本所在目录的上级）
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"
# .env 必须放在仓库根目录：backend/src/server.js 与 scripts/*.js 都从根目录读取
ENV_FILE="$PROJECT_DIR/.env"

# ============ sync-backend: 仅拉取最新代码并热更新后端（日常同步用） ============
# 用法: bash deploy.sh sync-backend
# 仅做三件事：git pull --ff-only（拒绝分叉/覆盖）→ 安装生产依赖 → pm2 重启。
# 全量部署（建库/装前端/nginx/管理员）仍用无参数的 `bash deploy.sh`。
sync_backend() {
  info "同步后端到最新提交（仅 fast-forward，拒绝分叉/覆盖）..."
  cd "$PROJECT_DIR"
  git pull --ff-only

  info "安装生产依赖（仅在依赖变化时需要）..."
  cd "$BACKEND_DIR"
  npm install --omit=dev

  info "重启后端服务..."
  pm2 restart ncse-backend

  info "后端已同步并重启完成 ($(git rev-parse --short HEAD))"
  exit 0
}

# 子命令分发：sync-backend 走轻量同步，其余（含无参数）走全量部署
if [ "${1:-}" = "sync-backend" ]; then
  sync_backend
fi

info "项目路径: $PROJECT_DIR"

# ============ 1. 检查环境 ============
info "检查环境..."

# 兼容 nvm 安装的 Node.js（非交互 shell 下 PATH 可能不包含 nvm）
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "/usr/share/nvm/nvm.sh" ] && . "/usr/share/nvm/nvm.sh"

command -v node >/dev/null 2>&1 || error "未安装 Node.js，请先安装 Node.js 18+"
command -v npm >/dev/null 2>&1  || error "未安装 npm"
command -v mysql >/dev/null 2>&1 || error "未安装 MySQL 客户端"
command -v nginx >/dev/null 2>&1 || error "未安装 Nginx"

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
[ "$NODE_VER" -ge 18 ] || error "Node.js 版本过低 ($(node -v))，需要 18+"

info "Node.js: $(node -v), npm: $(npm -v)"

# ============ 2. 配置 .env ============
if [ ! -f "$ENV_FILE" ]; then
  warn ".env 文件不存在，从模板创建..."
  cp "$PROJECT_DIR/deploy/env.example" "$ENV_FILE"
  warn "请编辑 $ENV_FILE 填入你的实际配置（数据库密码、JWT密钥、CORS_ORIGIN 等）"
  warn "编辑完成后重新运行此脚本"
  exit 0
fi

info "使用现有 .env 配置: $ENV_FILE"

# 初始管理员不再使用公开默认凭据，部署前必须在 .env 中显式配置。
ADMIN_USERNAME=$(grep -E '^ADMIN_USERNAME=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | sed 's/\r$//')
ADMIN_EMAIL=$(grep -E '^ADMIN_EMAIL=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | sed 's/\r$//')
ADMIN_PASSWORD=$(grep -E '^ADMIN_PASSWORD=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | sed 's/\r$//')
[ -n "$ADMIN_USERNAME$ADMIN_EMAIL" ] || error "请在 $ENV_FILE 配置 ADMIN_USERNAME 或 ADMIN_EMAIL"
[ ${#ADMIN_PASSWORD} -ge 12 ] || error "请在 $ENV_FILE 配置至少 12 位的 ADMIN_PASSWORD"

# ============ 3. 创建数据库 ============
info "检查数据库..."

# 从 .env 读取数据库配置
DB_HOST=$(grep -E '^MYSQL_HOST=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
DB_PORT=$(grep -E '^MYSQL_PORT=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
DB_USER=$(grep -E '^MYSQL_USER=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
DB_PASS=$(grep -E '^MYSQL_PASSWORD=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
DB_NAME=$(grep -E '^MYSQL_DATABASE=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')

DB_PORT=${DB_PORT:-3306}

# 尝试创建数据库（如果不存在）
info "创建数据库 $DB_NAME（如不存在）..."
if [ -n "$DB_PASS" ]; then
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || {
    warn "数据库连接失败，请确认 MySQL 是否运行且 .env 中的密码正确"
    warn "你可以手动创建数据库: CREATE DATABASE ncse-practice-system CHARACTER SET utf8mb4;"
  }
else
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || true
fi

# 导入表结构（如果表不存在）
info "导入数据库表结构..."
if [ -n "$DB_PASS" ]; then
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$BACKEND_DIR/db/schema.sql" 2>/dev/null || warn "表结构导入失败（可能已存在，可忽略）"
else
  mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" < "$BACKEND_DIR/db/schema.sql" 2>/dev/null || true
fi

# 应用 migrations（幂等，已存在的表结构会报错，可忽略）
for migration in "$BACKEND_DIR"/db/migrations/*.sql; do
  [ -f "$migration" ] || continue
  info "应用迁移: $(basename "$migration")"
  if [ -n "$DB_PASS" ]; then
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$migration" 2>/dev/null || warn "迁移 $(basename "$migration") 跳过（可能已应用）"
  else
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" < "$migration" 2>/dev/null || true
  fi
done

# ============ 4. 安装依赖 ============
info "安装后端依赖..."
cd "$BACKEND_DIR"
npm install --production

info "安装前端依赖..."
cd "$FRONTEND_DIR"
npm install

# ============ 5. 构建前端 ============
info "构建前端..."
cd "$FRONTEND_DIR"
npm run build

# 验证构建产物
[ -d "$FRONTEND_DIR/dist" ] || error "前端构建失败，dist 目录不存在"
info "前端构建完成: $FRONTEND_DIR/dist"

# ============ 6. 安装 PM2（进程管理） ============
if ! command -v pm2 >/dev/null 2>&1; then
  info "安装 PM2 进程管理器..."
  npm install -g pm2
fi

# ============ 7. 启动后端 ============
info "启动后端服务..."
cd "$BACKEND_DIR"

# 停止旧进程（如果存在）
pm2 delete ncse-backend 2>/dev/null || true

# 用 PM2 启动，设置 NODE_ENV=production
NODE_ENV=production pm2 start src/server.js --name ncse-backend --time

# 设置开机自启
pm2 startup 2>/dev/null || true
pm2 save 2>/dev/null || true

info "后端已启动，PID: $(pm2 pid ncse-backend)"

# ============ 8. 配置 Nginx ============
info "配置 Nginx..."

sudo cp "$PROJECT_DIR/deploy/nginx.conf" /etc/nginx/sites-available/ncse-practice
sudo ln -sf /etc/nginx/sites-available/ncse-practice /etc/nginx/sites-enabled/

# 移除默认站点（如果存在）
sudo rm -f /etc/nginx/sites-enabled/default

# 测试并重载
if sudo nginx -t 2>/dev/null; then
  sudo systemctl reload nginx
  info "Nginx 配置已生效"
else
  error "Nginx 配置测试失败，请检查 /etc/nginx/sites-available/ncse-practice"
fi

# ============ 9. 创建管理员账号 ============
info "创建管理员账号..."
cd "$BACKEND_DIR"
node scripts/seed_admin.js || warn "管理员账号可能已存在"

# ============ 完成 ============
echo ""
echo "=========================================="
info "部署完成！"
echo "=========================================="
echo ""
echo "  访问地址: http://$(hostname -I | awk '{print $1}')"
echo ""
echo "  管理员账号已按 .env 中的配置创建或确认存在。"
echo ""
echo "  常用命令:"
echo "    查看后端状态: pm2 status"
echo "    查看后端日志: pm2 logs ncse-backend"
echo "    重启后端:     pm2 restart ncse-backend"
echo "    停止后端:     pm2 stop ncse-backend"
echo ""
echo "  ⚠️  请务必修改仓库根目录 .env 中的:"
echo "    - JWT_SECRET (改为随机强密钥)"
echo "    - MYSQL_PASSWORD (改为强密码)"
echo "    - CORS_ORIGIN (填前端域名，前后端不同域时必填)"
echo "    - ADMIN_PASSWORD（至少 12 位随机强密码）"
echo ""
