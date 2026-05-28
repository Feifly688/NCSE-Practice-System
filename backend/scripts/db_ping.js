require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE
    });
    const [rows] = await conn.query('SELECT @@version AS version, CURRENT_USER() AS `current_user`');
    await conn.end();
    console.log('DB_OK', rows[0]);
  } catch (e) {
    console.error('DB_FAIL', e.message);
    process.exit(1);
  }
})();


