/**
 * 清理无用用户数据（测试账号、僵尸会话、测试智能卷、重复答题记录）。
 *
 * 用法：
 *   node scripts/cleanup_user_data.js            # DRY-RUN：只列清单与数量，不写库
 *   node scripts/cleanup_user_data.js --apply    # 单事务执行；执行前请自行 mysqldump 备份
 *
 * 保留规则（任何情况下不删）：
 *   - username 为 12 / ETETT / admin 的真实账号
 *   - username 为空且 role=admin 的早期管理员账号
 *   - 上述账号的全部练习数据、错题、收藏、个人智能组卷
 *   - is_hidden=0 且 origin<>'smart' 的真题卷及其题目（完全不触碰）
 *
 * 删除规则：
 *   1. 匹配「脚本注册特征」且不在白名单的账号，及其全部关联数据
 *   2. 这些账号名下的 origin='smart' 个人卷（含卷面题、材料组、分类映射）
 *   3. 同 (session_id, question_id) 的重复答题记录，保留 MIN(id)
 *   4. 外键断裂的孤立记录
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');

// 真实账号白名单；参数化，不接受外部输入
const KEEP_USERNAMES = ['12', 'ETETT', 'admin'];
// COALESCE 避免 username 为 NULL 时 `NULL IN (...)` 产生三值逻辑 NULL，
// 导致该账号既不进删除清单也不进保留/待确认清单。
const KEEP_SQL = `(COALESCE(u.username, '') IN (${KEEP_USERNAMES.map(() => '?').join(',')}) OR (u.username IS NULL AND u.role = 'admin'))`;
const KEEP_PARAMS = KEEP_USERNAMES;

// 脚本注册特征：字母/下划线开头且含数字的随机短用户名（不会误伤 zhangsan 这类全字母真人用户名），
// 或中文验证类昵称。真实账号一律由白名单兜底。
const TEST_SQL = `(u.username REGEXP '^[a-zA-Z_]{1,8}[0-9][0-9_]*$'
   OR u.nickname REGEXP '验证|冒烟|终验|诊断|测试|核查|布局|回归|分页|标签栏|隐藏|计数|组卷|题组|排查|重验|核对|近[0-9]+年')`;

const q = async (conn, sql, params = []) => (await conn.query(sql, params))[0];

async function snapshot(conn) {
  const one = async (sql, params = []) => Number((await q(conn, sql, params))[0].c) || 0;
  return {
    users: await one('SELECT COUNT(*) c FROM user'),
    sessions: await one('SELECT COUNT(*) c FROM practice_session'),
    answers: await one('SELECT COUNT(*) c FROM practice_answer'),
    wrongs: await one('SELECT COUNT(*) c FROM wrong_book'),
    favorites: await one('SELECT COUNT(*) c FROM favorite'),
    feedbacks: await one('SELECT COUNT(*) c FROM question_feedback'),
    smartPapers: await one("SELECT COUNT(*) c FROM exam_paper WHERE origin='smart'"),
    truePapers: await one("SELECT COUNT(*) c FROM exam_paper WHERE is_hidden=0 AND (origin IS NULL OR origin<>'smart')"),
    approvedQuestions: await one("SELECT COUNT(*) c FROM question WHERE status='approved'"),
    orphans: {
      answer_no_session: await one('SELECT COUNT(*) c FROM practice_answer a LEFT JOIN practice_session s ON a.session_id=s.id WHERE s.id IS NULL'),
      answer_no_question: await one('SELECT COUNT(*) c FROM practice_answer a LEFT JOIN question q2 ON a.question_id=q2.id WHERE q2.id IS NULL'),
      session_no_user: await one('SELECT COUNT(*) c FROM practice_session s LEFT JOIN user u ON s.user_id=u.id WHERE u.id IS NULL'),
      wrong_no_user: await one('SELECT COUNT(*) c FROM wrong_book w LEFT JOIN user u ON w.user_id=u.id WHERE u.id IS NULL'),
      fav_no_user: await one('SELECT COUNT(*) c FROM favorite f LEFT JOIN user u ON f.user_id=u.id WHERE u.id IS NULL'),
      feedback_no_user: await one('SELECT COUNT(*) c FROM question_feedback f LEFT JOIN user u ON f.user_id=u.id WHERE u.id IS NULL'),
    },
  };
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4',
  });

  const before = await snapshot(conn);

  const testUsers = await q(conn,
    `SELECT u.id, u.username, u.nickname, u.role, u.created_at,
       (SELECT COUNT(*) FROM practice_session s WHERE s.user_id=u.id) AS sessions,
       (SELECT COUNT(*) FROM practice_answer a JOIN practice_session s2 ON a.session_id=s2.id WHERE s2.user_id=u.id) AS answers,
       (SELECT COUNT(*) FROM wrong_book w WHERE w.user_id=u.id) AS wrongs,
       (SELECT COUNT(*) FROM favorite f WHERE f.user_id=u.id) AS favs,
       (SELECT COUNT(*) FROM question_feedback f2 WHERE f2.user_id=u.id) AS feedbacks,
       (SELECT COUNT(*) FROM exam_paper ep WHERE ep.creator_user_id=u.id) AS papers
     FROM user u
     WHERE ${TEST_SQL} AND NOT ${KEEP_SQL}
     ORDER BY u.id`, KEEP_PARAMS);

  const keptUsers = await q(conn,
    `SELECT u.id, u.username, u.nickname, u.role FROM user u WHERE ${KEEP_SQL} ORDER BY u.id`, KEEP_PARAMS);

  const unmatched = await q(conn,
    `SELECT u.id, u.username, u.nickname, u.role FROM user u
      WHERE (NOT (${TEST_SQL}) OR ${TEST_SQL} IS NULL) AND NOT ${KEEP_SQL} ORDER BY u.id`, KEEP_PARAMS);

  const ids = testUsers.map((u) => u.id);
  const ph = ids.map(() => '?').join(',');
  const smartPapers = ids.length
    ? await q(conn, `SELECT id, title, creator_user_id FROM exam_paper WHERE origin='smart' AND creator_user_id IN (${ph}) ORDER BY id`, ids)
    : [];
  const spIds = smartPapers.map((p) => p.id);
  const sph = spIds.map(() => '?').join(',');

  const [dupRow] = await q(conn,
    'SELECT COUNT(*) c, COALESCE(SUM(n - 1), 0) del FROM (SELECT COUNT(*) n FROM practice_answer GROUP BY session_id, question_id HAVING n > 1) x');
  const dupGroups = Number(dupRow.c) || 0;
  const dupExtra = Number(dupRow.del) || 0;

  const report = {
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    database: process.env.MYSQL_DATABASE,
    before,
    toDelete: {
      testUsers: testUsers.length,
      userRows: testUsers,
      smartPapers: smartPapers.length,
      smartPaperRows: smartPapers,
      duplicateAnswerGroups: dupGroups,
      duplicateAnswerExtraRows: dupExtra,
    },
    keptUsers,
    unmatchedNotDeleted: unmatched,
  };
  console.log(JSON.stringify(report, null, 2));

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未写入任何数据。确认清单后先 mysqldump 备份，再加 --apply 执行。');
    await conn.end();
    return;
  }

  const deleted = {};
  const del = async (label, sql, params = []) => {
    const [r] = await conn.query(sql, params);
    deleted[label] = r.affectedRows || 0;
  };

  await conn.beginTransaction();
  try {
    if (spIds.length) {
      await del('exam_paper_question', `DELETE FROM exam_paper_question WHERE exam_paper_id IN (${sph})`, spIds);
      if (await q(conn, "SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_paper_material_group'").then(r => r[0].c)) {
        await del('exam_paper_material_group', `DELETE FROM exam_paper_material_group WHERE exam_paper_id IN (${sph})`, spIds);
      }
      await del('exam_paper_category', `DELETE FROM exam_paper_category WHERE exam_paper_id IN (${sph})`, spIds);
      await del('exam_paper', `DELETE FROM exam_paper WHERE id IN (${sph})`, spIds);
    }
    if (ids.length) {
      await del('practice_answer', `DELETE a FROM practice_answer a JOIN practice_session s ON a.session_id=s.id WHERE s.user_id IN (${ph})`, ids);
      await del('question_feedback', `DELETE FROM question_feedback WHERE user_id IN (${ph})`, ids);
      await del('wrong_book', `DELETE FROM wrong_book WHERE user_id IN (${ph})`, ids);
      await del('favorite', `DELETE FROM favorite WHERE user_id IN (${ph})`, ids);
      await del('user_practice_config', `DELETE FROM user_practice_config WHERE user_id IN (${ph})`, ids);
      await del('practice_session', `DELETE FROM practice_session WHERE user_id IN (${ph})`, ids);
      await del('user', `DELETE FROM user WHERE id IN (${ph})`, ids);
    }

    // 重复答题记录：临时表法绕开 MySQL 同表子查询限制
    if (dupExtra > 0) {
      await conn.query(`CREATE TEMPORARY TABLE tmp_dup_ans AS
        SELECT MIN(id) AS keep_id, session_id, question_id FROM practice_answer
        GROUP BY session_id, question_id HAVING COUNT(*) > 1`);
      await del('duplicate_answers', `DELETE a FROM practice_answer a
        JOIN tmp_dup_ans d ON a.session_id = d.session_id AND a.question_id = d.question_id
        WHERE a.id > d.keep_id`);
      await conn.query('DROP TEMPORARY TABLE tmp_dup_ans');
    }

    // 孤立记录兜底（正常应为 0）
    await del('orphan_answers', 'DELETE a FROM practice_answer a LEFT JOIN practice_session s ON a.session_id=s.id WHERE s.id IS NULL');
    await del('orphan_wrongs', 'DELETE w FROM wrong_book w LEFT JOIN user u ON w.user_id=u.id WHERE u.id IS NULL');
    await del('orphan_favorites', 'DELETE f FROM favorite f LEFT JOIN user u ON f.user_id=u.id WHERE u.id IS NULL');
    await del('orphan_feedbacks', 'DELETE f FROM question_feedback f LEFT JOIN user u ON f.user_id=u.id WHERE u.id IS NULL');

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error('[APPLY] 失败，已回滚：', e.message);
    await conn.end();
    process.exit(1);
  }

  const after = await snapshot(conn);
  const invariants = {
    truePapersUnchanged: before.truePapers === after.truePapers,
    approvedQuestionsUnchanged: before.approvedQuestions === after.approvedQuestions,
    noOrphans: Object.values(after.orphans).every((n) => n === 0),
    keptUsersPresent: keptUsers.length > 0,
  };
  console.log('\n=== 删除行数 ===\n' + JSON.stringify(deleted, null, 2));
  console.log('=== 清理后快照 ===\n' + JSON.stringify(after, null, 2));
  console.log('=== 完整性校验 ===\n' + JSON.stringify(invariants, null, 2));
  if (!Object.values(invariants).every(Boolean)) {
    console.error('[APPLY] 完整性校验未通过，请检查备份！');
    await conn.end();
    process.exit(1);
  }
  console.log('[APPLY] 完成，全部校验通过。');
  await conn.end();
}

main().catch((e) => { console.error('清理脚本异常：', e.message); process.exit(1); });
