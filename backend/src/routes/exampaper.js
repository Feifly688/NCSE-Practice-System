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
  splitIntoChunks, parseChunk, runPool, dedupeList, normalizeQuestion, mergeFragments, STANDARD_STEM,
} = require('../lib/paperParser');
const { normalizeQuestionStem } = require('../lib/questionStem');
const { buildFingerprint, findDuplicate, matchQuestionNumbers, assignQuestionsToNumbers, diceSimilarity, stemPart } = require('../lib/questionDedupe');
const { preprocessPaperText } = require('../lib/paperText');
const { safeJson } = require('../lib/json');
const { assertPublicUrl, safeGet } = require('../lib/ssrf');
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

/**
 * SSRF 防护：仅允许公网 http(s)，拒绝内网/保留地址。
 * 判定逻辑已收敛到 lib/ssrf.js（含 DNS 解析层拦截与禁用重定向），
 * 这里保留布尔语义，方便在路由里做 400 前置校验。
 */
function isPublicUrl(urlStr) {
  try {
    assertPublicUrl(urlStr);
    return true;
  } catch {
    return false;
  }
}

/**
 * 提取作用域内的叶子块文本，每块一行。
 *
 * 为什么不用 $(el).text()：cheerio 的 text() 会把所有后代文本**拼成一整块**，
 * 没有换行分隔。噪声过滤是按行做的，拿一整块去过滤等于完全失效
 * （首页/登录/分享这些导航文字会整段混进正文）。
 * 只取叶子块（内部不再含块级子元素）可避免父子重复。
 */
function blockTexts($, scope) {
  const BLOCK = 'p, div, li, td, h1, h2, h3, h4, h5, tr, section, article, dd, dt, blockquote';
  const out = [];
  scope.find(BLOCK).each((_, el) => {
    const $el = $(el);
    if ($el.find(BLOCK).length > 0) return; // 非叶子块，交给它的子块
    const t = $el.text().replace(/[\t\u00a0]+/g, ' ').trim();
    if (t) out.push(t);
  });
  return out;
}

/**
 * 从 HTML 中提取标题与正文（纯函数，便于单测）。
 *
 * 真题站点的正文容器千差万别：人民网/新华社用 <p>，粉笔/中公这类题库站
 * 常用 <div class="..."> 直接排题（几乎没有 <p>），还有些站点把整页塞进
 * 一个 div。因此按「优先语义化段落 → 退到正文容器 → 最后才用 body」三级提取，
 * 并在最后一级把导航/页脚等噪声行剔掉，避免正文里混进大量菜单文字。
 *
 * @param {string} html 页面 HTML
 * @returns {{title: string, text: string}}
 */
function extractArticle(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer, iframe, noscript, form, button, aside').remove();

  const title = ($('h1').first().text() || $('title').text() || '').trim();

  // ① 语义化段落：最干净，优先
  const paragraphs = $('p, div.article p, div.content p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 5);

  if (paragraphs.length >= 3) {
    return { title, text: paragraphs.join('\n') };
  }

  // ② 正文容器：题库站常用 div 排版，取文本量最大的几个容器
  const containers = $('article, main, [class*="content"], [class*="article"], [class*="detail"], [class*="question"], [id*="content"]')
    .filter((_, el) => $(el).find('p, div, li, td').length > 0)
    .map((_, el) => ({ el, text: blockTexts($, $(el)).join('\n') }))
    .get()
    .filter((c) => c.text.length > 200)
    .sort((a, b) => b.text.length - a.text.length);
  if (containers.length > 0) {
    const cleaned = cleanCrawledText(containers[0].text);
    if (cleaned.length >= 50) return { title, text: cleaned };
  }

  // ③ 兜底：整页文本（按叶子块分行，便于过滤噪声行）
  const body = cleanCrawledText(blockTexts($, $('body')).join('\n'));
  return { title, text: body };
}

/**
 * 抓取试卷页正文。
 *
 * 走 safeGet：DNS 解析层 + 重定向守卫双重拦截内网地址。
 */
async function crawlText(url) {
  const { data } = await safeGet(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 30000,
  });
  return extractArticle(data);
}

/**
 * 清洗抓取到的整页文本：去掉导航、版权、分享等噪声行。
 *
 * 不做这一步的话，body.text() 会把菜单、页脚、推荐链接一起拼进来，
 * 拆题时这些非题目内容会被模型当成题目片段，题号对账随之失准。
 */
function cleanCrawledText(raw) {
  const noise = /(首页|登录|注册|客户端|下载|APP|扫码|分享|收藏|评论|版权|备案|ICP备|举报|联系我们|关于我们|广告|上一篇|下一篇|相关阅读|推荐阅读|返回顶部|网站地图|友情链接|投稿|订阅|打印|字体|繁體|简体)/;
  return String(raw || '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => l.length > 4)
    .filter((l) => !noise.test(l) || l.length > 120)
    .join('\n')
    .trim();
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
/**
 * 问句特征：用于判断一段文字是不是「问题」（而不是材料残片）。
 * 必须覆盖政治理论/常识的标准写法 ——「这段话体现的哲学原理**不包括**（ ）」、
 * 「下列相关表述**正确的有**（ ）」这类问句**不含问号**，只靠「？」会全部漏判，
 * 结果整道题被当成材料丢弃（实测政治理论 1/9/15 三题全灭）。
 */
const ASK_RE = /[？?]|多少|哪项|哪些|正确的是|错误的是|的是|推出|约是|比重|排名|趋势|反映|属于|符合|不可能|下列|以下|这段话|表述|不包括|正确的有/;

/** 公考选择题的题干几乎都带「（ ）」空括号，也是可靠的问句信号 */
const BLANK_BLANKET_RE = /[（(]\s*[）)]/;

/** 判断一段文字是不是问题（而不是材料残片） */
function looksLikeQuestion(text) {
  const s = String(text || '');
  if (ASK_RE.test(s) || BLANK_BLANKET_RE.test(s)) return true;
  // 图形推理/立体/分类/数字推理的标准题干句式：本身没有问号也没有空括号
  // （"从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性："），
  // 但它们是完整题干，必须和资料分析那种纯数据材料区分开
  return STANDARD_STEM.test(s);
}

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
 * 按选项内容判断题型。
 *
 * 规则兜底构题原先一律写死「单选题」，导致资料分析、判断题、多选题
 * 在题库里全被标成单选题（题型筛选一选就漏）。
 * 这里按选项形态区分：
 *   · 含 ①②③ 圈号 → 组合表述题，按多选计
 *   · 5 个及以上选项 → 多选
 *   · 两个选项且为「正确/错误、对/错」→ 判断题
 *   · 其余 → 单选
 */
function detectQtype(options) {
  const opts = (Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean);
  if (opts.length >= 2 && opts.some((o) => /[①②③④⑤⑥⑦⑧⑨⑩]/.test(o))) return '多选题';
  if (opts.length >= 5) return '多选题';
  const judgeOption = /^(正确|错误|对|错|√|×|是|否|正确项|错误项)$/;
  if (opts.length === 2 && opts.every((o) => judgeOption.test(o))) return '判断题';
  return '单选题';
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
  const combo = normalizeQuestionStem({ stem: finalStem, options: options.length ? options : [] });
  const finalOptions = combo.options.length ? combo.options : ['（图片选项）', '（图片选项）', '（图片选项）', '（图片选项）'];
  return {
    module: info.section || '未分区',
    qtype: detectQtype(finalOptions),
    passage,
    stem: combo.stem.slice(0, 2000),
    options: finalOptions,
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
  // 题干里带问句 → 这条已经是完整题目（引言+问句+编号行），既不剥离也不丢。
  // 政治理论题正是这种情况：原文索引把「引言 + 问句」整体算成了材料段，
  // 于是「材料尾部」就是问句本身，剥离后剩余为空而被误丢（实测 1/9/15 三题全灭）。
  // 注意问句可能在题干中部（题 9/15 是「下列相关表述正确的有（ ）」后面接着
  // ①②③④ 编号行），所以要看整条而不是只看末尾。
  const tailIsQuestion = looksLikeQuestion(s);
  for (const p of passages) {
    const pp = String(p || '').trim();
    if (pp.length < 30) continue;
    if (diceSimilarity(sPart, stemPart(pp)) < 0.8) continue;
    const tail = pp.slice(-24);
    const at = s.indexOf(tail);
    if (at < 0) continue; // 不是逐字复制，放过
    const rest = s.slice(at + tail.length).replace(/^[\s。、，,；;]*/, '').trim();
    if (rest.length >= 8 && looksLikeQuestion(rest)) return { stem: rest, hit: true };
    if (tailIsQuestion) return { stem: s, hit: false };
    return { stem: null, hit: true }; // 剥不出问题 → 整条是材料
  }
  return { stem: s, hit: false };
}

function reconcileQuestions(list, pre) {
  const byNumber = pre.index.byNumber;

  // 步骤 0：清掉「材料被当成题」的条目
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
  }

  // 步骤 1：全局指派 —— 每个原文题号对应最像它的那道题。
  // 用匈牙利算法（最大权二分图匹配）而不是序列比对（DP）：DP 遇到连续漏题
  // 会把后面的题整体左移（错位），导致真正没拆出来的题号被"占用"、
  // 拆错位的题又占了别人的号，补多少都对不齐（实测判断推理连丢 4 题）。
  const assign = assignQuestionsToNumbers(list, byNumber, { minScore: 0.45 });

  // 步骤 2：按题号组装成卷 —— **每个原文题号恰好一题**。
  //   · 指派到的题：取相似度最高的那条（规则兜底题与原文逐字一致，天然胜出 AI 改写版）
  //   · 没被指派的题号：直接用原文块规则构题补齐（不调 AI，零延迟、零随机性）
  //   · 没被指派的 AI 题（多拆/残片）：一律丢弃
  // 兜底必须与组装在同一步完成：分两步时，"已覆盖"的题可能在后续去重里被删掉，
  // 而兜底早已认定它覆盖过 → 题号永久空缺（实测题号 69 丢失）。
  const ordered = [];
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const usedIdx = new Set();
  let ruleFilled = 0;
  for (const no of numbers) {
    const hit = assign.byNo.get(no);
    if (hit) {
      ordered.push({ no, q: hit.q, score: hit.score, i: hit.i });
      usedIdx.add(hit.i);
      continue;
    }
    const rule = buildQuestionFromBlock(byNumber.get(no), no);
    if (rule) {
      ordered.push({ no, q: rule, score: 1, i: -1, isRule: true });
      ruleFilled++;
    }
  }
  // 兜底题自带题号（q.no），不参与指派，直接并入
  list.forEach((q, i) => {
    if (q.no == null || usedIdx.has(i)) return;
    const prev = ordered.find((o) => o.no === q.no);
    if (prev) {
      const score = diceSimilarity(stemPart(String(q.stem || '')), stemPart(String(byNumber.get(q.no).blockText || '')));
      if (score > prev.score) { prev.q = q; prev.score = score; prev.i = i; }
    } else {
      ordered.push({ no: q.no, q, score: 1, i });
      usedIdx.add(i);
    }
  });
  ordered.sort((a, b) => a.no - b.no);
  if (ruleFilled > 0) {
    console.log(`[exam] 题号收口：${ruleFilled} 个题号由原文块规则兜底补齐（AI 未拆出或匹配不上）`);
  }

  const dropped = list.length - ordered.length;
  if (dropped > 0) {
    console.log(
      `[exam] 题号对账收口：${list.length} → ${ordered.length} 题` +
      `（丢弃 ${dropped} 条：多拆/残片或与已指派的题重复）`
    );
  }
  return ordered.map((o, i) => {
    const src = byNumber.get(o.no);
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
 * 拆题并发数（总在途请求数）。
 * 供应商各自还有一道闸门（Agnes 3 / 智谱 2），这里取两者之和，
 * 让两个供应商能同时跑满 —— 主力供应商并发满时请求会自动溢出到另一个，
 * 不会全部堵在闸门里。
 */
const PARSE_CONCURRENCY = Math.max(1, Number(process.env.PARSE_CONCURRENCY || 5));

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

/**
 * 正在拆题的试卷 id（进程内）。
 * 没有这层保护时，重复点「重新拆题」会为同一份卷子起多个后台任务，
 * 每个任务都要跑 9-12 分钟并占用 AI 并发闸门，几个管理员各点几次就把
 * AI 配额和数据库连接全占满，所有人拆题一起变慢。
 */
const activeParseJobs = new Set();

/**
 * 用数据库做原子抢占，把试卷状态从非 parsing 置为 parsing。
 *
 * 内存集合只能挡住单进程内的重复触发；多实例（PM2 cluster / 多台服务器）部署时，
 * 每个实例都有自己的 activeParseJobs，同一份卷子仍可能被拆两次。
 * 这里用条件 UPDATE 做跨实例的原子锁：谁把 affectedRows 抢到 1，谁才有权跑。
 */
async function claimParseJob(paperId) {
  return withConnection(async (conn) => {
    const [r] = await conn.query(
      "UPDATE exam_paper SET parse_status = 'parsing', parse_error = NULL WHERE id = ? AND parse_status <> 'parsing'",
      [paperId]
    );
    return r.affectedRows === 1;
  }).catch((err) => {
    console.error('[exam] 抢占拆题任务失败:', err.message);
    return false;
  });
}

async function runParseJob(paperId) {
  if (activeParseJobs.has(paperId)) {
    console.warn(`[exam] paper=${paperId} 已在拆题中，忽略重复触发`);
    return;
  }
  // 跨实例抢占失败说明别的实例正在拆，直接放弃
  if (!(await claimParseJob(paperId))) {
    console.warn(`[exam] paper=${paperId} 已被其他实例/任务占用，跳过`);
    return;
  }
  activeParseJobs.add(paperId);
  // 心跳定时器兜底：截图、补拆等阶段不经过 chunk 回调，
  // 没有定时器时这些长阶段仍可能被判僵死
  const heartbeat = setInterval(() => touchParseHeartbeat(paperId), 60 * 1000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  try {
    return await runParseJobInner(paperId);
  } finally {
    clearInterval(heartbeat);
    activeParseJobs.delete(paperId);
    // 任务结束时确保进度条目被清掉，避免异常路径留下永久 parsing
    parseProgress.delete(paperId);
  }
}

async function runParseJobInner(paperId) {
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, title, raw_text FROM exam_paper WHERE id = ?', [paperId]);
    return rows[0] || null;
  }).catch((err) => {
    console.error('[exam] 读取试卷失败:', err.message);
    return null;
  });

  if (!paper) {
    console.error('[exam] 拆题任务中止：试卷不存在 id=' + paperId);
    // 抢占时已把状态置为 parsing，这里必须显式复位，
    // 否则这份卷子会一直停在 parsing，只能等 12 分钟后的僵死兜底
    await updateParseState(paperId, {
      parse_status: 'failed',
      parse_error: '试卷不存在，拆题任务中止',
    });
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
      // 刷新心跳：整卷拆题要 9-15 分钟，而 last_parse_at 只在开始和结束时写。
      // 没有心跳时，跑满 12 分钟的任务会被 /parse-status 判为「僵死」直接标 failed，
      // 任务其实还在跑，状态却被覆盖，用户看到的就是莫名其妙的失败。
      touchParseHeartbeat(paperId);
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
  // ── 规则兜底补漏已并入 reconcileQuestions ──────────────────────
  // 收口阶段会为每个未被指派的题号直接用原文块构题，因此这里无需再单独兜底。
  // （之前分两步做时，"已覆盖"的题可能在后续去重里被删掉，而兜底已认定它覆盖过，
  //   导致题号永久空缺 —— 实测题号 69 丢失。）

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

  // 写入整卷题目（先清后写，保证重拆结果干净）。
  // 必须用事务：原先是先 DELETE 再逐条 INSERT，中途失败会留下「旧题已删、新题没写进去」
  // 的空卷，前端看到的就是 0 题。这里改成单事务 + 批量 INSERT（130 题 1 次往返）。
  await withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [paperId]);
      if (deduped.length > 0) {
        const rows = [];
        const params = [];
        for (const q of deduped) {
          rows.push('(?,?,?,?,?,?,?,?,?,?,?,?)');
          params.push(
            paperId, q.seq, q.section, q.qtype, q.difficulty,
            q.passage || null, q.stem, JSON.stringify(q.options), imageBySeq.get(q.seq) || null,
            q.answer, q.explanation || null,
            q.fingerprint || buildFingerprint(q)
          );
        }
        await conn.query(
          `INSERT INTO exam_paper_question
           (exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json, image_url, answer, explanation, fingerprint)
           VALUES ${rows.join(',')}`,
          params
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
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

/**
 * 刷新拆题心跳（只更新 last_parse_at）。
 * 供长任务在执行过程中定期调用，避免被 /parse-status 的僵死判定误伤。
 */
function touchParseHeartbeat(paperId) {
  withConnection(async (conn) => {
    await conn.query('UPDATE exam_paper SET last_parse_at = NOW() WHERE id = ?', [paperId]);
  }).catch((err) => console.error('[exam] 心跳更新失败:', err.message));
}

/** exam_paper 上允许由 updateParseState 写入的列名白名单 */
const PARSE_STATE_COLUMNS = new Set([
  'parse_status', 'parse_error', 'parsed_count', 'question_count', 'status', 'raw_text', 'expected_count',
]);

/**
 * 更新拆题状态。
 * 列名走白名单：虽然当前调用点都是内部常量，但直接把对象 key 拼进 SQL
 * 是危险模式 —— 一旦将来有调用方把外部输入透传进来就是注入点。这里显式收口。
 */
async function updateParseState(paperId, fields) {
  const keys = Object.keys(fields).filter((k) => PARSE_STATE_COLUMNS.has(k));
  if (keys.length === 0) return;
  const unknown = Object.keys(fields).filter((k) => !PARSE_STATE_COLUMNS.has(k));
  if (unknown.length > 0) {
    console.warn(`[exam] updateParseState 忽略未知字段: ${unknown.join(',')}`);
  }
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
// 分两步：先 /crawl/preview 抓取并预览，确认无误再 /crawl 入库。
// 直接一步到底的问题是：抓取失败或抓到了错误页面时，试卷已经落库并触发了
// AI 拆题，库里留下一条没法用的记录，管理员还得手动删。
router.post('/crawl/preview', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url || !isPublicUrl(url)) return res.status(400).json({ error: '无效的或非公网的 URL' });

  let crawled;
  try {
    crawled = await crawlText(url);
  } catch (err) {
    // 把失败原因分类说明，管理员才知道是反爬、重定向还是网络问题
    const msg = err.message || '';
    let hint = '抓取失败';
    if (/SSRF|内网|保留地址/.test(msg)) hint = '该地址被安全策略拒绝（内网或保留地址不可抓取）';
    else if (/status code 4\d\d/.test(msg)) hint = '目标站点拒绝访问（可能需要登录或有反爬策略）';
    else if (/status code 5\d\d/.test(msg)) hint = '目标站点返回服务器错误';
    else if (/timeout|ECONN|ENOTFOUND/.test(msg)) hint = '无法连接目标站点（超时或域名解析失败）';
    else if (/maxRedirects/.test(msg)) hint = '重定向次数过多';
    return res.status(400).json({ error: hint, detail: msg.slice(0, 200) });
  }

  if (!crawled.text || crawled.text.length < 50) {
    return res.status(400).json({
      error: '抓取到的正文为空或过短',
      detail: `仅取到 ${crawled.text ? crawled.text.length : 0} 字符。该页面可能是 JS 渲染（需浏览器）或未包含试题内容。`,
    });
  }

  return res.json({
    title: crawled.title,
    text: crawled.text,
    textLength: crawled.text.length,
    preview: crawled.text.slice(0, 1500),
  });
}));

router.post('/crawl', asyncHandler(async (req, res) => {
  const { url, title, year, text } = req.body;
  if (!url || !isPublicUrl(url)) return res.status(400).json({ error: '无效的或非公网的 URL' });

  // 预览步骤已经拿到正文就直接用，避免重复抓取（对方站点可能限流）
  let paperText = typeof text === 'string' ? text.trim() : '';
  let pageTitle = '';
  if (!paperText) {
    let crawled;
    try {
      crawled = await crawlText(url);
    } catch (err) {
      return res.status(400).json({ error: '抓取失败：' + err.message });
    }
    if (!crawled.text || crawled.text.length < 50) return res.status(400).json({ error: '抓取内容为空' });
    paperText = crawled.text;
    pageTitle = crawled.title;
  }

  const paperTitle = String(title || pageTitle || '').trim() || '未命名真题';
  const id = await ingestPaper({
    title: paperTitle,
    year: Number(year) || null,
    source: new URL(url).hostname,
    sourceUrl: url,
    origin: 'crawl',
    text: paperText,
    userId: req.user.userId,
  });

  return res.json({
    id,
    title: paperTitle,
    textLength: paperText.length,
    parse_status: 'pending',
    message: '已保存整卷并开始 AI 拆题',
  });
}));

// ── 3. 拆题状态（前端轮询）──────────────────────────
router.get('/:id/parse-status', asyncHandler(async (req, res) => {
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT ep.id, ep.title, ep.parse_status, ep.parse_error, ep.parsed_count, ep.last_parse_at, ep.status,
              (SELECT COUNT(*) FROM question q WHERE q.exam_paper_id = ep.id) AS question_count
       FROM exam_paper ep WHERE ep.id = ?`,
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
  if (paper.parse_status === 'parsing' || activeParseJobs.has(Number(req.params.id))) {
    return res.json({ started: false, message: '正在拆题中，请稍候' });
  }

  runParseJob(paper.id).catch((err) => console.error('[exam] 拆题任务异常:', err.message));
  return res.json({ started: true, parse_status: 'parsing' });
}));

router.post('/:id/reparse', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, parse_status FROM exam_paper WHERE id = ?', [id]);
    return rows[0] || null;
  });
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  // 正在拆题时直接拒绝，否则重复触发会叠加后台任务打满 AI 并发
  if (paper.parse_status === 'parsing' || activeParseJobs.has(id)) {
    return res.json({ started: false, message: '正在拆题中，请稍候' });
  }

  await withConnection(async (conn) => {
    await conn.query(
      "UPDATE exam_paper SET parse_status = 'pending', parse_error = NULL WHERE id = ?",
      [id]
    );
  });

  runParseJob(id).catch((err) => console.error('[exam] 拆题任务异常:', err.message));
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
  const questions = rows.map((r) => {
    const fixed = normalizeQuestionStem({ stem: r.stem, options: safeJson(r.options_json, []) });
    return { ...r, stem: fixed.stem, options: fixed.options };
  });
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

    // 科目映射一次取全（slug 只有两三种，原先每题查一次纯属浪费）
    const [subjectRows] = await conn.query('SELECT id, slug FROM subject');
    const subjectBySlug = new Map(subjectRows.map((r) => [r.slug, r.id]));

    // 先整体归一化并算指纹，再用一次 IN 查询批量判重，
    // 替代原先「每题一次 SELECT fingerprint」的 N+1
    const prepared = [];
    for (const raw of list) {
      const q = normalizeQuestion(raw);
      if (!q) continue;
      prepared.push({ raw, q, fp: buildFingerprint(q) });
    }
    const existingFps = new Set();
    if (prepared.length > 0) {
      const [fpRows] = await conn.query(
        'SELECT fingerprint FROM question WHERE fingerprint IN (?)',
        [prepared.map((p) => p.fp)]
      );
      for (const r of fpRows) existingFps.add(r.fingerprint);
    }

    let duplicated = 0;
    const byModule = {};
    const duplicateDetails = [];
    const toInsert = [];

    for (const { raw, q, fp } of prepared) {
      if (existingFps.has(fp)) {
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
      const subjectId = subjectBySlug.get(slug) || 1;

      toInsert.push({
        subjectId,
        q,
        fp,
        modName: q.module || '未分类',
      });

      // 新入库题目加入候选集，避免同批内互相重复
      candidates.push({ id: null, qtype: q.qtype, stem: q.stem, options: q.options, answer: q.answer, fingerprint: fp });
    }

    // 批量落库 + 更新试卷计数，整体一个事务：
    // 原先逐条 INSERT 且无事务，中途失败会留下「题已入库但试卷计数没更新」的偏差
    let inserted = 0;
    await conn.beginTransaction();
    try {
      if (toInsert.length > 0) {
        const rowSql = "(?,?,?,?,?,?,?,?,?,?,?,?,'pending_review')";
        const params = [];
        for (const it of toInsert) {
          params.push(
            it.subjectId,
            it.q.qtype,
            it.q.difficulty,
            it.q.passage || null,
            it.q.stem.slice(0, 1024),
            JSON.stringify(it.q.options),
            it.q.answer,
            it.q.explanation || '',
            paper.title.slice(0, 128),
            paper.id,
            it.fp,
            req.user.userId
          );
        }
        await conn.query(
          `INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation,
           source_exam, exam_paper_id, fingerprint, creator_user_id, status)
           VALUES ${Array(toInsert.length).fill(rowSql).join(',')}`,
          params
        );
        inserted = toInsert.length;
        for (const it of toInsert) {
          byModule[it.modName] = (byModule[it.modName] || 0) + 1;
        }
      }

      // question_count 直接写成实际入库行数，不再累加：
      // 累加语义下重复入库（第二次 inserted=0）会让计数虚高，
      // 而题库里单独删题又只会让计数偏高 —— 两个方向都会与实际不符。
      await conn.query(
        `UPDATE exam_paper
         SET question_count = (SELECT COUNT(*) FROM question WHERE exam_paper_id = ?),
             status = 'parsed'
         WHERE id = ?`,
        [paper.id, paper.id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }

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
    // question_count 用实时子查询，不用 exam_paper 表里的累加字段。
    // 累加字段只增不减：题库里单独删题 / 批量禁用 / 重复入库都会让它与实际值脱节，
    // 表现为「真题列表显示已入库 30 题，题目管理里却只有 28 题」这种脏数据。
    const [rows] = await conn.query(
      `SELECT ep.id, ep.title, ep.year, ep.source, ep.source_url, ep.file_name, ep.origin,
              (SELECT COUNT(*) FROM question q WHERE q.exam_paper_id = ep.id) AS question_count,
              ep.status, ep.parse_status, ep.parse_error, ep.parsed_count, ep.last_parse_at, ep.created_at
       FROM exam_paper ep ORDER BY ep.id DESC LIMIT ? OFFSET ?`,
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
    // question_count 同样按实际入库行数统计，与列表页保持一致（见列表接口注释）
    const [cnt] = await conn.query(
      'SELECT COUNT(*) AS c FROM question WHERE exam_paper_id = ?', [paper.id]
    );
    return { paper: { ...paper, question_count: cnt[0].c }, questions: qs, paperQuestions: epq };
  });
  if (!data) return res.status(404).json({ error: '试卷不存在' });
  return res.json(data);
}));

/** 删除试卷关联的磁盘文件：原卷 PDF + 该卷的题目区域截图目录 */
function removePaperFiles(paperId) {
  const targets = [
    path.join(PAPER_FILES_DIR, `${paperId}.pdf`),
    path.join(PAPER_FILES_DIR, PAPER_IMAGE_SUBDIR, String(paperId)),
  ];
  for (const t of targets) {
    try {
      fs.rmSync(t, { recursive: true, force: true });
    } catch (err) {
      // 文件清理失败不影响删除流程，但必须留下日志便于运维补删
      console.warn(`[exam] 清理试卷文件失败 ${t}: ${err.message}`);
    }
  }
}

// 删除试卷：整卷题目随外键级联删除；已入库的 question 保留（仅解除归属）
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const affected = await withConnection(async (conn) => {
    await conn.query('UPDATE question SET exam_paper_id = NULL WHERE exam_paper_id = ?', [id]);
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [id]);
    const [r] = await conn.query('DELETE FROM exam_paper WHERE id = ?', [id]);
    return r.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '试卷不存在' });
  // 同步清理 PDF 与截图，否则 uploads 会随每次上传/重跑持续增长
  removePaperFiles(id);
  return res.json({ success: true });
}));

module.exports = router;
// 运维入口：允许在服务器上直接触发拆题（node scripts/reparse-paper.js <试卷ID>），
// 用于不便走管理端接口时（如接口鉴权异常）重跑拆题任务
module.exports.runParseJob = runParseJob;
// 调试用：把收口相关的内部函数暴露出来，便于在服务器上复现某一步的取舍
module.exports.__debug = { reconcileQuestions, buildQuestionFromBlock, splitMaterial, splitOptionSequence, crawlText, extractArticle, cleanCrawledText, detectQtype };
