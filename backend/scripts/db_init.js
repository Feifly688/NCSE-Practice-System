require('dotenv').config();
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
