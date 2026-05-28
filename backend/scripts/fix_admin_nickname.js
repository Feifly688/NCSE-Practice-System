require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4'
  });
  await c.query("UPDATE user SET nickname=_utf8mb4 x'E7AEA1E79086E59198' WHERE email='admin@example.com'");
  const [rows] = await c.query("SELECT id, email, nickname FROM user WHERE email='admin@example.com'");
  console.log(JSON.stringify(rows[0], null, 2));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });