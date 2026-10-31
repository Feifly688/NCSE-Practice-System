const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { requireAuth, signToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { resolveExpiresIn, describeExpiresIn, longExpiresIn, shortExpiresIn, parseExpiresIn } = require('../lib/tokenPolicy');
const { COOKIE_TOKEN, resolveCookieOptions, clearCookieOptions } = require('../lib/cookieConfig');

const router = express.Router();

/**
 * 登录成功后把 token 写进 httpOnly Cookie。
 *
 * 为什么要 cookie 而不是只回给前端：
 *   token 一旦存进 localStorage / sessionStorage，页面里任何一处 XSS 都能
 *   把它读走并冒用用户身份。httpOnly Cookie 让 JS 读不到，XSS 偷不走。
 *
 * 有效期与「记住我」保持一致：
 *   · 勾选记住我 → cookie 带 maxAge（长有效期），关浏览器也在
 *   · 未勾选     → 会话 cookie（无 maxAge），关浏览器即失效
 *
 * 同时仍然把 token 放在响应体里返回，是为了让 API 客户端 / 脚本继续可用
 * （它们不跑浏览器，拿不到 Cookie）。浏览器端已改为不再持久化 token。
 */
function issueTokenCookie(res, token, remember) {
  const expiresIn = resolveExpiresIn({ remember });
  const ms = parseExpiresIn(expiresIn);
  // 未勾选「记住我」时用会话 cookie（maxAge 不传），与服务端短有效期语义一致
  const maxAgeMs = remember === false ? 0 : ms;
  res.cookie(COOKIE_TOKEN, token, resolveCookieOptions(maxAgeMs));
}

// 密码长度策略：6 位在当今算力下等同于明文（撞库 + 离线爆破都很快）。
// 上限设 128 位是因为 bcrypt 只取前 72 字节，过长的密码会被静默截断，
// 与其让用户以为设了超强密码，不如直接拒绝。
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// 限流说明：
//   只按 IP 限流时，一旦代理层（proxy-addr / X-Forwarded-For）被伪造或用户共用出口 IP，
//   要么被绕过、要么误伤一片。因此登录拆成两层：
//     · IP 层：挡住单 IP 的高频试探（含撞库扫全站账号）
//     · IP+账号 层：挡住针对单个账号的定向爆破（见下方 keyGenerator 注释）
//   两层取交集，任一超限即拒绝。
const loginIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: '登录请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginAccountLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: '该账号尝试次数过多，请 1 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  // 这层的 key 是「IP + 账号」的组合，不是纯账号。
  //
  // 纯账号限流有个明显副作用：攻击者只要持续用错误密码刷某个账号，
  // 就能让这个账号的真实用户永远登不进去（账号锁定 DoS）。
  // 换成 IP+账号 组合后：
  //   · 攻击者在自己 IP 上刷 → 只有他自己的组合被限，受害者换个网络照常登录
  //   · 分布式换 IP 爆破 → 由上面的 IP 层限流兜底
  // 账号不存在时回退纯 IP，避免用随机账号把内存里的桶撑爆。
  //
  // 注意不能用 skipFailedRequests —— 登录失败是 401，会被判为 failed 而不计数，
  // 那样爆破反而不消耗额度，限流形同虚设。这里所有请求一律计数。
  keyGenerator: (req) => {
    const account = String(req.body?.account ?? req.body?.email ?? '').trim().toLowerCase();
    // 用到 IP 时必须经 ipKeyGenerator 归一化（按 /64 子网聚合 IPv6），
    // 否则同一个 IPv6 段换一个地址就能绕过限流
    const ip = ipKeyGenerator(req.ip);
    return account ? `${ip}:acct:${account}` : `ip:${ip}`;
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: '注册请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/register
// 用户名为必填登录名，唯一不可重复；邮箱选填，作为备用登录名
router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const { email, password, nickname, username } = req.body;
  if (!username || !password || !nickname) return res.status(400).json({ error: '用户名、密码和昵称不能为空' });
  if (username.length < 2 || username.length > 64) return res.status(400).json({ error: '用户名长度需为2-64个字符' });
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线、连字符和中文' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (email && email.length > 100) return res.status(400).json({ error: '邮箱不能超过100个字符' });
  // 6 位纯数字密码在当今算力下几乎等于明文，且登录接口有撞库风险
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `密码不能超过 ${MAX_PASSWORD_LENGTH} 位` });
  }

  const result = await withConnection(async (conn) => {
    const [existingUser] = await conn.query('SELECT id FROM `user` WHERE username = ?', [username]);
    if (existingUser.length > 0) return { conflict: '该用户名已被使用' };
    if (email) {
      const [existing] = await conn.query('SELECT id FROM `user` WHERE email = ?', [email]);
      if (existing.length > 0) return { conflict: '该邮箱已被注册' };
    }

    const hash = await bcrypt.hash(password, 10);
    const [r] = await conn.query('INSERT INTO `user` (username, email, nickname, password_hash, role, status) VALUES (?,?,?,?,?,?)', [username, email || null, nickname, hash, 'user', 'active']);
    return { insertId: r.insertId };
  });

  if (result.conflict) return res.status(409).json({ error: result.conflict });

  const user = { id: result.insertId, username, email: email || null, nickname, role: 'user', created_at: new Date().toISOString() };
  const remember = req.body?.remember;
  const token = signToken(user, { remember });
  issueTokenCookie(res, token, remember);
  return res.json({ token, user, session: describeExpiresIn(resolveExpiresIn({ remember })) });
}));

// POST /api/auth/login
// 支持用户名或邮箱登录：account 匹配 username 或 email
router.post('/login', loginIpLimiter, loginAccountLimiter, asyncHandler(async (req, res) => {
  const { account, email, password } = req.body;
  // 兼容旧前端传 email 的调用方式
  const identifier = (account || email || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: '账号和密码不能为空' });

  const user = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, username, email, nickname, password_hash, role, status, created_at FROM `user` WHERE username = ? OR email = ? LIMIT 1', [identifier, identifier]);
    return rows[0] || null;
  });

  if (!user) return res.status(401).json({ error: '邮箱或密码错误' });
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已被禁用' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: '邮箱或密码错误' });

  const token = signToken(user, { remember: req.body?.remember });
  issueTokenCookie(res, token, req.body?.remember);
  return res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, nickname: user.nickname, role: user.role, created_at: user.created_at },
    session: describeExpiresIn(resolveExpiresIn({ remember: req.body?.remember })),
  });
}));

// POST /api/auth/logout
// 清除 httpOnly Cookie。之前的登出只是前端删本地 token，
// 服务端并不知道，Cookie 方案下必须有一个显式的登出端点。
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_TOKEN, clearCookieOptions());
  return res.json({ success: true });
});

// GET /api/auth/session-policy
// 公开端点：前端据此渲染「记住我」旁的时效提示，避免硬编码文案与后端配置脱节
router.get('/session-policy', (_req, res) => {
  return res.json({
    long: describeExpiresIn(longExpiresIn()),
    short: describeExpiresIn(shortExpiresIn()),
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, username, email, nickname, role, status, created_at FROM `user` WHERE id = ?', [req.user.userId]);
    return rows[0] || null;
  });
  if (!user) return res.status(404).json({ error: '用户不存在' });
  return res.json({ user });
}));

// PUT /api/auth/profile
// 仅修改昵称和邮箱；用户名（登录名）的变更走 PUT /api/auth/username
router.put('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { nickname, email } = req.body;
  if (req.body.username !== undefined) {
    return res.status(400).json({ error: '用户名请通过专门的修改入口变更' });
  }
  if (nickname && nickname.length > 50) return res.status(400).json({ error: '昵称不能超过50个字符' });
  if (email && email.length > 100) return res.status(400).json({ error: '邮箱不能超过100个字符' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });

  await withConnection(async (conn) => {
    const [current] = await conn.query('SELECT username, email FROM `user` WHERE id = ?', [req.user.userId]);
    if (current.length === 0) throw Object.assign(new Error('用户不存在'), { status: 404 });

    const updates = [];
    const params = [];
    if (nickname) { updates.push('nickname = ?'); params.push(nickname.trim()); }
    if (email !== undefined) {
      const nextEmail = email || null;
      if (nextEmail && !current[0].username) {
        throw Object.assign(new Error('用户名缺失时邮箱不能清空，需保留一个登录名'), { status: 400 });
      }
      if (nextEmail) {
        const [existing] = await conn.query('SELECT id FROM `user` WHERE email = ? AND id != ?', [nextEmail, req.user.userId]);
        if (existing.length > 0) throw Object.assign(new Error('该邮箱已被使用'), { status: 409 });
      }
      updates.push('email = ?'); params.push(nextEmail);
    }
    if (updates.length === 0) throw Object.assign(new Error('没有要更新的信息'), { status: 400 });
    params.push(req.user.userId);
    await conn.query('UPDATE `user` SET ' + updates.join(', ') + ' WHERE id = ?', params);
  });

  return res.json({ success: true });
}));

// PUT /api/auth/username
// 修改登录名（用户名），唯一不可重复
router.put('/username', requireAuth, asyncHandler(async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: '请输入新用户名' });
  if (username.length < 2 || username.length > 64) return res.status(400).json({ error: '用户名长度需为2-64个字符' });
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线、连字符和中文' });

  await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT username FROM `user` WHERE id = ?', [req.user.userId]);
    if (rows.length === 0) throw Object.assign(new Error('用户不存在'), { status: 404 });
    if (rows[0].username === username) throw Object.assign(new Error('新用户名与当前用户名相同'), { status: 400 });

    const [existing] = await conn.query('SELECT id FROM `user` WHERE username = ? AND id != ?', [username, req.user.userId]);
    if (existing.length > 0) throw Object.assign(new Error('该用户名已被使用'), { status: 409 });

    await conn.query('UPDATE `user` SET username = ? WHERE id = ?', [username, req.user.userId]);
  });

  return res.json({ success: true, username });
}));

// PUT /api/auth/password
router.put('/password', requireAuth, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` });
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `密码不能超过 ${MAX_PASSWORD_LENGTH} 位` });
  }
  await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT password_hash FROM `user` WHERE id = ?', [req.user.userId]);
    if (rows.length === 0) throw Object.assign(new Error('用户不存在'), { status: 404 });

    const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!ok) throw Object.assign(new Error('旧密码错误'), { status: 401 });

    const hash = await bcrypt.hash(newPassword, 10);
    await conn.query('UPDATE `user` SET password_hash = ? WHERE id = ?', [hash, req.user.userId]);
  });

  return res.json({ success: true });
}));

module.exports = router;
