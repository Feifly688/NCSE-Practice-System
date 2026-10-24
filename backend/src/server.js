const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const { withConnection, closePool } = require('./db');
const authRoutes = require('./routes/auth');
const questionRoutes = require('./routes/questions');
const practiceRoutes = require('./routes/practice');
const articleRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const generateRoutes = require('./routes/generate');
const statsRoutes = require('./routes/stats');
const examPaperRoutes = require('./routes/exampaper');
const examPaperTakeRoutes = require('./routes/exampaperTake');

const app = express();
const port = process.env.APP_PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

// 反向代理信任：生产环境 API 由 Cloudflare Tunnel（cloudflared）直接转发到本进程，
// 中间恰好 1 跳代理。不设置 trust proxy 时 express-rate-limit 会因读到
// X-Forwarded-For 却无法信任它而抛 ValidationError，且按 IP 限流会把所有用户
// 归为同一个出口 IP（隧道本机地址），导致误伤。
app.set('trust proxy', 1);

// CORS：开发环境允许 localhost:5173；生产环境由 CORS_ORIGIN 指定（前后端不同域时必填）
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (isProd && allowedOrigins.length === 0) {
  console.warn('WARNING: NODE_ENV=production but CORS_ORIGIN is not set, cross-origin requests will be blocked');
}

app.use(
  cors({
    origin: isProd ? allowedOrigins : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true
  })
);

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
app.use('/api/stats', statsRoutes);
app.use('/api/admin/exam-papers', examPaperRoutes);
// 用户端：整卷阅览与答题（/api/exam-papers）
app.use('/api/exam-papers', examPaperTakeRoutes);

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
// 前端部署在 Cloudflare Pages 时可留空 FRONTEND_DIST，跳过静态托管（后端只提供 /api）
if (isProd) {
  const frontendDist = process.env.FRONTEND_DIST || path.resolve(__dirname, '../../frontend/dist');
  console.log('[STATIC] Serving frontend from:', frontendDist);
  const fs = require('fs');
  console.log('[STATIC] index.html exists:', fs.existsSync(path.join(frontendDist, 'index.html')));

  if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
    app.use(express.static(frontendDist));
    // SPA fallback：所有非 /api 的请求都返回 index.html
    app.get('*', (req, res) => {
      const indexPath = path.join(frontendDist, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error('[STATIC] sendFile error:', err.message);
          res.status(500).json({ error: 'Failed to serve frontend' });
        }
      });
    });
  } else {
    // 前端由 Cloudflare Pages 托管时，未匹配 /api 的请求直接返回 404，避免误导
    console.warn('[STATIC] frontend dist not found, static hosting disabled (API-only mode)');
    app.use('*', (req, _res, next) => {
      if (req.path.startsWith('/api')) return next();
      return next();
    });
  }
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
