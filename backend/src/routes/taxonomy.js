const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const {
  getCategoryTree,
  listQuestionsByCategory,
  countQuestions,
  getCategoryDescendants,
  getCategoryDescendantsBatch,
  pickQuestionsByConfig,
  POOL_KEYS,
} = require('../lib/taxonomy');
const { getWeaknessProfile } = require('../lib/weakness');

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

/** 解析 focusWeak：只接受 boolean 真值、数字 1 或 '1'/'true' 之类真值字符串 */
function parseWeakFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * 取用户近 2000 次练习里出现过的题目 id，供「优先未做题」排序使用。
 * meta_json.question_ids 是整卷与专项练习共用的题目标识口径。
 * 上限由 500 提高以覆盖更全；MAX_ANSWERED_IDS 兜底防止极端数据把内存打爆。
 * 可选传入 conn 复用外部连接（不传则内部 withConnection）。
 */
const MAX_ANSWERED_IDS = 50000;
async function getAnsweredQuestionIds(userId, existingConn) {
  const run = async (conn) => {
    const [rows] = await conn.query(
      'SELECT meta_json FROM practice_session WHERE user_id = ? ORDER BY id DESC LIMIT 2000',
      [userId]
    );
    const ids = new Set();
    for (const r of rows) {
      if (!r.meta_json) continue;
      try {
        const meta = typeof r.meta_json === 'string' ? JSON.parse(r.meta_json) : r.meta_json;
        for (const id of meta.question_ids || []) {
          const n = Number(id);
          if (Number.isInteger(n) && n > 0) ids.add(n);
        }
      } catch (_) { /* 单条 meta 损坏不影响抽题 */ }
      if (ids.size >= MAX_ANSWERED_IDS) break; // 防御：避免极端数据把内存打爆
    }
    return [...ids];
  };
  return existingConn ? run(existingConn) : withConnection(run);
}

// GET /api/taxonomy/generated-subjects
// AI 生成题独立入口：按科目列出已上架生成题及数量（生成题不进分类树）
router.get('/generated-subjects', requireAuth, asyncHandler(async (_req, res) => {
  const [rows] = await withConnection((conn) => conn.query(
    `SELECT s.id, s.name, s.slug, COUNT(q.id) AS count
       FROM subject s
       LEFT JOIN question q ON q.subject_id = s.id
            AND q.status = 'approved' AND (q.source_exam LIKE '%AI生成%' OR q.source_article_id IS NOT NULL)
      GROUP BY s.id, s.name, s.slug
      ORDER BY s.id`
  ));
  const total = rows.reduce((n, r) => n + Number(r.count || 0), 0);
  res.json({ subjects: rows, total });
}));

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
    // 含子分类（粉笔点二级分类时是整个子树）。
    // count 与 list 复用同一连接：避免单请求占 3 个连接、也避免各自
    // withConnection 带来的可用数/列表快照不一致（available>0 但 picked=0）。
    const ids = await getCategoryDescendants(conn, categoryId);
    const rows = await listQuestionsByCategory({
      pool, categoryIds: ids, qtypes, difficultyRange, limit, offset,
    }, conn);
    const total = await countQuestions({ pool, categoryIds: ids, qtypes, difficultyRange }, conn);
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
 *   excludeAnswered: boolean,   // 优先未做题
 *   yearMode,                    // 不限 / near3 / near5 / near10
 *   sourceType,                  // national=国考真题 local=地方真题
 *   focusWeak: boolean           // 按学情诊断的薄弱一级模块加权抽题
 * }
 *
 * 参照粉笔：练习阶段接口不下发答案与解析，交卷后由 /practice/submit 下发权威答案。
 */
router.post('/pick', requireAuth, asyncHandler(async (req, res) => {
  const {
    pool: rawPool,
    categoryIds: rawCategoryIds,
    qtypes: rawQtypes,
    difficultyRange: rawRange,
    count: rawCount,
    excludeAnswered,
    subjectIds: rawSubjectIds,
    yearMode: rawYearMode,
    sourceType: rawSourceType,
    focusWeak: rawFocusWeak,
  } = req.body || {};

  const pool = pickPool(rawPool);
  const categoryIds = parseIds(rawCategoryIds);
  const qtypes = Array.isArray(rawQtypes) ? rawQtypes.filter(Boolean).slice(0, 20) : [];
  const range = Array.isArray(rawRange) && rawRange.length === 2
    ? rawRange.map(Number).filter((n) => Number.isFinite(n))
    : null;
  const count = Math.min(Math.max(Number(rawCount) || 10, 1), 200);
  const subjectIds = parseIds(rawSubjectIds).slice(0, 20);
  // 出题年份：不限 / 近3年 / 近5年 / 近10年，只对 question 池生效
  const span = { near3: 3, near5: 5, near10: 10 }[String(rawYearMode || '')] || 0;
  const yearFrom = span ? new Date().getFullYear() - span : null;
  const sourceType = ['national', 'local'].includes(String(rawSourceType || '')) ? String(rawSourceType) : null;
  const preferUndone = Boolean(excludeAnswered);
  const focusWeak = parseWeakFlag(rawFocusWeak);

  // 整个 /pick 在单一连接内完成：已练题查询、分类批量展开、count、抽题
  // 复用同一 conn，避免多次 withConnection 各自占用连接与快照不一致。
  const result = await withConnection(async (conn) => {
    const preferUndoneIds = preferUndone ? await getAnsweredQuestionIds(req.user.userId, conn) : [];
    // 分类 id 批量展开成子树：一次查询 + 内存计算并去重，替代逐分类循环 await
    const expanded = categoryIds.length
      ? await getCategoryDescendantsBatch(conn, categoryIds)
      : categoryIds;

    const available = await countQuestions({
      pool, categoryIds: expanded, qtypes, difficultyRange: range,
      subjectIds, yearFrom, sourceType,
    }, conn);
    if (!available) return { available: 0, rows: [], weakModules: [] };

    // 薄弱点加权：在同一 conn 内做学情诊断（无作答数据时画像为空，
    // weakCategoryIds 为空 → pickQuestionsByConfig 退化为普通抽题，接口不报错）。
    let weakCategoryIds = [];
    let weakModules = [];
    if (focusWeak) {
      const profile = await getWeaknessProfile(conn, req.user.userId);
      weakCategoryIds = profile.weakCategoryIds;
      weakModules = profile.topWeak.map((m) => ({
        categoryId: m.categoryId,
        name: m.name,
        accuracy: m.accuracy,
      }));
    }

    const rows = await pickQuestionsByConfig({
      pool, categoryIds: expanded, qtypes, difficultyRange: range, count,
      subjectIds, yearFrom, sourceType, preferUndoneIds, weakCategoryIds,
    }, conn);
    return { available, rows, weakModules };
  });

  if (!result.available) {
    return res.status(400).json({ error: '所选条件下没有可练习的题目', available: 0 });
  }

  res.json({
    pool,
    available: result.available,
    picked: result.rows.length,
    count,
    preferUndone,
    focusWeak,
    weakModules: result.weakModules,
    // 答题阶段只下发题干与选项；答案和解析统一由交卷接口下发，防止提前查看
    questions: result.rows.map((r) => ({
      id: r.id,
      qtype: r.qtype,
      difficulty: r.difficulty,
      section: r.section || null,
      subjectId: r.subject_id || null,
      stem: r.stem,
      passage: r.passage || null,
      options: safeParse(r.options_json),
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
    `SELECT m.dim, m.value, COUNT(DISTINCT m.exam_paper_id) AS c
       FROM exam_paper_category m
       JOIN exam_paper p ON p.id = m.exam_paper_id AND p.is_hidden = 0 AND (p.origin IS NULL OR p.origin <> 'smart')
      GROUP BY m.dim, m.value`
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
