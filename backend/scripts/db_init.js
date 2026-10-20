require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function env(k, fallback) {
  return process.env[k] || fallback;
}

(async () => {
  const host = env('MYSQL_HOST', '127.0.0.1');
  const port = Number(env('MYSQL_PORT', '3306'));
  const user = env('MYSQL_USER', 'root');
  const password = env('MYSQL_PASSWORD', '');
  const database = env('MYSQL_DATABASE', 'ncse');

  const connCfg = { host, port, user, password, charset: 'utf8mb4' };

  // Connect to MySQL server (no DB)
  const rootConn = await mysql.createConnection(connCfg);

  // 安全检查：DROP DATABASE 会清空所有数据，生产环境必须显式确认
  if (process.env.NODE_ENV === 'production') {
    if (process.env.ALLOW_DB_DROP !== 'true') {
      console.error('DB_INIT_ABORT: NODE_ENV=production 会删除整个数据库，已中止。');
      console.error('如确需重建，请设置 ALLOW_DB_DROP=true；日常建表请改用 db/schema.sql 导入。');
      await rootConn.end();
      process.exit(1);
    }
  }

  // Recreate database to avoid legacy encoding issues in dev setup
  await rootConn.query('DROP DATABASE IF EXISTS `' + database + '`');
  await rootConn.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await rootConn.end();

  // Connect to target DB and apply schema
  const dbConn = await mysql.createConnection({ ...connCfg, database, multipleStatements: true });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await dbConn.query(sql);
  await dbConn.end();

  console.log('DB_INIT_OK', { host, port, database });
})().catch((e) => {
  console.error('DB_INIT_FAIL', e.message);
  process.exit(1);
});
