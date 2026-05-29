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

info "项目路径: $PROJECT_DIR"

# ============ 1. 检查环境 ============
info "检查环境..."

command -v node >/dev/null 2>&1 || error "未安装 Node.js，请先安装 Node.js 18+"
command -v npm >/dev/null 2>&1  || error "未安装 npm"
command -v mysql >/dev/null 2>&1 || error "未安装 MySQL 客户端"
command -v nginx >/dev/null 2>&1 || error "未安装 Nginx"

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
[ "$NODE_VER" -ge 18 ] || error "Node.js 版本过低 ($(node -v))，需要 18+"

info "Node.js: $(node -v), npm: $(npm -v)"

# ============ 2. 配置 .env ============
if [ ! -f "$BACKEND_DIR/.env" ]; then
  warn ".env 文件不存在，从模板创建..."
  cp "$PROJECT_DIR/deploy/env.example" "$BACKEND_DIR/.env"
  warn "请编辑 $BACKEND_DIR/.env 填入你的实际配置（数据库密码、JWT密钥等）"
  warn "编辑完成后重新运行此脚本"
  exit 0
fi

info "使用现有 .env 配置"

# ============ 3. 创建数据库 ============
info "检查数据库..."

# 从 .env 读取数据库配置
DB_HOST=$(grep MYSQL_HOST "$BACKEND_DIR/.env" | cut -d'=' -f2 | tr -d ' ')
DB_PORT=$(grep MYSQL_PORT "$BACKEND_DIR/.env" | cut -d'=' -f2 | tr -d ' ')
DB_USER=$(grep MYSQL_USER "$BACKEND_DIR/.env" | cut -d'=' -f2 | tr -d ' ')
DB_PASS=$(grep MYSQL_PASSWORD "$BACKEND_DIR/.env" | cut -d'=' -f2 | tr -d ' ')
DB_NAME=$(grep MYSQL_DATABASE "$BACKEND_DIR/.env" | cut -d'=' -f2 | tr -d ' ')

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
echo "  默认管理员:"
echo "    邮箱: admin@example.com"
echo "    密码: Admin@12345"
echo ""
echo "  常用命令:"
echo "    查看后端状态: pm2 status"
echo "    查看后端日志: pm2 logs ncse-backend"
echo "    重启后端:     pm2 restart ncse-backend"
echo "    停止后端:     pm2 stop ncse-backend"
echo ""
echo "  ⚠️  请务必修改 backend/.env 中的:"
echo "    - JWT_SECRET (改为随机强密钥)"
echo "    - MYSQL_PASSWORD (改为强密码)"
echo "    - 默认管理员密码"
echo ""
