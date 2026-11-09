/**
 * 数据库迁移执行器：按文件名顺序执行 db/migrations/*.sql。
 *
 * 安全性：
 *   - 只执行 ALTER TABLE / CREATE TABLE 这类增量语句，不删数据
 *   - 同一语句已应用过会报错（如重复列），这里识别为「已应用」并跳过，不中断
 *   - 因历史文件的排序依赖而失败的语句，会在全部迁移跑完后统一重试一轮
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
  const skippedFiles = new Set();
  // 迁移按文件名排序，但历史文件之间存在「靠前的文件引用靠后文件才创建的列」的
  // 顺序依赖（例如 add_paper_hidden.sql 用到 add_question_paper_reflow.sql 的
  // source_paper_id）。生产库列早已存在所以一直没暴露，全新空库首跑才会失败。
  // 对策：第一轮失败的语句先暂存，等全部文件跑完、结构齐全后再统一重试一轮。
  const deferred = [];

  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const stmts = splitStatements(sql);
    let deferredInFile = 0;
    for (const s of stmts) {
      try {
        await conn.query(s);
        applied++;
      } catch (err) {
        if (isAlreadyApplied(err.message)) { skipped++; skippedFiles.add(f); continue; }
        deferred.push({ f, s });
        deferredInFile++;
      }
    }
    console.log(`[migrate] ${f} ${deferredInFile ? `完成（${deferredInFile} 条延迟重试）` : '完成'}`);
  }

  if (deferred.length) {
    console.log(`[migrate] 结构补齐后重试 ${deferred.length} 条因迁移顺序失败的语句…`);
    for (const { f, s } of deferred) {
      try {
        await conn.query(s);
        applied++;
      } catch (err) {
        if (isAlreadyApplied(err.message)) { skipped++; skippedFiles.add(f); continue; }
        failed++;
        console.error(`[migrate] ${f} 重试后仍失败：${err.message}`);
        console.error(`  语句：${s.slice(0, 160)}`);
      }
    }
  }

  console.log(`[migrate] 共 ${files.length} 个迁移文件：成功 ${applied} 条，跳过（已存在）${skipped} 条，失败 ${failed} 条`);
  // 列出被跳过的文件，便于发现「永远不生效的死迁移」或结构漂移
  if (skippedFiles.size) {
    console.log(`[migrate] 因结构已存在而跳过：${[...skippedFiles].join(', ')}`);
  }
  await conn.end();
  if (failed > 0) throw new Error(`${failed} 条迁移语句执行失败，请检查上面的错误明细`);
  return { files: files.length, applied, skipped, failed };
}

// 直接运行：node scripts/migrate.js
// 被 db_init.js 引用：await main()，让「重建空库」一次就补齐全部增量结构
if (require.main === module) {
  main().catch((e) => { console.error('[migrate] 致命错误:', e.message); process.exit(1); });
}

module.exports = { main };
