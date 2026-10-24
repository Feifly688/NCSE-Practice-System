/**
 * 临时提权脚本：把指定用户名设为 admin（用于端到端验证），用完即删。
 * 用法：node scripts/tmp_promote.js <username> admin|user
 */
require('dotenv').config({ path: '/root/ncse/.env' });
const { withConnection, closePool } = require('../src/db');

async function main() {
  const username = process.argv[2];
  const role = process.argv[3] || 'admin';
  if (!username) { console.error('用法: node scripts/tmp_promote.js <username> [role]'); process.exit(1); }
  await withConnection(async (conn) => {
    const [r] = await conn.query('UPDATE `user` SET role = ? WHERE username = ?', [role, username]);
    console.log('updated rows:', r.affectedRows);
    const [rows] = await conn.query('SELECT id, username, role FROM `user` WHERE username = ?', [username]);
    console.log(JSON.stringify(rows));
  });
  await closePool();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
