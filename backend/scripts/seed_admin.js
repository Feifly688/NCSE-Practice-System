require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const username = process.env.ADMIN_USERNAME || null;
  const email = process.env.ADMIN_EMAIL || null;
  const nickname = process.env.ADMIN_NICKNAME || '管理员';
  const password = process.env.ADMIN_PASSWORD;

  if (!username && !email) {
    throw new Error('ADMIN_USERNAME 或 ADMIN_EMAIL 至少需要配置一个');
  }
  if (!password || password.length < 12) {
    throw new Error('ADMIN_PASSWORD 必须配置，且长度不得少于 12 位');
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4'
  });

  const [rows] = await conn.query('SELECT id FROM `user` WHERE email = ? OR (username IS NOT NULL AND username = ?)', [email, username]);
  if (rows.length > 0) {
    console.log('ADMIN_EXISTS', { username, email });
  } else {
    const hash = await bcrypt.hash(password, 10);
    await conn.query(
      'INSERT INTO `user` (username, email, nickname, password_hash, role, status) VALUES (?,?,?,?,?,?)',
      [username, email, nickname, hash, 'admin', 'active']
    );
    console.log('ADMIN_CREATED', { username, email });
  }

  await conn.end();
})().catch((e) => {
  console.error('SEED_ADMIN_FAIL', e.message);
  process.exit(1);
});
