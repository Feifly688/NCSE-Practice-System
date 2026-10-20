const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { requireAuth, signToken } = require('../middleware/auth');
const { withConnection } = require('../db');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '登录请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: '注册请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/register
// username 与 email 至少填一个，均可作为登录名
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, nickname, username } = req.body;
    if (!password || !nickname) return res.status(400).json({ error: '密码和昵称不能为空' });
    if (!email && !username) return res.status(400).json({ error: '用户名和邮箱至少填写一项' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (email && email.length > 100) return res.status(400).json({ error: '邮箱不能超过100个字符' });
    if (username) {
      if (username.length < 2 || username.length > 64) return res.status(400).json({ error: '用户名长度需为2-64个字符' });
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线、连字符和中文' });
    }
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const result = await withConnection(async (conn) => {
      if (username) {
        const [existing] = await conn.query('SELECT id FROM `user` WHERE username = ?', [username]);
        if (existing.length > 0) return { conflict: '该用户名已被使用' };
      }
      if (email) {
        const [existing] = await conn.query('SELECT id FROM `user` WHERE email = ?', [email]);
        if (existing.length > 0) return { conflict: '该邮箱已被注册' };
      }

      const hash = await bcrypt.hash(password, 10);
      const [r] = await conn.query('INSERT INTO `user` (username, email, nickname, password_hash, role, status) VALUES (?,?,?,?,?,?)', [username || null, email || null, nickname, hash, 'user', 'active']);
      return { insertId: r.insertId };
    });

    if (result.conflict) return res.status(409).json({ error: result.conflict });

    const user = { id: result.insertId, username: username || null, email: email || null, nickname, role: 'user', created_at: new Date().toISOString() };
    const token = signToken(user);
    return res.json({ token, user });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/auth/login
// 支持用户名或邮箱登录：account 匹配 username 或 email
router.post('/login', loginLimiter, async (req, res) => {
  try {
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

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, username: user.username, email: user.email, nickname: user.nickname, role: user.role, created_at: user.created_at } });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT id, username, email, nickname, role, status, created_at FROM `user` WHERE id = ?', [req.user.userId]);
      return rows[0] || null;
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// PUT /api/auth/profile
// 可修改昵称、用户名、邮箱；用户名与邮箱均需唯一，且至少保留一个作为登录名
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { nickname, email, username } = req.body;
    if (nickname && nickname.length > 50) return res.status(400).json({ error: '昵称不能超过50个字符' });
    if (email && email.length > 100) return res.status(400).json({ error: '邮箱不能超过100个字符' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (username !== undefined) {
      if (username !== null && username !== '') {
        if (username.length < 2 || username.length > 64) return res.status(400).json({ error: '用户名长度需为2-64个字符' });
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线、连字符和中文' });
      }
    }

    await withConnection(async (conn) => {
      // 查询当前值，用于校验「至少保留一个登录名」
      const [current] = await conn.query('SELECT username, email FROM `user` WHERE id = ?', [req.user.userId]);
      if (current.length === 0) throw Object.assign(new Error('用户不存在'), { status: 404 });
      const nextEmail = email !== undefined ? (email || null) : current[0].email;
      const nextUsername = username !== undefined ? (username || null) : current[0].username;
      if (!nextEmail && !nextUsername) throw Object.assign(new Error('用户名和邮箱至少保留一项'), { status: 400 });

      const updates = [];
      const params = [];
      if (nickname) { updates.push('nickname = ?'); params.push(nickname.trim()); }
      if (username !== undefined) {
        if (nextUsername) {
          const [existing] = await conn.query('SELECT id FROM `user` WHERE username = ? AND id != ?', [nextUsername, req.user.userId]);
          if (existing.length > 0) throw Object.assign(new Error('该用户名已被使用'), { status: 409 });
        }
        updates.push('username = ?'); params.push(nextUsername);
      }
      if (email !== undefined) {
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
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || String(err) });
  }
});

// PUT /api/auth/password
router.put('/password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
    if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });

    await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT password_hash FROM `user` WHERE id = ?', [req.user.userId]);
      if (rows.length === 0) throw Object.assign(new Error('用户不存在'), { status: 404 });

      const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
      if (!ok) throw Object.assign(new Error('旧密码错误'), { status: 401 });

      const hash = await bcrypt.hash(newPassword, 10);
      await conn.query('UPDATE `user` SET password_hash = ? WHERE id = ?', [hash, req.user.userId]);
    });

    return res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || String(err) });
  }
});

module.exports = router;
