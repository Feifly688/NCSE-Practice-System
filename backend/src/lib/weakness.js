/**
 * 学情诊断（薄弱点识别）。
 *
 * 数据链路：
 *   practice_answer(session_id, question_id, is_correct, time_spent_sec)
 *     → practice_session(user_id)
 *     → question(id, qtype, ...)
 *     → question_category_map(pool='question', ref_id=question.id, category_id)
 *     → question_category(level=1 或 dim='module'：一级模块)
 *
 * 设计要点：
 *   · 只依赖外部传入的 conn（不自建 withConnection），供 /pick 在单连接内复用。
 *   · 固定 3 次查询（作答明细 / 分类元信息 / 一级模块映射），无 N+1；
 *     模块映射用 GROUP BY ref_id + MIN(category_id) 保证「一题只归一模块」，
 *     避免 question_category_map 一题多映射把作答数重复计算。
 *   · avgTimeSec 忽略 time_spent_sec = 0 的记录（0 多为历史未记录用时，一并计入
 *     会系统性拉低均值）；若某模块/题型没有任何有效用时则为 0。
 *   · wrongCount 采用作答口径 attempts - correct（与 attempts/correct 同源自洽），
 *     不引入 wrong_book 累计错次（口径不同，且 mastered 会重置）。
 *   · SQL 一律参数绑定；本模块不使用 IN(...)，故无需占位符上限保护。
 */

'use strict';

// weakScore 权重：正确率低 0.6 + 归一化耗时 0.25 + 归一化错次 0.15
const WEAK_SCORE_WEIGHTS = { accuracy: 0.6, time: 0.25, wrong: 0.15 };
// 样本数低于该值的模块按 attempts / MIN 线性降权，避免一两道题被误判为薄弱
const MIN_SAMPLES_FOR_FULL_WEIGHT = 3;
// topWeak / weakCategoryIds 最多取 3 个一级模块
const MAX_WEAK_MODULES = 3;

/** 四舍五入到指定小数位（避免浮点尾数污染 JSON） */
function round(n, digits) {
  const f = 10 ** digits;
  return Math.round((Number(n) || 0) * f) / f;
}

/** 用户无作答数据时的空画像 */
function emptyProfile() {
  return {
    hasData: false,
    totalAnswered: 0,
    modules: [],
    byQtype: [],
    topWeak: [],
    weakCategoryIds: [],
  };
}

/**
 * 单个模块的 weakScore（纯函数，便于复用/单测）。
 * 归一化基准 maxTime / maxWrong 取自「有作答模块」集合内部，
 * 因此分数只反映该用户自身的相对薄弱度，而非全库绝对耗时/错次。
 *
 *   raw = (1-accuracy)*0.6 + (avgTimeSec/maxTime)*0.25 + (wrongCount/maxWrong)*0.15
 *   weakScore = raw * min(1, attempts / 3)   // 样本 <3 降权
 */
function computeWeakScore(metrics, maxTime, maxWrong) {
  const normTime = maxTime > 0 ? metrics.avgTimeSec / maxTime : 0;
  const normWrong = maxWrong > 0 ? metrics.wrongCount / maxWrong : 0;
  const raw = (1 - metrics.accuracy) * WEAK_SCORE_WEIGHTS.accuracy
    + normTime * WEAK_SCORE_WEIGHTS.time
    + normWrong * WEAK_SCORE_WEIGHTS.wrong;
  const confidence = Math.min(1, metrics.attempts / MIN_SAMPLES_FOR_FULL_WEIGHT);
  return round(raw * confidence, 4);
}

/**
 * 生成用户学情画像。
 *
 * @param {Object} conn   外部传入的 mysql2 连接（复用，不自建连接）
 * @param {number} userId 用户 id
 * @returns {Promise<{hasData:boolean, totalAnswered:number, modules:Array,
 *                    byQtype:Array, topWeak:Array, weakCategoryIds:number[]}>}
 */
async function getWeaknessProfile(conn, userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return emptyProfile();

  // ① 该用户全部作答明细。JOIN 命中的都是主键/唯一键：
  //    一条 practice_answer 只会对应一行 session、一行 question，不会被放大。
  const [answerRows] = await conn.query(
    `SELECT pa.question_id, pa.is_correct, pa.time_spent_sec, q.qtype
       FROM practice_answer pa
       JOIN practice_session ps ON ps.id = pa.session_id AND ps.user_id = ?
       JOIN question q ON q.id = pa.question_id`,
    [uid]
  );
  if (!answerRows.length) return emptyProfile();

  // ② 分类元信息：一次拉全表在内存建索引（与分类树同款做法），无 N+1。
  const [catRows] = await conn.query(
    'SELECT id, parent_id, level, name, slug, dim FROM question_category'
  );
  const catById = new Map();
  for (const c of catRows) {
    const id = Number(c.id);
    catById.set(id, {
      categoryId: id,
      name: c.name,
      slug: c.slug,
      level: Number(c.level),
      dim: c.dim,
    });
  }

  // ③ 一级模块映射：按 ref_id 去重（MIN(category_id)）。
  //    一题常同时挂一级模块与二级题型两张映射，若按映射行直接 JOIN，
  //    作答数会翻倍；这里先按题目聚合出唯一一级模块，再在内存归模块。
  const [mapRows] = await conn.query(
    `SELECT m.ref_id, MIN(m.category_id) AS module_id
       FROM question_category_map m
       JOIN question_category c ON c.id = m.category_id
        AND (c.level = 1 OR c.dim = 'module')
      WHERE m.pool = ?
      GROUP BY m.ref_id`,
    ['question']
  );
  const moduleOf = new Map(); // questionId -> moduleId
  for (const r of mapRows) moduleOf.set(Number(r.ref_id), Number(r.module_id));

  // 内存聚合：模块维度 + 题型维度，一次遍历完成
  const moduleAgg = new Map(); // moduleId -> agg
  const qtypeAgg = new Map();  // qtype    -> agg
  const newAgg = () => ({ attempts: 0, correct: 0, timeSum: 0, timeCount: 0 });

  for (const r of answerRows) {
    const qid = Number(r.question_id);
    const correct = Number(r.is_correct) === 1 ? 1 : 0;
    const t = Number(r.time_spent_sec) || 0;
    const qtype = r.qtype == null ? '' : String(r.qtype);

    // 题型：所有作答都计入（含没有一级模块标签的题）
    let qa = qtypeAgg.get(qtype);
    if (!qa) { qa = newAgg(); qtypeAgg.set(qtype, qa); }
    qa.attempts += 1;
    qa.correct += correct;
    if (t > 0) { qa.timeSum += t; qa.timeCount += 1; }

    // 模块：只归到有一级模块标签的作答
    const mid = moduleOf.get(qid);
    if (mid != null && catById.has(mid)) {
      let ma = moduleAgg.get(mid);
      if (!ma) { ma = newAgg(); moduleAgg.set(mid, ma); }
      ma.attempts += 1;
      ma.correct += correct;
      if (t > 0) { ma.timeSum += t; ma.timeCount += 1; }
    }
  }

  // 组装模块基础指标（保留未取整的原始值用于打分，输出时再取整）
  const base = [];
  for (const [mid, a] of moduleAgg) {
    const cat = catById.get(mid);
    const accuracy = a.attempts > 0 ? a.correct / a.attempts : 0;
    const avgTimeSec = a.timeCount > 0 ? a.timeSum / a.timeCount : 0;
    const wrongCount = a.attempts - a.correct;
    base.push({
      categoryId: mid,
      name: cat.name,
      slug: cat.slug,
      level: cat.level,
      attempts: a.attempts,
      correct: a.correct,
      wrongCount,
      _accuracy: accuracy,
      _avgTimeSec: avgTimeSec,
    });
  }
  const maxTime = base.reduce((m, x) => Math.max(m, x._avgTimeSec), 0);
  const maxWrong = base.reduce((m, x) => Math.max(m, x.wrongCount), 0);
  const modules = base.map((m) => ({
    categoryId: m.categoryId,
    name: m.name,
    slug: m.slug,
    level: m.level,
    attempts: m.attempts,
    correct: m.correct,
    accuracy: round(m._accuracy, 4),
    avgTimeSec: round(m._avgTimeSec, 1),
    wrongCount: m.wrongCount,
    weakScore: computeWeakScore(
      { accuracy: m._accuracy, avgTimeSec: m._avgTimeSec, wrongCount: m.wrongCount, attempts: m.attempts },
      maxTime,
      maxWrong
    ),
  })).sort((x, y) => y.weakScore - x.weakScore || y.attempts - x.attempts);

  const byQtype = [...qtypeAgg.entries()]
    .map(([qtype, a]) => ({
      qtype,
      attempts: a.attempts,
      correct: a.correct,
      accuracy: round(a.attempts > 0 ? a.correct / a.attempts : 0, 4),
      avgTimeSec: round(a.timeCount > 0 ? a.timeSum / a.timeCount : 0, 1),
    }))
    .sort((x, y) => y.attempts - x.attempts);

  // topWeak 只取「有作答数据且真正薄弱（weakScore>0）」的模块，最多 3 个；
  // 全对且快的模块 weakScore=0，不应被当作薄弱点去加权抽题。
  const topWeak = modules
    .filter((m) => m.weakScore > 0)
    .slice(0, MAX_WEAK_MODULES)
    .map((m) => ({
      categoryId: m.categoryId,
      name: m.name,
      accuracy: m.accuracy,
      weakScore: m.weakScore,
    }));
  const weakCategoryIds = topWeak.map((m) => m.categoryId);

  return {
    hasData: true,
    totalAnswered: answerRows.length,
    modules,
    byQtype,
    topWeak,
    weakCategoryIds,
  };
}

module.exports = {
  getWeaknessProfile,
  computeWeakScore,
  emptyProfile,
  WEAK_SCORE_WEIGHTS,
  MIN_SAMPLES_FOR_FULL_WEIGHT,
  MAX_WEAK_MODULES,
};
