require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { withConnection, closePool } = require('./db');
const authRoutes = require('./routes/auth');
const questionRoutes = require('./routes/questions');
const practiceRoutes = require('./routes/practice');
const articleRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const generateRoutes = require('./routes/generate');

const app = express();
const port = process.env.APP_PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

// CORS：开发环境允许 localhost:5173，生产环境由 nginx 代理所以允许所有
if (!isProd) {
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true }));
}

app.use(express.json({ limit: '2mb' }));

// 请求日志
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}`);
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/practice', practiceRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/generate', generateRoutes);

// Health 端点
app.get('/api/health', async (_req, res) => {
  try {
    await withConnection(async (conn) => {
      await conn.query('SELECT 1');
    });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'database connection failed' });
  }
});

// 生产环境：托管前端静态文件
if (isProd) {
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  // SPA fallback：所有非 /api 的请求都返回 index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// 全局错误处理中间件
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.stack || err.message || err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? '服务器内部错误' : err.message });
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

const server = app.listen(port, () => {
  console.log(`backend listening on http://localhost:${port} [${isProd ? 'production' : 'development'}]`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  server.close();
  await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  server.close();
  await closePool();
  process.exit(0);
});
