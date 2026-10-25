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
const { buildFingerprint, findDuplicate, matchQuestionNumbers, diceSimilarity, stemPart } = require('../lib/questionDedupe');
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
/**
 * 拆题收口：题号对账去重 + 模块归位 + 卷序重排。
 *
 * 为什么必须有这一步：dedupeList 只做「题与题之间」的两两去重，而多拆的题
 * 大多不是「同一题被拆两次」这么直白 —— 实测一份 130 题的卷子被拆成 135 题，
 * 多出的 5 题全部落在末尾（seq 124/125/130 等位置），内容却是前面板块已经
 * 拆出来的题（政治理论 #10、判断推理 #85、资料分析 #117）。原因是补拆/跨片
 * 输出的题与已拆出的题指向**同一个原文题号**，排序时又被挤到卷末。
 *
 * 三条规则：
 *   1. 同一原文题号只保留「与原文题干最像」的一条（其余必为重复）；
 *   2. 匹配不到题号的题，若与已保留的题足够相似（0.6，与补拆前的真漏过滤
 *      同阈值 —— 那边已认定「拆出来了」，这边就不能再留一条），直接丢弃；
 *   3. 模块以原文分区为准（AI 给的 module 可能是子类型或错位），卷序按题号，
 *      匹配不到题号的题继承前一题位置（+0.5），不再全部挤到末尾。
 *
 * @param {Array} list AI 拆出的题目（已过 mergeFragments + dedupeList）
 * @param {object} pre preprocessPaperText 的结果
 * @returns {Array} 带 seq / section 的成卷题目
 */
/** 问句特征：用于判断一段文字是不是「问题」（而不是材料残片） */
const ASK_RE = /[？?]|多少|哪项|哪些|正确的是|错误的是|的是|推出|约是|比重|排名|趋势|反映|属于|符合|不可能/;

/**
 * 把一段文本切成「题干 + 选项序列」。
 *
 * 选项序列必须**从 A 开始且 B/C/D 连续**，否则视为题干里恰好出现的字母
 * （如「维生素A.」「PM2.5」），不切分。字母前还要求有空白/换行/左括号
 * 做分隔，进一步降低误判。
 *
 * @returns {{stem: string, options: string[]}}
 */
function splitOptionSequence(text) {
  const s = String(text || '');
  const hits = [];
  const re = /([A-D])\s*[.．、]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > 0 && !/[\s\n（(（]/.test(s[m.index - 1])) continue;
    hits.push({ letter: m[1], at: m.index, after: re.lastIndex });
  }
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].letter !== 'A') continue;
    const seq = [hits[i]];
    for (let k = i + 1; k < hits.length && hits[k].letter === String.fromCharCode(65 + seq.length); k++) {
      seq.push(hits[k]);
    }
    if (seq.length < 2) continue;
    const options = seq.map((h, idx) => {
      const end = seq[idx + 1] ? seq[idx + 1].at : s.length;
      return s.slice(h.after, end).replace(/\s+/g, ' ').trim();
    });
    // 选项内容为空、或只有单个字母 —— 原文里这些位置是图形（图形推理/立体/统计图）
    if (options.every((o) => !o || /^[A-Da-d]$/.test(o))) {
      return { stem: s.slice(0, seq[0].at), options: ['（图片选项）', '（图片选项）', '（图片选项）', '（图片选项）'] };
    }
    return { stem: s.slice(0, seq[0].at), options };
  }
  return { stem: s, options: [] };
}

/**
 * 规则兜底构题：从原文题号块直接提取题目（不调 AI）。
 *
 * 为什么需要：模型对三类题持续漏拆，且补拆也补不回来 ——
 *   ① 图形推理/立体图形/分类（块长 59-89 字，选项只有 "A. A B. B C. C D. D"）
 *   ② 政治理论组合表述题（①②③ 编号行 + "A. 1项 B. 2项" 选项）
 *   ③ 大段言语填空/篇章理解（实测一次漏掉 45-56 连续 12 题）
 * 这些题的题干和选项本来就在原文里，规则提取的确定性远高于反复调模型。
 *
 * @param {object} info 原文题号索引里的块信息（blockText / section / passage）
 * @param {number} num 该块的原文题号（直接写进题里，避免再走一次匹配）
 * @returns {object|null} 结构同 AI 输出的题；块无效时返回 null
 */
function buildQuestionFromBlock(info, num) {
  const raw = String((info && info.blockText) || '').trim();
  if (raw.length < 10) return null;
  const text = raw.replace(/^\s*\d{1,3}\s*[.、．]\s*/, '');
  const { stem, options } = splitOptionSequence(text);
  const passage = String(info.passage || '').trim();
  let finalStem = String(stem || '').trim();
  // 资料分析：题干开头可能带着整段共享材料，剥掉（与 splitMaterial 同思路）
  if (passage && finalStem.startsWith(passage.slice(0, 24))) {
    const tail = passage.slice(-24);
    const at = finalStem.indexOf(tail);
    if (at >= 0) finalStem = finalStem.slice(at + tail.length).replace(/^[\s。、，,；;]*/, '').trim();
  }
  if (finalStem.length < 5) return null;
  return {
    module: info.section || '未分区',
    qtype: '单选题',
    passage,
    stem: finalStem.slice(0, 2000),
    options: options.length ? options : ['（图片选项）', '（图片选项）', '（图片选项）', '（图片选项）'],
    answer: '',
    explanation: '',
    // 标记来源：mergeFragments 不能把它当"残片"合并掉；no 已确定，reconcile 直接用
    no: num,
    fromRule: true,
  };
}

/**
 * 剥离题干开头被误并入的共享材料。
 *
 * 资料分析一篇材料带 5 题，模型偶发把整段材料当成一道题输出（实测一份卷子
 * 里出现 8 条，stem 与材料逐字相同，长度 200+，直接把题数从 130 顶到 134）。
 *
 * @returns {string|null} 剥离后的题干；整条就是材料（剥完不成题）时返回 null
 */
/**
 * 判断一道「题」是不是被误当成题的共享材料，是则尝试剥离材料、只留问题。
 *
 * 判据必须与题号无关：这类条目往往连原文题号都匹配不上（实测 8 条全部 no=null），
 * 只能直接和原文的材料段比。相似度门槛 0.8（逐字复制级别），并要求材料尾部
 * 能在 stem 里原样找到，避免「题干开头几个字和材料撞了」被误杀。
 *
 * @returns {{stem: string|null, hit: boolean}} stem=null 表示整条就是材料，应丢弃
 */
function splitMaterial(stem, passages) {
  const s = String(stem || '').trim();
  const sPart = stemPart(s);
  for (const p of passages) {
    const pp = String(p || '').trim();
    if (pp.length < 30) continue;
    if (diceSimilarity(sPart, stemPart(pp)) < 0.8) continue;
    const tail = pp.slice(-24);
    const at = s.indexOf(tail);
    if (at < 0) continue; // 不是逐字复制，放过
    const rest = s.slice(at + tail.length).replace(/^[\s。、，,；;]*/, '').trim();
    if (rest.length >= 8 && ASK_RE.test(rest)) return { stem: rest, hit: true };
    return { stem: null, hit: true }; // 剥不出问题 → 整条是材料
  }
  return { stem: s, hit: false };
}

function reconcileQuestions(list, pre) {
  const byNumber = pre.index.byNumber;
  let nums = matchQuestionNumbers(list, byNumber);

  // 步骤 0：清掉「材料被当成题」的条目，并重算题号对齐
  const passageSet = new Set();
  for (const v of byNumber.values()) if (v.passage && v.passage.length >= 30) passageSet.add(v.passage);
  for (const s of pre.sections || []) if (s.material && s.material.length >= 30) passageSet.add(s.material);
  const passages = [...passageSet];
  const cleaned = [];
  for (const q of list) {
    const { stem, hit } = splitMaterial(q.stem, passages);
    if (stem == null) continue;
    cleaned.push(hit ? { ...q, stem } : q);
  }
  if (cleaned.length !== list.length) {
    console.log(`[exam] 清除「材料被当成题」的条目：${list.length} → ${cleaned.length} 题`);
    list = cleaned;
    nums = matchQuestionNumbers(list, byNumber);
  }

  // 规则 1：同一原文题号只留最像的一条
  const best = new Map();
  const unmatched = [];
  list.forEach((q, i) => {
    // 规则兜底补的题自带题号（来自原文块），优先用它；其余走序列比对匹配。
    // 兜底题若也交给 DP 匹配，会因为它插在列表末尾、对应题号已被前面的题占用
    // 而走 gap，最终被当成「匹配不到题号」丢掉（实测 130 题卷只剩 112 题）。
    const no = q.no != null ? q.no : nums[i];
    if (no == null) { unmatched.push(i); return; }
    const block = byNumber.get(no);
    const score = diceSimilarity(
      stemPart(String(q.stem || '')),
      stemPart(String((block && block.blockText) || ''))
    );
    const prev = best.get(no);
    if (!prev || score > prev.score) best.set(no, { i, q, no, score });
  });
  const kept = [...best.values()];

  // 规则 2：匹配不到题号的题一律丢弃。
  // 这些题的内容必然对应某个原文块，只有两种可能：
  //   a) 该块已被匹配题覆盖 → 它是重复（AI 改写题干导致匹配失败）
  //   b) 该块没被覆盖 → 属于漏题，由调用方的规则兜底从原文块重新构题补回
  // 无论哪种，留着它都只会和兜底题撞车（实测 130 题卷补出 140，多出的全是这类）。
  const droppedUnmatched = unmatched.length;

  // 规则 3：卷序按题号 + 模块以原文分区为准（kept 全部有题号，天然有序）
  const ordered = kept.sort((a, b) => a.no - b.no);
  const dropped = list.length - ordered.length;
  if (dropped > 0) {
    console.log(
      `[exam] 题号对账收口：${list.length} → ${ordered.length} 题` +
      `（同题号重复 ${list.length - unmatched.length - ordered.length} 条、匹配不到题号 ${droppedUnmatched} 条）`
    );
  }
  return ordered.map((o, i) => {
    const src = o.no != null ? byNumber.get(o.no) : null;
    return {
      ...o.q,
      seq: i + 1,
      section: (src && src.section) || o.q.module || '未分区',
    };
  });
}

/**
 * 原卷是否自带答案区（区分「原卷没有答案」与「有答案但没拆出来」）。
 * 特征：参考答案标题，或答案速查表（形如「1-5 CABDC」「101-105 ABDCE」）。
 * 题干里不会出现「数字-数字 + 连续 3 个以上选项字母」的组合，故误判风险低。
 */
function hasAnswerSection(text) {
  const t = String(text || '');
  if (/参考答案|答案及解析|答案速查|【答案】/.test(t)) return true;
  return /\b\d{1,3}\s*[-~—]\s*\d{1,3}\s*[A-Ea-e]{3,}/.test(t);
}

/**
 * 拆题并发数。
 * 原来是 3：一份 130 题的卷子切 20 片、每片 60-150s，串行下来整卷 9-12 分钟，
 * 用户体验就是「点了拆题一直转圈」。单片耗时几乎全在等模型，并发提到 5 后
 * 整卷可压到 3-4 分钟。可调 PARSE_CONCURRENCY 覆盖（模型侧有限流时调小）。
 */
const PARSE_CONCURRENCY = Math.max(1, Number(process.env.PARSE_CONCURRENCY || 3));

/** 整卷拆题预算：超时则保留已拆出的题目落库，不让用户无限等 */
const PARSE_BUDGET_MS = Number(process.env.PARSE_BUDGET_MS || 15 * 60 * 1000);

/** 判定「拆题任务已经死了」的静默时长：进程重启后 parse_status 会永远停在 parsing */
const PARSE_STALE_MS = Number(process.env.PARSE_STALE_MS || 12 * 60 * 1000);

/**
 * 单片 AI 调用超时（毫秒）。
 * 实测并发 5 时单片会被排队拖到 269s/458s，超时后触发「切片减半」递归，
 * 反而比等下去更慢。因此并发回到 3，超时放宽到 120s：宁可等一次，
 * 也不要因为超时把一片拆成两片再各调一次。
 */
const PARSE_CHUNK_TIMEOUT_MS = Number(process.env.PARSE_CHUNK_TIMEOUT_MS || 120000);

/** 拆题进度（进程内）：paperId -> { stage, done, total, startedAt } */
const parseProgress = new Map();

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
  parseProgress.set(paperId, { stage: '拆题', done: 0, total: chunks.length, startedAt: Date.now() });

  const started = Date.now();
  const results = await runPool(
    chunks.map((c, i) => async () => {
      const t0 = Date.now();
      // 单片硬超时：超时后 parseChunk 内部会切片减半重试，比干等更快收敛
      const r = await parseChunk(c, { paperTitle: paper.title, timeout: PARSE_CHUNK_TIMEOUT_MS });
      const p = parseProgress.get(paperId);
      if (p) p.done += 1;
      console.log(
        `[exam] paper=${paperId} 第 ${i + 1}/${chunks.length} 片（${c.section}）完成：` +
        `${r.questions.length} 题 / ${((Date.now() - t0) / 1000).toFixed(1)}s / ` +
        `降级=${r.degraded || '-'}${r.error ? ' / 错误=' + r.error.slice(0, 80) : ''}`
      );
      return r;
    }),
    PARSE_CONCURRENCY
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
  let deduped = reconcileQuestions(dedupeList(mergeFragments(questions)), pre);

  // ── 定向补拆：把模型漏输出的题捡回来 ──────────────────────────
  // 小模型（glm-4-flash）每片固定漏 1 题左右（实测资料分析 20 题漏 5、
  // 判断推理 35 漏 4），切片再小也消除不了这个漏题率。题数对账能发现
  // 缺口（expectedCount vs 实际拆出），这里按「未匹配上的原文题号」
  // 构造 1-5 题的小片重拆一次——小片漏题率远低于大碎片，
  // 从而把总题数确定性拉回接近原文。
  const usedNums0 = new Set(matchQuestionNumbers(deduped, pre.index.byNumber).filter((n) => n != null));
  // 「未匹配」不等于「漏题」：匹配算法可能因局部错配漏掉已拆出的题。
  // 补拆前先过滤——若某个原文题号的题干部分与任一已拆出的题足够相似
  // （阈值 0.6，与合并去重的 0.75 衔接，避免 0.45~0.92 的「两头漏」区间：
  // 过滤放行但去重不判，补拆题重复入库——实测 137 题多 7 全是这类），
  // 说明题已经拆出来了（只是没匹配上），补拆它只会造出重复题。
  const trulyMissing = pre.numbers.filter((n) => {
    if (usedNums0.has(n)) return false;
    const block = String((pre.index.byNumber.get(n) || {}).blockText || '');
    if (block.length < 20) return true; // 原文块太短无法判断，按漏题处理
    const blockStem = stemPart(block);
    return !questions.some((q) => diceSimilarity(String(q.stem || ''), blockStem) >= 0.6);
  });
  if (trulyMissing.length > 0) {
    const p0 = parseProgress.get(paperId);
    if (p0) { p0.stage = '补拆漏题'; p0.done = 0; p0.total = trulyMissing.length; }
    console.log(`[exam] paper=${paperId} 题数对账：未匹配 ${pre.numbers.length - usedNums0.size} 题号，其中真漏 ${trulyMissing.length} 题（题号 ${trulyMissing.join(',')}），开始定向补拆`);
    const supp = await supplementMissingQuestions(pre, trulyMissing, paper.title);
    if (supp.length > 0) {
      // 补拆结果与已拆出题合并去重：阈值降到 0.75（低于片内的 0.92）——
      // AI 两次拆同一题的题干表述可能有细微差异（一次含"根据以上材料"、
      // 一次不含），Dice 落在 0.75~0.92 之间，用 0.92 判不出重复。
      const merged = dedupeList(mergeFragments([...questions, ...supp]), { threshold: 0.75 });
      deduped = reconcileQuestions(merged, pre);
      console.log(`[exam] paper=${paperId} 补拆合并后共 ${deduped.length} 题`);
    }
  }

  // ── 规则兜底补漏：模型（含补拆）仍然漏掉的题，用原文块确定性构题 ────
  // 图形推理、政治理论组合表述题、大段言语填空这三类模型反复漏，
  // 而它们的题干与选项都在原文里 —— 不调 AI，零网络开销，也不会再漏。
  {
    const used = new Set(matchQuestionNumbers(deduped, pre.index.byNumber).filter((x) => x != null));
    const stillMissing = pre.numbers.filter((n) => !used.has(n));
    if (stillMissing.length > 0) {
      // 收口已丢弃所有匹配不到题号的题，所以这里不需要「补前过滤」：
      // 这些题号对应的内容确实还缺（无论 AI 拆过没有），一律用原文块确定性补回。
      const built = stillMissing.map((n) => buildQuestionFromBlock(pre.index.byNumber.get(n), n)).filter(Boolean);
      if (built.length > 0) {
        console.log(
          `[exam] paper=${paperId} 规则兜底补漏 ${built.length} 题` +
          `（题号 ${stillMissing.slice(0, 30).join(',')}${stillMissing.length > 30 ? '…' : ''}）`
        );
        deduped = reconcileQuestions(
          dedupeList(mergeFragments([...deduped, ...built]), { threshold: 0.75 }),
          pre
        );
        console.log(`[exam] paper=${paperId} 兜底合并后共 ${deduped.length} 题`);
      }
    }
  }

  // ── 题目区域截图：把图形从原 PDF 里裁出来 ──────────────────────
  // 文本层里没有的图形（图形推理、几何图、统计图表）只能靠渲染原 PDF 取得。
  // 没有原 PDF 的老试卷无法补图，只能保留题干并标记「选项为图片」。
  const imageBySeq = new Map();
  let imageStats = null;
  const pdfPath = path.join(PAPER_FILES_DIR, `${paperId}.pdf`);
  // 预算兜底：拆题已经耗时过久时，先让用户拿到题目，截图留到下一次重跑再补，
  // 而不是让整卷继续挂着（用户感受就是「点了拆题没反应」）。
  const pImg = parseProgress.get(paperId);
  if (pImg) { pImg.stage = '生成题目截图'; pImg.done = 0; pImg.total = 0; }
  const overBudget = Date.now() - started > PARSE_BUDGET_MS;
  if (overBudget) {
    errors.push(`拆题总耗时已超过 ${Math.round(PARSE_BUDGET_MS / 60000)} 分钟，本次跳过题目截图以尽快返回结果（重新拆题可补图）`);
    console.warn(`[exam] paper=${paperId} 超出时间预算，跳过截图阶段`);
  }
  if (!overBudget && fs.existsSync(pdfPath)) {
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
  // 「无答案」有两种截然不同的成因：原卷压根没有答案区（真题卷常见，答案单独成册），
  // 或原卷有但没拆出来。前者提示「待补」会误导管理员反复重跑。
  if (noAnswer > 0) {
    account.push(hasAnswerSection(pre.text)
      ? `${noAnswer} 题缺答案待补`
      : `${noAnswer} 题无答案（原卷未含答案区，需上传带答案的 PDF 或人工录入）`);
  }
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
  parseProgress.delete(paperId);

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

  // 拆题进程被重启/中断时 parse_status 会永远停在 parsing，前端只能一直转圈。
  // 这里按「最后一次状态更新时间」判定任务已死，直接给出结论 + 重跑入口。
  if (paper.parse_status === 'parsing' && paper.last_parse_at) {
    const silent = Date.now() - new Date(paper.last_parse_at).getTime();
    if (silent > PARSE_STALE_MS) {
      await updateParseState(paper.id, {
        parse_status: 'failed',
        parse_error: `拆题任务已中断（超过 ${Math.round(PARSE_STALE_MS / 60000)} 分钟无进展，通常是服务重启所致），请重新拆题`,
      });
      paper.parse_status = 'failed';
      paper.parse_error = `拆题任务已中断（超过 ${Math.round(PARSE_STALE_MS / 60000)} 分钟无进展，通常是服务重启所致），请重新拆题`;
    }
  }

  // 拆题进度：整卷要跑 9-12 分钟，只回 parsing 会让用户以为「卡住了」
  const prog = parseProgress.get(paper.id);
  return res.json({
    paperId: paper.id,
    parse_status: paper.parse_status,
    parse_error: paper.parse_error,
    parsed_count: paper.parsed_count,
    last_parse_at: paper.last_parse_at,
    question_count: paper.question_count,
    status: paper.status,
    sections,
    progress: prog
      ? {
          stage: prog.stage,
          done: prog.done,
          total: prog.total,
          elapsedMs: Date.now() - prog.startedAt,
        }
      : null,
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
