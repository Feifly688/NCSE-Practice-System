require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4'
  });

  // First, remove duplicates keeping the latest
  const [result] = await conn.query(`
    DELETE a FROM article a
    INNER JOIN (
      SELECT source, title, MAX(id) AS keep_id
      FROM article
      GROUP BY source, title
    ) d ON a.source = d.source AND a.title = d.title AND a.id != d.keep_id
  `);
  console.log('Deleted duplicates:', result.affectedRows);

  // Then update fingerprints to be content-based
  const [all] = await conn.query('SELECT id, source, title FROM article');
  let updated = 0;
  for (const a of all) {
    const newFp = crypto.createHash('md5').update(a.source + '::' + a.title).digest('hex');
    await conn.query('UPDATE article SET fingerprint = ? WHERE id = ?', [newFp, a.id]);
    updated++;
  }
  console.log('Updated fingerprints:', updated);

  const [count] = await conn.query('SELECT COUNT(*) AS total FROM article');
  console.log('Articles remaining:', count[0].total);

  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });