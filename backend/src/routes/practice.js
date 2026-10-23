const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { localDateTimeStr } = require('../lib/time');
const { safeOptions } = require('../lib/json');

const router = express.Router();

const aiAnalysisLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 10,
  // 参数是错的题（500/400/404）不该消耗用户额度，只统计真正发起 AI 调用的请求
  skipFailedRequests: true,
  keyGenerator: (req) => String(req.user?.userId || 'anon'),
  message: { error: '请求过于频繁，请稍后再试' }
});

function parseMetaJson(raw) {
  if (typeof raw === 'object' && raw !== null) return raw;
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

// POST /api/practice/start
router.post('/start', requireAuth, asyncHandler(async (req, res) => {
  const { subject_id, questions } = req.body;
  if (!subject_id || !questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const session_id = await withConnection(async (conn) => {
    // 验证 subject_id 存在
    const [subjects] = await conn.query('SELECT id FROM subject WHERE id = ?', [subject_id]);
    if (subjects.length === 0) throw Object.assign(new Error('科目不存在'), { status: 400 });

      const [result] = await conn.query(
        'INSERT INTO practice_session (user_id, subject_id, mode, status, total, duration_sec, started_at, meta_json) VALUES (?,?,?,?,?,?,?,?)',
        [req.user.userId, subject_id, 'random', 'in_progress', questions.length, 0, localDateTimeStr(), JSON.stringify({ questions })]
      );
    return result.insertId;
  });

  return res.json({ session_id });
}));

// POST /api/practice/save-progress
router.post('/save-progress', requireAuth, asyncHandler(async (req, res) => {
  const { session_id, answers, elapsed_sec } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  await withConnection(async (conn) => {
    const [sessions] = await conn.query(
      'SELECT id, status, meta_json FROM practice_session WHERE id = ? AND user_id = ?',
      [session_id, req.user.userId]
    );
    if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });
    if (sessions[0].status === 'completed') throw Object.assign(new Error('答题已完成，无法保存'), { status: 400 });

    let meta = parseMetaJson(sessions[0].meta_json);
    if (!meta.questions) meta.questions = [];
    meta.answers = answers || meta.answers || {};
    meta.elapsed_sec = elapsed_sec || meta.elapsed_sec || 0;

    await conn.query(
      'UPDATE practice_session SET meta_json = ?, duration_sec = ? WHERE id = ?',
      [JSON.stringify(meta), elapsed_sec || 0, session_id]
    );
  });

  return res.json({ success: true });
}));

// POST /api/practice/submit
router.post('/submit', requireAuth, asyncHandler(async (req, res) => {
  const { session_id, answers, elapsed_sec } = req.body;
  if (!session_id || !answers) return res.status(400).json({ error: '参数不完整' });

  const result = await withConnection(async (conn) => {
    const [sessions] = await conn.query(
      'SELECT id, status, meta_json FROM practice_session WHERE id = ? AND user_id = ?',
      [session_id, req.user.userId]
    );
    if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });

    let meta = parseMetaJson(sessions[0].meta_json);
    const questions = meta.questions || [];
    let correct = 0;
    const total = questions.length;

    await conn.query('DELETE FROM practice_answer WHERE session_id = ?', [session_id]);

    for (const q of questions) {
      const userAnswer = answers[q.id] || '';
      const isCorrect = userAnswer === q.answer ? 1 : 0;
      if (isCorrect) correct++;
      await conn.query(
        'INSERT INTO practice_answer (session_id, question_id, user_answer, is_correct, time_spent_sec) VALUES (?,?,?,?,?)',
        [session_id, q.id, userAnswer, isCorrect, 0]
      );
    }

    const score = total > 0 ? ((correct / total) * 100).toFixed(2) : 0;

    for (const q of questions) {
      const userAnswer = answers[q.id] || '';
      if (userAnswer !== q.answer) {
        await conn.query(
          'INSERT INTO wrong_book (user_id, question_id, wrong_count, mastered) VALUES (?, ?, 1, 0) ON DUPLICATE KEY UPDATE wrong_count = wrong_count + 1, mastered = 0',
          [req.user.userId, q.id]
        );
      }
    }

    meta.answers = answers;
    meta.elapsed_sec = elapsed_sec || 0;

    await conn.query(
      'UPDATE practice_session SET status = ?, correct = ?, score = ?, duration_sec = ?, finished_at = ?, meta_json = ? WHERE id = ?',
      ['completed', correct, score, elapsed_sec || 0, localDateTimeStr(), JSON.stringify(meta), session_id]
    );

    return { session_id, total, correct, score: Number(score), duration_sec: elapsed_sec || 0 };
  });

  return res.json(result);
}));

// GET /api/practice/session/:id
router.get('/session/:id', requireAuth, asyncHandler(async (req, res) => {
  const data = await withConnection(async (conn) => {
    const [sessions] = await conn.query(
      `SELECT ps.*, s.name AS subject_name FROM practice_session ps LEFT JOIN subject s ON ps.subject_id = s.id WHERE ps.id = ? AND ps.user_id = ?`,
      [req.params.id, req.user.userId]
    );
    if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });

    const session = sessions[0];
    const meta = parseMetaJson(session.meta_json);

    const [answerDetails] = await conn.query(
      `SELECT pa.*, q.stem, q.passage, q.options_json, q.answer AS correct_answer, q.explanation, q.qtype, q.difficulty
       FROM practice_answer pa JOIN question q ON pa.question_id = q.id WHERE pa.session_id = ?`,
      [session.id]
    );

    return {
      session: {
        id: session.id, subject_id: session.subject_id, subject_name: session.subject_name,
        status: session.status, total: session.total, correct: session.correct,
        score: session.score, duration_sec: session.duration_sec,
        started_at: session.started_at, finished_at: session.finished_at
      },
      // 注意：questions 来自 meta_json，仅含 {id, answer}（start 时写入的精简数据），
      // 缺少 stem/options_json/explanation。需要完整题目数据请用 answerDetails
      // （practice_answer JOIN question，字段齐全）。前端结果页已改用 answerDetails。
      questions: meta.questions || [],
      answers: meta.answers || {},
      elapsed_sec: meta.elapsed_sec || session.duration_sec || 0,
      answerDetails
    };
  });

  return res.json(data);
}));

// GET /api/practice/history
router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 10, 50);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM practice_session WHERE user_id = ?', [req.user.userId]);
    const [sessions] = await conn.query(
      `SELECT ps.*, s.name AS subject_name FROM practice_session ps LEFT JOIN subject s ON ps.subject_id = s.id
       WHERE ps.user_id = ? ORDER BY ps.id DESC LIMIT ? OFFSET ?`,
      [req.user.userId, pageSize, offset]
    );
    return { sessions, total: countRows[0].total };
  });

  return res.json({ ...data, page, pageSize });
}));

// GET /api/practice/stats
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const data = await withConnection(async (conn) => {
    const [overall] = await conn.query(
      `SELECT COUNT(*) AS total_sessions, SUM(total) AS total_questions, SUM(correct) AS total_correct,
       ROUND(AVG(score), 2) AS avg_score, ROUND(AVG(duration_sec), 0) AS avg_duration
       FROM practice_session WHERE user_id = ? AND status = 'completed'`,
      [req.user.userId]
    );
    const [bySubject] = await conn.query(
      `SELECT s.name, s.slug, COUNT(*) AS sessions, SUM(ps.total) AS questions, SUM(ps.correct) AS correct,
       ROUND(AVG(ps.score), 2) AS avg_score
       FROM practice_session ps JOIN subject s ON ps.subject_id = s.id
       WHERE ps.user_id = ? AND ps.status = 'completed' GROUP BY ps.subject_id`,
      [req.user.userId]
    );
    const [recent] = await conn.query(
      `SELECT ps.id, ps.total, ps.correct, ps.score, ps.duration_sec, ps.started_at, ps.status, s.name AS subject_name
       FROM practice_session ps LEFT JOIN subject s ON ps.subject_id = s.id
       WHERE ps.user_id = ? ORDER BY ps.id DESC LIMIT 5`,
      [req.user.userId]
    );
    return { overall: overall[0], bySubject, recent };
  });

  return res.json(data);
}));

// GET /api/practice/leaderboard
router.get('/leaderboard', requireAuth, asyncHandler(async (req, res) => {
  const leaderboard = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT u.id, u.nickname,
         COUNT(*) AS total_sessions, ROUND(AVG(ps.score), 2) AS avg_score,
         SUM(ps.total) AS total_questions, SUM(ps.correct) AS total_correct
       FROM practice_session ps JOIN user u ON ps.user_id = u.id
       WHERE ps.status = 'completed' AND u.status = 'active'
       GROUP BY u.id ORDER BY avg_score DESC, total_sessions DESC LIMIT 50`
    );
    return rows;
  });
  return res.json({ leaderboard });
}));

// ── 错题本接口 ──────────────────────────────────────────

// GET /api/practice/wrong-book
router.get('/wrong-book', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 15, 50);
  const offset = (page - 1) * pageSize;
  const mastered = req.query.mastered;

  const data = await withConnection(async (conn) => {
    let whereClause = ' WHERE wb.user_id = ?';
    const params = [req.user.userId];
    if (mastered !== undefined && mastered !== '') { whereClause += ' AND wb.mastered = ?'; params.push(Number(mastered)); }

    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM wrong_book wb' + whereClause, params);
    const [rows] = await conn.query(
      `SELECT wb.*, q.stem, q.passage, q.options_json, q.answer, q.explanation, q.qtype, q.difficulty
       FROM wrong_book wb JOIN question q ON wb.question_id = q.id ${whereClause}
       ORDER BY wb.mastered ASC, wb.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const [statsRows] = await conn.query(
      'SELECT COUNT(*) AS total, SUM(mastered = 0) AS active, SUM(mastered = 1) AS mastered, SUM(wrong_count) AS total_wrongs FROM wrong_book WHERE user_id = ?',
      [req.user.userId]
    );
    const [byType] = await conn.query(
      'SELECT q.qtype, SUM(wb.wrong_count) AS count FROM wrong_book wb JOIN question q ON wb.question_id = q.id WHERE wb.user_id = ? AND wb.mastered = 0 GROUP BY q.qtype ORDER BY count DESC',
      [req.user.userId]
    );
    statsRows[0].byType = byType;

    return { items: rows, total: countRows[0].total, stats: statsRows[0] };
  });

  return res.json({ ...data, page, pageSize });
}));

// DELETE /api/practice/wrong-book/:id
router.delete('/wrong-book/:id', requireAuth, asyncHandler(async (req, res) => {
  const affected = await withConnection(async (conn) => {
    const [result] = await conn.query('DELETE FROM wrong_book WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
    return result.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '错题记录不存在' });
  return res.json({ success: true });
}));

// DELETE /api/practice/wrong-book/by-question/:questionId
router.delete('/wrong-book/by-question/:questionId', requireAuth, asyncHandler(async (req, res) => {
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM wrong_book WHERE user_id = ? AND question_id = ?', [req.user.userId, req.params.questionId]);
  });
  return res.json({ success: true });
}));

// PUT /api/practice/wrong-book/:id/mastered
router.put('/wrong-book/:id/mastered', requireAuth, asyncHandler(async (req, res) => {
  const { mastered } = req.body;
  await withConnection(async (conn) => {
    await conn.query('UPDATE wrong_book SET mastered = ? WHERE id = ? AND user_id = ?', [mastered ? 1 : 0, req.params.id, req.user.userId]);
  });
  return res.json({ success: true });
}));

// POST /api/practice/wrong-book/redo
router.post('/wrong-book/redo', requireAuth, asyncHandler(async (req, res) => {
  const { count = 10 } = req.body;
  const questions = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT q.id, q.subject_id, q.qtype, q.difficulty, q.passage, q.stem, q.options_json, q.answer, q.explanation, q.source_exam, q.source_article_id,
       a.clean_text as article_text, a.title as article_title
       FROM wrong_book wb JOIN question q ON wb.question_id = q.id LEFT JOIN article a ON q.source_article_id = a.id
       WHERE wb.user_id = ? AND wb.mastered = 0 AND q.status = 'approved' ORDER BY RAND() LIMIT ?`,
      [req.user.userId, Math.min(count, 50)]
    );
    return rows.map(q => {
      if (!q.passage && q.article_text) q.passage = q.article_text.substring(0, 300);
      return q;
    });
  });
  return res.json({ questions });
}));

// ── 题目评分与反馈 ──────────────────────────────────────

// POST /api/practice/feedback
// 提交或修改某题的评分与文字反馈。同一用户对同一题目重复提交为覆盖更新。
router.post('/feedback', requireAuth, asyncHandler(async (req, res) => {
  const { question_id, session_id, rating, feedback } = req.body;

  // 入参校验：评分必须为 1-5 的整数
  const ratingNum = Number(rating);
  if (!question_id) return res.status(400).json({ error: '缺少 question_id' });
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: '评分必须为 1-5 的整数' });
  }

  // 反馈长度限制，避免异常大请求体
  const feedbackText = typeof feedback === 'string' ? feedback.trim() : '';
  if (feedbackText.length > 1000) return res.status(400).json({ error: '反馈内容不能超过 1000 字' });

  await withConnection(async (conn) => {
    // 校验题目存在，避免脏外键
    const [questions] = await conn.query('SELECT id FROM question WHERE id = ?', [question_id]);
    if (questions.length === 0) throw Object.assign(new Error('题目不存在'), { status: 404 });

    // 校验 session 归属（若传了 session_id），防止越权关联他人练习记录
    let sessionValue = null;
    if (session_id) {
      const [sessions] = await conn.query(
        'SELECT id FROM practice_session WHERE id = ? AND user_id = ?',
        [session_id, req.user.userId]
      );
      if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });
      sessionValue = sessions[0].id;
    }

    // 覆盖写入：利用 (user_id, question_id) 唯一键，重复评分即更新
    await conn.query(
      `INSERT INTO question_feedback (user_id, question_id, session_id, rating, feedback)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), rating = VALUES(rating),
                               feedback = VALUES(feedback), updated_at = CURRENT_TIMESTAMP`,
      [req.user.userId, question_id, sessionValue, ratingNum, feedbackText || null]
    );
  });

  return res.json({ success: true, rating: ratingNum, feedback: feedbackText });
}));

// GET /api/practice/feedback?ids=1,2,3
// 批量查询当前用户对若干题目的评分（结果页一次性渲染用，避免 N 次请求）
router.get('/feedback', requireAuth, asyncHandler(async (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return res.json({ feedbacks: {} });

  const rows = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `SELECT question_id, rating, feedback, updated_at FROM question_feedback
       WHERE user_id = ? AND question_id IN (?)`,
      [req.user.userId, ids]
    );
    return r;
  });

  // 以 question_id 为键返回，前端可直接按题目查找
  const feedbacks = {};
  for (const row of rows) {
    feedbacks[row.question_id] = {
      rating: row.rating,
      feedback: row.feedback || '',
      updated_at: row.updated_at,
    };
  }
  return res.json({ feedbacks });
}));

// GET /api/practice/feedback/stats
// 管理员视角的评分汇总（按题目聚合，用于后台观察题目质量）
router.get('/feedback/stats', requireAuth, asyncHandler(async (req, res) => {
  const rows = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `SELECT qf.question_id, q.stem, q.qtype,
              COUNT(*) AS rating_count, ROUND(AVG(qf.rating), 2) AS avg_rating,
              SUM(qf.feedback IS NOT NULL AND qf.feedback <> '') AS feedback_count
       FROM question_feedback qf JOIN question q ON qf.question_id = q.id
       GROUP BY qf.question_id, q.stem, q.qtype
       ORDER BY rating_count DESC, avg_rating ASC LIMIT 100`
    );
    return r;
  });
  return res.json({ items: rows });
}));

// ── 收藏接口 ──────────────────────────────────────────

// GET /api/practice/favorites
router.get('/favorites', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 15, 50);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM favorite WHERE user_id = ?', [req.user.userId]);
    const [rows] = await conn.query(
      `SELECT f.id, f.question_id, f.created_at, q.stem, q.passage, q.options_json, q.answer, q.explanation, q.qtype, q.difficulty
       FROM favorite f JOIN question q ON f.question_id = q.id
       WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.userId, pageSize, offset]
    );
    return { items: rows, total: countRows[0].total };
  });
  return res.json({ ...data, page, pageSize });
}));

// POST /api/practice/favorites
router.post('/favorites', requireAuth, asyncHandler(async (req, res) => {
  const { question_id } = req.body;
  if (!question_id) return res.status(400).json({ error: '缺少题目ID' });
  await withConnection(async (conn) => {
    await conn.query('INSERT IGNORE INTO favorite (user_id, question_id) VALUES (?, ?)', [req.user.userId, question_id]);
  });
  return res.json({ success: true });
}));

// DELETE /api/practice/favorites/:questionId
router.delete('/favorites/:questionId', requireAuth, asyncHandler(async (req, res) => {
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM favorite WHERE user_id = ? AND question_id = ?', [req.user.userId, req.params.questionId]);
  });
  return res.json({ success: true });
}));

// GET /api/practice/favorites/check
router.get('/favorites/check', requireAuth, asyncHandler(async (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean).map(Number);
  if (ids.length === 0) return res.json({ favorited: [] });
  const favorited = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT question_id FROM favorite WHERE user_id = ? AND question_id IN (?)', [req.user.userId, ids]);
    return rows.map(r => r.question_id);
  });
  return res.json({ favorited });
}));

// GET /api/practice/trend
router.get('/trend', requireAuth, asyncHandler(async (req, res) => {
  const trend = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT score, started_at FROM practice_session WHERE user_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 20`,
      [req.user.userId]
    );
    return rows.reverse();
  });
  return res.json({ trend });
}));

// POST /api/practice/ai-analysis
router.post('/ai-analysis', requireAuth, aiAnalysisLimiter, asyncHandler(async (req, res) => {
  const { question_id, user_answer } = req.body;
  if (!question_id) return res.status(400).json({ error: '缺少 question_id' });

  const q = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT q.*, a.clean_text AS article_text FROM question q LEFT JOIN article a ON q.source_article_id = a.id WHERE q.id = ?',
      [question_id]
    );
    return rows[0] || null;
  });
  if (!q) return res.status(404).json({ error: '题目不存在' });

  const options = safeOptions(q.options_json);
  const optionsText = options.map((opt, i) => String.fromCharCode(65 + i) + '. ' + opt).join('\n');

  const API_KEY = process.env.API_KEY || process.env.MIMO_API_KEY;
  const BASE_URL = process.env.BASE_URL || process.env.MIMO_BASE_URL || 'https://api.deepseek.com/v1';
  if (!API_KEY) return res.status(500).json({ error: 'AI 服务未配置' });

  // 答对与答错给予不同侧重点的讲解：错题重在纠偏，答对重在思路沉淀
  const isCorrect = user_answer === q.answer;
  const prompt = isCorrect
    ? `你是一位公务员考试辅导老师。学生答对了以下题目，请给出思路讲解，重点说明：
1. 这道题的突破口在哪里（如何快速定位关键信息）
2. 正确答案 ${q.answer} 为什么最合适
3. 同类题的通用解法与可迁移的技巧

题目类型：${q.qtype}
难度：${q.difficulty}/5
${q.passage ? '片段：\n' + q.passage : ''}
题干：${q.stem}
选项：
${optionsText}
正确答案：${q.answer}
标准解析：${q.explanation}

请用简洁的中文回答，不超过200字。`
    : `你是一位公务员考试辅导老师。学生做错了以下题目，请给出个性化的解析，重点解释：
1. 为什么学生选的 ${user_answer || '未选'} 是错的
2. 正确答案 ${q.answer} 为什么对
3. 这道题的解题思路和易错点

题目类型：${q.qtype}
难度：${q.difficulty}/5
${q.passage ? '片段：\n' + q.passage : ''}
题干：${q.stem}
选项：
${optionsText}
正确答案：${q.answer}
标准解析：${q.explanation}

请用简洁的中文回答，不超过200字。`;

  let analysis = '';
  try {
    const aiRes = await axios.post(
      BASE_URL + '/chat/completions',
      {
        model: process.env.MODEL || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是公务员考试辅导专家，擅长用通俗易懂的方式讲解题目。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    // 上游若返回非标准结构（裸文本/流式分片），这里取不到内容时要显式降级，
    // 不能把原始响应直接透给前端，否则前端 JSON 解析会失败
    analysis = (aiRes.data?.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('[AI] 解析调用失败:', e.response?.status || '', e.response?.data?.error?.message || e.message);
    return res.status(502).json({ error: 'AI 服务暂时不可用，请稍后再试' });
  }

  if (!analysis) return res.status(502).json({ error: 'AI 未返回有效内容，请稍后再试' });
  return res.json({ analysis });
}));

module.exports = router;
