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
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, nickname } = req.body;
    if (!email || !password || !nickname) return res.status(400).json({ error: '邮箱、密码和昵称不能为空' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const result = await withConnection(async (conn) => {
      const [existing] = await conn.query('SELECT id FROM `user` WHERE email = ?', [email]);
      if (existing.length > 0) return { conflict: true };

      const hash = await bcrypt.hash(password, 10);
      const [r] = await conn.query('INSERT INTO `user` (email, nickname, password_hash, role, status) VALUES (?,?,?,?,?)', [email, nickname, hash, 'user', 'active']);
      return { insertId: r.insertId };
    });

    if (result.conflict) return res.status(409).json({ error: '该邮箱已注册' });

    const user = { id: result.insertId, email, nickname, role: 'user', created_at: new Date().toISOString() };
    const token = signToken(user);
    return res.json({ token, user });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });

    const user = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT id, email, nickname, password_hash, role, status, created_at FROM `user` WHERE email = ?', [email]);
      return rows[0] || null;
    });

    if (!user) return res.status(401).json({ error: '邮箱或密码错误' });
    if (user.status === 'disabled') return res.status(403).json({ error: '账号已被禁用' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '邮箱或密码错误' });

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, email: user.email, nickname: user.nickname, role: user.role, created_at: user.created_at } });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT id, email, nickname, role, status, created_at FROM `user` WHERE id = ?', [req.user.userId]);
      return rows[0] || null;
    });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// PUT /api/auth/profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { nickname, email } = req.body;
    if (nickname && nickname.length > 50) return res.status(400).json({ error: '昵称不能超过50个字符' });
    if (email && email.length > 100) return res.status(400).json({ error: '邮箱不能超过100个字符' });

    await withConnection(async (conn) => {
      const updates = [];
      const params = [];
      if (nickname) { updates.push('nickname = ?'); params.push(nickname.trim()); }
      if (email) {
        const [existing] = await conn.query('SELECT id FROM `user` WHERE email = ? AND id != ?', [email, req.user.userId]);
        if (existing.length > 0) throw Object.assign(new Error('该邮箱已被使用'), { status: 409 });
        updates.push('email = ?'); params.push(email);
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
