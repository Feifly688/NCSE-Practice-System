const express = require('express');
const axios = require('axios');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { localDateTimeStr } = require('../lib/time');
const { safeOptions } = require('../lib/json');
const { normalizePractice, buildSessionTitle } = require('../lib/sessionTitle');
const { buildReport } = require('../lib/report');
const { parseIdsQuery } = require('../helpers');

const router = express.Router();

const aiAnalysisLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 10,
  // 参数是错的题（500/400/404）不该消耗用户额度，只统计真正发起 AI 调用的请求
  skipFailedRequests: true,
  keyGenerator: (req) => String(req.user?.userId || 'anon'),
  message: { error: '请求过于频繁，请稍后再试' }
});

function parseMetaJson(raw) {
  if (typeof raw === 'object' && raw !== null) return raw;
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

/** 单次练习的题目数上限 */
const MAX_SESSION_QUESTIONS = 200;

/**
 * 错题「待复习」判定（表别名统一为 wb）：
 *   - next_review_at 到期（含迁移前老数据 NULL）
 *   - 或今天新错 / 重错的题（粉笔冲刺口径：当天新错的题当天打标签并回顾，
 *     隔一天才按错频周期重做）。否则首次错题要等 15 天才出现，新用户打开
 *     「今日待复习」会是一片空白。
 */
const DUE_SQL = '(wb.next_review_at IS NULL OR wb.next_review_at <= NOW() OR DATE(wb.updated_at) = CURDATE())';

/**
 * 从 meta 中取出题目 id 列表。
 *
 * 安全要点：meta 里的题目**答案一律不可信** —— 历史格式 meta.questions 是 start
 * 时把客户端整个题目对象（含 answer）塞进来的，客户端可以任意改写。判分必须
 * 只取 id，再去 question 表取权威答案。这里因此只返回 id，不返回任何答案字段。
 *
 * 兼容两种历史格式：
 *   新格式 meta.question_ids = [1,2,3]
 *   旧格式 meta.questions    = [{ id, answer }, ...] 或 [1,2,3]
 */
function extractQuestionIds(meta) {
  const raw = Array.isArray(meta.question_ids)
    ? meta.question_ids
    : Array.isArray(meta.questions)
      ? meta.questions.map((q) => (typeof q === 'object' && q !== null ? q.id : q))
      : [];
  const seen = new Set();
  const ids = [];
  for (const v of raw) {
    const id = Number(v);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const FENBI_SOURCE_PREFIX = '粉笔题库·';

/**
 * 题目来源展示规则：
 *   · 真题（粉笔题库·xxxx年xx考试《行测》题…）→ 去掉前缀，只显示试卷归属
 *   · 粉笔自创 / 模拟题（没有真题试卷归属）→ 保留「粉笔题库」品牌来源
 *   · 其它来源原样；没有 source_exam 时退回来源文章标题
 */
function normalizeQuestionSource(sourceExam, articleTitle) {
  const raw = String(sourceExam || '').trim();
  if (raw.startsWith(FENBI_SOURCE_PREFIX)) {
    const rest = raw.slice(FENBI_SOURCE_PREFIX.length).trim();
    if (!rest) return '粉笔题库';
    if (/自创|原创|模拟/.test(rest)) return raw;
    return rest;
  }
  if (raw) return raw;
  return String(articleTitle || '').trim();
}

/**
 * 批量取题目的分类元信息：level 1 模块、level 2 二级分类。
 * 题目经 question_category_map(pool='question') 关联；同层挂多张标签时
 * 用 MIN(name) 取稳定值即可（纯展示用途）。
 */
async function loadQuestionTaxonomy(conn, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const [rows] = await conn.query(
    `SELECT m.ref_id, c.level, MIN(c.name) AS name
       FROM question_category_map m
       JOIN question_category c ON c.id = m.category_id
      WHERE m.pool = 'question' AND m.ref_id IN (?) AND c.level IN (1, 2)
      GROUP BY m.ref_id, c.level`,
    [ids]
  );
  for (const r of rows) {
    const id = Number(r.ref_id);
    if (!map.has(id)) map.set(id, {});
    map.get(id)[r.level === 1 ? 'module_name' : 'category_name'] = r.name;
  }
  return map;
}

/** 按给定顺序取出题目完整数据（判分用权威答案 + 结果页展示用字段） */
async function loadQuestionsByIds(conn, ids) {
  if (!ids.length) return [];
  const [rows] = await conn.query(
    `SELECT q.id, q.subject_id, q.qtype, q.difficulty, q.passage, q.stem, q.options_json,
            q.answer, q.explanation, q.source_exam, q.source_article_id,
            a.title AS article_title
       FROM question q
       LEFT JOIN article a ON a.id = q.source_article_id
      WHERE q.id IN (?)`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 保持客户端出题顺序（IN 查询不保证顺序）
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const tax = await loadQuestionTaxonomy(conn, ordered.map(q => q.id));
  return ordered.map((q) => ({
    ...q,
    // 真题只显示试卷归属；仅粉笔自创/模拟题才保留「粉笔题库」字样
    source: normalizeQuestionSource(q.source_exam, q.article_title),
    module_name: tax.get(q.id)?.module_name || '',
    category_name: tax.get(q.id)?.category_name || '',
  }));
}

// POST /api/practice/smart-paper —— 智能组卷：按国考行测 130 题结构自动抽题，
// 落库为一份个人试卷（origin='smart'，仅创建者可见、不进历年试卷列表），
// 前端拿到 paper_id 后直接进整卷答题界面作答（判分/解析/历史复用整卷链路）。
router.post('/smart-paper', requireAuth, asyncHandler(async (req, res) => {
  const { pickSmartPaper } = require('../lib/taxonomy');
  const yearMode = String(req.body?.yearMode || '');
  const picked = await pickSmartPaper({ yearMode });
  if (!picked.questions.length) {
    return res.status(400).json({ error: '题库题量不足，无法生成试卷' });
  }

  const spanLabel = { near3: '近3年', near5: '近5年', near10: '近10年' }[yearMode] || '';
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const title = `智能组卷${spanLabel ? `（${spanLabel}）` : ''} · ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const paperId = await withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const [pr] = await conn.query(
        `INSERT INTO exam_paper
           (title, year, paper_type, origin, status, parse_status, parsed_count, question_count, creator_user_id, created_at, updated_at)
         VALUES (?, ?, '智能组卷', 'smart', 'approved', 'success', ?, ?, ?, NOW(), NOW())`,
        [title, now.getFullYear(), picked.questions.length, picked.questions.length, req.user.userId]
      );
      const pid = pr.insertId;

      // 资料分析：先落「父级大题」(一篇材料一行)，再把 5 道小题显式关联过去。
      // 父级大题不计入卷面题数，子题仍是正常作答/判分题目。
      const groupIdByNo = new Map();
      const groups = picked.materialGroups || [];
      for (const g of groups) {
        const [gr] = await conn.query(
          `INSERT INTO exam_paper_material_group
             (exam_paper_id, group_no, title, passage, images, question_count)
           VALUES (?,?,?,?,?,?)`,
          [pid, g.groupNo, g.title, g.passage || null, g.images || null, g.questions.length]
        );
        groupIdByNo.set(g.groupNo, gr.insertId);
      }

      const values = [];
      const params = [];
      picked.questions.forEach((q, i) => {
        const groupId = q.materialGroupNo ? groupIdByNo.get(q.materialGroupNo) || null : null;
        values.push('(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        params.push(pid, i + 1, q.section || null, q.qtype || '单选题', q.difficulty || 3,
          q.passage || null, q.stem, q.options_json, q.answer || '', q.explanation || null, null,
          groupId, groupId ? 'material_child' : 'normal');
      });
      // 用预编译语句：题干/选项含引号、反斜杠时 conn.query 的转义会炸
      await conn.execute(
        `INSERT INTO exam_paper_question
           (exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json, answer, explanation, image_url,
            material_group_id, question_role)
         VALUES ${values.join(',')}`,
        params
      );
      await conn.commit();
      return pid;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });

  res.json({ paper_id: paperId, total: picked.questions.length, sections: picked.sections, title });
}));

// POST /api/practice/start
// 只接收题目 id 列表：答案一律由服务端在判分时从 question 表读取，
// 客户端提交的题目对象里的 answer 字段会被丢弃。
router.post('/start', requireAuth, asyncHandler(async (req, res) => {
  const { subject_id, questions, practice } = req.body;
  // 练习配置只取白名单字段，历史列表据此生成粉笔式名称（不再用自增编号）
  const practiceMeta = normalizePractice(practice);
  if (!subject_id || !questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const requestedIds = extractQuestionIds({ questions });
  if (requestedIds.length === 0) return res.status(400).json({ error: '题目列表为空或格式不正确' });
  if (requestedIds.length > MAX_SESSION_QUESTIONS) {
    return res.status(400).json({ error: `一次练习最多 ${MAX_SESSION_QUESTIONS} 道题` });
  }

  const session_id = await withConnection(async (conn) => {
    // 验证 subject_id 存在
    const [subjects] = await conn.query('SELECT id FROM subject WHERE id = ?', [subject_id]);
    if (subjects.length === 0) throw Object.assign(new Error('科目不存在'), { status: 400 });

    // 过滤掉不存在 / 未过审的题目，并保持客户端给定的出题顺序
    const [rows] = await conn.query(
      'SELECT id FROM question WHERE id IN (?) AND status = ?',
      [requestedIds, 'approved']
    );
    const valid = new Set(rows.map((r) => r.id));
    const questionIds = requestedIds.filter((id) => valid.has(id));
    if (questionIds.length === 0) throw Object.assign(new Error('没有可用的题目'), { status: 400 });

    const sessionMeta = { question_ids: questionIds };
    if (practiceMeta) sessionMeta.practice = { ...practiceMeta, count: questionIds.length };
    const [result] = await conn.query(
      'INSERT INTO practice_session (user_id, subject_id, mode, status, total, duration_sec, started_at, meta_json) VALUES (?,?,?,?,?,?,?,?)',
      [req.user.userId, subject_id, 'random', 'in_progress', questionIds.length, 0, localDateTimeStr(), JSON.stringify(sessionMeta)]
    );
    return result.insertId;
  });

  return res.json({ session_id });
}));

// POST /api/practice/save-progress
router.post('/save-progress', requireAuth, asyncHandler(async (req, res) => {
  const { session_id, answers, elapsed_sec, marked } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  await withConnection(async (conn) => {
    const [sessions] = await conn.query(
      'SELECT id, status, meta_json FROM practice_session WHERE id = ? AND user_id = ?',
      [session_id, req.user.userId]
    );
    if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });
    if (sessions[0].status === 'completed') throw Object.assign(new Error('答题已完成，无法保存'), { status: 400 });

    let meta = parseMetaJson(sessions[0].meta_json);
    if (!meta.questions) meta.questions = [];
    meta.answers = answers || meta.answers || {};
    meta.elapsed_sec = elapsed_sec || meta.elapsed_sec || 0;
    // 标记题随进度一起持久化，刷新/续答后答题卡仍能还原标记状态
    if (Array.isArray(marked)) meta.marked = marked;

    await conn.query(
      'UPDATE practice_session SET meta_json = ?, duration_sec = ? WHERE id = ?',
      [JSON.stringify(meta), elapsed_sec || 0, session_id]
    );
  });

  return res.json({ success: true });
}));

// POST /api/practice/submit
// 判分只认 question 表里的权威答案；客户端提交的 answers 只作为「用户选了什么」。
// 全程单事务：避免 DELETE 后 INSERT 中断导致的半截数据。
router.post('/submit', requireAuth, asyncHandler(async (req, res) => {
  const { session_id, answers, elapsed_sec } = req.body;
  if (!session_id || !answers) return res.status(400).json({ error: '参数不完整' });
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: '作答数据格式不正确' });
  }
  const elapsed = Number(elapsed_sec) || 0;
  // 逐题用时（可选）：key 为题目 id（字符串或数字），value 为非负整数秒。
  // 未传或值非法一律按 0，保证旧调用方（不带 timings）向后兼容；口径与整卷一致。
  const timingsRaw = req.body && req.body.timings;
  const timings = (timingsRaw && typeof timingsRaw === 'object' && !Array.isArray(timingsRaw))
    ? timingsRaw : {};
  const timeOf = (qid) => {
    const v = timings[String(qid)] ?? timings[qid];
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const result = await withConnection(async (conn) => {
    const [sessions] = await conn.query(
      'SELECT id, status, meta_json FROM practice_session WHERE id = ? AND user_id = ?',
      [session_id, req.user.userId]
    );
    if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });
    if (sessions[0].status === 'completed') {
      throw Object.assign(new Error('该练习已提交，无法重复交卷'), { status: 400 });
    }

    const meta = parseMetaJson(sessions[0].meta_json);
    const questionIds = extractQuestionIds(meta);
    if (questionIds.length === 0) throw Object.assign(new Error('该练习没有题目，请重新发起'), { status: 400 });

    // 权威答案与展示字段都来自 question 表
    const questions = await loadQuestionsByIds(conn, questionIds);
    if (questions.length === 0) throw Object.assign(new Error('题目已不存在，请重新发起练习'), { status: 400 });

    const total = questions.length;
    let correct = 0;
    const answerRows = [];
    const answerParams = [];
    const wrongIds = [];
    // 只落库本卷题目 id 的作答，丢弃客户端夹带的任何杂项键
    const savedAnswers = {};
    // 结果页 / 历史列表展示用的逐题用时（已规范化为 0 或非负整数）
    const savedTimings = {};
    // 按题目所属一级模块分组统计：module_name 已由 loadQuestionsByIds 带上，无需额外查库
    const sectionMap = new Map();
    let unanswered = 0;

    for (const q of questions) {
      const userAnswer = String(answers[q.id] ?? answers[String(q.id)] ?? '');
      if (userAnswer) savedAnswers[q.id] = userAnswer;
      const isCorrect = userAnswer !== '' && userAnswer === q.answer ? 1 : 0;
      if (isCorrect) correct++;
      else wrongIds.push(q.id);
      const spent = timeOf(q.id);
      savedTimings[q.id] = spent;
      // bySection：一级模块名（无标签归「其他」），timeSec 取本轮规范化后的用时
      const sectionName = q.module_name || '其他';
      if (!sectionMap.has(sectionName)) sectionMap.set(sectionName, { name: sectionName, total: 0, correct: 0, timeSec: 0 });
      const sec = sectionMap.get(sectionName);
      sec.total++;
      if (isCorrect) sec.correct++;
      sec.timeSec += spent;
      if (userAnswer === '') unanswered++;
      answerRows.push('(?,?,?,?,?)');
      // answerParams 是扁平数组：每行 5 个占位符，末列是 time_spent_sec（原恒 0）
      answerParams.push(session_id, q.id, userAnswer, isCorrect, spent);
    }

    const bySection = Array.from(sectionMap.values()).map((s) => ({
      name: s.name,
      total: s.total,
      correct: s.correct,
      accuracy: s.total > 0 ? Number((s.correct / s.total).toFixed(4)) : 0,
      timeSec: s.timeSec,
    }));
    const completion = total > 0 ? Number(((total - unanswered) / total).toFixed(4)) : 0;
    const score = total > 0 ? Number(((correct / total) * 100).toFixed(2)) : 0;

    await conn.beginTransaction();
    try {
      await conn.query('DELETE FROM practice_answer WHERE session_id = ?', [session_id]);
      // 批量写入作答记录（原先逐条 INSERT，100 题 = 100 次往返）
      await conn.query(
        `INSERT INTO practice_answer (session_id, question_id, user_answer, is_correct, time_spent_sec)
         VALUES ${answerRows.join(',')}`,
        answerParams
      );

      if (wrongIds.length > 0) {
        // 首次答错：wrong_count=1（低频），下次复习 +15 天。
        // 重复答错：ON DUPLICATE KEY UPDATE 从左到右求值，next_review_at 赋值放在
        // wrong_count 之前，用 (wrong_count + 1) 表示更新后的错次，据此定复习周期：
        // >=3 高频 +1 天 / =2 中频 +7 天 / 其余低频 +15 天。
        const placeholders = wrongIds.map(() => '(?, ?, 1, 0, DATE_ADD(NOW(), INTERVAL 15 DAY))').join(',');
        const params = [];
        for (const id of wrongIds) params.push(req.user.userId, id);
        await conn.query(
          `INSERT INTO wrong_book (user_id, question_id, wrong_count, mastered, next_review_at) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             next_review_at = CASE
               WHEN (wrong_count + 1) >= 3 THEN DATE_ADD(NOW(), INTERVAL 1 DAY)
               WHEN (wrong_count + 1) = 2 THEN DATE_ADD(NOW(), INTERVAL 7 DAY)
               ELSE DATE_ADD(NOW(), INTERVAL 15 DAY)
             END,
             wrong_count = wrong_count + 1,
             mastered = 0`,
          params
        );
      }

      const nextMeta = { ...meta, question_ids: questionIds, answers: savedAnswers, elapsed_sec: elapsed, timings: savedTimings };
      await conn.query(
        'UPDATE practice_session SET status = ?, correct = ?, score = ?, duration_sec = ?, finished_at = ?, meta_json = ? WHERE id = ?',
        ['completed', correct, score, elapsed, localDateTimeStr(), JSON.stringify(nextMeta), session_id]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }

    return {
      session_id,
      total,
      correct,
      score,
      duration_sec: elapsed,
      bySection,
      unanswered,
      completion,
      // 结果页需要正确答案与解析；答题阶段接口不下发（防提前看答案），交卷后才给
      questions: questions.map((q) => ({
        id: q.id,
        subject_id: q.subject_id,
        qtype: q.qtype,
        difficulty: q.difficulty,
        passage: q.passage,
        stem: q.stem,
        options_json: q.options_json,
        answer: q.answer,
        explanation: q.explanation,
        source_exam: q.source_exam,
        // 结果页每题展示用元信息；答题阶段接口不下发这些字段
        source: q.source || '',
        module_name: q.module_name || '',
        category_name: q.category_name || '',
        // 结果页逐题解析处展示本题用时（已规范化，老数据为 0）
        time_spent_sec: savedTimings[q.id] || 0,
      })),
    };
  });

  return res.json(result);
}));

// GET /api/practice/weakness —— 学情诊断（薄弱点画像）
// 注册在 /session/:id 等动态路由之前，避免被参数段抢先匹配。
// 画像计算见 lib/weakness.js；无数据用户由其返回 hasData:false + 空数组，不会 500。
router.get('/weakness', requireAuth, asyncHandler(async (req, res) => {
  const { getWeaknessProfile } = require('../lib/weakness');
  const profile = await withConnection((conn) => getWeaknessProfile(conn, req.user.userId));
  return res.json({ ...(profile || {}), generatedAt: new Date().toISOString() });
}));

// GET /api/practice/session/:id
router.get('/session/:id', requireAuth, asyncHandler(async (req, res) => {
  const data = await withConnection(async (conn) => {
    const [sessions] = await conn.query(
      `SELECT ps.*, s.name AS subject_name FROM practice_session ps LEFT JOIN subject s ON ps.subject_id = s.id WHERE ps.id = ? AND ps.user_id = ?`,
      [req.params.id, req.user.userId]
    );
    if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });

    const session = sessions[0];
    const meta = parseMetaJson(session.meta_json);

    // questions 统一从 question 表取完整数据（meta 里只有 id 列表，没有题干/选项/解析）
    const questions = await loadQuestionsByIds(conn, extractQuestionIds(meta));

    const [answerDetails] = await conn.query(
      `SELECT pa.*, q.stem, q.passage, q.options_json, q.answer AS correct_answer, q.explanation, q.qtype, q.difficulty
       FROM practice_answer pa JOIN question q ON pa.question_id = q.id WHERE pa.session_id = ?`,
      [session.id]
    );

    // 历史结果页与 submit 同口径：以本卷题目为框架、作答明细为数据源。
    // 模块归属沿用 questions 里的 module_name（一级模块），不额外查库、无 N+1。
    const detailById = new Map(answerDetails.map((a) => [Number(a.question_id), a]));
    const sectionMap = new Map();
    let unanswered = 0;
    for (const q of questions) {
      const a = detailById.get(Number(q.id));
      const userAnswer = a ? String(a.user_answer ?? '') : '';
      const isCorrect = a && Number(a.is_correct) === 1 ? 1 : 0;
      const spent = a ? Number(a.time_spent_sec) || 0 : 0;
      const sectionName = q.module_name || '其他';
      if (!sectionMap.has(sectionName)) sectionMap.set(sectionName, { name: sectionName, total: 0, correct: 0, timeSec: 0 });
      const sec = sectionMap.get(sectionName);
      sec.total++;
      if (isCorrect) sec.correct++;
      sec.timeSec += spent;
      if (userAnswer === '') unanswered++;
    }
    const bySection = Array.from(sectionMap.values()).map((s) => ({
      name: s.name,
      total: s.total,
      correct: s.correct,
      accuracy: s.total > 0 ? Number((s.correct / s.total).toFixed(4)) : 0,
      timeSec: s.timeSec,
    }));
    const completion = questions.length > 0
      ? Number(((questions.length - unanswered) / questions.length).toFixed(4)) : 0;

    return {
      session: {
        id: session.id, subject_id: session.subject_id, subject_name: session.subject_name,
        status: session.status, total: session.total, correct: session.correct,
        score: session.score, duration_sec: session.duration_sec,
        started_at: session.started_at, finished_at: session.finished_at
      },
      // 完整题目数据（含 answer / explanation），供结果页与恢复进度渲染。
      // 未提交（in_progress）的练习在答题阶段不会走到这里 —— 恢复进度时
      // practice_answer 还没有记录，answerDetails 为空，此时才需要 questions。
      questions,
      answers: meta.answers || {},
      elapsed_sec: meta.elapsed_sec || session.duration_sec || 0,
      marked: Array.isArray(meta.marked) ? meta.marked : [],
      answerDetails,
      bySection,
      unanswered,
      completion
    };
  });

  return res.json(data);
}));

// GET /api/practice/history
router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 10, 50);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM practice_session WHERE user_id = ?', [req.user.userId]);
    const [rows] = await conn.query(
      `SELECT ps.*, s.name AS subject_name FROM practice_session ps LEFT JOIN subject s ON ps.subject_id = s.id
       WHERE ps.user_id = ? ORDER BY ps.id DESC LIMIT ? OFFSET ?`,
      [req.user.userId, pageSize, offset]
    );
    // 名称由服务端统一生成，历史页与题库页历史卡片共用同一口径
    const sessions = rows.map((r) => ({ ...r, title: buildSessionTitle(r) }));
    return { sessions, total: countRows[0].total };
  });

  return res.json({ ...data, page, pageSize });
}));

// GET /api/practice/report —— 个人学习报告：时间窗、按日趋势、六模块能力、环比、全站对比
router.get('/report', requireAuth, asyncHandler(async (req, res) => {
  const raw = String(req.query.range || '');
  const range = ['7d', '30d', 'month'].includes(raw) ? raw : '7d';
  const data = await withConnection((conn) => buildReport(conn, req.user.userId, range));
  return res.json(data);
}));

// GET /api/practice/stats
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const data = await withConnection(async (conn) => {
    const [overall] = await conn.query(
      `SELECT COUNT(*) AS total_sessions, SUM(total) AS total_questions, SUM(correct) AS total_correct,
       ROUND(AVG(score), 2) AS avg_score, ROUND(AVG(duration_sec), 0) AS avg_duration
       FROM practice_session WHERE user_id = ? AND status = 'completed'`,
      [req.user.userId]
    );
    const [bySubject] = await conn.query(
      `SELECT s.name, s.slug, COUNT(*) AS sessions, SUM(ps.total) AS questions, SUM(ps.correct) AS correct,
       ROUND(AVG(ps.score), 2) AS avg_score
       FROM practice_session ps JOIN subject s ON ps.subject_id = s.id
       WHERE ps.user_id = ? AND ps.status = 'completed' GROUP BY ps.subject_id`,
      [req.user.userId]
    );
    const [recent] = await conn.query(
      `SELECT ps.id, ps.total, ps.correct, ps.score, ps.duration_sec, ps.started_at, ps.status, s.name AS subject_name
       FROM practice_session ps LEFT JOIN subject s ON ps.subject_id = s.id
       WHERE ps.user_id = ? ORDER BY ps.id DESC LIMIT 5`,
      [req.user.userId]
    );
    return { overall: overall[0], bySubject, recent };
  });

  return res.json(data);
}));

// GET /api/practice/leaderboard
router.get('/leaderboard', requireAuth, asyncHandler(async (req, res) => {
  const leaderboard = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT u.id, u.nickname,
         COUNT(*) AS total_sessions, ROUND(AVG(ps.score), 2) AS avg_score,
         SUM(ps.total) AS total_questions, SUM(ps.correct) AS total_correct
       FROM practice_session ps JOIN user u ON ps.user_id = u.id
       WHERE ps.status = 'completed' AND u.status = 'active'
       GROUP BY u.id ORDER BY avg_score DESC, total_sessions DESC LIMIT 50`
    );
    return rows;
  });
  return res.json({ leaderboard });
}));

// ── 错题本接口 ──────────────────────────────────────────

// wrong_book.reason_tag 允许的非空取值；NULL 表示「未标注」。
// 前端中文标签：概念不清 / 计算失误 / 审题不清 / 时间不够 / 其他 / 未标注。
const REASON_TAGS = ['concept', 'calculation', 'reading', 'time', 'other'];

// GET /api/practice/wrong-book
// 可选 categoryId：按一级模块（question_category level=1）筛选；'0' 表示没有模块标签的题。
// 可选 reason：concept|calculation|reading|time|other 走等值匹配，unlabeled 表示 reason_tag IS NULL。
// 可选 freq：按 wrong_count 分档 —— high(>=3) / mid(=2) / low(=1)。
// 不传时行为与原来完全一致，仅在返回里额外附带 items.module_id/name、reason_tag 与 modules 列表。
// 可选 review：due=只看到期错题（含 next_review_at 为 NULL 的老数据），all（默认）=全部，向后兼容。
router.get('/wrong-book', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 15, 50);
  const offset = (page - 1) * pageSize;
  const mastered = req.query.mastered;
  const rawCategory = req.query.categoryId;
  const categoryId = (rawCategory === undefined || rawCategory === '' || rawCategory === null)
    ? null : Number(rawCategory);
  const reason = req.query.reason;
  const freq = req.query.freq;
  const review = req.query.review === 'due' ? 'due' : 'all';

  const data = await withConnection(async (conn) => {
    let whereClause = ' WHERE wb.user_id = ?';
    const params = [req.user.userId];
    if (mastered !== undefined && mastered !== '') { whereClause += ' AND wb.mastered = ?'; params.push(Number(mastered)); }
    // 统一用 wb.question_id 做子查询，这样 COUNT 查询无需 JOIN question 也能复用 whereClause
    if (categoryId !== null && Number.isInteger(categoryId) && categoryId > 0) {
      whereClause += ` AND EXISTS (SELECT 1 FROM question_category_map m
        WHERE m.pool = 'question' AND m.ref_id = wb.question_id AND m.category_id = ?)`;
      params.push(categoryId);
    } else if (categoryId === 0) {
      whereClause += ` AND NOT EXISTS (SELECT 1 FROM question_category_map m
        JOIN question_category c ON c.id = m.category_id AND c.level = 1
        WHERE m.pool = 'question' AND m.ref_id = wb.question_id)`;
    }
    // 错因筛选：unlabeled = 尚未标注（IS NULL）；其余仅接受白名单值并参数绑定。
    // 非法/未传一律不加条件，保持「全部」行为，绝不把原始字符串拼进 SQL。
    if (reason === 'unlabeled') {
      whereClause += ' AND wb.reason_tag IS NULL';
    } else if (REASON_TAGS.includes(reason)) {
      whereClause += ' AND wb.reason_tag = ?';
      params.push(reason);
    }
    // 错次分档复用 wrong_count，不新增列；只用字面量条件，无外部输入拼接。
    if (freq === 'high') whereClause += ' AND wb.wrong_count >= 3';
    else if (freq === 'mid') whereClause += ' AND wb.wrong_count = 2';
    else if (freq === 'low') whereClause += ' AND wb.wrong_count = 1';

    // 到期口径见文件顶部 DUE_SQL：老数据 NULL 视为到期，当天新错的题也进来。
    const dueClause = ' AND ' + DUE_SQL;
    const listWhere = review === 'due' ? whereClause + dueClause : whereClause;

    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM wrong_book wb' + listWhere, params);
    // 徽标数字：当前筛选条件下到期的错题总数（与 review 视图无关，恒定可比）。
    let dueCount = Number(countRows[0].total) || 0;
    if (review !== 'due') {
      const [dueRows] = await conn.query('SELECT COUNT(*) AS c FROM wrong_book wb' + whereClause + dueClause, params);
      dueCount = Number(dueRows[0].c) || 0;
    }
    const [rows] = await conn.query(
      `SELECT wb.id, wb.user_id, wb.question_id, wb.wrong_count, wb.mastered, wb.reason_tag, wb.updated_at,
        wb.next_review_at,
        CASE WHEN wb.wrong_count >= 3 THEN 'high' WHEN wb.wrong_count = 2 THEN 'mid' ELSE 'low' END AS review_level,
        ${DUE_SQL} AS due,
        q.stem, q.passage, q.options_json, q.answer, q.explanation, q.qtype, q.difficulty,
        (SELECT c.id FROM question_category_map m
           JOIN question_category c ON c.id = m.category_id AND c.level = 1
          WHERE m.pool = 'question' AND m.ref_id = q.id LIMIT 1) AS module_id,
        (SELECT c.name FROM question_category_map m
           JOIN question_category c ON c.id = m.category_id AND c.level = 1
          WHERE m.pool = 'question' AND m.ref_id = q.id LIMIT 1) AS module_name
       FROM wrong_book wb JOIN question q ON wb.question_id = q.id ${listWhere}
       ORDER BY wb.mastered ASC, wb.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    const items = rows.map((r) => ({ ...r, due: Number(r.due) === 1 }));

    const [statsRows] = await conn.query(
      'SELECT COUNT(*) AS total, SUM(mastered = 0) AS active, SUM(mastered = 1) AS mastered, SUM(wrong_count) AS total_wrongs FROM wrong_book WHERE user_id = ?',
      [req.user.userId]
    );
    const [byType] = await conn.query(
      'SELECT q.qtype, SUM(wb.wrong_count) AS count FROM wrong_book wb JOIN question q ON wb.question_id = q.id WHERE wb.user_id = ? AND wb.mastered = 0 GROUP BY q.qtype ORDER BY count DESC',
      [req.user.userId]
    );
    statsRows[0].byType = byType;

    // 该用户错题涉及的一级模块，用于错题本按模块导航与分模块重做。
    // 按需计算：只有错题本页显式带 withModules=1 才跑这个聚合，
    // 否则题库页等「只取统计数字」的请求也要跟着全表扫描分类映射，白白拖慢响应。
    let moduleRows = [];
    if (req.query.withModules === '1') {
      const [mods] = await conn.query(
        `SELECT COALESCE(qm.module_id, 0) AS module_id,
                COALESCE(qm.module_name, '其他') AS module_name,
                COUNT(*) AS count
           FROM wrong_book wb
           JOIN question q ON q.id = wb.question_id
           LEFT JOIN (
             SELECT m.ref_id, MIN(c.id) AS module_id, MIN(c.name) AS module_name
               FROM question_category_map m
               JOIN question_category c ON c.id = m.category_id AND c.level = 1
              WHERE m.pool = 'question'
              GROUP BY m.ref_id
           ) qm ON qm.ref_id = q.id
          WHERE wb.user_id = ?
          GROUP BY qm.module_id, qm.module_name
          ORDER BY module_id`,
        [req.user.userId]
      );
      moduleRows = mods;
    }

    return { items, total: countRows[0].total, dueCount, stats: statsRows[0], modules: moduleRows };
  });

  return res.json({ ...data, page, pageSize });
}));

// PUT /api/practice/wrong-book/by-question/:questionId/reason
// 设置 / 清除某道错题的错因标签，按 question_id 定位（列表里已下发该字段）。
// 必须注册在 /wrong-book/:id/mastered 等动态路由之前，避免被 /:id 段抢先匹配。
router.put('/wrong-book/by-question/:questionId/reason', requireAuth, asyncHandler(async (req, res) => {
  const raw = req.body?.reason;
  let value;
  if (raw === null || raw === '') {
    value = null; // null / 空串 = 清除标注，落库为 NULL（未标注）
  } else if (REASON_TAGS.includes(raw)) {
    value = raw;
  } else {
    return res.status(400).json({ error: '非法的错因标签' });
  }
  const affectedRows = await withConnection(async (conn) => {
    const [result] = await conn.query(
      'UPDATE wrong_book SET reason_tag = ? WHERE user_id = ? AND question_id = ?',
      [value, req.user.userId, req.params.questionId]
    );
    return result.affectedRows;
  });
  return res.json({ success: true, affectedRows });
}));

// DELETE /api/practice/wrong-book/:id
router.delete('/wrong-book/:id', requireAuth, asyncHandler(async (req, res) => {
  const affected = await withConnection(async (conn) => {
    const [result] = await conn.query('DELETE FROM wrong_book WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
    return result.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '错题记录不存在' });
  return res.json({ success: true });
}));

// DELETE /api/practice/wrong-book/by-question/:questionId
router.delete('/wrong-book/by-question/:questionId', requireAuth, asyncHandler(async (req, res) => {
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM wrong_book WHERE user_id = ? AND question_id = ?', [req.user.userId, req.params.questionId]);
  });
  return res.json({ success: true });
}));

// PUT /api/practice/wrong-book/:id/mastered
router.put('/wrong-book/:id/mastered', requireAuth, asyncHandler(async (req, res) => {
  const { mastered } = req.body;
  await withConnection(async (conn) => {
    await conn.query('UPDATE wrong_book SET mastered = ? WHERE id = ? AND user_id = ?', [mastered ? 1 : 0, req.params.id, req.user.userId]);
  });
  return res.json({ success: true });
}));

// POST /api/practice/wrong-book/redo
// 可选 categoryId：只重做某个一级模块下的错题（'0' = 无模块标签），不传则重做全部。
// 可选 review=due：优先抽到期错题（含 next_review_at 为 NULL 的老数据）；不传保持原随机口径。
router.post('/wrong-book/redo', requireAuth, asyncHandler(async (req, res) => {
  const { count = 10 } = req.body;
  const review = req.body.review === 'due' ? 'due' : 'all';
  const rawCategory = req.body.categoryId;
  const categoryId = (rawCategory === undefined || rawCategory === '' || rawCategory === null)
    ? null : Number(rawCategory);
  let categoryClause = '';
  const params = [req.user.userId];
  if (categoryId !== null && Number.isInteger(categoryId) && categoryId > 0) {
    categoryClause = ` AND EXISTS (SELECT 1 FROM question_category_map m
      WHERE m.pool = 'question' AND m.ref_id = wb.question_id AND m.category_id = ?)`;
    params.push(categoryId);
  } else if (categoryId === 0) {
    categoryClause = ` AND NOT EXISTS (SELECT 1 FROM question_category_map m
      JOIN question_category c ON c.id = m.category_id AND c.level = 1
      WHERE m.pool = 'question' AND m.ref_id = wb.question_id)`;
  }
  const questions = await withConnection(async (conn) => {
    // 同 /questions/random：答题阶段不下发 answer / explanation，交卷后由 submit 返回
    const [rows] = await conn.query(
      `SELECT q.id, q.subject_id, q.qtype, q.difficulty, q.passage, q.stem, q.options_json, q.source_exam, q.source_article_id,
       a.clean_text as article_text, a.title as article_title
       FROM wrong_book wb JOIN question q ON wb.question_id = q.id LEFT JOIN article a ON q.source_article_id = a.id
       WHERE wb.user_id = ? AND wb.mastered = 0 AND q.status = 'approved' ${categoryClause}
       ORDER BY ${review === 'due' ? DUE_SQL + ' DESC, ' : ''}RAND() LIMIT ?`,
      [...params, Math.min(count, 50)]
    );
    return rows.map(q => {
      if (!q.passage && q.article_text) q.passage = q.article_text.substring(0, 300);
      return q;
    });
  });
  return res.json({ questions });
}));

// ── 题目评分与反馈 ──────────────────────────────────────

// POST /api/practice/feedback
// 提交或修改某题的评分与文字反馈。同一用户对同一题目重复提交为覆盖更新。
router.post('/feedback', requireAuth, asyncHandler(async (req, res) => {
  const { question_id, session_id, rating, feedback } = req.body;

  // 入参校验：评分必须为 1-5 的整数
  const ratingNum = Number(rating);
  if (!question_id) return res.status(400).json({ error: '缺少 question_id' });
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: '评分必须为 1-5 的整数' });
  }

  // 反馈长度限制，避免异常大请求体
  const feedbackText = typeof feedback === 'string' ? feedback.trim() : '';
  if (feedbackText.length > 1000) return res.status(400).json({ error: '反馈内容不能超过 1000 字' });

  await withConnection(async (conn) => {
    // 校验题目存在，避免脏外键
    const [questions] = await conn.query('SELECT id FROM question WHERE id = ?', [question_id]);
    if (questions.length === 0) throw Object.assign(new Error('题目不存在'), { status: 404 });

    // 校验 session 归属（若传了 session_id），防止越权关联他人练习记录
    let sessionValue = null;
    if (session_id) {
      const [sessions] = await conn.query(
        'SELECT id FROM practice_session WHERE id = ? AND user_id = ?',
        [session_id, req.user.userId]
      );
      if (sessions.length === 0) throw Object.assign(new Error('答题记录不存在'), { status: 404 });
      sessionValue = sessions[0].id;
    }

    // 覆盖写入：利用 (user_id, question_id) 唯一键，重复评分即更新
    await conn.query(
      `INSERT INTO question_feedback (user_id, question_id, session_id, rating, feedback)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), rating = VALUES(rating),
                               feedback = VALUES(feedback), updated_at = CURRENT_TIMESTAMP`,
      [req.user.userId, question_id, sessionValue, ratingNum, feedbackText || null]
    );
  });

  return res.json({ success: true, rating: ratingNum, feedback: feedbackText });
}));

// GET /api/practice/feedback?ids=1,2,3
// 批量查询当前用户对若干题目的评分（结果页一次性渲染用，避免 N 次请求）
router.get('/feedback', requireAuth, asyncHandler(async (req, res) => {
  // 限制条数并过滤非法值：客户端可以拼任意长的 ?ids= 把 IN 子句撑爆
  const ids = parseIdsQuery(req.query.ids, { max: 200 });
  if (ids.length === 0) return res.json({ feedbacks: {} });

  const rows = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `SELECT question_id, rating, feedback, updated_at FROM question_feedback
       WHERE user_id = ? AND question_id IN (?)`,
      [req.user.userId, ids]
    );
    return r;
  });

  // 以 question_id 为键返回，前端可直接按题目查找
  const feedbacks = {};
  for (const row of rows) {
    feedbacks[row.question_id] = {
      rating: row.rating,
      feedback: row.feedback || '',
      updated_at: row.updated_at,
    };
  }
  return res.json({ feedbacks });
}));

// GET /api/practice/feedback/stats
// 管理员视角的评分汇总（按题目聚合，用于后台观察题目质量）
// 注意：必须挂 requireAdmin —— 汇总里带全站题目的评分分布与 stem，普通用户无权查看
router.get('/feedback/stats', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `SELECT qf.question_id, q.stem, q.qtype,
              COUNT(*) AS rating_count, ROUND(AVG(qf.rating), 2) AS avg_rating,
              SUM(qf.feedback IS NOT NULL AND qf.feedback <> '') AS feedback_count
       FROM question_feedback qf JOIN question q ON qf.question_id = q.id
       GROUP BY qf.question_id, q.stem, q.qtype
       ORDER BY rating_count DESC, avg_rating ASC LIMIT 100`
    );
    return r;
  });
  return res.json({ items: rows });
}));

// ── 收藏接口 ──────────────────────────────────────────

// GET /api/practice/favorites
router.get('/favorites', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 15, 50);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM favorite WHERE user_id = ?', [req.user.userId]);
    // 补全前端标签用的两个展示字段：subject_name 来自科目表，
    // category_name 取二级分类名（相关子查询 + MIN，避免一题多标签放大行数）。
    const [rows] = await conn.query(
      `SELECT f.id, f.question_id, f.created_at, q.stem, q.passage, q.options_json, q.answer, q.explanation, q.qtype, q.difficulty,
        s.name AS subject_name,
        (SELECT MIN(c.name) FROM question_category_map m
           JOIN question_category c ON c.id = m.category_id AND c.level = 2
          WHERE m.pool = 'question' AND m.ref_id = q.id) AS category_name
       FROM favorite f JOIN question q ON f.question_id = q.id
       LEFT JOIN subject s ON s.id = q.subject_id
       WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.userId, pageSize, offset]
    );
    return { items: rows, total: countRows[0].total };
  });
  return res.json({ ...data, page, pageSize });
}));

// POST /api/practice/favorites
router.post('/favorites', requireAuth, asyncHandler(async (req, res) => {
  const { question_id } = req.body;
  if (!question_id) return res.status(400).json({ error: '缺少题目ID' });
  await withConnection(async (conn) => {
    await conn.query('INSERT IGNORE INTO favorite (user_id, question_id) VALUES (?, ?)', [req.user.userId, question_id]);
  });
  return res.json({ success: true });
}));

// DELETE /api/practice/favorites/:questionId
router.delete('/favorites/:questionId', requireAuth, asyncHandler(async (req, res) => {
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM favorite WHERE user_id = ? AND question_id = ?', [req.user.userId, req.params.questionId]);
  });
  return res.json({ success: true });
}));

// GET /api/practice/favorites/check
router.get('/favorites/check', requireAuth, asyncHandler(async (req, res) => {
  const ids = parseIdsQuery(req.query.ids, { max: 200 });
  if (ids.length === 0) return res.json({ favorited: [] });
  const favorited = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT question_id FROM favorite WHERE user_id = ? AND question_id IN (?)', [req.user.userId, ids]);
    return rows.map(r => r.question_id);
  });
  return res.json({ favorited });
}));

// GET /api/practice/trend
router.get('/trend', requireAuth, asyncHandler(async (req, res) => {
  const trend = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT score, started_at FROM practice_session WHERE user_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 20`,
      [req.user.userId]
    );
    return rows.reverse();
  });
  return res.json({ trend });
}));

// POST /api/practice/ai-analysis
router.post('/ai-analysis', requireAuth, aiAnalysisLimiter, asyncHandler(async (req, res) => {
  const { question_id, user_answer } = req.body;
  if (!question_id) return res.status(400).json({ error: '缺少 question_id' });

  const q = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT q.*, a.clean_text AS article_text FROM question q LEFT JOIN article a ON q.source_article_id = a.id WHERE q.id = ?',
      [question_id]
    );
    return rows[0] || null;
  });
  if (!q) return res.status(404).json({ error: '题目不存在' });

  const options = safeOptions(q.options_json);
  const optionsText = options.map((opt, i) => String.fromCharCode(65 + i) + '. ' + opt).join('\n');

  const API_KEY = process.env.API_KEY || process.env.MIMO_API_KEY;
  const BASE_URL = process.env.BASE_URL || process.env.MIMO_BASE_URL || 'https://api.deepseek.com/v1';
  if (!API_KEY) return res.status(500).json({ error: 'AI 服务未配置' });

  // 答对与答错给予不同侧重点的讲解：错题重在纠偏，答对重在思路沉淀
  const isCorrect = user_answer === q.answer;
  const prompt = isCorrect
    ? `你是一位公务员考试辅导老师。学生答对了以下题目，请给出思路讲解，重点说明：
1. 这道题的突破口在哪里（如何快速定位关键信息）
2. 正确答案 ${q.answer} 为什么最合适
3. 同类题的通用解法与可迁移的技巧

题目类型：${q.qtype}
难度：${q.difficulty}/5
${q.passage ? '片段：\n' + q.passage : ''}
题干：${q.stem}
选项：
${optionsText}
正确答案：${q.answer}
标准解析：${q.explanation}

请用简洁的中文回答，不超过200字。`
    : `你是一位公务员考试辅导老师。学生做错了以下题目，请给出个性化的解析，重点解释：
1. 为什么学生选的 ${user_answer || '未选'} 是错的
2. 正确答案 ${q.answer} 为什么对
3. 这道题的解题思路和易错点

题目类型：${q.qtype}
难度：${q.difficulty}/5
${q.passage ? '片段：\n' + q.passage : ''}
题干：${q.stem}
选项：
${optionsText}
正确答案：${q.answer}
标准解析：${q.explanation}

请用简洁的中文回答，不超过200字。`;

  let analysis = '';
  try {
    const aiRes = await axios.post(
      BASE_URL + '/chat/completions',
      {
        model: process.env.MODEL || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是公务员考试辅导专家，擅长用通俗易懂的方式讲解题目。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    // 上游若返回非标准结构（裸文本/流式分片），这里取不到内容时要显式降级，
    // 不能把原始响应直接透给前端，否则前端 JSON 解析会失败
    analysis = (aiRes.data?.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('[AI] 解析调用失败:', e.response?.status || '', e.response?.data?.error?.message || e.message);
    return res.status(502).json({ error: 'AI 服务暂时不可用，请稍后再试' });
  }

  if (!analysis) return res.status(502).json({ error: 'AI 未返回有效内容，请稍后再试' });
  return res.json({ analysis });
}));

module.exports = router;
