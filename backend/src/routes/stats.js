const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { localDateStr, shiftDateStr } = require('../lib/time');

const router = express.Router();

// 访问量上报是匿名可写接口，前端的 3 小时节流只在客户端生效，
// 直接打接口可以无限刷。这里按 IP 兜底限流。
const visitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 首页统计缓存：这组数据每次请求要跑 8 个聚合查询，且每个访客打开首页都会打一次。
// 统计口径本身允许几十秒的延迟，缓存住能挡掉绝大部分数据库压力。
const PUBLIC_STATS_TTL_MS = 30 * 1000;
let publicStatsCache = { at: 0, payload: null };
let publicStatsInflight = null;

/** 真正跑统计查询（8 个聚合），结果会被上层缓存复用 */
async function computePublicStats() {
  // 以 Node 本地时区（Asia/Shanghai）为事实源计算日期边界，
  // 避免 MySQL 服务端 UTC 时区导致凌晨记录被算到前一天
  const today = localDateStr();

  return withConnection(async (conn) => {
    // 今日区间用「>= 今天 00:00 AND < 明天 00:00」比较，
    // 而不是 DATE(started_at) = ? —— 后者把列包在函数里，索引直接失效，全表扫描。
    const todayStart = today + ' 00:00:00';
    const tomorrowStart = shiftDateStr(1) + ' 00:00:00';

    // 今日答题数（通过 session 关联获取日期）
    const [todayAnswers] = await conn.query(`
      SELECT COUNT(*) as count
      FROM practice_answer a
      JOIN practice_session s ON a.session_id = s.id
      WHERE s.started_at >= ? AND s.started_at < ?
    `, [todayStart, tomorrowStart]);

    // 今日正确率
    const [todayCorrectRate] = await conn.query(`
      SELECT ROUND(SUM(a.is_correct)/COUNT(*)*100, 1) as rate
      FROM practice_answer a
      JOIN practice_session s ON a.session_id = s.id
      WHERE s.started_at >= ? AND s.started_at < ?
    `, [todayStart, tomorrowStart]);

    // 今日完成的练习次数
    const [todaySessions] = await conn.query(
      "SELECT COUNT(*) as count FROM practice_session WHERE started_at >= ? AND started_at < ? AND status = 'completed'",
      [todayStart, tomorrowStart]
    );

    // 总用户数
    const [totalUsers] = await conn.query(
      "SELECT COUNT(*) as count FROM user"
    );

    // 总题目数（已审核通过）
    const [totalQuestions] = await conn.query(
      "SELECT COUNT(*) as count FROM question WHERE status = 'approved'"
    );

    // 总文章数
    const [totalArticles] = await conn.query(
      "SELECT COUNT(*) as count FROM article"
    );

    // 总访问量
    const [totalVisits] = await conn.query(
      "SELECT stat_value as count FROM site_stats WHERE stat_key = 'total_visits'"
    );

    // 今日访问量
    const [todayVisitsRow] = await conn.query(
      "SELECT stat_value as count, updated_at FROM site_stats WHERE stat_key = 'today_visits'"
    );
    const todayVisitsDate = todayVisitsRow[0]?.updated_at;
    const todayVisits = (todayVisitsDate && new Date(todayVisitsDate).toDateString() === new Date().toDateString())
      ? (todayVisitsRow[0]?.count || 0) : 0;

    // 近7天答题趋势（本地时区：今天 00:00 起前推 6 天）
    const [weekTrend] = await conn.query(`
      SELECT DATE(s.started_at) as date, COUNT(*) as count
      FROM practice_answer a
      JOIN practice_session s ON a.session_id = s.id
      WHERE s.started_at >= ?
      GROUP BY DATE(s.started_at)
      ORDER BY date ASC
    `, [shiftDateStr(-6) + ' 00:00:00']);

    // 填充缺失的日期（确保连续7天）
    // 注意：必须用本地日期串比较，不能用 toISOString()（其会按 UTC 转换，
    // 在东八区凌晨 0-8 点会把日期算到前一天）
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = localDateStr(date);
      const found = weekTrend.find(t => localDateStr(new Date(t.date)) === dateStr);
      trend.push({
        date: `${date.getMonth() + 1}/${date.getDate()}`,
        count: found ? found.count : 0
      });
    }

    return {
      todayAnswers: todayAnswers[0].count || 0,
      todayCorrectRate: todayCorrectRate[0].rate || 0,
      todaySessions: todaySessions[0].count || 0,
      totalUsers: totalUsers[0].count || 0,
      totalQuestions: totalQuestions[0].count || 0,
      totalArticles: totalArticles[0].count || 0,
      totalVisits: totalVisits[0]?.count || 0,
      todayVisits,
      weekTrend: trend
    };
  });
}

// GET /api/stats/public - 公开统计数据（无需登录、无需实时精确）
router.get('/public', asyncHandler(async (req, res) => {
  const now = Date.now();
  // 命中新鲜缓存直接返回
  if (publicStatsCache.payload && now - publicStatsCache.at < PUBLIC_STATS_TTL_MS) {
    return res.json(publicStatsCache.payload);
  }

  try {
    // 缓存刚过期时的并发合并：多个请求共用同一次查询，避免同时打穿数据库
    if (!publicStatsInflight) {
      publicStatsInflight = computePublicStats()
        .then((payload) => {
          publicStatsCache = { at: Date.now(), payload };
          return payload;
        })
        .finally(() => { publicStatsInflight = null; });
    }
    return res.json(await publicStatsInflight);
  } catch (err) {
    // 查询失败时降级返回上一份缓存（首页总比报错强），没有缓存才真正抛错
    if (publicStatsCache.payload) {
      console.error('Stats error (fallback to cache):', err.message);
      return res.json(publicStatsCache.payload);
    }
    throw err;
  }
}, (err) => console.error('Stats error:', err)));

// POST /api/stats/visit - 记录访问量（每次加载首页时调用）
router.post('/visit', visitLimiter, asyncHandler(async (req, res) => {
  await withConnection(async (conn) => {
    // 增加总访问量
    await conn.query(`
      INSERT INTO site_stats (stat_key, stat_value) VALUES ('total_visits', 1)
      ON DUPLICATE KEY UPDATE stat_value = stat_value + 1
    `);

    // 检查今日访问量是否需要重置
    const [todayRow] = await conn.query(
      "SELECT stat_value, updated_at FROM site_stats WHERE stat_key = 'today_visits'"
    );
    const lastUpdate = todayRow[0]?.updated_at;
    const isToday = lastUpdate && new Date(lastUpdate).toDateString() === new Date().toDateString();

    if (isToday) {
      // 今天已记录，直接 +1
      await conn.query(`
        UPDATE site_stats SET stat_value = stat_value + 1 WHERE stat_key = 'today_visits'
      `);
    } else {
      // 新的一天，重置为 1
      await conn.query(`
        INSERT INTO site_stats (stat_key, stat_value) VALUES ('today_visits', 1)
        ON DUPLICATE KEY UPDATE stat_value = 1
      `);
    }
  });

  return res.json({ success: true });
}, (err) => console.error('Visit record error:', err)));

module.exports = router;
