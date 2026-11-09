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

/* ── 分类树静态骨架缓存 ──────────────────────────────────────────────
 * 缓存内容：分类节点结构 + 每个分类子树内的「去重题目 id 集合」，按 pool 分 key。
 *          这两部分只随分类/映射/上架题变化，与用户无关，可安全复用。
 * 不缓存：用户相关的 doneCount（已练题数）等 —— getDoneSets 每次实时查，
 *          因此提交练习后无需失效缓存，用户不会看到过期进度。
 * 失效：TTL(300s) 到期自动重建；进程重启自然清空；管理端改分类节点/映射后
 *       可调用 clearTaxonomyCache() 主动清空（本轮暂未接调用点）。
 * 上限：key 仅按 pool（最多 3 个），仍设硬上限防止未来扩展导致无限增长。
 * 响应结构：仍按 id/parentId/level/name/slug/dim/sortOrder/totalCount/
 *          doneCount/children 逐字段组装，与前端依赖完全一致。
 */
const STATIC_TREE_TTL_MS = 300 * 1000;
const STATIC_TREE_MAX_ENTRIES = 16;
const staticTreeCache = new Map(); // poolKey -> { promise, expiresAt }

/** 清空分类树静态缓存，供管理端改分类节点/映射后调用（本轮未接调用点）。 */
function clearTaxonomyCache() {
  staticTreeCache.clear();
}

/** Fisher-Yates 原地打乱（Node 端随机抽题，替代 SQL 全表 ORDER BY RAND()）。 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 取（或构建）某 pool 的分类树静态骨架。
 * 并发的同 pool 请求共用一个 in-flight promise，避免缓存击穿时重复重算。
 */
function getStaticTree(conn, poolKey) {
  const now = Date.now();
  const hit = staticTreeCache.get(poolKey);
  if (hit && hit.expiresAt > now) return hit.promise;

  const build = buildStaticTree(conn, poolKey).catch((err) => {
    staticTreeCache.delete(poolKey); // 构建失败不缓存，下次请求重试
    throw err;
  });
  if (staticTreeCache.size >= STATIC_TREE_MAX_ENTRIES) {
    staticTreeCache.delete(staticTreeCache.keys().next().value);
  }
  staticTreeCache.set(poolKey, { promise: build, expiresAt: now + STATIC_TREE_TTL_MS });
  return build;
}

/** 一次性查询并计算静态骨架：节点结构 + 子树分类 id + 子树去重题目 id 集合。 */
async function buildStaticTree(conn, poolKey) {
  const [rows] = await conn.query(
    `SELECT c.id, c.parent_id, c.level, c.name, c.slug, c.dim, c.sort_order
       FROM question_category c
      ORDER BY c.level, c.sort_order, c.id`
  );

  // 每个分类「直挂」的题目集合（按题目去重，跨层级不重复计数）。
  // 背景：一道题会同时挂一级模块和二级题型两张映射，若按映射行数逐层求和，
  // 模块总数会翻倍（言语 4326 显示成 8652）；统一改为「子树内去重题目数」。
  let refJoin = '';
  if (poolKey === 'question') {
    refJoin = "JOIN question q ON q.id = m.ref_id AND q.status = 'approved'\n" +
      "             AND (q.source_exam IS NULL OR q.source_exam NOT LIKE '%AI生成%') AND q.source_article_id IS NULL";
  }
  const [mapRows] = await conn.query(
    `SELECT m.category_id, m.ref_id
       FROM question_category_map m
       ${refJoin}
      WHERE m.pool = ?`,
    [poolKey]
  );
  const direct = new Map(); // categoryId -> Set(questionId)
  for (const r of mapRows) {
    if (!direct.has(r.category_id)) direct.set(r.category_id, new Set());
    direct.get(r.category_id).add(Number(r.ref_id));
  }

  const childrenOf = new Map();
  rows.forEach((r) => {
    if (r.parent_id) {
      if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, []);
      childrenOf.get(r.parent_id).push(r.id);
    }
  });

  // 自底向上一次算出每个节点「子树分类 id 列表」与「子树去重题目 id 集合」，
  // 替代原先对每个节点都重复遍历子树（O(N^2)）。state 同时防环。
  const subtreeIds = new Map();  // nodeId -> number[]
  const subtreeQids = new Map(); // nodeId -> Set(questionId)
  const state = new Map();       // 0/1/2 未访问/访问中/已完成
  const compute = (nodeId) => {
    if (state.get(nodeId) === 2) return;
    if (state.get(nodeId) === 1) return; // 回边，防环
    state.set(nodeId, 1);
    const ids = [nodeId];
    const qids = new Set(direct.get(nodeId) || []);
    for (const cid of childrenOf.get(nodeId) || []) {
      compute(cid);
      if (state.get(cid) === 2) {
        for (const x of subtreeIds.get(cid)) ids.push(x);
        for (const x of subtreeQids.get(cid)) qids.add(x);
      }
    }
    subtreeIds.set(nodeId, ids);
    subtreeQids.set(nodeId, qids);
    state.set(nodeId, 2);
  };
  rows.forEach((r) => compute(r.id));

  return { rows, subtreeIds, subtreeQids };
}

/** 用静态骨架 + 实时 doneSets 组装最终分类树（doneCount 每次现算，不缓存）。 */
function assembleTree(staticData, doneSets) {
  const { rows, subtreeIds, subtreeQids } = staticData;
  const byId = new Map();
  rows.forEach((r) => {
    const d = new Set();
    for (const cid of subtreeIds.get(r.id) || []) {
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
      totalCount: (subtreeQids.get(r.id) || new Set()).size,
      doneCount: d.size,
      children: [],
    });
  });
  const roots = [];
  byId.forEach((node) => {
    if (node.parentId && byId.get(node.parentId)) byId.get(node.parentId).children.push(node);
    else roots.push(node);
  });
  return roots;
}

/**
 * 读整棵分类树，并带上每个分类的「已练/总数」统计。
 * 静态骨架走缓存；用户相关的 doneCount 实时查，保证进度即时反映。
 *
 * @param {number} userId  用于统计用户已练题数
 * @param {string} pool    题池
 * @returns {Promise<Array>} 分类树节点
 */
async function getCategoryTree(userId, pool) {
  const poolKey = POOLS[pool] ? pool : 'question';
  return withConnection(async (conn) => {
    const staticData = await getStaticTree(conn, poolKey);
    const doneSets = await getDoneSets(conn, userId, poolKey); // 实时，不缓存
    return assembleTree(staticData, doneSets);
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

const MATERIAL_GROUP_SIZE = 5; // 一篇资料固定 5 道小题
const normPassagePrefix = (s) => String(s || '').replace(/\s+/g, '').slice(0, 100);

/**
 * 抽资料分析材料题组：一篇材料 = 1 个父级大题 + 固定 5 道小题。
 * 识别依据：同一来源卷 + 归一化后的材料正文前缀相同；只取恰好能凑满 5 题的组。
 * 年份过滤后完整组不足时，用剩余资料分析题按 5 题一组补齐（父题材料取组内
 * 最长的 passage），保证任何情况下资料分析都不会散成彼此独立的单题。
 *
 * 性能：无 LIMIT 的候选集只 SELECT 分桶所需的轻量列（id/passage/来源卷），
 *       抽中后再按 id IN(...) 取回完整题目行，避免把 stem/options_json/answer/
 *       explanation 等大字段全库拉进内存；结果集与抽题逻辑完全不变。
 */
async function pickMaterialGroups(conn, subjectId, yearFrom, needGroups) {
  const params = [subjectId];
  let yearSql = '';
  if (yearFrom) { yearSql = 'AND q.year >= ?'; params.push(yearFrom); }
  const [rows] = await conn.query(
    `SELECT q.id, q.source_paper_id, q.source_paper_seq, q.passage
       FROM question q
      WHERE q.status = 'approved' AND q.subject_id = ?
        AND (q.source_exam IS NULL OR q.source_exam NOT LIKE '%AI生成%') AND q.source_article_id IS NULL
        ${yearSql}
      ORDER BY q.source_paper_id, q.source_paper_seq, q.id`,
    params
  );

  // ① 完整的真实材料组
  const buckets = new Map();
  for (const r of rows) {
    const p = String(r.passage || '').trim();
    if (p.length < 80) continue;
    const key = `${r.source_paper_id}|${normPassagePrefix(p)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const full = [...buckets.values()].filter((v) => v.length >= MATERIAL_GROUP_SIZE)
    .map((v) => v.slice(0, MATERIAL_GROUP_SIZE));
  // 打乱组顺序（Fisher-Yates），每次组卷抽到不同材料
  for (let i = full.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [full[i], full[j]] = [full[j], full[i]];
  }
  const chosen = full.slice(0, needGroups);

  // ② 兜底：完整组不够时，用未被选中的题按 5 题一组合成
  const used = new Set(chosen.flat().map((r) => r.id));
  const leftovers = rows.filter((r) => !used.has(r.id));
  for (let i = 0; chosen.length < needGroups && leftovers.length >= MATERIAL_GROUP_SIZE; i++) {
    const chunk = leftovers.splice(0, MATERIAL_GROUP_SIZE);
    chosen.push(chunk);
  }

  // ③ 抽中后再按 id IN(...) 取回完整题目行（含 answer/explanation，供落卷使用）
  const chosenIds = chosen.flat().map((r) => r.id);
  const fullById = new Map();
  if (chosenIds.length) {
    const ph = chosenIds.map(() => '?').join(',');
    const [fetched] = await conn.query(
      `SELECT q.id, q.subject_id, q.qtype, q.difficulty, q.passage, q.stem,
              q.options_json, q.answer, q.explanation,
              q.source_paper_id, q.source_paper_seq, q.year
         FROM question q
        WHERE q.id IN (${ph})`,
      chosenIds
    );
    for (const r of fetched) fullById.set(Number(r.id), r);
  }

  return chosen.map((members, idx) => {
    const passage = members.map((r) => String(r.passage || '').trim())
      .sort((a, b) => b.length - a.length)[0] || '';
    const fullMembers = members.map((r) => fullById.get(Number(r.id))).filter(Boolean);
    return {
      groupNo: idx + 1,
      title: `材料${['一', '二', '三', '四', '五', '六'][idx] || idx + 1}`,
      passage,
      images: '',
      questions: fullMembers.map((r) => ({ ...r, section: '资料分析' })),
    };
  });
}

/**
 * 智能组卷：把 5 个非资料分析分区的「6 次串行 ORDER BY RAND() 全表排序」
 * 合并为「一次轻量 id 查询 + Node 内按科目随机抽取 + 一次完整行回取」，
 * 单连接串行完成，避免并发多连接占用、也不破坏 130 题固定结构与材料题组。
 */
async function pickSmartPaper(opts = {}) {
  const span = { near3: 3, near5: 5, near10: 10 }[String(opts.yearMode || '')] || 0;
  const yearFrom = span ? new Date().getFullYear() - span : null;

  return withConnection(async (conn) => {
    const [subjects] = await conn.query('SELECT id, slug FROM subject');
    const bySlug = new Map(subjects.map((x) => [x.slug, x.id]));

    const dataTpl = SMART_PAPER_TEMPLATE.find((t) => t.subjectSlug === 'data_analysis');
    const nonData = SMART_PAPER_TEMPLATE.filter((t) => t.subjectSlug !== 'data_analysis');

    // 合并 5 个分区：一次查出各科目候选 id（轻量列，无 ORDER BY RAND()）
    const sids = [];
    for (const t of nonData) {
      const sid = bySlug.get(t.subjectSlug);
      if (sid) sids.push(Number(sid));
    }
    const idsBySid = new Map();
    if (sids.length) {
      const ph = sids.map(() => '?').join(',');
      const params = [...sids];
      let yearSql = '';
      if (yearFrom) { yearSql = 'AND q.year >= ?'; params.push(yearFrom); }
      const [rows] = await conn.query(
        `SELECT q.id, q.subject_id
           FROM question q
          WHERE q.status = 'approved' AND q.subject_id IN (${ph})
            AND (q.source_exam IS NULL OR q.source_exam NOT LIKE '%AI生成%') AND q.source_article_id IS NULL
            ${yearSql}`,
        params
      );
      for (const r of rows) {
        const sid = Number(r.subject_id);
        if (!idsBySid.has(sid)) idsBySid.set(sid, []);
        idsBySid.get(sid).push(Number(r.id));
      }
    }

    // Node 内随机抽取：等价于原来每分区 ORDER BY RAND() LIMIT n
    // （全局/分组均匀洗牌后按科目取前 n 个，是无放回均匀随机样本）
    const pickedIdsBySection = new Map();
    const allPickedIds = [];
    for (const t of nonData) {
      const sid = bySlug.get(t.subjectSlug);
      const ids = sid ? shuffle([...(idsBySid.get(Number(sid)) || [])]).slice(0, t.count) : [];
      pickedIdsBySection.set(t.section, ids);
      allPickedIds.push(...ids);
    }

    // 一次性取回选中题目的完整行（TEXT/JSON 列不参与排序/分组）
    const fullById = new Map();
    if (allPickedIds.length) {
      const ph = allPickedIds.map(() => '?').join(',');
      const [full] = await conn.query(
        `SELECT id, subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation
           FROM question
          WHERE id IN (${ph})`,
        allPickedIds
      );
      for (const r of full) fullById.set(Number(r.id), r);
    }

    // 资料分析：按完整材料题组抽取（候选集列已收敛，抽中后再取完整行）
    let materialGroups = [];
    const dataSid = dataTpl ? bySlug.get(dataTpl.subjectSlug) : undefined;
    if (dataSid) {
      materialGroups = await pickMaterialGroups(conn, dataSid, yearFrom, dataTpl.count / MATERIAL_GROUP_SIZE);
    }

    // 按模板顺序组装 sections / questions，保持 130 题固定结构与材料题组
    const sections = [];
    const questions = [];
    for (const t of SMART_PAPER_TEMPLATE) {
      if (t.subjectSlug === 'data_analysis') {
        const picked = materialGroups.flatMap((g) => g.questions);
        sections.push({ section: t.section, target: t.count, picked: picked.length,
          groups: materialGroups.length, groupSize: MATERIAL_GROUP_SIZE });
        // 每题带上所属材料组序号，保存时据此建立父子关联
        materialGroups.forEach((g) => g.questions.forEach((q) => { q.materialGroupNo = g.groupNo; }));
        questions.push(...picked);
        continue;
      }
      const ids = pickedIdsBySection.get(t.section) || [];
      const rows = ids.map((id) => fullById.get(id)).filter(Boolean)
        .map((r) => ({ ...r, section: t.section }));
      sections.push({ section: t.section, target: t.count, picked: rows.length });
      questions.push(...rows);
    }
    // 材料正文只保存在父级大题里，子题不再各自重复携带（避免散题化）
    for (const q of questions) {
      if (q.materialGroupNo) q.passage = null;
    }
    return { questions, sections, materialGroups, total: questions.length };
  });
}

/**
 * 列出某分类下的题目（可直接用于组卷）。
 *
 * 可选传入 conn 复用外部连接（不传则内部 withConnection），供上层在
 * 同一连接/快照内完成 count 与 list，避免单请求占用多个连接。
 *
 * @param {Object} opts
 * @param {string} opts.pool       题池
 * @param {number[]} opts.categoryIds 分类 id（子分类也包含）
 * @param {string[]} opts.qtypes   题型过滤
 * @param {number[]} opts.difficultyRange [min,max]
 * @param {number} opts.limit      数量上限
 * @param {number} opts.offset     偏移
 */
async function listQuestionsByCategory(opts, existingConn) {
  const poolKey = POOLS[opts.pool] ? opts.pool : 'question';
  const cfg = POOLS[poolKey];

  const exec = async (conn) => {
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
    // LIMIT/OFFSET 数值 clamp 后再拼接，杜绝非法/负数注入
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 200);
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
  };

  return existingConn ? exec(existingConn) : withConnection(exec);
}

/**
 * 统计某分类（或全库）符合条件的题目数量 —— 用于「已练/总数」与组卷可行性检查。
 * 可选传入 conn 复用外部连接（不传则内部 withConnection）。
 */
async function countQuestions(opts, existingConn) {
  const poolKey = POOLS[opts.pool] ? opts.pool : 'question';
  const cfg = POOLS[poolKey];

  const exec = async (conn) => {
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
    // 来源：国考真题（source_exam 含「国家公务员」） / 地方真题（其余）
    if (opts.sourceType === 'national' && poolKey === 'question') {
      where.push('t.source_exam LIKE ?');
      params.push('%国家公务员%');
    } else if (opts.sourceType === 'local' && poolKey === 'question') {
      where.push('(t.source_exam IS NULL OR t.source_exam NOT LIKE ?)');
      params.push('%国家公务员%');
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
    // pool 值改用参数绑定（白名单值），不再拼接进 SQL。
    const needMap = cfg.requiresMap !== false;
    const mapJoin = needMap
      ? 'JOIN question_category_map m ON m.pool = ? AND m.ref_id = t.id'
      : '';
    const mapParam = needMap ? [poolKey] : [];
    const [[row]] = await conn.query(
      `SELECT COUNT(DISTINCT t.id) AS c
         FROM ${cfg.table} t
         ${mapJoin}
        ${whereSql}`,
      [...mapParam, ...params]
    );
    return Number(row.c) || 0;
  };

  return existingConn ? exec(existingConn) : withConnection(exec);
}

/**
 * 取分类的祖先链（用于把二级分类的题也纳入统计）。
 * 返回从该分类到根的 id 链（含自身）。
 * 一次拉全表建 parent 索引后在内存里向上走，消除逐层 N+1；保留 guard 防环。
 */
async function getCategoryAncestry(conn, categoryId) {
  const [rows] = await conn.query('SELECT id, parent_id FROM question_category');
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id]));
  const ids = [];
  let cur = Number(categoryId);
  let guard = 0;
  const seen = new Set();
  while (cur && guard < 10) {
    if (seen.has(cur)) break;      // 防环
    if (!parentOf.has(cur)) break; // 分类不存在则停止（与原逐层查不到即 break 一致）
    seen.add(cur);
    ids.push(cur);
    cur = parentOf.get(cur);
    guard += 1;
  }
  return ids;
}

/** 一次拉全部分类表，构建 parentId -> children[] 索引（供批量后代计算复用） */
async function loadCategoryChildrenIndex(conn) {
  const [rows] = await conn.query('SELECT id, parent_id FROM question_category');
  const childrenOf = new Map();
  for (const r of rows) {
    if (r.parent_id) {
      if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, []);
      childrenOf.get(r.parent_id).push(r.id);
    }
  }
  return childrenOf;
}

/** 从若干起点收集所有后代分类 id（含自身），Set 去重并防环，返回一维数组 */
function collectDescendantIds(childrenOf, startIds) {
  const out = new Set();
  const stack = [...startIds];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue; // 去重 + 防环
    out.add(cur);
    for (const cid of childrenOf.get(cur) || []) stack.push(cid);
  }
  return [...out];
}

/** 批量取多个分类的全部后代 id（含自身）：一次查询 + 内存计算并去重 */
async function getCategoryDescendantsBatch(conn, categoryIds) {
  const ids = (categoryIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const childrenOf = await loadCategoryChildrenIndex(conn);
  return collectDescendantIds(childrenOf, ids);
}

/** 取某分类的所有后代 id（含自身）—— 支持任意层级，单次查询 */
async function getCategoryDescendants(conn, categoryId) {
  return getCategoryDescendantsBatch(conn, [categoryId]);
}

/**
 * 按配置从分类树中抽题（自定义刷题的核心）。
 *
 * 策略：先按分类 + 题型 + 难度等条件查出「去重题目 id」（轻量 SELECT），
 * 在 Node 内随机抽取并应用「优先未做题」权重，再按 id IN(...) 取完整题目行；
 * TEXT/JSON 列不参与排序与 GROUP BY。筛选条件与题量上限全部保持不变。
 *
 * 可选传入 conn 复用外部连接（不传则内部 withConnection）。
 */
async function pickQuestionsByConfig(config, existingConn) {
  const poolKey = POOLS[config.pool] ? config.pool : 'question';
  const cfg = POOLS[poolKey];

  const count = Math.min(Math.max(Number(config.count) || 10, 1), 200);

  // 薄弱点加权（可选）：仅当传入有效 weakCategoryIds 时启用；
  // 为空时下面的 else 分支与原实现逐字节等价，不改变普通抽题的分布。
  // IN(...) 占位符上限保护：正常来源 topWeak 最多 3 个，这里留足余量。
  const MAX_WEAK_CATEGORY_IDS = 10;
  const weakCategoryIds = (Array.isArray(config.weakCategoryIds) ? config.weakCategoryIds : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_WEAK_CATEGORY_IDS);

  const exec = async (conn) => {
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
    // 来源：国考真题（source_exam 含「国家公务员」） / 地方真题（其余）
    if (config.sourceType === 'national' && poolKey === 'question') {
      where.push('t.source_exam LIKE ?');
      params.push('%国家公务员%');
    } else if (config.sourceType === 'local' && poolKey === 'question') {
      where.push('(t.source_exam IS NULL OR t.source_exam NOT LIKE ?)');
      params.push('%国家公务员%');
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

    // ① 轻量查询：只取符合条件的去重题目 id，TEXT/JSON 列不参与排序/分组
    const mapJoin = needMap ? 'JOIN question_category_map m ON m.pool = ? AND m.ref_id = t.id' : '';
    const mapParam = needMap ? [poolKey] : [];
    const [idRows] = await conn.query(
      `SELECT DISTINCT t.id
         FROM ${cfg.table} t
         ${mapJoin}
        ${whereSql}`,
      [...mapParam, ...params]
    );
    const candidateIds = idRows.map((r) => Number(r.id));

    // ② 排序选 id：preferUndoneIds 是已练过的题，排到后面。
    const preferSet = new Set(
      (Array.isArray(config.preferUndoneIds) ? config.preferUndoneIds : [])
        .map(Number).filter((n) => Number.isInteger(n) && n > 0)
    );

    let selectedIds;
    if (weakCategoryIds.length) {
      // ②-a 薄弱加权：额外查一次薄弱一级模块下的题目 id 集合，
      //     按「薄弱且未做 → 薄弱已做 → 非薄弱未做 → 非薄弱已做」四组排序，
      //     每组内仍 Fisher-Yates 洗牌，最后 slice(0, count)。
      //     既偏向薄弱模块，又保持组内随机性；未做的薄弱题优先。
      const wph = weakCategoryIds.map(() => '?').join(',');
      const [weakRows] = await conn.query(
        `SELECT DISTINCT ref_id FROM question_category_map
          WHERE pool = ? AND category_id IN (${wph})`,
        ['question', ...weakCategoryIds]
      );
      const weakSet = new Set(weakRows.map((r) => Number(r.ref_id)));

      const weakUndone = [], weakDone = [], otherUndone = [], otherDone = [];
      for (const id of candidateIds) {
        const isWeak = weakSet.has(id);
        const isDone = preferSet.has(id);
        if (isWeak && !isDone) weakUndone.push(id);
        else if (isWeak && isDone) weakDone.push(id);
        else if (!isDone) otherUndone.push(id);
        else otherDone.push(id);
      }
      selectedIds = [
        ...shuffle(weakUndone), ...shuffle(weakDone),
        ...shuffle(otherUndone), ...shuffle(otherDone),
      ].slice(0, count);
    } else {
      // ②-b 原逻辑（逐字节等价）：未做题随机在前、已做题随机补位，
      //     等价于 ORDER BY (t.id IN (preferIds)) ASC, RAND() LIMIT count。
      const undone = shuffle(candidateIds.filter((id) => !preferSet.has(id)));
      const done = shuffle(candidateIds.filter((id) => preferSet.has(id)));
      selectedIds = [...undone, ...done].slice(0, count);
    }
    if (!selectedIds.length) return [];

    // ③ 按 id IN(...) 取完整题目行（无 JOIN / GROUP BY，命中主键，开销小）
    const ph = selectedIds.map(() => '?').join(',');
    const [rows] = await conn.query(
      `SELECT t.id, t.qtype, t.difficulty, t.subject_id,
              t.stem, t.passage, t.options_json, t.answer, t.explanation
         FROM ${cfg.table} t
        WHERE t.id IN (${ph})`,
      selectedIds
    );
    // IN 查询不保证顺序，按随机选中的顺序还原
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return selectedIds.map((id) => byId.get(id)).filter(Boolean);
  };

  return existingConn ? exec(existingConn) : withConnection(exec);
}

module.exports = {
  POOLS,
  POOL_KEYS,
  getCategoryTree,
  clearTaxonomyCache,
  listQuestionsByCategory,
  countQuestions,
  getCategoryAncestry,
  getCategoryDescendants,
  getCategoryDescendantsBatch,
  pickQuestionsByConfig,
  pickSmartPaper,
};
