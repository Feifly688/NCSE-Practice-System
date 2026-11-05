/**
 * 题目分类服务（参照粉笔「专项练习」的三层分类结构）。
 *
 * 结构：模块(level 1) → 考点/题型(level 2) → 知识点(level 3)
 * 每层的 dim 字段标明该层的分类维度：
 *   module   模块（政治理论/常识判断/…）
 *   topic    考点（马克思主义/增长率/…）
 *   qtype    题型（图形推理/逻辑填空/…）
 *   knowledge 知识点（位置类/基期与现期/…）
 *
 * 题目分布在两个池子：
 *   'question'             单题练习池（question 表）
 *   'exam_paper_question'  整卷题池（exam_paper_question 表）
 */

const { withConnection } = require('../db');

/** 两个池子的表名与可用字段（防注入：只允许白名单） */
const POOLS = {
  question: {
    table: 'question',
    statusField: 'status',
    statusValue: 'approved',
    extraFields: ['qtype', 'difficulty', 'subject_id'],
    // 专项练习只用爬取/回流题 —— AI 生成的题走独立入口（generated 池）
    extraWhere: "(t.source_exam IS NULL OR t.source_exam NOT LIKE '%AI生成%') AND t.source_article_id IS NULL",
  },
  generated: {
    table: 'question',
    statusField: 'status',
    statusValue: 'approved',
    extraFields: ['qtype', 'difficulty', 'subject_id'],
    extraWhere: "(t.source_exam LIKE '%AI生成%' OR t.source_article_id IS NOT NULL)",
    requiresMap: false, // 生成题不进分类树，抽题不 JOIN 分类映射
  },
  exam_paper_question: {
    table: 'exam_paper_question',
    statusField: null,
    statusValue: null,
    extraFields: ['qtype', 'difficulty', 'section'],
  },
};

const POOL_KEYS = Object.keys(POOLS);

/**
 * 读整棵分类树，并带上每个分类的「已练/总数」统计。
 *
 * @param {number} userId  用于统计用户已练题数
 * @param {string} pool    题池
 * @returns {Promise<Array>} 分类树节点
 */
async function getCategoryTree(userId, pool) {
  const poolKey = POOLS[pool] ? pool : 'question';

  return withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT c.id, c.parent_id, c.level, c.name, c.slug, c.dim, c.sort_order
         FROM question_category c
        ORDER BY c.level, c.sort_order, c.id`
    );

    // 每个分类「直挂」的题目集合（按题目去重，跨层级不重复计数）。
    // 背景：一道题会同时挂一级模块和二级题型两张映射，若按映射行数逐层求和，
    // 模块总数会翻倍（言语 4326 显示成 8652）；而二级下还可能有直挂 + 空三级
    // 考点并存的情形。所以统一改为「子树内去重题目数」。
    let refJoin = '';
    let refParams = [];
    if (poolKey === 'question') {
      refJoin = "JOIN question q ON q.id = m.ref_id AND q.status = 'approved'\n" +
        "             AND (q.source_exam IS NULL OR q.source_exam NOT LIKE '%AI生成%') AND q.source_article_id IS NULL";
    }
    const [mapRows] = await conn.query(
      `SELECT m.category_id, m.ref_id
         FROM question_category_map m
         ${refJoin}
        WHERE m.pool = ?`,
      [poolKey, ...refParams]
    );
    const direct = new Map(); // categoryId -> Set(questionId)
    for (const r of mapRows) {
      if (!direct.has(r.category_id)) direct.set(r.category_id, new Set());
      direct.get(r.category_id).add(Number(r.ref_id));
    }

    // 用户已练过的题：每分类的去重集合
    const doneSets = await getDoneSets(conn, userId, poolKey);

    // 子树（含自身）内的去重题目数 / 已练数
    const childrenOf = new Map();
    rows.forEach((r) => {
      if (r.parent_id) {
        if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, []);
        childrenOf.get(r.parent_id).push(r.id);
      }
    });
    const subtreeIds = (rootId) => {
      const out = [];
      const stack = [rootId];
      while (stack.length) {
        const cur = stack.pop();
        out.push(cur);
        for (const cid of childrenOf.get(cur) || []) stack.push(cid);
      }
      return out;
    };

    const byId = new Map();
    rows.forEach((r) => {
      const ids = subtreeIds(r.id);
      const t = new Set();
      const d = new Set();
      for (const cid of ids) {
        const dt = direct.get(cid);
        if (dt) for (const x of dt) t.add(x);
        const dd = doneSets.get(cid);
        if (dd) for (const x of dd) d.add(x);
      }
      byId.set(r.id, {
        id: r.id,
        parentId: r.parent_id,
        level: r.level,
        name: r.name,
        slug: r.slug,
        dim: r.dim,
        sortOrder: r.sort_order,
        totalCount: t.size,
        doneCount: d.size,
        children: [],
      });
    });

    // 组树
    const roots = [];
    byId.forEach((node) => {
      if (node.parentId && byId.get(node.parentId)) byId.get(node.parentId).children.push(node);
      else roots.push(node);
    });

    return roots;
  });
}

/** 统计用户在各分类下已练的题目集合（按题目去重，供分类树做子树汇总） */
async function getDoneSets(conn, userId, poolKey) {
  const out = new Map(); // categoryId -> Set(refId)
  if (!userId) return out;

  // 练习记录里的题目：practice_session.meta_json.question_ids
  const [sessions] = await conn.query(
    `SELECT meta_json FROM practice_session
      WHERE user_id = ? AND meta_json IS NOT NULL
      ORDER BY id DESC LIMIT 500`,
    [userId]
  );

  const doneRefs = new Set();
  for (const s of sessions) {
    let meta = null;
    try { meta = typeof s.meta_json === 'string' ? JSON.parse(s.meta_json) : s.meta_json; } catch (e) { continue; }
    if (!meta) continue;
    const ids = meta.question_ids || meta.exam_question_ids || [];
    for (const id of ids) {
      const key = `${poolKey}:${id}`;
      if (!doneRefs.has(key)) doneRefs.add(key);
    }
  }
  if (!doneRefs.size) return out;

  const refIds = [...doneRefs]
    .filter((k) => k.startsWith(`${poolKey}:`))
    .map((k) => Number(k.slice(poolKey.length + 1)))
    .filter((n) => Number.isFinite(n));
  if (!refIds.length) return out;

  let refJoin = '';
  const params = [poolKey, ...refIds];
  if (poolKey === 'question') {
    refJoin = "JOIN question q ON q.id = m.ref_id AND q.status = 'approved'\n" +
      "             AND (q.source_exam IS NULL OR q.source_exam NOT LIKE '%AI生成%') AND q.source_article_id IS NULL";
  }
  const ph = refIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT m.category_id, m.ref_id
       FROM question_category_map m
       ${refJoin}
      WHERE m.pool = ? AND m.ref_id IN (${ph})`,
    params
  );
  for (const r of rows) {
    if (!out.has(r.category_id)) out.set(r.category_id, new Set());
    out.get(r.category_id).add(Number(r.ref_id));
  }
  return out;
}


/**
 * 智能组卷：按国考行测 130 题标准结构，从各模块抽取固定题数。
 * 结构取自本库 2025/2026 年国考真题卷（地市级/行政执法卷 130 题）实测分区：
 *   政治理论20 / 常识判断15 / 言语理解与表达30 / 数量关系10 / 判断推理35 / 资料分析20
 * 某模块（含年份过滤后）题量不足时按实际可用抽取，不凑数。
 */
const SMART_PAPER_TEMPLATE = [
  { section: '政治理论', subjectSlug: 'politics_theory', count: 20 },
  { section: '常识判断', subjectSlug: 'common_knowledge', count: 15 },
  { section: '言语理解与表达', subjectSlug: 'verbal_comprehension', count: 30 },
  { section: '数量关系', subjectSlug: 'quantity_relation', count: 10 },
  { section: '判断推理', subjectSlug: 'logic_reasoning', count: 35 },
  { section: '资料分析', subjectSlug: 'data_analysis', count: 20 },
];

async function pickSmartPaper(opts = {}) {
  const span = { near3: 3, near5: 5, near10: 10 }[String(opts.yearMode || '')] || 0;
  const yearFrom = span ? new Date().getFullYear() - span : null;

  return withConnection(async (conn) => {
    const [subjects] = await conn.query('SELECT id, slug FROM subject');
    const bySlug = new Map(subjects.map((x) => [x.slug, x.id]));

    const sections = [];
    const questions = [];
    for (const t of SMART_PAPER_TEMPLATE) {
      const sid = bySlug.get(t.subjectSlug);
      const params = [];
      let yearSql = '';
      if (sid) {
        params.push(sid);
        if (yearFrom) { yearSql = 'AND year >= ?'; params.push(yearFrom); }
      }
      const [rows] = sid
        ? await conn.query(
          `SELECT id, subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation
             FROM question
            WHERE status = 'approved' AND subject_id = ?
              AND (source_exam IS NULL OR source_exam NOT LIKE '%AI生成%') AND source_article_id IS NULL
              ${yearSql}
            ORDER BY RAND() LIMIT ${t.count}`,
          params
        )
        : [];
      sections.push({ section: t.section, target: t.count, picked: rows.length });
      questions.push(...rows.map((r) => ({ ...r, section: t.section })));
    }
    return { questions, sections, total: questions.length };
  });
}

/**
 * 列出某分类下的题目（可直接用于组卷）。
 *
 * @param {Object} opts
 * @param {string} opts.pool       题池
 * @param {number[]} opts.categoryIds 分类 id（子分类也包含）
 * @param {string[]} opts.qtypes   题型过滤
 * @param {number[]} opts.difficultyRange [min,max]
 * @param {number} opts.limit      数量上限
 * @param {number} opts.offset     偏移
 */
async function listQuestionsByCategory(opts) {
  const poolKey = POOLS[opts.pool] ? opts.pool : 'question';
  const cfg = POOLS[poolKey];

  return withConnection(async (conn) => {
    const where = [];
    const params = [];

    if (opts.categoryIds && opts.categoryIds.length) {
      const ph = opts.categoryIds.map(() => '?').join(',');
      where.push(`m.category_id IN (${ph})`);
      params.push(...opts.categoryIds);
    }
    if (opts.qtypes && opts.qtypes.length) {
      const ph = opts.qtypes.map(() => '?').join(',');
      where.push(`t.qtype IN (${ph})`);
      params.push(...opts.qtypes);
    }
    if (opts.difficultyRange && opts.difficultyRange.length === 2) {
      const [min, max] = opts.difficultyRange;
      where.push('t.difficulty BETWEEN ? AND ?');
      params.push(Math.min(min, max), Math.max(min, max));
    }
    if (cfg.statusField) {
      where.push(`t.${cfg.statusField} = ?`);
      params.push(cfg.statusValue);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Number(opts.limit) || 20, 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);

    // 一题可能挂多个分类（如同时属于「图形推理」与「位置类」）。
    // JOIN 会产生重复行，这里用 GROUP BY t.id 去重，只取一个分类 id。
    // GROUP BY 列必须与 SELECT 严格一致：question 表没有 section 列，
    // 无条件写 t.section 会让 question 池直接报 Unknown column。
    const secCol = poolKey === 'question' ? 't.subject_id' : 't.subject_id, t.section';
    const [rows] = await conn.query(
      `SELECT t.id, t.qtype, t.difficulty${poolKey === 'question' ? ', t.subject_id' : ', t.section'},
              t.stem, t.passage,
              MIN(m.category_id) AS category_id
         FROM ${cfg.table} t
         JOIN question_category_map m ON m.pool = ? AND m.ref_id = t.id
        ${whereSql}
        GROUP BY t.id, t.qtype, t.difficulty, ${secCol}, t.stem, t.passage
        ORDER BY t.id
        LIMIT ${limit} OFFSET ${offset}`,
      [poolKey, ...params]
    );

    return rows;
  });
}

/**
 * 统计某分类（或全库）符合条件的题目数量 —— 用于「已练/总数」与组卷可行性检查。
 */
async function countQuestions(opts) {
  const poolKey = POOLS[opts.pool] ? opts.pool : 'question';
  const cfg = POOLS[poolKey];

  return withConnection(async (conn) => {
    const where = [];
    const params = [];

    if (opts.categoryIds && opts.categoryIds.length) {
      const ph = opts.categoryIds.map(() => '?').join(',');
      where.push(`m.category_id IN (${ph})`);
      params.push(...opts.categoryIds);
    }
    if (opts.qtypes && opts.qtypes.length) {
      const ph = opts.qtypes.map(() => '?').join(',');
      where.push(`t.qtype IN (${ph})`);
      params.push(...opts.qtypes);
    }
    if (opts.difficultyRange && opts.difficultyRange.length === 2) {
      const [min, max] = opts.difficultyRange;
      where.push('t.difficulty BETWEEN ? AND ?');
      params.push(Math.min(min, max), Math.max(min, max));
    }
    if (opts.subjectIds && opts.subjectIds.length) {
      const ph = opts.subjectIds.map(() => '?').join(',');
      where.push(`t.subject_id IN (${ph})`);
      params.push(...opts.subjectIds);
    }
    if (opts.yearFrom && poolKey === 'question') {
      where.push('t.year >= ?');
      params.push(opts.yearFrom);
    }
    if (cfg.statusField) {
      where.push(`t.${cfg.statusField} = ?`);
      params.push(cfg.statusValue);
    }
    if (cfg.extraWhere) {
      where.push(`(${cfg.extraWhere})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 生成题池没有分类映射（requiresMap=false），计数时不能 JOIN 映射表，
    // 否则可用数永远是 0 —— AI 生成题入口报「获取题目失败」的根因。
    const mapJoin = cfg.requiresMap === false
      ? ''
      : `JOIN question_category_map m ON m.pool = '${poolKey}' AND m.ref_id = t.id`;
    const [[row]] = await conn.query(
      `SELECT COUNT(DISTINCT t.id) AS c
         FROM ${cfg.table} t
         ${mapJoin}
        ${whereSql}`,
      params
    );
    return Number(row.c) || 0;
  });
}

/**
 * 取分类的祖先链（用于把二级分类的题也纳入统计）。
 * 返回从根到该分类的所有 id。
 */
async function getCategoryAncestry(conn, categoryId) {
  const ids = [];
  let cur = Number(categoryId);
  let guard = 0;
  while (cur && guard < 10) {
    const [rows] = await conn.query(
      'SELECT id, parent_id FROM question_category WHERE id = ?',
      [cur]
    );
    if (!rows.length) break;
    ids.push(rows[0].id);
    cur = rows[0].parent_id;
    guard += 1;
  }
  return ids;
}

/** 取某分类的所有后代 id（含自身） */
async function getCategoryDescendants(conn, categoryId) {
  const ids = [];
  const [rows] = await conn.query(
    'SELECT id FROM question_category WHERE id = ? OR parent_id = ?',
    [categoryId, categoryId]
  );
  rows.forEach((r) => ids.push(r.id));
  // 三层结构：再取第三层
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const [l3] = await conn.query(
      `SELECT id FROM question_category WHERE parent_id IN (${ph})`,
      ids
    );
    l3.forEach((r) => ids.push(r.id));
  }
  return ids;
}

/**
 * 按配置从分类树中抽题（自定义刷题的核心）。
 *
 * 策略：先按分类 + 题型 + 难度过滤，再随机取 count 道；
 * 同一道题可命中多个分类时去重。
 */
async function pickQuestionsByConfig(config) {
  const poolKey = POOLS[config.pool] ? config.pool : 'question';
  const cfg = POOLS[poolKey];

  const count = Math.min(Math.max(Number(config.count) || 10, 1), 200);

  return withConnection(async (conn) => {
    const where = [];
    const params = [];

    if (config.categoryIds && config.categoryIds.length) {
      const ph = config.categoryIds.map(() => '?').join(',');
      where.push(`m.category_id IN (${ph})`);
      params.push(...config.categoryIds);
    }
    if (config.qtypes && config.qtypes.length) {
      const ph = config.qtypes.map(() => '?').join(',');
      where.push(`t.qtype IN (${ph})`);
      params.push(...config.qtypes);
    }
    if (config.difficultyRange && config.difficultyRange.length === 2) {
      const [min, max] = config.difficultyRange;
      where.push('t.difficulty BETWEEN ? AND ?');
      params.push(Math.min(min, max), Math.max(min, max));
    }
    if (config.subjectIds && config.subjectIds.length) {
      const ph = config.subjectIds.map(() => '?').join(',');
      where.push(`t.subject_id IN (${ph})`);
      params.push(...config.subjectIds);
    }
    if (config.yearFrom && poolKey === 'question') {
      where.push('t.year >= ?');
      params.push(config.yearFrom);
    }
    if (cfg.statusField) {
      where.push(`t.${cfg.statusField} = ?`);
      params.push(cfg.statusValue);
    }
    if (cfg.extraWhere) {
      where.push(`(${cfg.extraWhere})`);
    }
    const needMap = cfg.requiresMap !== false || (config.categoryIds && config.categoryIds.length > 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // RAND() 让每次刷题的顺序与组合都不同（粉笔的「去练习」是随机的）
    // 同上：GROUP BY 列与 SELECT 一致，question 池不带 t.section
    const secCol2 = poolKey === 'exam_paper_question' ? 't.subject_id, t.section' : 't.subject_id';
    const mapJoin = needMap ? 'JOIN question_category_map m ON m.pool = ? AND m.ref_id = t.id' : '';
    const mapParam = needMap ? [poolKey] : [];
    const [rows] = await conn.query(
      `SELECT t.id, t.qtype, t.difficulty, t.subject_id,
              t.stem, t.passage, t.options_json, t.answer, t.explanation
         FROM ${cfg.table} t
         ${mapJoin}
        ${whereSql}
        GROUP BY t.id, t.qtype, t.difficulty, ${secCol2},
                 t.stem, t.passage, t.options_json, t.answer, t.explanation
        ORDER BY RAND()
        LIMIT ${count}`,
      [...mapParam, ...params]
    );
    return rows;
  });
}

module.exports = {
  POOLS,
  POOL_KEYS,
  getCategoryTree,
  listQuestionsByCategory,
  countQuestions,
  getCategoryAncestry,
  getCategoryDescendants,
  pickQuestionsByConfig,
  pickSmartPaper,
};
