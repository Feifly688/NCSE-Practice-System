const jwt = require('jsonwebtoken');
const { getConnection } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_local_secret';

// optionalAuth: 有 token 就解析，没有就跳过
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next();
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { userId: payload.userId, email: payload.email, role: payload.role };
  } catch (_) {
    // token 无效就当游客
  }
  return next();
}

// requireAuth: 必须有有效 token 且用户未被禁用
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { userId: payload.userId, email: payload.email, role: payload.role };

    // 检查用户是否仍存在且未被禁用
    const conn = await getConnection();
    const [rows] = await conn.query('SELECT status FROM `user` WHERE id = ?', [payload.userId]);
    await conn.end();
    if (rows.length === 0 || rows[0].status === 'disabled') {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    return next();
  } catch (_) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// requireAdmin: 必须是管理员
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足' });
  }
  return next();
}

function signToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = { optionalAuth, requireAuth, requireAdmin, signToken };