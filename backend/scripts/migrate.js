/**
 * 数据库迁移执行器：按文件名顺序执行 db/migrations/*.sql。
 *
 * 安全性：
 *   - 只执行 ALTER TABLE / CREATE TABLE 这类增量语句，不删数据
 *   - 同一语句已应用过会报错（如重复列），这里识别为「已应用」并跳过，不中断
 *   - 生产环境可安全重复执行
 *
 * 用法：node scripts/migrate.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

/** 把一份 .sql 按分号切成语句（跳过注释行） */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 判定为「该结构已存在」的错误 → 可跳过 */
function isAlreadyApplied(msg) {
  return /Duplicate column name|Duplicate key name|already exists|Unknown database/i.test(msg);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'ncse',
    charset: 'utf8mb4',
    multipleStatements: false,
  });

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const stmts = splitStatements(sql);
    let fileOk = true;
    for (const s of stmts) {
      try {
        await conn.query(s);
        applied++;
      } catch (err) {
        if (isAlreadyApplied(err.message)) { skipped++; continue; }
        fileOk = false;
        failed++;
        console.error(`[migrate] ${f} 执行失败：${err.message}`);
        console.error(`  语句：${s.slice(0, 160)}`);
      }
    }
    console.log(`[migrate] ${f} ${fileOk ? '完成' : '部分失败'}`);
  }

  console.log(`[migrate] 共 ${files.length} 个迁移文件：成功 ${applied} 条，跳过（已存在）${skipped} 条，失败 ${failed} 条`);
  await conn.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('[migrate] 致命错误:', e.message); process.exit(1); });
