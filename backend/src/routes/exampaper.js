/**
 * 真题（Exam Paper）管理 —— 入库流水线与整卷拆分。
 *
 * 流水线（联网爬取与 PDF 上传共用同一套）：
 *   获取原文 → 文本提取/质量校验 → 保存整卷（exam_paper）→ 自动触发 AI 拆题
 *   → 分批拆题（含重试与降级）→ 结果写入 exam_paper_question（整卷形态）
 *   → 管理员确认后按模块去重入库 question（题库形态）
 *
 * 两种存储形态：
 *   a) 完整真题试卷：exam_paper.raw_text + exam_paper_question（保持原卷顺序与分区）
 *   b) 分模块去重题库：question 表（指纹 + 文本相似度 + 题型/选项/答案特征去重）
 *
 * 拆题不再同步阻塞 HTTP：入库后立刻返回，前端轮询 /:id/parse-status。
 * 失败会写入 parse_status / parse_error，并提供重新拆题入口（/:id/reparse）。
 */
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { extractPdfText } = require('../lib/pdfText');
const { callChat } = require('../lib/aiClient');
const {
  splitIntoChunks, parseChunk, runPool, dedupeList, normalizeQuestion,
} = require('../lib/paperParser');
const { buildFingerprint, findDuplicate } = require('../lib/questionDedupe');

const router = express.Router();

// PDF 上传：内存暂存，限制 30MB，仅接受 PDF
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = /pdf$/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
    cb(isPdf ? null : new Error('仅支持 PDF 文件'), isPdf);
  },
});

router.use(requireAuth, requireAdmin);

/** 模块 → 科目 slug（拆分后归类到题库） */
function moduleToSubject(moduleName) {
  const m = String(moduleName || '');
  if (m.includes('政治') || m.includes('常识')) return 'politics';
  return 'verbal_comprehension';
}

/** SSRF 防护：仅允许公网 http(s)，拒绝内网地址 */
function isPublicUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith('.internal') || host.endsWith('.local')) return false;
    return true;
  } catch {
    return false;
  }
}

/** 抓取试卷页正文 */
async function crawlText(url) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 30000,
  });
  const $ = cheerio.load(data);
  $('script, style, nav, header, footer, iframe, noscript').remove();
  const title = ($('h1').first().text() || $('title').text() || '').trim();
  const paragraphs = $('p, div.article p, div.content p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 5);
  const text = paragraphs.length >= 3
    ? paragraphs.join('\n')
    : $('body').text().replace(/\s{2,}/g, '\n').trim();
  return { title, text };
}

// ── 拆题任务 ────────────────────────────────────────
/**
 * 执行整卷拆题（异步任务）：分批调用 AI → 写入 exam_paper_question → 更新状态。
 * 不抛异常（内部捕获并记录到 parse_error）。
 */
async function runParseJob(paperId) {
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, title, raw_text FROM exam_paper WHERE id = ?', [paperId]);
    return rows[0] || null;
  }).catch((err) => {
    console.error('[exam] 读取试卷失败:', err.message);
    return null;
  });

  if (!paper) {
    console.error('[exam] 拆题任务中止：试卷不存在 id=' + paperId);
    return;
  }

  const rawText = String(paper.raw_text || '').trim();
  if (rawText.length < 50) {
    await updateParseState(paperId, {
      parse_status: 'failed',
      parse_error: '整卷文本为空或过短，无法拆题',
      parsed_count: 0,
    });
    return;
  }

  await updateParseState(paperId, { parse_status: 'parsing', parse_error: null });
  console.log(`[exam] 开始拆题 paper=${paperId} 文本长度=${rawText.length}`);

  const chunks = splitIntoChunks(rawText);
  console.log(`[exam] paper=${paperId} 切分为 ${chunks.length} 个片段`);

  const started = Date.now();
  const results = await runPool(
    chunks.map((c, i) => async () => {
      const t0 = Date.now();
      const r = await parseChunk(c, { paperTitle: paper.title });
      console.log(
        `[exam] paper=${paperId} 第 ${i + 1}/${chunks.length} 片（${c.section}）完成：` +
        `${r.questions.length} 题 / ${((Date.now() - t0) / 1000).toFixed(1)}s / ` +
        `降级=${r.degraded || '-'}${r.error ? ' / 错误=' + r.error.slice(0, 80) : ''}`
      );
      return r;
    }),
    3
  );

  const questions = [];
  const errors = [];
  let salvagedChunks = 0;
  results.forEach((r, i) => {
    if (r && Array.isArray(r.questions)) questions.push(...r.questions);
    if (r && r.error) {
      errors.push(`第${i + 1}片：${r.error}`);
      console.error(`[exam] paper=${paperId} 第 ${i + 1} 片拆题问题: ${r.error}`);
    }
    if (r && (r.degraded === 'salvaged' || r.degraded === 'split-retry')) salvagedChunks++;
  });

  const deduped = dedupeList(questions).map((q, i) => ({
    ...q,
    seq: i + 1,
    section: q.module || '未分区',
  }));

  // 写入整卷题目（先清后写，保证重拆结果干净）
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [paperId]);
    for (const q of deduped) {
      await conn.query(
        `INSERT INTO exam_paper_question
         (exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json, answer, explanation, fingerprint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          paperId, q.seq, q.section, q.qtype, q.difficulty,
          q.passage || null, q.stem, JSON.stringify(q.options), q.answer, q.explanation || null,
          q.fingerprint || buildFingerprint(q),
        ]
      );
    }
  }).catch((err) => {
    console.error('[exam] 写入整卷题目失败:', err.message);
    errors.push('写入整卷题目失败：' + err.message);
  });

  const cost = ((Date.now() - started) / 1000).toFixed(1);
  // 只有「有报错」的片段才算失败；封面/注意事项等本身无题目的片段属正常
  const failedChunks = results.filter((r) => r && r.error && r.degraded === 'failed').length;

  let parseStatus = 'success';
  if (deduped.length === 0) parseStatus = 'failed';
  else if (failedChunks > 0 || salvagedChunks > 0) parseStatus = 'partial';

  let parseError = null;
  if (errors.length > 0) {
    parseError = `共 ${chunks.length} 片，${failedChunks} 片失败、${salvagedChunks} 片降级；首条原因：${errors[0]}`;
  } else if (parseStatus === 'partial') {
    // 无硬错误但有片段降级（输出截断后抢救/重试），给出可读说明而非留空
    parseError = `共 ${chunks.length} 片，其中 ${salvagedChunks} 片输出被截断后已自动降级重试，已保留完整题目；可点「重新拆题」再跑一次以补全。`;
  }

  await updateParseState(paperId, {
    parse_status: parseStatus,
    parse_error: parseError ? parseError.slice(0, 500) : null,
    parsed_count: deduped.length,
  });

  console.log(
    `[exam] 拆题完成 paper=${paperId} 题目=${deduped.length} 状态=${parseStatus} 耗时=${cost}s`
  );
}

async function updateParseState(paperId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `\`${k}\` = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  await withConnection(async (conn) => {
    await conn.query(`UPDATE exam_paper SET ${setSql}, last_parse_at = NOW() WHERE id = ?`, [...values, paperId]);
  }).catch((err) => console.error('[exam] 更新拆题状态失败:', err.message));
}

/** 保存试卷并异步触发拆题（上传与爬取共用） */
async function ingestPaper({ title, year, source, sourceUrl, fileName, origin, text, userId }) {
  const id = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO exam_paper (title, year, source, source_url, file_name, origin, raw_text, parse_status, creator_user_id)
       VALUES (?,?,?,?,?,?,?,'pending',?)`,
      [title, year || null, source || null, sourceUrl || null, fileName || null, origin, text, userId]
    );
    return r.insertId;
  });
  // 异步触发，不阻塞响应
  runParseJob(id).catch((err) => console.error('[exam] 拆题任务异常:', err.message));
  return id;
}

// ── 1. 上传 PDF 真题 ──────────────────────────────────
router.post('/upload', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择 PDF 文件' });
  const title = String(req.body.title || req.file.originalname || '').replace(/\.pdf$/i, '').trim();
  if (!title) return res.status(400).json({ error: '请填写试卷标题' });

  const extracted = await extractPdfText(req.file.buffer);
  if (!extracted.ok) {
    // 文本提取失败：给出明确可读原因（扫描件 / 损坏 / OCR 依赖缺失等）
    return res.status(400).json({
      error: extracted.error || '未能从 PDF 提取到有效文本',
      detail: {
        pages: extracted.pages ?? null,
        method: extracted.method || null,
        quality: extracted.quality || null,
      },
    });
  }

  const id = await ingestPaper({
    title,
    year: Number(req.body.year) || null,
    source: '手动上传',
    fileName: req.file.originalname,
    origin: 'upload',
    text: extracted.text,
    userId: req.user.userId,
  });

  return res.json({
    id,
    title,
    textLength: extracted.text.length,
    pages: extracted.pages,
    method: extracted.method,
    warning: extracted.warning || null,
    parse_status: 'pending',
    message: '已保存整卷并开始 AI 拆题',
  });
}));

// ── 2. 联网爬取真题 ───────────────────────────────────
router.post('/crawl', asyncHandler(async (req, res) => {
  const { url, title, year } = req.body;
  if (!url || !isPublicUrl(url)) return res.status(400).json({ error: '无效的或非公网的 URL' });

  let crawled;
  try {
    crawled = await crawlText(url);
  } catch (err) {
    return res.status(400).json({ error: '抓取失败：' + err.message });
  }
  if (!crawled.text || crawled.text.length < 50) return res.status(400).json({ error: '抓取内容为空' });

  const paperTitle = String(title || crawled.title || '').trim() || '未命名真题';
  const id = await ingestPaper({
    title: paperTitle,
    year: Number(year) || null,
    source: new URL(url).hostname,
    sourceUrl: url,
    origin: 'crawl',
    text: crawled.text,
    userId: req.user.userId,
  });

  return res.json({
    id,
    title: paperTitle,
    textLength: crawled.text.length,
    parse_status: 'pending',
    message: '已保存整卷并开始 AI 拆题',
  });
}));

// ── 3. 拆题状态（前端轮询）──────────────────────────
router.get('/:id/parse-status', asyncHandler(async (req, res) => {
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id, title, parse_status, parse_error, parsed_count, last_parse_at, status, question_count
       FROM exam_paper WHERE id = ?`,
      [req.params.id]
    );
    return rows[0] || null;
  });
  if (!paper) return res.status(404).json({ error: '试卷不存在' });

  const [sections] = await withConnection((conn) => conn.query(
    `SELECT section AS name, COUNT(*) AS count FROM exam_paper_question
     WHERE exam_paper_id = ? GROUP BY section ORDER BY MIN(seq)`,
    [paper.id]
  ));

  return res.json({
    paperId: paper.id,
    parse_status: paper.parse_status,
    parse_error: paper.parse_error,
    parsed_count: paper.parsed_count,
    last_parse_at: paper.last_parse_at,
    question_count: paper.question_count,
    status: paper.status,
    sections,
  });
}));

// ── 4. 触发 / 重新拆题 ────────────────────────────────
router.post('/:id/parse', asyncHandler(async (req, res) => {
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, parse_status FROM exam_paper WHERE id = ?', [req.params.id]);
    return rows[0] || null;
  });
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  if (paper.parse_status === 'parsing') return res.json({ started: false, message: '正在拆题中，请稍候' });

  runParseJob(paper.id).catch((err) => console.error('[exam] 拆题任务异常:', err.message));
  return res.json({ started: true, parse_status: 'parsing' });
}));

router.post('/:id/reparse', asyncHandler(async (req, res) => {
  const affected = await withConnection(async (conn) => {
    const [r] = await conn.query(
      "UPDATE exam_paper SET parse_status = 'pending', parse_error = NULL WHERE id = ?",
      [req.params.id]
    );
    return r.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '试卷不存在' });

  runParseJob(req.params.id).catch((err) => console.error('[exam] 拆题任务异常:', err.message));
  return res.json({ started: true, parse_status: 'parsing' });
}));

// ── 5. 整卷题目（拆分结果预览）─────────────────────────
router.get('/:id/questions', asyncHandler(async (req, res) => {
  // 注意：withConnection 透传 conn.query 的返回值，需解构出结果行数组
  const [rows] = await withConnection((conn) => conn.query(
    `SELECT id, seq, section, qtype, difficulty, passage, stem, options_json, answer, explanation, fingerprint
     FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
    [req.params.id]
  ));
  const questions = rows.map((r) => ({
    ...r,
    options: safeJson(r.options_json, []),
  }));
  return res.json({ paperId: Number(req.params.id), questions, total: questions.length });
}));

/**
 * 解析选项字段。
 * 注意：mysql2 会把 JSON 列直接解析为数组，TEXT 列则是字符串，
 * 因此两种形态都要兼容，避免 JSON.parse(数组) 抛错导致选项丢失。
 */
function safeJson(v, fallback) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return v;
  try {
    const p = JSON.parse(v);
    return p ?? fallback;
  } catch {
    return fallback;
  }
}

// ── 6. 确认入库：分模块 + 双重去重（指纹 + 相似度/特征）──
router.post('/:id/confirm', asyncHandler(async (req, res) => {
  const list = req.body.questions;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: '没有要入库的题目' });

  const result = await withConnection(async (conn) => {
    const [paperRows] = await conn.query('SELECT id, title FROM exam_paper WHERE id = ?', [req.params.id]);
    const paper = paperRows[0];
    if (!paper) throw Object.assign(new Error('试卷不存在'), { status: 404 });

    // 候选题目（用于相似度判重）：取题库中较新的题目，避免全表比对过重
    const [candidateRows] = await conn.query(
      `SELECT id, qtype, stem, options_json, answer, fingerprint FROM question
       ORDER BY id DESC LIMIT 5000`
    );
    const candidates = candidateRows.map((r) => ({
      id: r.id,
      qtype: r.qtype,
      stem: r.stem,
      options: safeJson(r.options_json, []),
      answer: r.answer,
      fingerprint: r.fingerprint,
    }));

    let inserted = 0;
    let duplicated = 0;
    const byModule = {};
    const duplicateDetails = [];

    for (const raw of list) {
      const q = normalizeQuestion(raw);
      if (!q) continue;
      const fp = buildFingerprint(q);

      const [exact] = await conn.query('SELECT id FROM question WHERE fingerprint = ?', [fp]);
      if (exact.length > 0) {
        duplicated++;
        duplicateDetails.push({ stem: q.stem.slice(0, 40), reason: 'exact', score: 1 });
        continue;
      }

      const dup = findDuplicate(q, candidates, { threshold: 0.9 });
      if (dup) {
        duplicated++;
        duplicateDetails.push({ stem: q.stem.slice(0, 40), reason: dup.reason, score: Number(dup.score.toFixed(2)) });
        continue;
      }

      const slug = raw.subject_slug || moduleToSubject(q.module);
      const [subjects] = await conn.query('SELECT id FROM subject WHERE slug = ?', [slug]);
      const subjectId = subjects[0]?.id || 1;

      await conn.query(
        `INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation,
         source_exam, exam_paper_id, fingerprint, creator_user_id, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending_review')`,
        [
          subjectId,
          q.qtype,
          q.difficulty,
          q.passage || null,
          q.stem.slice(0, 1024),
          JSON.stringify(q.options),
          q.answer,
          q.explanation || '',
          paper.title.slice(0, 128),
          paper.id,
          fp,
          req.user.userId,
        ]
      );
      inserted++;

      // 新入库题目加入候选集，避免同批内互相重复
      candidates.push({ id: null, qtype: q.qtype, stem: q.stem, options: q.options, answer: q.answer, fingerprint: fp });

      const modName = q.module || '未分类';
      byModule[modName] = (byModule[modName] || 0) + 1;
    }

    await conn.query(
      `UPDATE exam_paper SET question_count = question_count + ?, status = 'parsed' WHERE id = ?`,
      [inserted, paper.id]
    );

    return { inserted, duplicated, byModule, duplicateDetails: duplicateDetails.slice(0, 20) };
  });

  return res.json(result);
}));

// ── 7. 列表 / 详情 / 删除 ─────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM exam_paper');
    const [rows] = await conn.query(
      `SELECT id, title, year, source, source_url, file_name, origin, question_count,
              status, parse_status, parse_error, parsed_count, last_parse_at, created_at
       FROM exam_paper ORDER BY id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    return { papers: rows, total: countRows[0].total };
  });

  return res.json({ ...data, page, pageSize });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const data = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM exam_paper WHERE id = ?', [req.params.id]);
    const paper = rows[0] || null;
    if (!paper) return null;
    const [qs] = await conn.query(
      `SELECT q.id, q.qtype, q.difficulty, q.stem, q.answer, q.status, q.exam_paper_id, s.name AS subject_name
       FROM question q LEFT JOIN subject s ON q.subject_id = s.id
       WHERE q.exam_paper_id = ? ORDER BY q.id`,
      [paper.id]
    );
    const [epq] = await conn.query(
      `SELECT seq, section, qtype, stem FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
      [paper.id]
    );
    return { paper, questions: qs, paperQuestions: epq };
  });
  if (!data) return res.status(404).json({ error: '试卷不存在' });
  return res.json(data);
}));

// 删除试卷：整卷题目随外键级联删除；已入库的 question 保留（仅解除归属）
router.delete('/:id', asyncHandler(async (req, res) => {
  const affected = await withConnection(async (conn) => {
    await conn.query('UPDATE question SET exam_paper_id = NULL WHERE exam_paper_id = ?', [req.params.id]);
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [req.params.id]);
    const [r] = await conn.query('DELETE FROM exam_paper WHERE id = ?', [req.params.id]);
    return r.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '试卷不存在' });
  return res.json({ success: true });
}));

module.exports = router;
// 运维入口：允许在服务器上直接触发拆题（node scripts/reparse-paper.js <试卷ID>），
// 用于不便走管理端接口时（如接口鉴权异常）重跑拆题任务
module.exports.runParseJob = runParseJob;
