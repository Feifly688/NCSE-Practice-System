const express = require('express');
const { withConnection } = require('../db');

const router = express.Router();

// GET /api/stats/public - 公开统计数据（无需登录）
router.get('/public', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      // 今日答题数
      const [todayAnswers] = await conn.query(
        "SELECT COUNT(*) as count FROM practice_answer WHERE DATE(created_at) = CURDATE()"
      );

      // 今日正确率
      const [todayCorrectRate] = await conn.query(
        "SELECT ROUND(SUM(is_correct)/COUNT(*)*100, 1) as rate FROM practice_answer WHERE DATE(created_at) = CURDATE()"
      );

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

      // 近7天答题趋势
      const [weekTrend] = await conn.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM practice_answer
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(created_at)
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
        weekTrend: trend
      };
    });

    return res.json(data);
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
