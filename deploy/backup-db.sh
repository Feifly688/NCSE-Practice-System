#!/bin/bash
# 数据库自动备份脚本
# 使用前请修改下方配置项

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=~/backups

# ===== 请根据实际情况修改以下配置 =====
DB_CONTAINER="mysql-container"    # MySQL 容器名，用 docker ps 查看
DB_USER="root"                    # 数据库用户名
DB_NAME="ncse-practice-system"    # 数据库名
# =====================================

# 创建备份目录
mkdir -p $BACKUP_DIR

# 备份数据库（需要输入密码）
echo "请输入 MySQL root 密码："
sudo docker exec -i $DB_CONTAINER mysqldump -u $DB_USER -p $DB_NAME | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# 保留最近 7 天的备份
find $BACKUP_DIR -name "db_*.sql.gz" -mtime +7 -delete

echo "备份完成: $BACKUP_DIR/db_$DATE.sql.gz"
ls -lh $BACKUP_DIR/db_$DATE.sql.gz
