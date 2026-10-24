const jwt = require('jsonwebtoken');
const { withConnection } = require('../db');
const { resolveExpiresIn } = require('../lib/tokenPolicy');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_local_secret';
if (!process.env.JWT_SECRET) console.warn('WARNING: JWT_SECRET not set in .env, using fallback (insecure for production)');

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
// 同时从数据库获取最新 role，防止降级后旧 token 仍有效
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);

    // 从数据库获取最新状态和角色
    const user = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT status, role FROM `user` WHERE id = ?', [payload.userId]);
      return rows[0] || null;
    });

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }
    if (user.status === 'disabled') {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    // 使用数据库中的最新 role，而非 JWT 中的旧值
    req.user = { userId: payload.userId, email: payload.email, role: user.role };
    return next();
  } catch (_) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

/**
 * requireAuth 的宽松变体：额外接受 ?t=<token> 查询参数。
 *
 * 用途：<img src> 这类标签无法携带 Authorization 头，题目截图必须走这种形式。
 * 只在图片这类 GET 静态资源路由上使用，不要给业务接口开这个口子
 * （URL 里的 token 会进日志与 Referer）。
 */
async function requireAuthOrToken(req, res, next) {
  const header = req.headers.authorization;
  let token = null;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query && typeof req.query.t === 'string' && req.query.t.length > 10) {
    token = req.query.t;
  }
  if (!token) return res.status(401).json({ error: '未登录' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT status, role FROM `user` WHERE id = ?', [payload.userId]);
      return rows[0] || null;
    });
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (user.status === 'disabled') return res.status(403).json({ error: '账号已被禁用' });
    req.user = { userId: payload.userId, email: payload.email, role: user.role };
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

// Token 有效期策略见 lib/tokenPolicy.js：
//   勾选「记住我」→ JWT_EXPIRES_IN（默认 7d），日常使用不必频繁登录
//   未勾选        → JWT_EXPIRES_SHORT（默认 2h），公共设备/共享浏览器自动收敛风险
// 未传 remember 字段的老客户端按长有效期处理，保持向后兼容。

function signToken(user, options = {}) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: resolveExpiresIn(options) }
  );
}

module.exports = { optionalAuth, requireAuth, requireAuthOrToken, requireAdmin, signToken };
