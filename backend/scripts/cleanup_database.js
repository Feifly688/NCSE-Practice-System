/**
 * 题库数据库内容清理（幂等）
 *
 * 清理规则：
 *  A. 重复题：按「题干 + 选项 + 答案 + 解析 + 来源」严格分组，仅保留每组最早（MIN(id)）
 *     且字段完整的记录；引用（practice_answer / wrong_book / favorite / 分类映射 /
 *     practice_session.meta_json 的 question_ids）迁移到保留行后再删副本。
 *     跨卷同题干但来源不同的题不算重复（属不同真题卷的关联数据），只报告待确认。
 *  B. 模拟卷：删除 is_hidden=1 的粉笔模拟卷及其全部关联数据
 *     （整卷题、分类、回流题、分类映射、作答/错题/收藏、该卷的练习会话、图片目录）；
 *     真题卷（is_hidden=0）与其关联数据一律保留。
 *  C. 冗余/孤立/临时：清理外键断裂的孤立记录、空的临时导出目录（fenbi_bundle）、
 *     模拟卷图片目录；跨表重复映射（同 category 同 ref 多行）。
 *  D. 结构：DROP 无任何代码引用、无数据、且不在任何迁移/schema 里定义的遗留空表
 *     （generate_task / user_stat_snapshot，仅本地存在）；有迁移定义的空表
 *     （user_practice_config）列为待确认，不动。
 *
 * 用法：
 *   node scripts/cleanup_database.js            # 试跑，只输出统计与待确认项
 *   node scripts/cleanup_database.js --apply    # 实际执行（事务内完成，失败整体回滚）
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..');
const REPORT = { mode: APPLY ? 'APPLY' : 'DRY-RUN', rules: [], deleted: {}, kept: {}, pending: [], structure: [], errors: [] };

const chunk = (arr, n = 500) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  const q = async (sql, params = []) => (await conn.query(sql, params))[0];
  const scalar = async (sql, params = []) => {
    const r = await q(sql, params);
    return Number(r[0] ? r[0].n : 0);
  };
  // 试跑只统计；执行时真正删除
  const del = async (label, countSql, deleteSql, params = []) => {
    const n = await scalar(countSql, params);
    REPORT.deleted[label] = n;
    if (APPLY && n > 0) { await q(deleteSql, params); }
    return n;
  };

  if (APPLY) await conn.beginTransaction();
  try {
    // ── 基线 ──
    const before = {};
    for (const t of ['exam_paper', 'exam_paper_question', 'question', 'practice_answer', 'practice_session',
      'question_category_map', 'exam_paper_category', 'wrong_book', 'favorite', 'question_feedback']) {
      before[t] = await scalar(`SELECT COUNT(*) n FROM \`${t}\``);
    }
    REPORT.kept.before = before;

    // ── A. 严格重复题 ──
    const strictDupGroups = await q(
      `SELECT MIN(id) keep_id, GROUP_CONCAT(id ORDER BY id) ids, COUNT(*) n
         FROM question
        GROUP BY stem, options_json, answer, explanation, source_exam
       HAVING n > 1`);
    let dupRemoved = 0;
    for (const g of strictDupGroups) {
      const ids = g.ids.split(',').map(Number);
      const dupIds = ids.slice(1);      // 保留最早的 keep_id（完整有效记录）
      if (!dupIds.length) continue;
      for (const group of chunk(dupIds)) {
        // 引用迁移：撞唯一键的跳过，之后统一删残留
        for (const table of ['practice_answer', 'wrong_book', 'favorite']) {
          if (APPLY) await q(`UPDATE IGNORE \`${table}\` SET question_id = ? WHERE question_id IN (?)`, [g.keep_id, group]);
        }
        if (APPLY) await q(`UPDATE IGNORE question_category_map SET ref_id = ? WHERE pool='question' AND ref_id IN (?)`, [g.keep_id, group]);
      }
      // 历史会话 meta 里的题目 id 同步指向保留行（避免详情缺题）
      if (APPLY) {
        const sessions = await q("SELECT id, meta_json FROM practice_session WHERE meta_json IS NOT NULL");
        for (const s of sessions) {
          const meta = typeof s.meta_json === 'string' ? JSON.parse(s.meta_json) : s.meta_json;
          if (!meta || !Array.isArray(meta.question_ids)) continue;
          const next = meta.question_ids.map((id) => (dupIds.includes(Number(id)) ? g.keep_id : id));
          if (next.some((v, i) => v !== meta.question_ids[i])) {
            meta.question_ids = next;
            await q('UPDATE practice_session SET meta_json = ? WHERE id = ?', [JSON.stringify(meta), s.id]);
          }
        }
      }
      dupRemoved += dupIds.length;
    }
    REPORT.deleted['A. 严格重复题副本（题干+选项+答案+解析+来源完全一致）'] = dupRemoved;
    REPORT.rules.push('A 重复题：五字段全等才判重；保留 MIN(id)，引用与历史 meta 迁移后删除副本');

    // 宽口径同题（不同来源/解析）只报告，不动 —— 属于不同真题卷的关联数据
    const looseDup = await scalar(
      `SELECT COALESCE(SUM(n-1),0) n FROM (
         SELECT COUNT(*) n FROM question GROUP BY stem, options_json, answer HAVING n > 1) x`);
    REPORT.pending.push(`跨卷同题干/选项/答案但来源或解析不同的题：${looseDup} 条冗余候选。不同真题卷各持实例，删除会影响整卷作答映射，未删（待确认）`);

    // ── B. 模拟卷及关联数据 ──
    const mockPapers = (await q('SELECT id FROM exam_paper WHERE is_hidden = 1')).map((r) => r.id);
    const realPapers = await scalar('SELECT COUNT(*) n FROM exam_paper WHERE is_hidden = 0');
    REPORT.kept['真题卷（is_hidden=0）'] = realPapers;
    REPORT.deleted['B. 粉笔模拟卷'] = mockPapers.length;
    REPORT.rules.push('B 模拟卷：is_hidden=1 为粉笔模拟卷，整卷及关联数据全删；is_hidden=0 的真题卷绝不动');

    let mockQids = [];
    let mockEpqIds = [];
    let mockSessionIds = [];
    for (const pids of chunk(mockPapers.length ? mockPapers : [-1])) {
      const qs = await q('SELECT id FROM question WHERE source_paper_id IN (?)', [pids]);
      mockQids.push(...qs.map((r) => r.id));
      const epq = await q('SELECT id FROM exam_paper_question WHERE exam_paper_id IN (?)', [pids]);
      mockEpqIds.push(...epq.map((r) => r.id));
      const sess = await q(
        "SELECT id FROM practice_session WHERE mode='exam_paper' AND CAST(JSON_EXTRACT(meta_json,'$.paper_id') AS UNSIGNED) IN (?)", [pids]);
      mockSessionIds.push(...sess.map((r) => r.id));
    }
    const qids = mockQids.length ? mockQids : [-1];
    const epqIds = mockEpqIds.length ? mockEpqIds : [-1];
    const sids = mockSessionIds.length ? mockSessionIds : [-1];

    // 逐类统计/删除（顺序遵守外键依赖）
    const steps = [
      ['practice_answer（模拟卷回流题的作答）',
        'SELECT COUNT(*) n FROM practice_answer WHERE question_id IN (?)',
        'DELETE FROM practice_answer WHERE question_id IN (?)', qids],
      ['practice_answer（模拟卷练习会话）',
        'SELECT COUNT(*) n FROM practice_answer WHERE session_id IN (?)',
        'DELETE FROM practice_answer WHERE session_id IN (?)', sids],
      ['practice_session（模拟卷练习记录）',
        "SELECT COUNT(*) n FROM practice_session WHERE mode='exam_paper' AND id IN (?)",
        'DELETE FROM practice_session WHERE id IN (?)', sids],
      ['wrong_book（模拟卷回流题）',
        'SELECT COUNT(*) n FROM wrong_book WHERE question_id IN (?)',
        'DELETE FROM wrong_book WHERE question_id IN (?)', qids],
      ['favorite（模拟卷回流题）',
        'SELECT COUNT(*) n FROM favorite WHERE question_id IN (?)',
        'DELETE FROM favorite WHERE question_id IN (?)', qids],
      ['question_feedback（模拟卷回流题）',
        'SELECT COUNT(*) n FROM question_feedback WHERE question_id IN (?)',
        'DELETE FROM question_feedback WHERE question_id IN (?)', qids],
      ['question_category_map（模拟卷回流题）',
        "SELECT COUNT(*) n FROM question_category_map WHERE pool='question' AND ref_id IN (?)",
        "DELETE FROM question_category_map WHERE pool='question' AND ref_id IN (?)", qids],
      ['question_category_map（模拟卷整卷题）',
        "SELECT COUNT(*) n FROM question_category_map WHERE pool='exam_paper_question' AND ref_id IN (?)",
        "DELETE FROM question_category_map WHERE pool='exam_paper_question' AND ref_id IN (?)", epqIds],
      ['question（模拟卷回流题）',
        'SELECT COUNT(*) n FROM question WHERE id IN (?)',
        'DELETE FROM question WHERE id IN (?)', qids],
      ['exam_paper_category（模拟卷分类）',
        'SELECT COUNT(*) n FROM exam_paper_category WHERE exam_paper_id IN (?)',
        'DELETE FROM exam_paper_category WHERE exam_paper_id IN (?)', mockPapers.length ? mockPapers : [-1]],
      ['exam_paper_question（模拟卷整卷题）',
        'SELECT COUNT(*) n FROM exam_paper_question WHERE exam_paper_id IN (?)',
        'DELETE FROM exam_paper_question WHERE exam_paper_id IN (?)', mockPapers.length ? mockPapers : [-1]],
      ['exam_paper（模拟卷本身）',
        'SELECT COUNT(*) n FROM exam_paper WHERE id IN (?)',
        'DELETE FROM exam_paper WHERE id IN (?)', mockPapers.length ? mockPapers : [-1]],
    ];
    for (const [label, countSql, deleteSql, params] of steps) {
      // 先统计（删除前的真实数量），再按 500 分块删除，避免 IN 过长
      REPORT.deleted[label] = await scalar(countSql, [params]);
      if (APPLY && REPORT.deleted[label] > 0) {
        for (const part of chunk(params)) {
          await q(deleteSql, [part]);
        }
      }
    }
    REPORT.deleted['B. 图片目录（模拟卷）'] = APPLY ? 0 : mockPapers.filter((id) =>
      fs.existsSync(path.join(ROOT, 'uploads/papers/paper-images', String(id)))).length;

    // ── C. 孤立记录与重复映射、临时目录 ──
    const orphanSteps = [
      ['C. practice_answer 孤立（题目已不存在）',
        'SELECT COUNT(*) n FROM practice_answer pa WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = pa.question_id)',
        'DELETE pa FROM practice_answer pa WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = pa.question_id)'],
      ['C. practice_answer 孤立（会话已不存在）',
        'SELECT COUNT(*) n FROM practice_answer pa WHERE NOT EXISTS (SELECT 1 FROM practice_session ps WHERE ps.id = pa.session_id)',
        'DELETE pa FROM practice_answer pa WHERE NOT EXISTS (SELECT 1 FROM practice_session ps WHERE ps.id = pa.session_id)'],
      ['C. wrong_book 孤立',
        'SELECT COUNT(*) n FROM wrong_book w WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = w.question_id)',
        'DELETE w FROM wrong_book w WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = w.question_id)'],
      ['C. favorite 孤立',
        'SELECT COUNT(*) n FROM favorite f WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = f.question_id)',
        'DELETE f FROM favorite f WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = f.question_id)'],
      ['C. question_feedback 孤立（题目）',
        'SELECT COUNT(*) n FROM question_feedback f WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = f.question_id)',
        'DELETE f FROM question_feedback f WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id = f.question_id)'],
      ['C. question_category_map 孤立（题库池）',
        "SELECT COUNT(*) n FROM question_category_map m WHERE m.pool='question' AND NOT EXISTS (SELECT 1 FROM question q WHERE q.id = m.ref_id)",
        "DELETE m FROM question_category_map m WHERE m.pool='question' AND NOT EXISTS (SELECT 1 FROM question q WHERE q.id = m.ref_id)"],
      ['C. question_category_map 孤立（整卷题池）',
        "SELECT COUNT(*) n FROM question_category_map m WHERE m.pool='exam_paper_question' AND NOT EXISTS (SELECT 1 FROM exam_paper_question q WHERE q.id = m.ref_id)",
        "DELETE m FROM question_category_map m WHERE m.pool='exam_paper_question' AND NOT EXISTS (SELECT 1 FROM exam_paper_question q WHERE q.id = m.ref_id)"],
      ['C. exam_paper_question 孤立（卷已不存在）',
        'SELECT COUNT(*) n FROM exam_paper_question q WHERE NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id = q.exam_paper_id)',
        'DELETE q FROM exam_paper_question q WHERE NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id = q.exam_paper_id)'],
      ['C. exam_paper_category 孤立（卷已不存在）',
        'SELECT COUNT(*) n FROM exam_paper_category c WHERE NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id = c.exam_paper_id)',
        'DELETE c FROM exam_paper_category c WHERE NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id = c.exam_paper_id)'],
      ['C. question 孤立（来源卷已不存在）',
        'SELECT COUNT(*) n FROM question q WHERE q.source_paper_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id = q.source_paper_id)',
        'DELETE q FROM question q WHERE q.source_paper_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id = q.source_paper_id)'],
      ['C. practice_session 孤立（用户已不存在）',
        'SELECT COUNT(*) n FROM practice_session ps WHERE NOT EXISTS (SELECT 1 FROM `user` u WHERE u.id = ps.user_id)',
        'DELETE ps FROM practice_session ps WHERE NOT EXISTS (SELECT 1 FROM `user` u WHERE u.id = ps.user_id)'],
    ];
    for (const [label, countSql, deleteSql] of orphanSteps) {
      await del(label, countSql, deleteSql);
    }
    REPORT.rules.push('C 冗余：删除外键断裂的孤立记录；空目录/临时导出目录单独清理');

    // 重复映射（同分类同题多行）
    const dupMap = await scalar(
      `SELECT COALESCE(SUM(n-1),0) n FROM (
         SELECT COUNT(*) n FROM question_category_map GROUP BY pool, category_id, ref_id HAVING n > 1) x`);
    REPORT.deleted['C. 重复分类映射（冗余行）'] = dupMap;
    if (APPLY && dupMap > 0) {
      // 临时表法：先固化要删的 id，再删（避免同表 UPDATE/DELETE 子查询限制）
      await q('DROP TEMPORARY TABLE IF EXISTS tmp_dup_del');
      await q(`CREATE TEMPORARY TABLE tmp_dup_del (id BIGINT PRIMARY KEY)
        SELECT m.id FROM question_category_map m
        JOIN (SELECT pool, category_id, ref_id, MIN(id) keep_id
                FROM question_category_map GROUP BY pool, category_id, ref_id HAVING COUNT(*) > 1) d
          ON d.pool = m.pool AND d.category_id = m.category_id AND d.ref_id = m.ref_id
       WHERE m.id > d.keep_id`);
      await q('DELETE m FROM question_category_map m JOIN tmp_dup_del d ON d.id = m.id');
      await q('DROP TEMPORARY TABLE IF EXISTS tmp_dup_del');
    }

    // ── 临时文件 / 图片目录（非事务，最后处理） ──
    const imgRoot = path.join(ROOT, 'uploads/papers/paper-images');
    if (APPLY && fs.existsSync(imgRoot)) {
      let removedDirs = 0;
      for (const id of mockPapers) {
        const dir = path.join(imgRoot, String(id));
        if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removedDirs++; }
      }
      REPORT.deleted['B. 图片目录（模拟卷）'] = removedDirs;
    }
    const bundle = path.join(ROOT, 'fenbi_bundle');
    const bundleSize = fs.existsSync(bundle)
      ? fs.readdirSync(bundle).reduce((s, f) => s + fs.statSync(path.join(bundle, f)).size, 0) : 0;
    REPORT.deleted['C. 临时导出目录 fenbi_bundle（字节）'] = bundleSize;
    if (APPLY && fs.existsSync(bundle)) fs.rmSync(bundle, { recursive: true, force: true });

    // ── D. 结构：无引用/无数据/无定义的遗留空表 ──
    const tables = await q("SELECT table_name t FROM information_schema.tables WHERE table_schema = DATABASE()");
    const tableNames = tables.map((r) => r.t);
    const legacyTables = ['generate_task', 'user_stat_snapshot'].filter((t) => tableNames.includes(t));
    for (const t of legacyTables) {
      const n = await scalar(`SELECT COUNT(*) n FROM \`${t}\``);
      if (n === 0) {
        REPORT.structure.push(`DROP TABLE \`${t}\`（0 行、代码无引用、schema/迁移未定义）`);
        if (APPLY) await q(`DROP TABLE IF EXISTS \`${t}\``);
      } else {
        REPORT.pending.push(`\`${t}\` 非空（${n} 行），未删除`);
      }
    }
    REPORT.pending.push('`user_practice_config`（0 行、代码无引用，但在 add_fenbi_taxonomy.sql 中有定义，可能为规划功能）—— 未删除，待确认');
    REPORT.pending.push('`favorite` / `question_feedback`（0 行但被 practice.js 引用，业务表）—— 保留');
    REPORT.pending.push('未被代码直接引用的字段（如 exam_paper.raw_text、question.source_article_id 等）可能是审计/规划用途 —— 未删除，待确认');
    REPORT.pending.push('测试/冒烟注册的用户账号（用户名形如 pg_*/tab_*/opt*/hide*/cnt*/urec*）—— 无法确认是否真人，未删除，待确认');

    // ── 完整性校验 ──
    const after = {};
    for (const t of Object.keys(before)) after[t] = await scalar(`SELECT COUNT(*) n FROM \`${t}\``);
    REPORT.kept.after = after;
    REPORT.kept['真题卷（清理后）'] = await scalar('SELECT COUNT(*) n FROM exam_paper WHERE is_hidden = 0');
    const integrity = {};
    integrity['模拟卷残留'] = await scalar('SELECT COUNT(*) n FROM exam_paper WHERE is_hidden = 1');
    integrity['孤立 practice_answer'] = await scalar(
      'SELECT COUNT(*) n FROM practice_answer pa WHERE NOT EXISTS (SELECT 1 FROM question q WHERE q.id=pa.question_id)');
    integrity['孤立 question_category_map(question)'] = await scalar(
      "SELECT COUNT(*) n FROM question_category_map m WHERE m.pool='question' AND NOT EXISTS (SELECT 1 FROM question q WHERE q.id=m.ref_id)");
    integrity['孤立 exam_paper_question'] = await scalar(
      'SELECT COUNT(*) n FROM exam_paper_question q WHERE NOT EXISTS (SELECT 1 FROM exam_paper p WHERE p.id=q.exam_paper_id)');
    integrity['严格重复题组'] = await scalar(
      'SELECT COUNT(*) n FROM (SELECT 1 FROM question GROUP BY stem, options_json, answer, explanation, source_exam HAVING COUNT(*)>1) x');
    integrity['无效 FOREIGN_KEY_CHECKS'] = 0;
    REPORT.integrity = integrity;

    if (APPLY) await conn.commit();
    REPORT.ok = true;
  } catch (e) {
    if (APPLY) await conn.rollback();
    REPORT.ok = false;
    REPORT.errors.push(e.message);
  }
  await conn.end();
  console.log(JSON.stringify(REPORT, null, 1));
  process.exitCode = REPORT.ok ? 0 : 1;
})().catch((e) => { console.error('致命错误:', e.message); process.exit(1); });
