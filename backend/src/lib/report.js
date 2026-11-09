/**
 * 个人学习报告聚合（参照粉笔「用户报告」：按时间窗、按模块、可对比）。
 *
 * 口径约定：
 *   - 答题量 / 正确率来自 practice_answer（只在交卷时写入），按 practice_session.started_at 归日；
 *   - 学习时长 / 练习次数 / 活跃天数来自 practice_session，只统计 completed；
 *   - 一律排除 duration_sec = 0 与 time_spent_sec = 0，避免老数据把均值拉低；
 *   - 时间边界用本地日期串做「>= 今天 00:00 AND < 明天 00:00」范围比较，
 *     不用 DATE(col) = ?（会把列包进函数、索引失效），也不依赖 MySQL 的 UTC 时区。
 */
'use strict';

const { localDateStr, shiftDateStr } = require('./time');

const RANGE_DAYS = { '7d': 7, '30d': 30 };
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 200;
const reportCache = new Map();

function shiftDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return localDateStr(d);
}

function round2(n) {
  return Number(Number(n || 0).toFixed(4));
}

/** MySQL DATE() 可能返回 JS Date 对象，也可能是 'YYYY-MM-DD' 字符串，统一成本地日期串 */
function isoDate(v) {
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v == null ? '' : v).slice(0, 10);
}

/** 本期与上期（等长）窗口；month = 本月 1 号至今 */
function windowOf(range) {
  const today = localDateStr();
  const tomorrow = shiftDateStr(1);
  const fromStr = range === 'month' ? today.slice(0, 8) + '01' : shiftDateStr(-((RANGE_DAYS[range] || 7) - 1));
  const days = Math.max(1, Math.round(
    (new Date(tomorrow + 'T00:00:00') - new Date(fromStr + 'T00:00:00')) / 86400000
  ));
  const prevFromStr = shiftDays(fromStr, -days);
  return {
    range, days,
    fromStr, toStr: shiftDays(tomorrow, -1),
    fromTime: fromStr + ' 00:00:00', toTime: tomorrow + ' 00:00:00',
    prevFromTime: prevFromStr + ' 00:00:00', prevToTime: fromStr + ' 00:00:00',
  };
}

/**
 * 单个窗口的统计。userId 传 null 表示全站（用于「与全站平均对比」）。
 * 过滤条件全部下推到 SQL；仅模块归组用的维度表在应用层做 Map 匹配。
 */
async function computeRange(conn, userId, fromTime, toTime, opts = {}) {
  const userClause = userId == null ? '' : ' AND s.user_id = ?';
  const tail = userId == null ? [] : [userId];
  const where = `s.started_at >= ? AND s.started_at < ? AND s.status = 'completed'${userClause}`;

  // ① 按日答题量与正确数（GROUP BY 日期，WHERE 仍是范围比较）
  const [dailyRows] = await conn.query(
    `SELECT DATE(s.started_at) AS d, COUNT(*) AS questions, COALESCE(SUM(a.is_correct), 0) AS correct
       FROM practice_answer a JOIN practice_session s ON s.id = a.session_id
      WHERE ${where}
      GROUP BY DATE(s.started_at)`,
    [fromTime, toTime, ...tail]
  );

  // ② 会话口径：次数、有效时长、活跃天数、参与人数
  const [sessionRows] = await conn.query(
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(NULLIF(s.duration_sec, 0)), 0) AS duration_sec,
            COUNT(DISTINCT DATE(s.started_at)) AS active_days,
            COUNT(DISTINCT s.user_id) AS users
       FROM practice_session s
      WHERE ${where}`,
    [fromTime, toTime, ...tail]
  );

  const byDate = new Map(dailyRows.map((r) => [isoDate(r.d), r]));
  let questions = 0;
  let correct = 0;
  for (const r of dailyRows) { questions += Number(r.questions); correct += Number(r.correct); }
  const sr = sessionRows[0] || {};
  const summary = {
    questions,
    correct,
    accuracy: questions > 0 ? round2(correct / questions) : null,
    durationSec: Number(sr.duration_sec) || 0,
    sessions: Number(sr.sessions) || 0,
    activeDays: Number(sr.active_days) || 0,
    users: Number(sr.users) || 0,
  };

  // ③ 按日序列补零（无数据的日子 accuracy 为 null，不画成 0%）
  let daily = [];
  if (opts.withDaily) {
    const startDate = fromTime.slice(0, 10);
    const dayCount = Math.max(1, Math.round(
      (new Date(toTime.slice(0, 10) + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 86400000
    ));
    daily = Array.from({ length: dayCount }, (_, i) => {
      const date = shiftDays(startDate, i);
      const hit = byDate.get(date);
      const q = hit ? Number(hit.questions) : 0;
      const c = hit ? Number(hit.correct) : 0;
      return { date, questions: q, correct: c, accuracy: q > 0 ? round2(c / q) : null };
    });
  }

  // ④ 按一级模块聚合（一题多映射时用 MIN(category_id) 去重，避免放大行数）
  let modules = [];
  if (opts.withModules) {
    const [modRows] = await conn.query(
      `SELECT c.id AS category_id, c.name, c.slug,
              COUNT(*) AS attempts, COALESCE(SUM(a.is_correct), 0) AS correct,
              ROUND(AVG(NULLIF(a.time_spent_sec, 0)), 1) AS avg_time_sec
         FROM practice_answer a
         JOIN practice_session s ON s.id = a.session_id
         LEFT JOIN (
           SELECT m.ref_id, MIN(m.category_id) AS category_id
             FROM question_category_map m
             JOIN question_category c2 ON c2.id = m.category_id AND (c2.level = 1 OR c2.dim = 'module')
            WHERE m.pool = 'question'
            GROUP BY m.ref_id
         ) mm ON mm.ref_id = a.question_id
         LEFT JOIN question_category c ON c.id = mm.category_id
        WHERE ${where}
        GROUP BY c.id, c.name, c.slug`,
      [fromTime, toTime, ...tail]
    );
    modules = modRows
      .filter((r) => r.category_id != null)
      .map((r) => ({
        categoryId: Number(r.category_id),
        name: r.name,
        slug: r.slug,
        attempts: Number(r.attempts),
        correct: Number(r.correct),
        accuracy: Number(r.attempts) > 0 ? round2(Number(r.correct) / Number(r.attempts)) : null,
        avgTimeSec: r.avg_time_sec == null ? null : Number(r.avg_time_sec),
      }));
  }

  return { summary, daily, modules };
}

function diff(a, b) {
  return a == null || b == null ? null : round2(a - b);
}

/** 生成报告；带 60s 进程内缓存，按 用户+时间窗 隔离 */
async function buildReport(conn, userId, range) {
  const key = `${userId}:${range || '7d'}`;
  const hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const w = windowOf(range);
  const current = await computeRange(conn, userId, w.fromTime, w.toTime, { withDaily: true, withModules: true });
  const previous = await computeRange(conn, userId, w.prevFromTime, w.prevToTime, {});
  const site = await computeRange(conn, null, w.fromTime, w.toTime, { withModules: true });

  // 固定六模块轴：没作答的模块也要出现在雷达里（显示「暂无数据」，不是 0 分）
  const [moduleDefs] = await conn.query(
    'SELECT id, name, slug FROM question_category WHERE level = 1 ORDER BY sort_order, id'
  );
  const myMap = new Map(current.modules.map((m) => [m.categoryId, m]));
  const siteMap = new Map(site.modules.map((m) => [m.categoryId, m.accuracy]));
  const modules = moduleDefs.map((c) => {
    const m = myMap.get(Number(c.id));
    const attempts = m ? m.attempts : 0;
    return {
      categoryId: Number(c.id), name: c.name, slug: c.slug,
      attempts,
      correct: m ? m.correct : 0,
      accuracy: m ? m.accuracy : null,
      avgTimeSec: m ? m.avgTimeSec : null,
      siteAccuracy: siteMap.has(Number(c.id)) ? siteMap.get(Number(c.id)) : null,
      lowSample: attempts < 3,
    };
  });

  const payload = {
    range: w.range,
    from: w.fromStr,
    to: w.toStr,
    days: w.days,
    current: current.summary,
    previous: previous.summary,
    delta: {
      questions: diff(current.summary.questions, previous.summary.questions),
      accuracy: diff(current.summary.accuracy, previous.summary.accuracy),
      durationSec: diff(current.summary.durationSec, previous.summary.durationSec),
      sessions: diff(current.summary.sessions, previous.summary.sessions),
    },
    daily: current.daily,
    modules,
    site: { accuracy: site.summary.accuracy, questions: site.summary.questions, users: site.summary.users },
    generatedAt: new Date().toISOString(),
  };

  if (reportCache.size >= CACHE_MAX) reportCache.clear();
  reportCache.set(key, { at: Date.now(), payload });
  return payload;
}

module.exports = { buildReport, windowOf, computeRange };
