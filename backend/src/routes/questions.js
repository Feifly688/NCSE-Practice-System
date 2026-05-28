const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getConnection } = require('../db');

const router = express.Router();

// ── 公开路由（仅需登录） ──────────────────────────────────

// GET /api/questions/random
router.get('/random', requireAuth, async (req, res) => {
  try {
    const count = Math.min(Number(req.query.count) || 10, 50);
    const subject = req.query.subject || null;

    const conn = await getConnection();
    const qtype = req.query.qtype || null;
    const difficulty = req.query.difficulty || null;

    let query = `SELECT q.id, q.subject_id, q.qtype, q.difficulty, q.passage, q.stem, q.options_json, 
      q.answer, q.explanation, q.source_exam, q.source_article_id,
      a.clean_text as article_text, a.title as article_title
      FROM question q 
      LEFT JOIN article a ON q.source_article_id = a.id
      WHERE q.status = 'approved'`;
    const params = [];

    if (subject) {
      query += ' AND q.subject_id = (SELECT id FROM subject WHERE slug = ?)';
      params.push(subject);
    }
    if (qtype) {
      query += ' AND q.qtype = ?';
      params.push(qtype);
    }
    if (difficulty) {
      query += ' AND q.difficulty = ?';
      params.push(Number(difficulty));
    }
    query += ' ORDER BY RAND() LIMIT ?';
    params.push(count);

    const [rows] = await conn.query(query, params);
    await conn.end();

    const questions = rows.map(q => {
      if (!q.passage && q.article_text) {
        q.passage = q.article_text.substring(0, 300);
      }
      return q;
    });

    return res.json({ questions });
  } catch (err) {
    console.error('Random questions error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/questions/subjects
router.get('/subjects', requireAuth, async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query('SELECT id, name, slug FROM subject ORDER BY id');
    await conn.end();
    return res.json({ subjects: rows });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// ── 管理员路由 ────────────────────────────────────────────

router.use(requireAuth, requireAdmin);

// GET /api/questions - admin list questions with filters
router.get('/', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const offset = (page - 1) * pageSize;
    const status = req.query.status || null;
    const qtype = req.query.qtype || null;
    const subjectId = req.query.subjectId || null;
    const keyword = req.query.keyword || null;

    const conn = await getConnection();

    let whereClause = ' WHERE 1=1';
    const params = [];

    if (status) { whereClause += ' AND q.status = ?'; params.push(status); }
    if (qtype) { whereClause += ' AND q.qtype = ?'; params.push(qtype); }
    if (subjectId) { whereClause += ' AND q.subject_id = ?'; params.push(subjectId); }
    if (keyword) { whereClause += ' AND (q.stem LIKE ? OR q.passage LIKE ? OR q.explanation LIKE ?)'; const like = '%' + keyword + '%'; params.push(like, like, like); }

    const countQuery = 'SELECT COUNT(*) AS total FROM question q' + whereClause;
    const query = `SELECT q.*, s.name AS subject_name, a.title AS article_title 
      FROM question q 
      LEFT JOIN subject s ON q.subject_id = s.id 
      LEFT JOIN article a ON q.source_article_id = a.id 
      ${whereClause} 
      ORDER BY q.id DESC LIMIT ? OFFSET ?`;

    const [countRows] = await conn.query(countQuery, params);
    const [rows] = await conn.query(query, [...params, pageSize, offset]);
    await conn.end();

    return res.json({ questions: rows, total: countRows[0].total, page, pageSize });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/questions/:id
router.get('/:id', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query(
      'SELECT q.*, s.name AS subject_name, a.title AS article_title FROM question q LEFT JOIN subject s ON q.subject_id = s.id LEFT JOIN article a ON q.source_article_id = a.id WHERE q.id = ?',
      [req.params.id]
    );
    await conn.end();
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    return res.json({ question: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// PUT /api/questions/:id
router.put('/:id', async (req, res) => {
  try {
    const { qtype, difficulty, stem, options, answer, explanation, status } = req.body;
    const conn = await getConnection();
    
    const updates = [];
    const params = [];
    
    if (qtype !== undefined) { updates.push('qtype = ?'); params.push(qtype); }
    if (difficulty !== undefined) { updates.push('difficulty = ?'); params.push(difficulty); }
    if (stem !== undefined) { updates.push('stem = ?'); params.push(stem); }
    if (options !== undefined) { updates.push('options_json = ?'); params.push(JSON.stringify(options)); }
    if (answer !== undefined) { updates.push('answer = ?'); params.push(answer); }
    if (explanation !== undefined) { updates.push('explanation = ?'); params.push(explanation); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    
    if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });
    
    params.push(req.params.id);
    await conn.query('UPDATE question SET ' + updates.join(', ') + ' WHERE id = ?', params);
    await conn.end();
    
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// DELETE /api/questions/:id
router.delete('/:id', async (req, res) => {
  try {
    const conn = await getConnection();
    await conn.query('DELETE FROM question WHERE id = ?', [req.params.id]);
    await conn.end();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/questions/batch-update-status
router.post('/batch-update-status', async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择题目' });
    if (!['pending_review', 'approved', 'disabled'].includes(status)) return res.status(400).json({ error: '无效的状态' });
    
    const conn = await getConnection();
    const [result] = await conn.query('UPDATE question SET status = ? WHERE id IN (?)', [status, ids]);
    await conn.end();
    return res.json({ updated: result.affectedRows });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/questions/batch-delete
router.post('/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择题目' });

    const conn = await getConnection();
    const [result] = await conn.query('DELETE FROM question WHERE id IN (?)', [ids]);
    await conn.end();
    return res.json({ deleted: result.affectedRows });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/questions - add a new question manually
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { qtype, difficulty, passage, stem, options, answer, explanation, status } = req.body;
    if (!stem || !options || !answer || !explanation) {
      return res.status(400).json({ error: '请填写完整的题目信息' });
    }
    if (options.length < 4) return res.status(400).json({ error: '至少需要4个选项' });

    const conn = await getConnection();
    const [subjects] = await conn.query("SELECT id FROM subject WHERE slug = 'verbal_comprehension'");
    const subjectId = subjects[0]?.id || 1;

    await conn.query(
      'INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation, status) VALUES (?,?,?,?,?,?,?,?,?)',
      [subjectId, qtype || '意图判断', difficulty || 3, passage || null, stem, JSON.stringify(options), answer, explanation, status || 'pending_review']
    );
    await conn.end();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});
module.exports = router;
