#!/bin/bash
# 数据库自动备份脚本
# 支持两种模式：
#   1. 裸机 MySQL（默认）：直接调用 mysqldump，从 .env 读取连接信息
#   2. Docker MySQL：设置 DB_CONTAINER 环境变量即可
# 用法: bash backup-db.sh

set -u

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-~/backups}
PROJECT_DIR=${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
ENV_FILE="$PROJECT_DIR/.env"

# 从 .env 读取配置（.env 位于仓库根目录）
if [ -f "$ENV_FILE" ]; then
  DB_USER=$(grep -E '^MYSQL_USER=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
  DB_NAME=$(grep -E '^MYSQL_DATABASE=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
  DB_PASS=$(grep -E '^MYSQL_PASSWORD=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
  DB_HOST=$(grep -E '^MYSQL_HOST=' "$ENV_FILE" | head -1 | cut -d'=' -f2 | tr -d ' ')
fi

DB_CONTAINER=${DB_CONTAINER:-}          # 留空 = 裸机模式；填容器名 = Docker 模式
DB_USER=${DB_USER:-root}
DB_NAME=${DB_NAME:-ncse-practice-system}
DB_HOST=${DB_HOST:-127.0.0.1}

mkdir -p "$BACKUP_DIR"
OUT_FILE="$BACKUP_DIR/db_$DATE.sql.gz"

echo "开始备份数据库 $DB_NAME ..."

if [ -n "$DB_CONTAINER" ]; then
  # Docker 模式
  docker exec -i "$DB_CONTAINER" mysqldump -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" | gzip > "$OUT_FILE"
else
  # 裸机模式（密码通过临时默认文件传递，避免出现在命令行参数中）
  DEFAULTS_FILE=$(mktemp)
  chmod 600 "$DEFAULTS_FILE"
  printf '[client]\nhost=%s\nuser=%s\npassword=%s\n' "$DB_HOST" "$DB_USER" "$DB_PASS" > "$DEFAULTS_FILE"
  mysqldump --defaults-extra-file="$DEFAULTS_FILE" "$DB_NAME" | gzip > "$OUT_FILE"
  rm -f "$DEFAULTS_FILE"
fi

# 校验备份是否成功（gzip 流为空文件说明导出失败）
if [ ! -s "$OUT_FILE" ]; then
  echo "备份失败：$OUT_FILE 为空"
  rm -f "$OUT_FILE"
  exit 1
fi

# 保留最近 7 天的备份
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +7 -delete

echo "备份完成: $OUT_FILE"
ls -lh "$OUT_FILE"
