/**
 * 整卷在线阅览与答题（用户端）。
 *
 * 设计要点：
 *   - 拉取整卷时不返回答案与解析（避免提前泄露），提交后才返回判分结果
 *   - 按 exam_paper_question.seq 保持原卷顺序，并按 section 分区，供前端做分区导航
 *   - 判分在服务端完成，多选题按字母集合完全匹配计分
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { safeJson } = require('../lib/json');

const router = express.Router();
router.use(requireAuth);

/** 答案比较：多选按字母集合比较 */
function isAnswerRight(yourAnswer, rightAnswer) {
  const norm = (v) => String(v || '').toUpperCase().match(/[A-Z]/g)?.sort().join('') || '';
  const a = norm(yourAnswer);
  const b = norm(rightAnswer);
  return a.length > 0 && a === b;
}

// GET /api/exam-papers —— 可作答的整卷列表
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS total FROM exam_paper WHERE parse_status IN ('success','partial')"
    );
    const [rows] = await conn.query(
      `SELECT id, title, year, source, origin, parsed_count, parse_status, created_at
       FROM exam_paper WHERE parse_status IN ('success','partial')
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    return { papers: rows, total: countRows[0].total };
  });

  return res.json({ ...data, page, pageSize });
}));

// GET /api/exam-papers/:id —— 整卷结构（不含答案与解析）
router.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const data = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT id, title, year, source, origin, raw_text, parsed_count, parse_status FROM exam_paper WHERE id = ?',
      [id]
    );
    const paper = rows[0] || null;
    if (!paper) return null;
    if (!['success', 'partial'].includes(paper.parse_status)) {
      return { forbidden: true, parse_status: paper.parse_status };
    }
    const [qs] = await conn.query(
      `SELECT id, seq, section, qtype, difficulty, passage, stem, options_json
       FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
      [id]
    );
    return { paper, questions: qs };
  });

  if (!data) return res.status(404).json({ error: '试卷不存在' });
  if (data.forbidden) return res.status(400).json({ error: '该试卷尚未完成拆题，暂不可作答', parse_status: data.parse_status });

  // 按分区聚合，保持原卷顺序
  const sectionMap = new Map();
  for (const q of data.questions) {
    const name = q.section || '未分区';
    if (!sectionMap.has(name)) sectionMap.set(name, []);
    sectionMap.get(name).push({
      seq: q.seq,
      id: q.id,
      qtype: q.qtype,
      difficulty: q.difficulty,
      passage: q.passage || null,
      stem: q.stem,
      options: safeJson(q.options_json, []),
    });
  }
  const sections = Array.from(sectionMap.entries()).map(([name, questions]) => ({
    name,
    count: questions.length,
    questions,
  }));

  return res.json({
    paper: {
      id: data.paper.id,
      title: data.paper.title,
      year: data.paper.year,
      source: data.paper.source,
      origin: data.paper.origin,
      parse_status: data.paper.parse_status,
    },
    sections,
    total: data.questions.length,
  });
}));

// POST /api/exam-papers/:id/submit —— 提交答案并判分
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const answers = req.body && req.body.answers;
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: '缺少作答数据' });

  // 注意：withConnection 透传 conn.query 的返回值，需解构出结果行数组
  const [rows] = await withConnection((conn) => conn.query(
    `SELECT seq, section, qtype, difficulty, stem, options_json, answer, explanation
     FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
    [id]
  ));
  if (rows.length === 0) return res.status(404).json({ error: '该试卷没有可判分的题目' });

  let correct = 0;
  const results = rows.map((q) => {
    const your = answers[String(q.seq)] ?? answers[q.seq] ?? null;
    const right = isAnswerRight(your, q.answer);
    if (right) correct++;
    return {
      seq: q.seq,
      section: q.section,
      qtype: q.qtype,
      difficulty: q.difficulty,
      stem: q.stem,
      options: safeJson(q.options_json, []),
      yourAnswer: your || null,
      answer: q.answer,
      correct: right,
      answered: !!your,
      explanation: q.explanation || null,
    };
  });

  const total = rows.length;
  const score = total > 0 ? Math.round((correct / total) * 100) : 0;

  // 分模块统计
  const bySection = {};
  for (const r of results) {
    const k = r.section || '未分区';
    if (!bySection[k]) bySection[k] = { total: 0, correct: 0 };
    bySection[k].total++;
    if (r.correct) bySection[k].correct++;
  }

  return res.json({
    paperId: id,
    total,
    correct,
    wrong: total - correct,
    unanswered: results.filter((r) => !r.answered).length,
    score,
    bySection,
    results,
  });
}));

module.exports = router;
