require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const nickname = process.env.ADMIN_NICKNAME || '管理员';
  const password = process.env.ADMIN_PASSWORD || 'Admin@12345';

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4'
  });

  const [rows] = await conn.query('SELECT id FROM `user` WHERE email = ?', [email]);
  if (rows.length > 0) {
    console.log('ADMIN_EXISTS', { email });
  } else {
    const hash = await bcrypt.hash(password, 10);
    await conn.query(
      'INSERT INTO `user` (email, nickname, password_hash, role, status) VALUES (?,?,?,?,?)',
      [email, nickname, hash, 'admin', 'active']
    );
    console.log('ADMIN_CREATED', { email });
  }

  await conn.end();
})().catch((e) => {
  console.error('SEED_ADMIN_FAIL', e.message);
  process.exit(1);
});
