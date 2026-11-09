/**
 * 整卷在线阅览与答题（用户端）。
 *
 * 设计要点：
 *   - 拉取整卷时不返回答案与解析（避免提前泄露），提交后才返回判分结果
 *   - 按 exam_paper_question.seq 保持原卷顺序，并按 section 分区，供前端做分区导航
 *   - 判分在服务端完成，多选题按字母集合完全匹配计分
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth, requireAuthOrToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { safeJson } = require('../lib/json');
const { classifyImageNeed } = require('../lib/questionImage');
const { normalizeQuestionStem } = require('../lib/questionStem');

const router = express.Router();

/** 试卷相关文件目录：原卷 PDF + 题目区域截图（与管理端保持一致） */
const PAPER_FILES_DIR = path.resolve(__dirname, '../../uploads/papers');
const PAPER_IMAGE_SUBDIR = 'paper-images';

/** 国考行测整卷考试时长（分钟）：考场模式倒计时基准，随整卷结构下发给前端 */
const EXAM_DURATION_MINUTES = 120;

// GET /api/exam-papers/images/:paperId/:file —— 题目区域截图
// 从原 PDF 裁出的截图，供答题时展示图形推理/几何图/统计图表。
// <img> 标签带不了 Authorization 头，故这个路由额外接受 ?t=<token>。
// 注意：必须放在 router.use(requireAuth) 之前 —— 否则 <img> 请求（无 Authorization 头）
// 会被 requireAuth 先拦掉直接 401，根本到不了这里。
router.get('/images/:paperId/:file', requireAuthOrToken, asyncHandler(async (req, res) => {
  const paperId = String(req.params.paperId);
  const file = String(req.params.file);
  // 只允许「数字」与「字母数字-_.」，防目录穿越
  if (!/^\d{1,10}$/.test(paperId) || !/^[A-Za-z0-9._-]{1,64}$/.test(file) || file.includes('..')) {
    return res.status(400).json({ error: '非法的图片路径' });
  }
  const abs = path.join(PAPER_FILES_DIR, PAPER_IMAGE_SUBDIR, paperId, file);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '图片不存在' });
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.sendFile(abs);
}));

router.use(requireAuth);

/** 答案比较：多选按字母集合比较 */
function isAnswerRight(yourAnswer, rightAnswer) {
  const norm = (v) => String(v || '').toUpperCase().match(/[A-Z]/g)?.sort().join('') || '';
  const a = norm(yourAnswer);
  const b = norm(rightAnswer);
  return a.length > 0 && a === b;
}

// GET /api/exam-papers —— 可作答的整卷列表
//
// 筛选维度参照粉笔「历年试卷」页的标签栏：
//   examLevel（国考/省考/…）、region（各省份）、paperType（推荐/模拟题/历年真题）、year
// 来源属性（source / origin / source_url）**不对普通用户展示**，仅管理员可见。
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const offset = (page - 1) * pageSize;

  const examLevel = req.query.examLevel ? String(req.query.examLevel) : '';
  const region = req.query.region ? String(req.query.region) : '';
  const paperType = req.query.paperType ? String(req.query.paperType) : '';
  const year = req.query.year ? Number(req.query.year) : null;
  const keyword = req.query.keyword ? String(req.query.keyword).trim() : '';
  // 粉笔原始标签（历年试卷页的扁平标签栏，value=粉笔 labelId）
  const fenbiLabel = req.query.label ? String(req.query.label) : '';

  const isAdmin = req.user && req.user.role === 'admin';

  const data = await withConnection(async (conn) => {
    const where = ["p.parse_status IN ('success','partial')", 'p.is_hidden = 0', "(p.origin IS NULL OR p.origin <> 'smart')"];
    const params = [];

    // 维度筛选：既支持 exam_paper 上的直列，也支持 exam_paper_category 关联表
    const dimFilter = (dim, value) => {
      if (!value) return;
      where.push(
        `(p.\`${dim}\` = ? OR EXISTS (SELECT 1 FROM exam_paper_category c
           WHERE c.exam_paper_id = p.id AND c.dim = ? AND c.value = ?))`
      );
      params.push(value, dim, value);
    };
    dimFilter('exam_level', examLevel);
    dimFilter('region', region);
    dimFilter('paper_type', paperType);
    if (fenbiLabel) {
      where.push(
        'EXISTS (SELECT 1 FROM exam_paper_category c WHERE c.exam_paper_id = p.id AND c.dim = ? AND c.value = ?)'
      );
      params.push('fenbi_label', fenbiLabel);
    }

    if (Number.isInteger(year) && year > 1900) {
      where.push('p.year = ?');
      params.push(year);
    }
    if (keyword) {
      where.push('p.title LIKE ?');
      params.push(`%${keyword}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM exam_paper p ${whereSql}`,
      params
    );
    const [rows] = await conn.query(
      `SELECT p.id, p.title, p.year, p.exam_level, p.region, p.paper_type,
              p.parsed_count, p.difficulty, p.parse_status, p.created_at
              ${isAdmin ? ', p.source, p.origin, p.source_url' : ''}
         FROM exam_paper p
         ${whereSql}
        ORDER BY p.year DESC, p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    return { papers: rows, total: countRows[0].total };
  });

  return res.json({ ...data, page, pageSize, canSeeSource: isAdmin });
}));

// GET /api/exam-papers/:id —— 整卷结构（不含答案与解析）
router.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const data = await withConnection(async (conn) => {
    const isAdmin = req.user && req.user.role === 'admin';
    const [rows] = await conn.query(
      `SELECT id, title, year, raw_text, parsed_count, parse_status,
              exam_level, region, paper_type, difficulty, is_hidden, origin, creator_user_id
              ${isAdmin ? ', source, source_url' : ''}
         FROM exam_paper WHERE id = ?`,
      [id]
    );
    const paper = rows[0] || null;
    if (!paper) return null;
    // 模拟卷等已隐藏的卷：管理员可见，普通用户当作不存在
    if (paper.is_hidden && !isAdmin) return null;
    // 智能组卷的个人卷：仅创建者（或管理员）可见
    if (paper.origin === 'smart' && !isAdmin && Number(paper.creator_user_id) !== Number(req.user.userId)) return null;
    if (!['success', 'partial'].includes(paper.parse_status)) {
      return { forbidden: true, parse_status: paper.parse_status };
    }
    // answer 只用于服务端生成指纹做题目映射，不会下发到响应体（避免提前泄露答案）
    const [qs] = await conn.query(
      `SELECT id, seq, section, qtype, difficulty, passage, stem, options_json, image_url,
              material_group_id, question_role, answer
       FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
      [id]
    );
    // 显式材料题组（父级大题 + 其下 5 道小题），供读取时优先还原，
    // 不依赖 passage 前缀猜测；其他题型与老试卷保持原有分组逻辑。
    const [mgs] = await conn.query(
      `SELECT id, group_no, title, passage, images, question_count
         FROM exam_paper_material_group WHERE exam_paper_id = ? ORDER BY group_no`,
      [id]
    );

    // (paper, seq) → question.id：优先按回流标记 source_paper_seq，
    // 回流时因指纹重复被跳过的题用 fingerprint 找回（与 submit 判分口径一致）。
    // 映射失败时置 null，绝不影响整卷下发。
    try {
      const { buildFingerprint } = require('../lib/questionDedupe');
      const [reflowed] = await conn.query(
        'SELECT id, source_paper_seq FROM question WHERE source_paper_id = ?', [id]);
      const bySeq = new Map();
      for (const r of reflowed) bySeq.set(Number(r.source_paper_seq), r.id);
      const missing = qs.filter((q) => !bySeq.has(Number(q.seq)));
      if (missing.length) {
        const fps = missing.map((q) => buildFingerprint({
          qtype: q.qtype, stem: q.stem, options: safeJson(q.options_json, []), answer: q.answer,
        }));
        const [found] = await conn.query(
          `SELECT id, fingerprint FROM question WHERE fingerprint IN (${fps.map(() => '?').join(',')})`,
          fps);
        const byFp = new Map(found.map((r) => [r.fingerprint, r.id]));
        missing.forEach((q, i) => {
          const qid = byFp.get(fps[i]);
          if (qid) bySeq.set(Number(q.seq), qid);
        });
      }
      for (const q of qs) q.question_id = bySeq.get(Number(q.seq)) ?? null;
    } catch (e) {
      console.error('[exam] 题目 question_id 映射失败:', e.message);
      for (const q of qs) q.question_id = null;
    }

    return { paper, questions: qs, materialGroups: mgs };
  });

  if (!data) return res.status(404).json({ error: '试卷不存在' });
  if (data.forbidden) return res.status(400).json({ error: '该试卷尚未完成拆题，暂不可作答', parse_status: data.parse_status });

  // ── 材料分组：把「一篇材料带一串题」识别出来 ──────────────────────────
  //
  // 第一优先级：**材料图归属**。材料图文件名 `q<篇首题号>-m*.png` 里的题号就是
  // 这篇材料的篇首，篇首之后到下一个篇首之前的题都属于这一篇。
  //   实测（粉笔第 40 季 34 页卷）p29 水利→111-115、p31 数字阅读→116-125、
  //   p33 城市供水→126-130，与 PDF 实际排版一致。
  // 为什么必须以材料图为准：上游 passage 抽取会串篇 —— 118-125 的 passage
  // 实际是「答题说明 + 上一篇水利材料」，用它分组会把材料显示错。
  //
  // 第二优先级：**passage 前缀**（给没有材料图的文字材料用，如逻辑判断
  // 106-110 共用同一段题干）。比较前抹掉空白：111/112 的 passage 带换行符而
  // 113-115 不带，不归一化前 80 字仍不相等。
  const MIN_PASSAGE_CHARS = 60;
  const PASSAGE_PREFIX = 80;
  const normPrefix = (s) => String(s || '').replace(/\s+/g, '').slice(0, PASSAGE_PREFIX);

  const groups = new Map();   // 组首题号 → { id, seqs:Set, images:Set, passage }
  const ensureGroup = (id) => {
    if (!groups.has(id)) groups.set(id, { id, seqs: new Set(), images: new Set(), passage: '' });
    return groups.get(id);
  };

  // ⓪ 显式材料题组（智能组卷保存的 1 个父级大题 + 5 道小题）：
  // 直接按 material_group_id 还原，优先级高于任何猜测式分组。
  // 父级大题的材料正文/图表只在本组第一题下发一次。
  const explicitSeqs = new Set();
  for (const mg of data.materialGroups || []) {
    const children = data.questions.filter((q) => Number(q.material_group_id) === Number(mg.id));
    if (!children.length) continue;
    const g = ensureGroup(children[0].seq);
    g.passage = String(mg.passage || '');
    g.title = mg.title || '';
    for (const f of String(mg.images || '').split(',').filter(Boolean)) g.images.add(f);
    for (const q of children) { g.seqs.add(q.seq); explicitSeqs.add(q.seq); }
  }

  // ① 材料图分组
  let curMatHead = null;
  for (const q of data.questions) {
    if (explicitSeqs.has(q.seq)) continue;
    const files = String(q.image_url || '').split(',').filter(Boolean);
    const matFiles = files.filter((f) => /-m/.test(f));
    if (matFiles.length) {
      const m = matFiles[0].match(/^q(\d+)-m/);
      if (m) curMatHead = Number(m[1]);
    }
    if (curMatHead == null) continue;
    const g = ensureGroup(curMatHead);
    g.seqs.add(q.seq);
    for (const f of matFiles) g.images.add(f);
  }
  // 组内第一道有 passage 的题，其 passage 作为该篇的材料正文
  for (const q of data.questions) {
    for (const g of groups.values()) {
      if (!g.seqs.has(q.seq) || g.passage) continue;
      const p = String(q.passage || '').trim();
      if (p.length >= MIN_PASSAGE_CHARS) g.passage = p;
    }
  }

  // ② 文字材料分组：连续 + passage 前缀相同（未被材料图分组的题）
  let curGroup = null;
  for (const q of data.questions) {
    if (explicitSeqs.has(q.seq)) { curGroup = null; continue; }
    const p = String(q.passage || '').trim();
    if (p.length < MIN_PASSAGE_CHARS) { curGroup = null; continue; }
    const inMatGroup = [...groups.values()].some((g) => g.seqs.has(q.seq));
    if (inMatGroup) { curGroup = null; continue; }
    if (curGroup && normPrefix(p) === normPrefix(curGroup.passage)) {
      curGroup.seqs.add(q.seq);
    } else {
      curGroup = { id: q.seq, passage: p, seqs: new Set([q.seq]), images: new Set() };
      groups.set(q.seq, curGroup);
    }
  }

  // 组内只有 1 题 → 不是材料组（passage 多半是上游误挂的题干片段）
  for (const [id, g] of [...groups]) {
    if (g.seqs.size < 2) groups.delete(id);
  }

  const groupOfSeq = new Map();
  for (const g of groups.values()) for (const s of g.seqs) groupOfSeq.set(s, g);
  const paperId = data.paper.id;

  // 按分区聚合，保持原卷顺序。
  // 共享材料（资料分析一篇材料一串题、逻辑判断一组共用题干）：材料正文与材料图
  // 只在**本组第一题**下发一次，后续题只带自己的题干和选项，避免整页反复重印同一段材料。
  const sectionMap = new Map();
  for (const q of data.questions) {
    const name = q.section || '未分区';
    if (!sectionMap.has(name)) sectionMap.set(name, []);
    // 题目区域截图（原 PDF 裁剪），多张用逗号分隔。
    // 路径不带 /api 前缀：前端会拼上 axios 的 baseURL，避免出现 /api/api/...
    const files = String(q.image_url || '').split(',').filter(Boolean);
    // 带 `-m` 后缀的是所属材料段的共享图（统计图表），其余是本题自身的区域截图
    const matFiles = files.filter((f) => /-m(-\d+)?\./.test(f));
    const ownFiles = files.filter((f) => !/-m(-\d+)?\./.test(f));
    const rawOpts = safeJson(q.options_json, []);
    // 部分题（规则兜底构题的那批）题干里还粘着 A./B./C./D. 选项行：
    // 页面会「题干读一遍、下面又渲染一遍」。这里在读取时剥离；若已存选项是占位符，
    // 则把题干里解析出的真实选项补上，避免用户看到四个无意义的占位符。
    const fixed = normalizeQuestionStem({ stem: q.stem, options: rawOpts });
    const opts = fixed.options;
    const passage = String(q.passage || '').trim();

    const group = groupOfSeq.get(q.seq) || null;
    const isGroupHead = group && group.id === q.seq;
    // 组首题展示材料正文与材料图；续题不重复展示，但要能折叠引用
    const showPassage = group && isGroupHead ? group.passage : null;
    const showMatFiles = group && isGroupHead
      ? [...group.images]
      : (group ? [] : matFiles);
    const materialRef = group && !isGroupHead
      ? {
        seq: group.id,
        passage: group.passage,
        images: [...group.images].map((f) => `/exam-papers/images/${paperId}/${f}`),
      }
      : null;
    const groupId = group ? group.id : null;

    // 不是每题都需要配图：纯文本题的区域截图只是把题干重拍一遍，
    // 前端已用文本渲染同样内容，再插图既冗余又拖慢加载。
    // 判定详见 lib/questionImage.js（仅影响显示，不删除资源）。
    // 共享材料组内的题：题干和选项已是文字，自身区域截图同样重复 —— 一律折叠，
    // 除非这题的选项本身就是图形（image-options）或标准图形句式（figure-stem）。
    // 材料组的图表由本组第一题统一展示一次。
    const need = classifyImageNeed(
      { section: name, stem: fixed.stem, options: opts, passage: showPassage },
      ownFiles
    );
    // 真正属于材料组的题（组内 ≥2 题）才折叠自身截图；
    // 单题被上游误挂的 passage 不算材料组，它的截图仍按普通规则处理。
    const inMaterialGroup = Boolean(group);
    const keepOwn = ['image-options', 'figure-stem'].includes(need.reason);
    const ownNeeded = need.needed && !(inMaterialGroup && !keepOwn);
    const outFiles = [...ownFiles, ...showMatFiles];
    sectionMap.get(name).push({
      seq: q.seq,
      id: q.id,
      // 对应 question.id（收藏等按题维度的能力用）；未回流/映射失败时为 null
      question_id: q.question_id ?? null,
      qtype: q.qtype,
      difficulty: q.difficulty,
      passage: showPassage,
      // 父级大题标题（材料一…），仅组首题下发
      materialTitle: group && isGroupHead ? (group.title || null) : null,
      // 同一材料的后续题保留材料引用，前端折叠展示（默认不占版面）
      materialRef,
      // 材料组 id（组首题号）；null 表示该题不属于任何材料组
      materialGroup: groupId,
      stem: fixed.stem,
      options: opts,
      images: outFiles.map((f) => `/exam-papers/images/${data.paper.id}/${f}`),
      // true → 内联展示；false → 折叠在「查看原卷截图」里
      imageNeeded: ownNeeded || showMatFiles.length > 0,
      imageReason: showMatFiles.length > 0
        ? 'material-figure'
        : (ownNeeded ? need.reason : 'material-group'),
    });
  }
  const sections = Array.from(sectionMap.entries()).map(([name, questions]) => ({
    name,
    count: questions.length,
    questions,
  }));

  return res.json({
    // 考场模式倒计时时长（分钟），前端据此初始化倒计时
    duration_minutes: EXAM_DURATION_MINUTES,
    paper: {
      id: data.paper.id,
      title: data.paper.title,
      year: data.paper.year,
      source: data.paper.source,
      origin: data.paper.origin,
      parse_status: data.paper.parse_status,
    },
    sections,
    total: data.questions.length,
  });
}));

// POST /api/exam-papers/:id/submit —— 提交答案并判分
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const answers = req.body && req.body.answers;
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: '缺少作答数据' });
  const durationSec = Math.max(0, Number(req.body.duration_sec) || 0);
  // 逐题用时（可选）：key 为 seq（字符串或数字），value 为非负整数秒。
  // 未传或值非法一律按 0 处理，保证旧调用方（不带 timings）向后兼容。
  const timingsRaw = req.body && req.body.timings;
  const timings = (timingsRaw && typeof timingsRaw === 'object' && !Array.isArray(timingsRaw))
    ? timingsRaw : {};
  const timeOf = (seq) => {
    const v = timings[String(seq)] ?? timings[seq];
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  // 交卷幂等键（可选）：同一交卷动作的重复请求（重复点击 / 刷新 / 网络重试）
  // 只落一条记录。去重维度是 (user_id, submit_key)，不按 (user_id, paper_id)，
  // 因此换一个新 submitKey 仍可主动重做同一张卷。不带键保持原有行为向后兼容。
  const rawSubmitKey = req.body && req.body.submitKey;
  const submitKey = (typeof rawSubmitKey === 'string' && rawSubmitKey.trim().length > 0)
    ? rawSubmitKey.slice(0, 64) : null;

  // 注意：withConnection 透传 conn.query 的返回值，需解构出结果行数组
  const [rows] = await withConnection((conn) => conn.query(
    `SELECT q.seq, q.section, q.qtype, q.difficulty, q.stem, q.options_json, q.answer, q.explanation, p.is_hidden
     FROM exam_paper_question q JOIN exam_paper p ON p.id = q.exam_paper_id
     WHERE q.exam_paper_id = ? ORDER BY q.seq`,
    [id]
  ));
  if (rows.length === 0) return res.status(404).json({ error: '该试卷没有可判分的题目' });
  if (rows[0].is_hidden && (!req.user || req.user.role !== 'admin')) {
    return res.status(403).json({ error: '该试卷已下架，无法作答' });
  }

  let correct = 0;
  const results = rows.map((q) => {
    const your = answers[String(q.seq)] ?? answers[q.seq] ?? null;
    const right = isAnswerRight(your, q.answer);
    if (right) correct++;
    return {
      seq: q.seq,
      section: q.section,
      qtype: q.qtype,
      difficulty: q.difficulty,
      stem: q.stem,
      options: safeJson(q.options_json, []),
      yourAnswer: your || null,
      answer: q.answer,
      correct: right,
      answered: !!your,
      explanation: q.explanation || null,
      time_sec: timeOf(q.seq),
    };
  });

  const total = rows.length;
  const score = total > 0 ? Math.round((correct / total) * 100) : 0;

  // 分模块统计
  const bySection = {};
  for (const r of results) {
    const k = r.section || '未分区';
    if (!bySection[k]) bySection[k] = { total: 0, correct: 0, time_sec: 0 };
    bySection[k].total++;
    if (r.correct) bySection[k].correct++;
    bySection[k].time_sec += r.time_sec;
  }

  // ── 统一答题记录：整卷成绩写进 practice_session / practice_answer ──
  // 参考粉笔：做过的真题与专项练习混排在「练习历史」里，统计一起算。
  // 题目映射 (paper, seq) → question.id：优先按回流标记，
  // 回流时因指纹重复被跳过的题按 fingerprint 找回（同一道题的规范副本）。
  let sessionId = null;
  let duplicate = false;
  try {
    const { buildFingerprint } = require('../lib/questionDedupe');
    const [reflowed] = await withConnection((conn) => conn.query(
      'SELECT id, source_paper_seq FROM question WHERE source_paper_id = ?', [id]));
    const bySeq = new Map(reflowed.map((r) => [Number(r.source_paper_seq), r.id]));
    const missing = rows.filter((q) => !bySeq.has(q.seq));
    if (missing.length) {
      const fps = missing.map((q) => buildFingerprint({
        qtype: q.qtype, stem: q.stem, options: safeJson(q.options_json, []), answer: q.answer,
      }));
      const [found] = await withConnection((conn) => conn.query(
        `SELECT id, fingerprint FROM question WHERE fingerprint IN (${fps.map(() => '?').join(',')})`, fps));
      const byFp = new Map(found.map((r) => [r.fingerprint, r.id]));
      missing.forEach((q, i) => { if (byFp.get(fps[i])) bySeq.set(q.seq, byFp.get(fps[i])); });
    }
    const mapped = rows.filter((q) => bySeq.has(q.seq));
    if (mapped.length) {
      const written = await withConnection(async (conn) => {
        const [q0] = await conn.query('SELECT subject_id FROM question WHERE id = ?', [bySeq.get(mapped[0].seq)]);
        const subjectId = (q0[0] && q0[0].subject_id) || 1;
        const [paperRow] = await conn.query('SELECT title FROM exam_paper WHERE id = ?', [id]);
        const paperTitle = (paperRow[0] && paperRow[0].title) || `整卷 #${id}`;

        let mCorrect = 0;
        const answerRows = [];
        const answerParams = [];
        const wrongIds = [];
        const savedAnswers = {};
        const questionIds = [];
        for (const q of mapped) {
          const your = answers[String(q.seq)] ?? answers[q.seq] ?? null;
          const right = isAnswerRight(your, q.answer);
          const qid = bySeq.get(q.seq);
          questionIds.push(qid);
          if (right) mCorrect++;
          else wrongIds.push(qid);
          // 答案按 question id 存（与普通练习的 meta 结构一致，结果页复用同一渲染）
          if (your) savedAnswers[qid] = your;
          answerRows.push('(?,?,?,?,?)');
          // 第 i 行的 5 个参数在 [i*5, i*5+5)：末列 time_spent_sec 写入该题用时
          answerParams.push(null, qid, your || '', right ? 1 : 0, timeOf(q.seq));
        }
        const mScore = mapped.length > 0 ? Number(((mCorrect / mapped.length) * 100).toFixed(2)) : 0;
        const now = Date.now();
        const fmt = (ts) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
        const meta = {
          exam: true,
          paper_id: id,
          paper_title: paperTitle,
          question_ids: questionIds,
          answers: savedAnswers,
          elapsed_sec: durationSec,
          full_total: total,       // 整卷口径（含个别未回流题）
          full_correct: correct,
        };

        // 列名 / 占位符按白名单拼装，值一律参数绑定。
        // 只有带 submitKey 时才写 submit_key 列：不带键的旧调用方即使迁移未执行也照常工作。
        const cols = ['user_id', 'subject_id', 'mode', 'total', 'correct', 'duration_sec', 'score',
          'started_at', 'finished_at', 'meta_json'];
        const vals = [req.user.userId, subjectId, 'exam_paper', mapped.length, mCorrect, durationSec,
          mScore, fmt(now - durationSec * 1000), fmt(now), JSON.stringify(meta)];
        if (submitKey) { cols.push('submit_key'); vals.push(submitKey); }
        cols.push('status'); vals.push('completed');
        const placeholders = cols.map(() => '?').join(',');

        await conn.beginTransaction();
        try {
          let sid;
          try {
            const [sr] = await conn.query(
              `INSERT INTO practice_session (${cols.join(',')}) VALUES (${placeholders})`, vals);
            sid = sr.insertId;
          } catch (insErr) {
            // 唯一键冲突 = 同一交卷动作的重复请求：回滚、不写任何记录，
            // 取出已存在的 session id，判分结果（纯内存计算）照常返回。
            if (submitKey && (insErr.code === 'ER_DUP_ENTRY' || insErr.errno === 1062)) {
              await conn.rollback();
              const [existing] = await conn.query(
                'SELECT id FROM practice_session WHERE user_id = ? AND submit_key = ?',
                [req.user.userId, submitKey]);
              return { sessionId: existing.length ? existing[0].id : null, duplicate: true };
            }
            throw insErr;
          }
          // answerParams 是扁平数组：第 i 行的参数在 [i*5, i*5+5)，行内首列是 session_id
          for (let i = 0; i < mapped.length; i++) answerParams[i * 5] = sid;
          await conn.query(
            `INSERT INTO practice_answer (session_id, question_id, user_answer, is_correct, time_spent_sec)
             VALUES ${answerRows.join(',')}`,
            answerParams
          );
          if (wrongIds.length) {
            // 与 /practice/submit 同口径：首次答错 +15 天；重复答错按更新后的
            // wrong_count 定复习周期（>=3 高频 +1 天 / =2 中频 +7 天 / 其余 +15 天）。
            // next_review_at 赋值放在 wrong_count 之前，用 (wrong_count + 1) 引用更新后错次。
            const ph = wrongIds.map(() => '(?, ?, 1, 0, DATE_ADD(NOW(), INTERVAL 15 DAY))').join(',');
            const wp = [];
            for (const qid of wrongIds) wp.push(req.user.userId, qid);
            await conn.query(
              `INSERT INTO wrong_book (user_id, question_id, wrong_count, mastered, next_review_at) VALUES ${ph}
               ON DUPLICATE KEY UPDATE
                 next_review_at = CASE
                   WHEN (wrong_count + 1) >= 3 THEN DATE_ADD(NOW(), INTERVAL 1 DAY)
                   WHEN (wrong_count + 1) = 2 THEN DATE_ADD(NOW(), INTERVAL 7 DAY)
                   ELSE DATE_ADD(NOW(), INTERVAL 15 DAY)
                 END,
                 wrong_count = wrong_count + 1,
                 mastered = 0`,
              wp
            );
          }
          await conn.commit();
          return { sessionId: sid, duplicate: false };
        } catch (err) {
          await conn.rollback();
          throw err;
        }
      });
      sessionId = written.sessionId;
      duplicate = written.duplicate;
    }
  } catch (e) {
    // 写库失败不再静默成功：明确返回 5xx，让前端提示用户重试。
    // 判分是纯内存计算，配合 submitKey 重试不会产生重复记录。
    console.error('[exam] 写入统一答题记录失败:', e.message);
    return res.status(500).json({ error: '成绩已判出，但保存答题记录失败，请稍后重试（重试不会产生重复记录）' });
  }

  return res.json({
    paperId: id,
    total,
    correct,
    wrong: total - correct,
    unanswered: results.filter((r) => !r.answered).length,
    score,
    bySection,
    results,
    sessionId,
    duplicate,
  });
}));

module.exports = router;
