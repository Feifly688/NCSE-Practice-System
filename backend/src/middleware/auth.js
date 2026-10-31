const jwt = require('jsonwebtoken');
const { withConnection } = require('../db');
const { resolveExpiresIn } = require('../lib/tokenPolicy');
const { COOKIE_TOKEN } = require('../lib/cookieConfig');

// JWT 签名密钥：必须有且足够强。
// 曾经这里是 `|| 'dev_local_secret'` —— 公开常量，任何人都能伪造任意用户（含 admin）
// 的 token 直接接管系统；短密钥同样可以离线爆破。现在改为启动即强校验。
// 生成：openssl rand -hex 32
// 本地开发若确实要用弱密钥，显式设 ALLOW_WEAK_JWT=true（生产环境该开关无效）。
const JWT_SECRET = process.env.JWT_SECRET || '';
const MIN_SECRET_LEN = 32;
const allowWeak = process.env.ALLOW_WEAK_JWT === 'true' && process.env.NODE_ENV !== 'production';

if (JWT_SECRET.length < MIN_SECRET_LEN) {
  if (!allowWeak) {
    console.error(
      `[FATAL] JWT_SECRET 未配置或强度不足（当前 ${JWT_SECRET.length} 字符，要求 >= ${MIN_SECRET_LEN}）。\n` +
      `        生成强密钥：openssl rand -hex 32\n` +
      `        本地开发如需临时放行，可设 ALLOW_WEAK_JWT=true（生产环境无效）。`
    );
    process.exit(1);
  }
  console.warn(
    `[SECURITY] 正在使用弱 JWT 密钥（${JWT_SECRET.length} 字符）。仅限本地开发，切勿用于生产。`
  );
}

/**
 * 从请求里提取 token，支持三条通道（按优先级）：
 *   ① Authorization: Bearer <token> —— API 客户端 / 脚本 / Postman，一直保留
 *   ② httpOnly Cookie                —— 浏览器 SPA 主通道，JS 读不到，防 XSS 窃取
 *   ③ ?t=<token> 查询参数            —— <img> 这类带不了头的场景
 *
 * 记录来源很关键：CSRF 校验只对「凭据来自 Cookie」的请求生效 ——
 * 攻击者能诱导浏览器自动带上 Cookie，但没法让浏览器伪造 Authorization 头。
 *
 * @returns {{ token: string|null, source: 'header'|'cookie'|'query'|null }}
 */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const t = header.slice(7).trim();
    if (t) return { token: t, source: 'header' };
  }
  if (req.cookies && req.cookies[COOKIE_TOKEN]) {
    const t = String(req.cookies[COOKIE_TOKEN]).trim();
    if (t) return { token: t, source: 'cookie' };
  }
  if (req.query && typeof req.query.t === 'string' && req.query.t.length > 10) {
    return { token: req.query.t, source: 'query' };
  }
  return { token: null, source: null };
}

// optionalAuth: 有 token 就解析，没有就跳过
function optionalAuth(req, res, next) {
  const { token } = extractToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { userId: payload.userId, email: payload.email, role: payload.role };
    req.authSource = 'header';
  } catch (_) {
    // token 无效就当游客
  }
  return next();
}

// requireAuth: 必须有有效 token 且用户未被禁用
// 同时从数据库获取最新 role，防止降级后旧 token 仍有效
async function requireAuth(req, res, next) {
  const { token, source } = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
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
    req.authSource = source;
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
  const { token, source } = extractToken(req);
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
    req.authSource = source;
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
