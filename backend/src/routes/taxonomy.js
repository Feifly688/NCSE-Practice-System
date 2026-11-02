const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const {
  getCategoryTree,
  listQuestionsByCategory,
  countQuestions,
  getCategoryDescendants,
  pickQuestionsByConfig,
  POOL_KEYS,
} = require('../lib/taxonomy');

const router = express.Router();

/** 解析 pool 参数（只允许白名单） */
function pickPool(value) {
  return POOL_KEYS.includes(value) ? value : 'question';
}

/** 解析 id 列表 */
function parseIds(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return arr
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * GET /api/taxonomy/categories
 * 分类树（带已练/总数）
 */
router.get('/categories', requireAuth, asyncHandler(async (req, res) => {
  const pool = pickPool(req.query.pool);
  const tree = await getCategoryTree(req.user.userId, pool);
  res.json({ pool, tree });
}));

/**
 * GET /api/taxonomy/categories/:id/questions
 * 某分类下的题目（支持题型/难度过滤、分页）
 */
router.get('/categories/:id/questions', requireAuth, asyncHandler(async (req, res) => {
  const categoryId = Number(req.params.id);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).json({ error: '分类 id 不合法' });
  }
  const pool = pickPool(req.query.pool);
  const qtypes = req.query.qtypes ? String(req.query.qtypes).split(',').filter(Boolean) : [];
  const diff = req.query.difficulty
    ? String(req.query.difficulty).split(',').map(Number).filter((n) => Number.isFinite(n))
    : null;
  const difficultyRange = diff && diff.length === 2 ? diff : null;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const result = await withConnection(async (conn) => {
    // 含子分类（粉笔点二级分类时是整个子树）
    const ids = await getCategoryDescendants(conn, categoryId);
    const rows = await listQuestionsByCategory({
      pool, categoryIds: ids, qtypes, difficultyRange, limit, offset,
    });
    const total = await countQuestions({ pool, categoryIds: ids, qtypes, difficultyRange });
    return { rows, total, ids };
  });

  res.json({
    categoryId,
    pool,
    total: result.total,
    count: result.rows.length,
    questions: result.rows.map((r) => ({
      id: r.id,
      qtype: r.qtype,
      difficulty: r.difficulty,
      section: r.section || null,
      subjectId: r.subject_id || null,
      stem: String(r.stem || '').slice(0, 160),
      hasPassage: Boolean(r.passage),
    })),
  });
}));

/**
 * POST /api/taxonomy/pick
 * 按配置抽题（自定义刷题）
 *
 * body: {
 *   pool, categoryIds[], qtypes[], difficultyRange:[min,max], count,
 *   excludeAnswered: boolean
 * }
 */
router.post('/pick', requireAuth, asyncHandler(async (req, res) => {
  const {
    pool: rawPool,
    categoryIds: rawCategoryIds,
    qtypes: rawQtypes,
    difficultyRange: rawRange,
    count: rawCount,
    excludeAnswered,
  } = req.body || {};

  const pool = pickPool(rawPool);
  const categoryIds = parseIds(rawCategoryIds);
  const qtypes = Array.isArray(rawQtypes) ? rawQtypes.filter(Boolean).slice(0, 20) : [];
  const range = Array.isArray(rawRange) && rawRange.length === 2
    ? rawRange.map(Number).filter((n) => Number.isFinite(n))
    : null;
  const count = Math.min(Math.max(Number(rawCount) || 10, 1), 200);

  // 分类 id 展开成子树（选二级分类时含三级）
  let expanded = categoryIds;
  if (categoryIds.length) {
    expanded = await withConnection(async (conn) => {
      const all = new Set();
      for (const cid of categoryIds) {
        const ids = await getCategoryDescendants(conn, cid);
        ids.forEach((id) => all.add(id));
      }
      return [...all];
    });
  }

  const available = await countQuestions({
    pool,
    categoryIds: expanded,
    qtypes,
    difficultyRange: range,
  });

  if (!available) {
    return res.status(400).json({ error: '所选条件下没有可练习的题目', available: 0 });
  }

  const rows = await pickQuestionsByConfig({
    pool, categoryIds: expanded, qtypes, difficultyRange: range, count,
  });

  res.json({
    pool,
    available,
    picked: rows.length,
    count,
    questions: rows.map((r) => ({
      id: r.id,
      qtype: r.qtype,
      difficulty: r.difficulty,
      section: r.section || null,
      subjectId: r.subject_id || null,
      stem: r.stem,
      passage: r.passage || null,
      options: safeParse(r.options_json),
      answer: r.answer || null,
      explanation: r.explanation || null,
    })),
  });
}));

/**
 * GET /api/taxonomy/paper-dict
 * 试卷分类字典（粉笔历年试卷页的标签栏）
 */
router.get('/paper-dict', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await withConnection(async (conn) => conn.query(
    'SELECT dim, value, label FROM paper_category_dict ORDER BY dim, sort_order, id'
  ));
  const dict = {};
  rows.forEach((r) => {
    if (!dict[r.dim]) dict[r.dim] = [];
    dict[r.dim].push({ value: r.value, label: r.label });
  });
  res.json({ dict });
}));

/**
 * GET /api/taxonomy/paper-filters
 * 试卷分类筛选项（只返回实际有试卷的维度值 + 各维度下的试卷数）
 */
router.get('/paper-filters', requireAuth, asyncHandler(async (req, res) => {
  // withConnection 返回 [rows, fields]，必须取第一项
  const [rows] = await withConnection(async (conn) => conn.query(
    `SELECT dim, value, COUNT(DISTINCT exam_paper_id) AS c
       FROM exam_paper_category
      GROUP BY dim, value`
  ));
  const [dict] = await withConnection(async (conn) => conn.query(
    'SELECT dim, value, label FROM paper_category_dict ORDER BY dim, sort_order, id'
  ));

  const counts = {};
  rows.forEach((r) => {
    if (!counts[r.dim]) counts[r.dim] = {};
    counts[r.dim][r.value] = Number(r.c) || 0;
  });

  const result = {};
  dict.forEach((r) => {
    if (!result[r.dim]) result[r.dim] = [];
    result[r.dim].push({
      value: r.value,
      label: r.label,
      count: counts[r.dim] ? (counts[r.dim][r.value] || 0) : 0,
    });
  });

  res.json({ filters: result });
}));

/** 安全解析 JSON */
function safeParse(text) {
  if (!text) return [];
  if (Array.isArray(text)) return text;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

module.exports = router;
