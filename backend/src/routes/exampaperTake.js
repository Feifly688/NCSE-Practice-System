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
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS total FROM exam_paper WHERE parse_status IN ('success','partial')"
    );
    const [rows] = await conn.query(
      `SELECT id, title, year, source, origin, parsed_count, parse_status, created_at
       FROM exam_paper WHERE parse_status IN ('success','partial')
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    return { papers: rows, total: countRows[0].total };
  });

  return res.json({ ...data, page, pageSize });
}));

// GET /api/exam-papers/:id —— 整卷结构（不含答案与解析）
router.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const data = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT id, title, year, source, origin, raw_text, parsed_count, parse_status FROM exam_paper WHERE id = ?',
      [id]
    );
    const paper = rows[0] || null;
    if (!paper) return null;
    if (!['success', 'partial'].includes(paper.parse_status)) {
      return { forbidden: true, parse_status: paper.parse_status };
    }
    const [qs] = await conn.query(
      `SELECT id, seq, section, qtype, difficulty, passage, stem, options_json, image_url
       FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
      [id]
    );
    return { paper, questions: qs };
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

  // ① 材料图分组
  let curMatHead = null;
  for (const q of data.questions) {
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
    // `-m.` 前缀的是所属材料段的共享图（统计图表），其余是本题自身的区域截图
    const matFiles = files.filter((f) => /-m\./.test(f));
    const ownFiles = files.filter((f) => !/-m\./.test(f));
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
      qtype: q.qtype,
      difficulty: q.difficulty,
      passage: showPassage,
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

  // 注意：withConnection 透传 conn.query 的返回值，需解构出结果行数组
  const [rows] = await withConnection((conn) => conn.query(
    `SELECT seq, section, qtype, difficulty, stem, options_json, answer, explanation
     FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
    [id]
  ));
  if (rows.length === 0) return res.status(404).json({ error: '该试卷没有可判分的题目' });

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
    };
  });

  const total = rows.length;
  const score = total > 0 ? Math.round((correct / total) * 100) : 0;

  // 分模块统计
  const bySection = {};
  for (const r of results) {
    const k = r.section || '未分区';
    if (!bySection[k]) bySection[k] = { total: 0, correct: 0 };
    bySection[k].total++;
    if (r.correct) bySection[k].correct++;
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
  });
}));

module.exports = router;
