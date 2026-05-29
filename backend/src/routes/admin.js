const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { withConnection } = require('../db');

const router = express.Router();

router.use(requireAuth, requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      const [questionStats] = await conn.query("SELECT COUNT(*) as total, SUM(status='approved') as approved, SUM(status='pending_review') as pending, SUM(status='disabled') as disabled FROM question");
      const [userStats] = await conn.query("SELECT COUNT(*) as total, SUM(role='admin') as admins FROM user");
      const [articleStats] = await conn.query("SELECT COUNT(*) as total FROM article");
      const [sessionStats] = await conn.query("SELECT COUNT(*) as total FROM practice_session");
      return { questions: questionStats[0], users: userStats[0], articles: articleStats[0], sessions: sessionStats[0] };
    });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const offset = (page - 1) * pageSize;

    const data = await withConnection(async (conn) => {
      const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM user');
      const [rows] = await conn.query(
        `SELECT u.id, u.email, u.nickname, u.role, u.status, u.created_at,
         (SELECT COUNT(*) FROM practice_session ps WHERE ps.user_id = u.id) as practice_count,
         (SELECT ROUND(AVG(ps.score), 1) FROM practice_session ps WHERE ps.user_id = u.id) as avg_score
         FROM user u ORDER BY u.id DESC LIMIT ? OFFSET ?`,
        [pageSize, offset]
      );
      return { users: rows, total: countRows[0].total };
    });

    return res.json({ ...data, page, pageSize });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
  try {
    const { role, status } = req.body;
    const userId = Number(req.params.id);
    if (!userId || isNaN(userId)) return res.status(400).json({ error: '无效的用户ID' });
    const VALID_ROLES = ['user', 'admin'];
    const VALID_STATUSES = ['active', 'disabled'];
    if (role !== undefined && !VALID_ROLES.includes(role)) return res.status(400).json({ error: '无效的角色值' });
    if (status !== undefined && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: '无效的状态值' });

    await withConnection(async (conn) => {
      const updates = [];
      const params = [];
      if (role !== undefined) { updates.push('role = ?'); params.push(role); }
      if (status !== undefined) { updates.push('status = ?'); params.push(status); }
      if (updates.length === 0) throw Object.assign(new Error('没有要更新的字段'), { status: 400 });
      params.push(req.params.id);
      await conn.query('UPDATE user SET ' + updates.join(', ') + ' WHERE id = ?', params);
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!userId || isNaN(userId)) return res.status(400).json({ error: '无效的用户ID' });
    if (userId === req.user.userId) return res.status(400).json({ error: '不能删除自己的账号' });
    await withConnection(async (conn) => {
      await conn.query('DELETE FROM practice_answer WHERE session_id IN (SELECT id FROM practice_session WHERE user_id = ?)', [req.params.id]);
      await conn.query('DELETE FROM practice_session WHERE user_id = ?', [req.params.id]);
      await conn.query('DELETE FROM user WHERE id = ?', [req.params.id]);
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
