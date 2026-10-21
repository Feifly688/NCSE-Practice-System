const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { localDateStr, shiftDateStr } = require('../lib/time');

const router = express.Router();

// GET /api/stats/public - 公开统计数据（无需登录）
router.get('/public', asyncHandler(async (req, res) => {
  // 以 Node 本地时区（Asia/Shanghai）为事实源计算日期边界，
  // 避免 MySQL 服务端 UTC 时区导致凌晨记录被算到前一天
  const today = localDateStr();

  const data = await withConnection(async (conn) => {
    // 今日答题数（通过 session 关联获取日期）
    const [todayAnswers] = await conn.query(`
      SELECT COUNT(*) as count
      FROM practice_answer a
      JOIN practice_session s ON a.session_id = s.id
      WHERE DATE(s.started_at) = ?
    `, [today]);

    // 今日正确率
    const [todayCorrectRate] = await conn.query(`
      SELECT ROUND(SUM(a.is_correct)/COUNT(*)*100, 1) as rate
      FROM practice_answer a
      JOIN practice_session s ON a.session_id = s.id
      WHERE DATE(s.started_at) = ?
    `, [today]);

    // 今日完成的练习次数
    const [todaySessions] = await conn.query(
      "SELECT COUNT(*) as count FROM practice_session WHERE DATE(started_at) = ? AND status = 'completed'",
      [today]
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

  return res.json(data);
}, (err) => console.error('Stats error:', err)));

// POST /api/stats/visit - 记录访问量（每次加载首页时调用）
router.post('/visit', asyncHandler(async (req, res) => {
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
