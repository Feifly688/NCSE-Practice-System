require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

// 用法:
//   node scripts/hash_password.js <新密码>             生成哈希（不写库）
//   node scripts/hash_password.js <新密码> --apply <用户名或邮箱>   生成并写入该用户
//
// 说明：user 表里存的是 bcrypt 哈希，不可逆，不能用 SQL 直接写明文。
//       本脚本生成正确的 bcrypt 哈希，可选直接更新到数据库。

(async () => {
  const args = process.argv.slice(2);
  const password = args[0];
  if (!password) {
    console.error('用法: node scripts/hash_password.js <新密码> [--apply <用户名或邮箱>]');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('密码至少6位');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  console.log('HASH=' + hash);

  const applyIndex = args.indexOf('--apply');
  if (applyIndex === -1) {
    console.log('\n未写入数据库。手动更新 SQL：');
    console.log(`UPDATE user SET password_hash = '${hash}' WHERE email = '用户邮箱';`);
    process.exit(0);
  }

  const identifier = args[applyIndex + 1];
  if (!identifier) {
    console.error('--apply 后需要跟用户名或邮箱');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4'
  });

  const [result] = await conn.query(
    'UPDATE user SET password_hash = ? WHERE username = ? OR email = ?',
    [hash, identifier, identifier]
  );

  if (result.affectedRows === 0) {
    console.error('未找到用户: ' + identifier);
    await conn.end();
    process.exit(1);
  }

  const [rows] = await conn.query('SELECT id, username, email, nickname, role, status FROM user WHERE username = ? OR email = ?', [identifier, identifier]);
  console.log('PASSWORD_UPDATED', rows[0]);
  await conn.end();
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
