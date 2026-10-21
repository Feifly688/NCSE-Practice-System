/**
 * 真题（Exam Paper）管理。
 *
 * 业务目标：管理员可以新增真题，来源支持
 *   1) 联网爬取（crawl）：给定试卷页 URL，抓取正文文本；
 *   2) 手动上传 PDF（upload）：解析 PDF 文本。
 *
 * 处理后存储为两种形态：
 *   a) 完整真题试卷 —— exam_paper 表保存整卷文本（raw_text）；
 *   b) 分模块去重题库 —— AI 拆分出的题目按模块归类后写入 question 表，
 *      以 fingerprint（题干指纹）去重，并记录 exam_paper_id 归属。
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');

const router = express.Router();

const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.BASE_URL;
const MODEL = process.env.MODEL;

// PDF 上传：内存暂存，限制 20MB，仅接受 PDF
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = /pdf$/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
    cb(isPdf ? null : new Error('仅支持 PDF 文件'), isPdf);
  },
});

router.use(requireAuth, requireAdmin);

/** 题干指纹：用于分模块入库时去重 */
function questionFingerprint(q) {
  const base = `${String(q.stem || '').trim()}|${(q.options || []).join('|')}|${String(q.answer || '').trim()}`;
  return crypto.createHash('md5').update(base).digest('hex');
}

/** 模块 → 科目 slug 映射（拆分后归类到题库的模块） */
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

/** 抓取试卷页正文（通用网页，非文章站点的白名单机制） */
async function crawlText(url) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*',
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
    .filter(t => t.length > 5);
  const text = paragraphs.length >= 3 ? paragraphs.join('\n') : $('body').text().replace(/\s{2,}/g, '\n').trim();
  return { title, text };
}

/** 调用 AI 将整卷文本拆分为结构化题目（分模块） */
async function parsePaperToQuestions(rawText, paperTitle) {
  if (!API_KEY || !BASE_URL) throw new Error('AI 服务未配置（API_KEY / BASE_URL）');

  const systemPrompt = `你是公考真题数字化专家。请把给定的真题试卷文本拆分为结构化题目。

## 要求
1. 逐题提取，不要遗漏，也不要凭空编造原文没有的题目
2. 每道题输出：module（模块名，如 言语理解与表达 / 常识判断 / 政治理论 / 判断推理 / 资料分析）、qtype（题型）、difficulty（1-5）、passage（材料段落，没有则留空字符串）、stem（题干）、options（4 个选项数组）、answer（A/B/C/D）、explanation（解析，60-150字）
3. 模块归类要准确：政治理论/时政类归入"政治理论"，片段阅读类归入"言语理解与表达"
4. 选项必须与原文一致，答案必须明确
5. 无法识别为题目的内容（如考试说明、注意事项）不要输出

## 输出格式
{"questions":[{...}]}`;

  const body = rawText.length > 16000 ? rawText.slice(0, 16000) : rawText;
  const userPrompt = `试卷标题：${paperTitle}\n\n试卷正文：\n${body}\n\n请输出 JSON（questions 数组）。`;

  let res;
  try {
    res = await axios.post(BASE_URL + '/chat/completions', {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    }, {
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      timeout: 1800000,
    });
  } catch (err) {
    console.error('Exam parse AI error:', err.message);
    throw new Error('AI 拆分失败: ' + err.message);
  }

  let content = res.data.choices[0].message.content.trim();
  content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI 返回内容不是合法 JSON');
    parsed = JSON.parse(m[0]);
  }
  return (parsed.questions || []).filter(q => q && q.stem && Array.isArray(q.options) && q.options.length === 4);
}

// ── 1. 上传 PDF 真题 ──────────────────────────────────
router.post('/upload', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择 PDF 文件' });
  const title = String(req.body.title || req.file.originalname || '').replace(/\.pdf$/i, '').trim();
  if (!title) return res.status(400).json({ error: '请填写试卷标题' });

  let text = '';
  try {
    // pdf-parse 需动态引入：加载时会尝试读取测试文件，失败不影响解析
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(req.file.buffer);
    text = (data.text || '').replace(/\r/g, '').trim();
  } catch (err) {
    console.error('PDF parse error:', err.message);
    return res.status(400).json({ error: 'PDF 解析失败：' + err.message });
  }
  if (!text || text.length < 50) return res.status(400).json({ error: '未能从 PDF 提取到有效文本（可能是扫描件）' });

  const year = Number(req.body.year) || null;
  const id = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO exam_paper (title, year, source, file_name, origin, raw_text, creator_user_id)
       VALUES (?,?,?,?,'upload',?,?)`,
      [title, year, '手动上传', req.file.originalname, text, req.user.userId]
    );
    return r.insertId;
  });

  return res.json({ id, title, textLength: text.length, status: 'pending_review' });
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
  const id = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO exam_paper (title, year, source, source_url, origin, raw_text, creator_user_id)
       VALUES (?,?,?,?,'crawl',?,?)`,
      [paperTitle, Number(year) || null, new URL(url).hostname, url, crawled.text, req.user.userId]
    );
    return r.insertId;
  });

  return res.json({ id, title: paperTitle, textLength: crawled.text.length, status: 'pending_review' });
}));

// ── 3. AI 拆分整卷为题目（预览，不入库）────────────────
router.post('/:id/parse', asyncHandler(async (req, res) => {
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM exam_paper WHERE id = ?', [req.params.id]);
    return rows[0] || null;
  });
  if (!paper) return res.status(404).json({ error: '试卷不存在' });

  const questions = await parsePaperToQuestions(paper.raw_text || '', paper.title);
  // 附加模块归类与指纹，供前端预览与后续去重
  const withMeta = questions.map(q => ({
    ...q,
    subject_slug: moduleToSubject(q.module),
    fingerprint: questionFingerprint(q),
  }));

  return res.json({ paperId: paper.id, title: paper.title, questions: withMeta, total: withMeta.length });
}));

// ── 4. 确认入库：分模块 + 去重 ─────────────────────────
router.post('/:id/confirm', asyncHandler(async (req, res) => {
  const list = req.body.questions;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: '没有要入库的题目' });

  const result = await withConnection(async (conn) => {
    const [paperRows] = await conn.query('SELECT id, title FROM exam_paper WHERE id = ?', [req.params.id]);
    const paper = paperRows[0];
    if (!paper) throw Object.assign(new Error('试卷不存在'), { status: 404 });

    let inserted = 0;
    let duplicated = 0;
    const byModule = {};

    for (const q of list) {
      if (!q.stem || !Array.isArray(q.options) || q.options.length !== 4) continue;
      const fp = q.fingerprint || questionFingerprint(q);
      // 去重：同一指纹（题干+选项+答案）只入库一次
      const [exists] = await conn.query('SELECT id FROM question WHERE fingerprint = ?', [fp]);
      if (exists.length > 0) { duplicated++; continue; }

      const slug = q.subject_slug || moduleToSubject(q.module);
      const [subjects] = await conn.query('SELECT id FROM subject WHERE slug = ?', [slug]);
      const subjectId = subjects[0]?.id || 1;

      await conn.query(
        `INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation,
         source_exam, exam_paper_id, fingerprint, creator_user_id, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending_review')`,
        [
          subjectId,
          q.qtype || '单选题',
          Number(q.difficulty) || 3,
          q.passage || null,
          String(q.stem).slice(0, 1024),
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
      const modName = q.module || '未分类';
      byModule[modName] = (byModule[modName] || 0) + 1;
    }

    await conn.query('UPDATE exam_paper SET question_count = question_count + ?, status = ? WHERE id = ?',
      [inserted, 'parsed', paper.id]);

    return { inserted, duplicated, byModule };
  });

  return res.json(result);
}));

// ── 5. 列表 / 详情 / 删除 ─────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const offset = (page - 1) * pageSize;

  const data = await withConnection(async (conn) => {
    const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM exam_paper');
    const [rows] = await conn.query(
      `SELECT id, title, year, source, source_url, file_name, origin, question_count, status, created_at
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
    return { paper, questions: qs };
  });
  if (!data) return res.status(404).json({ error: '试卷不存在' });
  return res.json(data);
}));

// 删除试卷：题目保留（仅解除归属），避免误删已入库题库
router.delete('/:id', asyncHandler(async (req, res) => {
  const affected = await withConnection(async (conn) => {
    await conn.query('UPDATE question SET exam_paper_id = NULL WHERE exam_paper_id = ?', [req.params.id]);
    const [r] = await conn.query('DELETE FROM exam_paper WHERE id = ?', [req.params.id]);
    return r.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '试卷不存在' });
  return res.json({ success: true });
}));

module.exports = router;
