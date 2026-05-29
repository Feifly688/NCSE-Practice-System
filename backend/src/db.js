const mysql = require('mysql2/promise');

// 使用连接池替代单次连接，避免高并发下连接数耗尽
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// 获取连接（从池中获取）
async function getConnection() {
  return pool.getConnection();
}

// 自动管理连接生命周期，避免连接泄漏
async function withConnection(fn) {
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// 关闭连接池（优雅退出时调用）
async function closePool() {
  await pool.end();
}

module.exports = { getConnection, withConnection, closePool };
