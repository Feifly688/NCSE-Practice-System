require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const authRoutes = require('./routes/auth');
const questionRoutes = require('./routes/questions');
const practiceRoutes = require('./routes/practice');
const articleRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const generateRoutes = require('./routes/generate');

const app = express();
const port = process.env.APP_PORT || 4000;

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true }));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/practice', practiceRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/generate', generateRoutes);

app.get('/api/health', async (_req, res) => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      charset: 'utf8mb4'
    });
    const [rows] = await conn.query('SELECT @@version AS version, CURRENT_USER() AS `current_user`');
    await conn.end();
    return res.json({ ok: true, db: rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.listen(port, () => {
  console.log(`backend listening on http://localhost:${port}`);
});
