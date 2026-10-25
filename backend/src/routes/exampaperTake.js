/**
 * 整卷在线阅览与答题（用户端）。
 *
 * 设计要点：
 *   - 拉取整卷时不返回答案与解析（避免提前泄露），提交后才返回判分结果
 *   - 按 exam_paper_question.seq 保持原卷顺序，并按 section 分区，供前端做分区导航
 *   - 判分在服务端完成，多选题按字母集合完全匹配计分
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth, requireAuthOrToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { safeJson } = require('../lib/json');
const { classifyImageNeed } = require('../lib/questionImage');

const router = express.Router();

/** 试卷相关文件目录：原卷 PDF + 题目区域截图（与管理端保持一致） */
const PAPER_FILES_DIR = path.resolve(__dirname, '../../uploads/papers');
const PAPER_IMAGE_SUBDIR = 'paper-images';

// GET /api/exam-papers/images/:paperId/:file —— 题目区域截图
// 从原 PDF 裁出的截图，供答题时展示图形推理/几何图/统计图表。
// <img> 标签带不了 Authorization 头，故这个路由额外接受 ?t=<token>。
// 注意：必须放在 router.use(requireAuth) 之前 —— 否则 <img> 请求（无 Authorization 头）
// 会被 requireAuth 先拦掉直接 401，根本到不了这里。
router.get('/images/:paperId/:file', requireAuthOrToken, asyncHandler(async (req, res) => {
  const paperId = String(req.params.paperId);
  const file = String(req.params.file);
  // 只允许「数字」与「字母数字-_.」，防目录穿越
  if (!/^\d{1,10}$/.test(paperId) || !/^[A-Za-z0-9._-]{1,64}$/.test(file) || file.includes('..')) {
    return res.status(400).json({ error: '非法的图片路径' });
  }
  const abs = path.join(PAPER_FILES_DIR, PAPER_IMAGE_SUBDIR, paperId, file);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '图片不存在' });
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.sendFile(abs);
}));

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
      `SELECT id, seq, section, qtype, difficulty, passage, stem, options_json, image_url
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
    // 题目区域截图（原 PDF 裁剪），多张用逗号分隔。
    // 路径不带 /api 前缀：前端会拼上 axios 的 baseURL，避免出现 /api/api/...
    const files = String(q.image_url || '').split(',').filter(Boolean);
    const opts = safeJson(q.options_json, []);
    // 不是每题都需要配图：纯文本题的区域截图只是把题干重拍一遍，
    // 前端已用文本渲染同样内容，再插图既冗余又拖慢加载。
    // 判定详见 lib/questionImage.js（仅影响显示，不删除资源）。
    const need = classifyImageNeed(
      { section: name, stem: q.stem, options: opts, passage: q.passage },
      files
    );
    sectionMap.get(name).push({
      seq: q.seq,
      id: q.id,
      qtype: q.qtype,
      difficulty: q.difficulty,
      passage: q.passage || null,
      stem: q.stem,
      options: opts,
      images: files.map((f) => `/exam-papers/images/${data.paper.id}/${f}`),
      // true → 内联展示；false → 折叠在「查看原卷截图」里
      imageNeeded: need.needed,
      imageReason: need.reason,
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
