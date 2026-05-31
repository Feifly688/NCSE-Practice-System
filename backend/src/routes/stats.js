const express = require('express');
const { withConnection } = require('../db');

const router = express.Router();

// GET /api/stats/public - 公开统计数据（无需登录）
router.get('/public', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      // 今日答题数（通过 session 关联获取日期）
      const [todayAnswers] = await conn.query(`
        SELECT COUNT(*) as count
        FROM practice_answer a
        JOIN practice_session s ON a.session_id = s.id
        WHERE DATE(s.started_at) = CURDATE()
      `);

      // 今日正确率
      const [todayCorrectRate] = await conn.query(`
        SELECT ROUND(SUM(a.is_correct)/COUNT(*)*100, 1) as rate
        FROM practice_answer a
        JOIN practice_session s ON a.session_id = s.id
        WHERE DATE(s.started_at) = CURDATE()
      `);

      // 今日完成的练习次数
      const [todaySessions] = await conn.query(
        "SELECT COUNT(*) as count FROM practice_session WHERE DATE(started_at) = CURDATE() AND status = 'completed'"
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

      // 近7天答题趋势
      const [weekTrend] = await conn.query(`
        SELECT DATE(s.started_at) as date, COUNT(*) as count
        FROM practice_answer a
        JOIN practice_session s ON a.session_id = s.id
        WHERE s.started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(s.started_at)
        ORDER BY date ASC
      `);

      // 填充缺失的日期（确保连续7天）
      const trend = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const found = weekTrend.find(t => {
          const tDate = new Date(t.date).toISOString().split('T')[0];
          return tDate === dateStr;
        });
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
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/stats/visit - 记录访问量（每次加载首页时调用）
router.post('/visit', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('Visit record error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
