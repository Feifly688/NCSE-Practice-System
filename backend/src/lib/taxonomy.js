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
      `SELECT c.id, c.parent_id, c.level, c.name, c.slug, c.dim, c.sort_order,
              (SELECT COUNT(*) FROM question_category_map m
                WHERE m.category_id = c.id AND m.pool = ?) AS total_count
         FROM question_category c
        ORDER BY c.level, c.sort_order, c.id`,
      [poolKey]
    );

    // 用户已练过的题：按分类聚合
    const doneMap = await getDoneCounts(conn, userId, poolKey, rows.map((r) => r.id));

    // 统计挂在子分类上的题，对父分类也要累加（粉笔的「全部」是子树汇总）
    const totalById = new Map();
    rows.forEach((r) => totalById.set(r.id, Number(r.total_count) || 0));

    const byId = new Map();
    rows.forEach((r) => {
      byId.set(r.id, {
        id: r.id,
        parentId: r.parent_id,
        level: r.level,
        name: r.name,
        slug: r.slug,
        dim: r.dim,
        sortOrder: r.sort_order,
        totalCount: Number(r.total_count) || 0,
        doneCount: doneMap.get(r.id) || 0,
        children: [],
      });
    });

    // 自底向上汇总 totalCount / doneCount 到父节点
    const byLevelDesc = [...byId.values()].sort((a, b) => b.level - a.level);
    byLevelDesc.forEach((node) => {
      if (!node.parentId) return;
      const parent = byId.get(node.parentId);
      if (!parent) return;
      parent.totalCount += node.totalCount;
      parent.doneCount += node.doneCount;
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

/** 统计用户在各分类下已练的题数 */
async function getDoneCounts(conn, userId, poolKey, categoryIds) {
  const out = new Map();
  if (!userId || !categoryIds.length) return out;

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

  // 按分类聚合已练数
  const placeholders = categoryIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT m.category_id, COUNT(DISTINCT m.ref_id) AS c
       FROM question_category_map m
      WHERE m.pool = ? AND m.category_id IN (${placeholders})
      GROUP BY m.category_id`,
    [poolKey, ...categoryIds]
  );
  rows.forEach((r) => out.set(r.category_id, Number(r.c) || 0));

  // 精确匹配用户已练的 ref_id（上面是分类内总题数里含未练的，改为按 ref 精确统计）
  const refIds = [...doneRefs]
    .filter((k) => k.startsWith(`${poolKey}:`))
    .map((k) => Number(k.slice(poolKey.length + 1)))
    .filter((n) => Number.isFinite(n));
  if (!refIds.length) return out;

  const ph2 = refIds.map(() => '?').join(',');
  const [exact] = await conn.query(
    `SELECT m.category_id, COUNT(DISTINCT m.ref_id) AS c
       FROM question_category_map m
      WHERE m.pool = ? AND m.ref_id IN (${ph2})
      GROUP BY m.category_id`,
    [poolKey, ...refIds]
  );
  out.clear();
  exact.forEach((r) => out.set(r.category_id, Number(r.c) || 0));
  return out;
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
    if (cfg.statusField) {
      where.push(`t.${cfg.statusField} = ?`);
      params.push(cfg.statusValue);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[row]] = await conn.query(
      `SELECT COUNT(DISTINCT t.id) AS c
         FROM ${cfg.table} t
         JOIN question_category_map m ON m.pool = ? AND m.ref_id = t.id
        ${whereSql}`,
      [poolKey, ...params]
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
    if (cfg.statusField) {
      where.push(`t.${cfg.statusField} = ?`);
      params.push(cfg.statusValue);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // RAND() 让每次刷题的顺序与组合都不同（粉笔的「去练习」是随机的）
    // 同上：GROUP BY 列与 SELECT 一致，question 池不带 t.section
    const secCol2 = poolKey === 'question' ? 't.subject_id' : 't.subject_id, t.section';
    const [rows] = await conn.query(
      `SELECT t.id, t.qtype, t.difficulty${poolKey === 'question' ? ', t.subject_id' : ', t.section'},
              t.stem, t.passage, t.options_json, t.answer, t.explanation
         FROM ${cfg.table} t
         JOIN question_category_map m ON m.pool = ? AND m.ref_id = t.id
        ${whereSql}
        GROUP BY t.id, t.qtype, t.difficulty, ${secCol2},
                 t.stem, t.passage, t.options_json, t.answer, t.explanation
        ORDER BY RAND()
        LIMIT ${count}`,
      [poolKey, ...params]
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
};
