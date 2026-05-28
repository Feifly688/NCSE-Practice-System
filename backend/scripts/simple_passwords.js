require('dotenv').config();
const bcrypt = require('bcryptjs');
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

  // Admin password: admin123
  const adminHash = await bcrypt.hash('admin123', 10);
  await c.query("UPDATE user SET password_hash=? WHERE email='admin@example.com'", [adminHash]);
  
  // Test user password: test123
  const testHash = await bcrypt.hash('test123', 10);
  await c.query("UPDATE user SET password_hash=? WHERE email='test@test.com'", [testHash]);

  const [rows] = await c.query("SELECT id, email, nickname, role FROM user");
  console.log('All users:');
  rows.forEach(r => console.log(`  ${r.email} / ${r.role} / ${r.nickname}`));
  
  console.log('\nPasswords updated:');
  console.log('  admin@example.com  -> admin123');
  console.log('  test@test.com      -> test123');
  
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });