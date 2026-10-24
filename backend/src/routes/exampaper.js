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
  splitIntoChunks, parseChunk, runPool, dedupeList, normalizeQuestion, mergeFragments,
} = require('../lib/paperParser');
const { buildFingerprint, findDuplicate, matchQuestionNumbers } = require('../lib/questionDedupe');
const { preprocessPaperText } = require('../lib/paperText');
const { safeJson } = require('../lib/json');
const { extractQuestionImages } = require('../lib/pdfRegions');
const fs = require('fs');
const path = require('path');

const router = express.Router();

/** 试卷相关文件目录：原卷 PDF + 题目区域截图 */
const PAPER_FILES_DIR = path.resolve(__dirname, '../../uploads/papers');
const PAPER_IMAGE_SUBDIR = 'paper-images';

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

  // 预处理：去页眉页脚、题号归一化、选项拆行、识别分区与板块材料。
  // 必须放在拆题之前 —— 未预处理的原始文本里题号有两套排版（独立成行 / 跟在题干行尾），
  // 切片会把题目从中间劈开，导致「130 题只识别出 110 题」。
  const pre = preprocessPaperText(rawText, { titles: [paper.title] });
  const expectedCount = pre.questionCount;
  console.log(
    `[exam] paper=${paperId} 预处理完成：原文题号 ${expectedCount} 个，` +
    `分区 ${pre.sections.length} 个，带共享材料的分区 ${pre.sections.filter((s) => s.material).length} 个`
  );

  const chunks = splitIntoChunks(pre.text, { sections: pre.sections, byNumber: pre.index.byNumber });
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

  // 跨片合并：组合表述题的题干与残片可能被切到不同片（实测 #15），
  // parseChunk 内的 mergeFragments 只能合片内相邻的，汇总层再合一次跨片相邻的。
  let deduped = dedupeList(mergeFragments(questions)).map((q, i) => ({
    ...q,
    seq: i + 1,
    section: q.module || '未分区',
  }));

  // ── 定向补拆：把模型漏输出的题捡回来 ──────────────────────────
  // 小模型（glm-4-flash）每片固定漏 1 题左右（实测资料分析 20 题漏 5、
  // 判断推理 35 漏 4），切片再小也消除不了这个漏题率。题数对账能发现
  // 缺口（expectedCount vs 实际拆出），这里按「未匹配上的原文题号」
  // 构造 1-5 题的小片重拆一次——小片漏题率远低于大碎片，
  // 从而把总题数确定性拉回接近原文。
  const usedNums0 = new Set(matchQuestionNumbers(deduped, pre.index.byNumber).filter((n) => n != null));
  const missingNums = pre.numbers.filter((n) => !usedNums0.has(n));
  if (missingNums.length > 0) {
    console.log(`[exam] paper=${paperId} 题数对账：漏 ${missingNums.length} 题（题号 ${missingNums.join(',')}），开始定向补拆`);
    const supp = await supplementMissingQuestions(pre, missingNums, paper.title);
    if (supp.length > 0) {
      const merged = dedupeList(mergeFragments([...questions, ...supp]));
      // 补拆结果按原文题号重排，保证 seq 与题号顺序一致（图片挂载依赖这个顺序）
      const nums = matchQuestionNumbers(merged, pre.index.byNumber);
      deduped = merged
        .map((q, i) => ({ q, no: nums[i] }))
        .sort((a, b) => (a.no == null ? 99999 : a.no) - (b.no == null ? 99999 : b.no))
        .map((o, i) => ({ ...o.q, seq: i + 1, section: o.q.module || '未分区' }));
      console.log(`[exam] paper=${paperId} 补拆合并后共 ${deduped.length} 题`);
    }
  }

  // ── 题目区域截图：把图形从原 PDF 里裁出来 ──────────────────────
  // 文本层里没有的图形（图形推理、几何图、统计图表）只能靠渲染原 PDF 取得。
  // 没有原 PDF 的老试卷无法补图，只能保留题干并标记「选项为图片」。
  const imageBySeq = new Map();
  let imageStats = null;
  const pdfPath = path.join(PAPER_FILES_DIR, `${paperId}.pdf`);
  if (fs.existsSync(pdfPath)) {
    try {
      const outDir = path.join(PAPER_FILES_DIR, PAPER_IMAGE_SUBDIR, String(paperId));
      const { questions: imagesByNo, materials: materialByNo, stats } = await extractQuestionImages(pdfPath, outDir);
      imageStats = stats;
      console.log(
        `[exam] paper=${paperId} 区域截图完成：页 ${stats.pages}，题号区域 ${stats.regions}，` +
        `生成 ${stats.rendered} 张，失败 ${stats.failed} 张；材料段 ${stats.materialRegions} 篇，` +
        `生成 ${stats.materialRendered} 张`
      );
      if (stats.skipped) {
        // poppler 未安装等情况：不能让用户以为截图功能正常
        errors.push('题目区域截图已跳过（服务器未安装 poppler-utils：pdftotext/pdftoppm），图形类题目将只有文字');
      }
      if (imagesByNo.size > 0 || materialByNo.size > 0) {
        // AI 拆出的题按顺序对应原文题号（用题干相似度对齐，避免错位）
        const numbers = matchQuestionNumbers(deduped, pre.index.byNumber);
        let mapped = 0;
        let materialMapped = 0;
        for (let i = 0; i < deduped.length; i++) {
          const no = numbers[i];
          if (no == null) continue;
          const seq = deduped[i].seq;
          // 1) 本题自己的区域截图
          const own = imagesByNo.get(no);
          // 2) 所属资料篇的材料段截图（同篇所有题共享，保证每题都能看到统计图表）
          const from = pre.index.byNumber.get(no);
          const matNo = from ? from.passageFrom : null;
          const mat = matNo != null ? materialByNo.get(matNo) : null;
          const files = [];
          if (own && own.length) files.push(...own.map((f) => path.basename(f)));
          if (mat && mat.length) {
            for (const f of mat) {
              const base = path.basename(f);
              if (!files.includes(base)) files.push(base);
            }
            materialMapped++;
          }
          if (files.length) {
            imageBySeq.set(seq, files.join(','));
            mapped++;
          }
        }
        console.log(`[exam] paper=${paperId} 截图挂载：${mapped}/${deduped.length} 题（其中 ${materialMapped} 题挂了资料篇材料图）`);
      }
    } catch (err) {
      console.error('[exam] 区域截图失败:', err.message);
      errors.push('区域截图失败：' + err.message);
    }
  } else {
    console.log(`[exam] paper=${paperId} 没有原始 PDF（uploads/papers/${paperId}.pdf），跳过区域截图`);
  }

  // 写入整卷题目（先清后写，保证重拆结果干净）
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [paperId]);
    for (const q of deduped) {
      await conn.query(
        `INSERT INTO exam_paper_question
         (exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json, image_url, answer, explanation, fingerprint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          paperId, q.seq, q.section, q.qtype, q.difficulty,
          q.passage || null, q.stem, JSON.stringify(q.options), imageBySeq.get(q.seq) || null,
          q.answer, q.explanation || null,
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

  // 题数对账：原文题号数 vs 实际拆出数。差额必须让管理员看见，
  // 否则会出现「试卷 130 题、只识别出 110 题」却没有任何提示的情况。
  const actualCount = deduped.length;
  const gap = expectedCount - actualCount;
  const noAnswer = deduped.filter((q) => !q.answer).length;
  const imageOptions = deduped.filter((q) => q.hasImageOptions).length;
  const account = [];
  if (expectedCount > 0) {
    account.push(`原文题号 ${expectedCount} 个，实际拆出 ${actualCount} 题`);
    if (gap > 0) account.push(`差 ${gap} 题`);
    else if (gap < 0) account.push(`多出 ${-gap} 题（可能有重复或题号识别偏差）`);
  }
  if (noAnswer > 0) account.push(`${noAnswer} 题缺答案待补`);
  if (imageOptions > 0) account.push(`${imageOptions} 题选项为图片`);
  if (imageBySeq.size > 0) account.push(`${imageBySeq.size} 题已附原卷截图`);

  let parseError = null;
  const notes = [];
  if (errors.length > 0) {
    notes.push(`共 ${chunks.length} 片，${failedChunks} 片失败、${salvagedChunks} 片降级；首条原因：${errors[0]}`);
  } else if (parseStatus === 'partial') {
    // 无硬错误但有片段降级（输出截断后抢救/重试），给出可读说明而非留空
    notes.push(`共 ${chunks.length} 片，其中 ${salvagedChunks} 片输出被截断后已自动降级重试，已保留完整题目；可点「重新拆题」再跑一次以补全。`);
  }
  if (account.length) notes.push(account.join('；'));
  if (notes.length) parseError = notes.join(' | ');

  if (gap > 0) parseStatus = 'partial';

  await updateParseState(paperId, {
    parse_status: parseStatus,
    parse_error: parseError ? parseError.slice(0, 500) : null,
    parsed_count: deduped.length,
  });

  console.log(
    `[exam] 拆题完成 paper=${paperId} 题目=${deduped.length} 状态=${parseStatus} 耗时=${cost}s`
  );
}

/**
 * 定向补拆：对模型漏输出的题号，构造「单题/连续小组」小片重拆。
 *
 * 为什么需要：小模型每片固定漏 1 题左右，这是能力上限，prompt 与
 * 切片大小都消除不了（实测资料分析切成 4-5 题/片仍漏 5 题）。
 * 题数对账（原文题号 vs 实际拆出）能定位缺口，这里把缺的题号
 * 按连续段分组（每组 < 900 字），各配一篇小片重拆，把漏题捡回来。
 *
 * @param {object} pre preprocessPaperText 的结果（含 index.byNumber / index.numAt / text）
 * @param {number[]} missingNums 未匹配上 AI 拆题的原文题号
 * @param {string} paperTitle 试卷标题（进 prompt）
 * @returns {Promise<Array>} 补拆出的题目（未去重，由调用方合并）
 */
async function supplementMissingQuestions(pre, missingNums, paperTitle) {
  if (!missingNums || !missingNums.length) return [];
  const lines = pre.text.split('\n');
  const numAt = pre.index.numAt || [];
  const lineOf = new Map(numAt.map((m) => [m.num, m.line]));

  // 连续题号归组；组内文本控制在 900 字以内（小片漏题率低）
  const groups = [];
  let cur = null;
  for (const n of missingNums) {
    const startLine = lineOf.get(n);
    if (startLine == null) continue;
    const q = pre.index.byNumber.get(n);
    if (!q) continue;
    const idx = numAt.findIndex((m) => m.num === n);
    const endLine = idx >= 0 && idx + 1 < numAt.length ? numAt[idx + 1].line : lines.length;
    const text = lines.slice(startLine, endLine).join('\n');
    if (cur && n === cur.last + 1 && cur.section === q.section && (cur.text.length + text.length) < 900) {
      cur.text += '\n' + text;
      cur.last = n;
    } else {
      cur = { section: q.section, first: n, last: n, text };
      groups.push(cur);
    }
  }

  const tasks = groups.map((g) => async () => {
    const q0 = pre.index.byNumber.get(g.first);
    const material = q0 && q0.passageShared && q0.passage ? q0.passage : '';
    const r = await parseChunk({ section: g.section, text: g.text, material }, { paperTitle });
    return { group: g, r };
  });
  const results = await runPool(tasks, 3);

  const out = [];
  for (const { group, r } of results) {
    if (r && Array.isArray(r.questions) && r.questions.length) {
      out.push(...r.questions);
      console.log(`[exam] 补拆 #${group.first}${group.last !== group.first ? '-#' + group.last : ''}（${group.section}）：+${r.questions.length} 题`);
    } else if (r && r.error) {
      console.warn(`[exam] 补拆 #${group.first} 失败：${r.error}`);
    }
  }
  return out;
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

/**
 * 保存试卷并异步触发拆题（上传与爬取共用）
 *
 * pdfBuffer 传入时会把原始 PDF 落盘（uploads/papers/{id}.pdf）：
 * 文本层里没有的图形（图形推理、几何图、统计图表）只能从原 PDF 裁剪出来，
 * 没有原文件就永远补不回来。
 */
async function ingestPaper({ title, year, source, sourceUrl, fileName, origin, text, userId, pdfBuffer }) {
  const id = await withConnection(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO exam_paper (title, year, source, source_url, file_name, origin, raw_text, parse_status, creator_user_id)
       VALUES (?,?,?,?,?,?,?,'pending',?)`,
      [title, year || null, source || null, sourceUrl || null, fileName || null, origin, text, userId]
    );
    return r.insertId;
  });
  if (pdfBuffer && pdfBuffer.length) {
    try {
      fs.mkdirSync(PAPER_FILES_DIR, { recursive: true });
      fs.writeFileSync(path.join(PAPER_FILES_DIR, `${id}.pdf`), pdfBuffer);
    } catch (err) {
      console.error('[exam] 保存原始 PDF 失败:', err.message);
    }
  }
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
    pdfBuffer: req.file.buffer,
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
