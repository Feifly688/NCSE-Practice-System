/**
 * 题目去重：文本相似度 + 题目特征（题型 / 选项 / 答案）。
 *
 * 两层策略：
 *   1) 精确层：fingerprint = md5(qtype|stem|options|answer)，完全一致即重复（原有逻辑）
 *   2) 相似层：题干归一化后按 bigram Dice 系数比对，超过阈值且题目特征一致即判重。
 *      用于应对「同一道题被不同试卷摘录、题干有个别字/标点差异」的情况。
 */
const crypto = require('crypto');

/** 归一化：去空白与常用标点，统一大小写，便于相似度比较 */
function normalizeText(s) {
  return String(s || '')
    .replace(/[\s]/g, '')
    .replace(/[，。、；：？！“”‘’（）()【】《》〈〉,.;:?!\-—_·"'“”]/g, '')
    .toLowerCase();
}

/** 生成 bigram 集合 */
function bigrams(s) {
  const set = new Set();
  const t = normalizeText(s);
  if (t.length < 2) {
    if (t.length === 1) set.add(t);
    return set;
  }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** Dice 系数（0-1），对短文本与局部差异较稳健 */
function diceSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return (2 * common) / (A.size + B.size);
}

/** 选项集合归一化（顺序无关），用于特征比对 */
function optionsKey(options) {
  return (Array.isArray(options) ? options : [])
    .map((o) => normalizeText(o))
    .sort()
    .join('|');
}

/** 精确指纹：题型 + 题干 + 选项 + 答案 */
function buildFingerprint(q) {
  const base = [
    String(q.qtype || ''),
    String(q.stem || '').trim(),
    optionsKey(q.options),
    String(q.answer || '').trim(),
  ].join('|');
  return crypto.createHash('md5').update(base).digest('hex');
}

/** 题干指纹（忽略题型/答案差异，用于相似度候选召回与整卷内部去重） */
function stemFingerprint(q) {
  return crypto.createHash('md5').update(normalizeText(q.stem)).digest('hex');
}

/**
 * 判断两题是否重复。
 * @param {object} a 待入库题目 { qtype, stem, options, answer }
 * @param {object} b 库中题目
 * @param {number} threshold 相似度阈值，默认 0.9
 * @returns {{ dup: boolean, reason: string, score: number }}
 */
function judgeDuplicate(a, b, threshold = 0.9) {
  // 选项是「图片占位」时没有任何区分度：图形推理/立体/分类题成批出现，
  // 题干逐字相同（"从所给的四个选项中，选择最合适的一个填入问号处……"），
  // 指纹和相似度都会判成同一题，于是整片被判重复删掉（实测 130 题卷里
  // 5 道图形推理全灭，只拆出 110+ 题）。这类题只能靠题号区分，
  // 因此这里完全退出判重（由调用方的题号对账保证不重复）。
  const imgOpts = (o) => Array.isArray(o) && o.length >= 2 && o.every((x) => String(x).trim() === '（图片选项）');
  if (imgOpts(a.options) || imgOpts(b.options)) {
    return { dup: false, reason: 'image-options', score: 0 };
  }
  if (buildFingerprint(a) === buildFingerprint(b)) {
    return { dup: true, reason: 'exact', score: 1 };
  }
  const score = diceSimilarity(a.stem, b.stem);
  if (score < threshold) return { dup: false, reason: 'stem-diff', score };

  // 相似度达标后，再用题目特征（题型/选项/答案）二次确认，避免误杀
  const sameQtype = !b.qtype || !a.qtype || String(a.qtype) === String(b.qtype);
  const optsA = optionsKey(a.options);
  const optsB = optionsKey(b.options);
  const optScore = optsA && optsB ? diceSimilarity(optsA, optsB) : 0;
  const sameAnswer = !b.answer || !a.answer || String(a.answer).trim().toUpperCase() === String(b.answer).trim().toUpperCase();

  if (sameQtype && sameAnswer && optScore >= 0.6) {
    // 题干几乎逐字相同时（如"把下面的六个图形分为两类，使每一类图形都有各自的
    // 共同特征或规律，分类正确的一项是："），两道题的选项集合其实不同
    // （实测 #83/#84 就是这样，一道题只被整片误杀）。这种"题干相同、选项不同"
    // 是公考常见写法，必须要求选项也几乎一致才算重复。
    if (score >= 0.97 && optScore < 0.9) {
      return { dup: false, reason: 'stem-same-opt-diff', score };
    }
    return { dup: true, reason: 'similar', score };
  }
  // 「题干相同、选项不同」是公考常见写法：填空题（"依次填入画横线部分最恰当的一项是："）、
  // 图形推理题（"从所给的四个选项中，选择最合适的一个填入问号处……"）成批出现，
  // 选项内容彼此完全不同。以前这里有一条 score >= 0.97 的强制判重，会把它们整片当成重复丢掉
  // （实测整卷 130 题只拆出 110 题，缺的正是这些题）。
  // 现在只在选项也高度相似时才强制判重；选项明显不同一律不判重。
  if (optsA && optsB && optScore < 0.6) {
    return { dup: false, reason: 'feature-diff', score };
  }
  if (score >= 0.97 && optScore >= 0.9) {
    return { dup: true, reason: 'similar-force', score };
  }
  return { dup: false, reason: 'feature-diff', score };
}

/**
 * 在候选集合中找出重复项。
 * @param {object} q 待检查题目
 * @param {Array} candidates 库中提取的候选题目 [{ id, qtype, stem, options, answer }]
 * @param {object} opts { threshold }
 */
function findDuplicate(q, candidates, opts = {}) {
  const threshold = opts.threshold ?? 0.9;
  for (const c of candidates) {
    const r = judgeDuplicate(q, c, threshold);
    if (r.dup) return { ...r, matchId: c.id, matchStem: c.stem };
  }
  return null;
}

/**
 * 截取一段文本的「题干部分」：从开头到第一个选项行（A./B./C./D.）为止。
 *
 * 为什么需要：AI 拆出的 stem 只含题干，而原文 blockText 是「题干 + 选项」。
 * 直接用整段做相似度会被选项稀释——言语题选项约 120 字、题干约 40 字，
 * Dice 可能只有 0.2，低于匹配阈值（实测 130 题只匹配上 80 题，
 * 误判 43 题"漏题"）。截到题干部分后是「题干 vs 题干」，相似度正常。
 *
 * @param {string} text
 * @returns {string}
 */
function stemPart(text) {
  const s = String(text || '');
  // 选项起点有两种排版：
  //   1) 选项独立成行 —— 行首的「A.」
  //   2) 题干与选项挤在同一行 ——「……下列说法正确的是（ ）。 A.甲自主决定…… B.乙入住……」
  //      （实测大量真题 PDF 提取后就是这样：一份 130 题卷里 33 题因此匹配不上。
  //      只认行首时原文侧截不断，变成「题干 vs 题干+选项」，Dice 被选项稀释到 0.2 左右。）
  // 字母前必须有空白或句末标点做分隔，题干里出现「维生素A、B」这类字母才不会被误截。
  const m = s.match(/(?:^|\n|[\s。；：）】])\s*[A-D]\s*[.．、]/);
  return m ? s.slice(0, m.index) : s;
}

/**
 * 把 AI 拆出的题目与原文题号对齐。
 *
 * AI 拆题基本按原文顺序逐题提取，但会有：遗漏（少拆）、多拆、
 * 局部乱序、以及**改写题干**（精简/重组表述，导致 Dice 相似度
 * 经常低于阈值——实测改写后大量题匹配不上，误判"漏题"）。
 *
 * 因此不用"相似度贪心"（逐题挑最相似 / 全局按分分配），改用
 * **序列比对（Needleman-Wunsch DP）**：
 *   - AI 题序列 vs 原文题号序列，得分矩阵 = 题干相似度
 *   - 允许 gap：跳过 AI 题（多拆）或跳过原文题号（漏题），
 *     惩罚远小于"低相似度硬配"的负分
 *   - DP 找总分最高的对齐路径，回溯得到配对
 * 优势：顺序结构 + 容错缺口，改写导致相似度下降时宁可留空
 * （不挂图片）也不错配；漏题在 DP 里自然体现为 gap，
 * 后续定向补拆只补真正的缺口。
 *
 * @param {Array<{stem: string}>} questions AI 拆出的题目
 * @param {Map<number, {blockText: string}>} index 原文题号索引
 * @returns {Array<number|null>} 与 questions 等长的题号数组
 */
function matchQuestionNumbers(questions, index, opts = {}) {
  const threshold = opts.threshold ?? 0.45;
  const entries = [];
  for (const [num, info] of index) entries.push({ num, text: String(info.blockText || '') });
  entries.sort((a, b) => a.num - b.num);
  const n = questions.length;
  const m = entries.length;
  const out = new Array(n).fill(null);
  if (!n || !m) return out;

  // 相似度矩阵（题干 vs 题干，避免选项稀释）
  const S = [];
  for (let i = 0; i < n; i++) {
    const stem = stemPart(String(questions[i]?.stem || ''));
    S[i] = new Float64Array(m);
    for (let j = 0; j < m; j++) S[i][j] = diceSimilarity(stem, stemPart(entries[j].text));
  }

  const GAP = -0.05;                 // 跳过一侧的惩罚（漏题/多拆）——轻，鼓励用 gap 处理缺口
  const MISMATCH = -0.3;             // 低于阈值硬配的重罚——宁可留空也不错配
  const STRONG = 0.7;                // 强匹配线：超过才给正分
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const ptr = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)); // 0=diag 1=up 2=left
  for (let i = 1; i <= n; i++) { dp[i][0] = dp[i - 1][0] + GAP; ptr[i][0] = 1; }
  for (let j = 1; j <= m; j++) { dp[0][j] = dp[0][j - 1] + GAP; ptr[0][j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = S[i - 1][j - 1];
      // 得分设计：强匹配正分 / 弱相似（threshold~STRONG）中性 / 低于阈值重罚。
      // 弱相似给中性很关键——漏题场景下相邻题相似度约 0.5，若给正分，
      // DP 会宁愿错配（连锁错位）也不走 gap；中性 + 轻 gap 让它正确跳过。
      const diagScore = s >= STRONG ? (s - STRONG) * 3 : (s >= threshold ? 0 : MISMATCH);
      const diag = dp[i - 1][j - 1] + diagScore;
      const up = dp[i - 1][j] + GAP;
      const left = dp[i][j - 1] + GAP;
      if (diag >= up && diag >= left) { dp[i][j] = diag; ptr[i][j] = 0; }
      else if (up >= left) { dp[i][j] = up; ptr[i][j] = 1; }
      else { dp[i][j] = left; ptr[i][j] = 2; }
    }
  }

  // 回溯对齐路径
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (ptr[i][j] === 0) {
      if (S[i - 1][j - 1] >= threshold) out[i - 1] = entries[j - 1].num;
      i--; j--;
    } else if (ptr[i][j] === 1) {
      i--;
    } else {
      j--;
    }
  }

  // ── 位置锚定补配 ──────────────────────────────────────────────
  // DP 遇到被改写的题干会走 gap，结果是「题拆出来了却没有题号」——
  // 图片挂不上，还会被题数对账当成漏题再去补拆一次（实测一份 130 题的卷子
  // 因此补拆 37 次，最后多出 9 题）。但顺序结构本身就是证据：若一段连续
  // 未匹配的题，其前后已匹配题号之间**恰好空出同样多的题号**，按序填入即可。
  const nums = entries.map((e) => e.num);
  let a = 0;
  while (a < n) {
    if (out[a] != null) { a++; continue; }
    let b = a;
    while (b < n && out[b] == null) b++;
    const segLen = b - a;
    let prevPos = -1;
    for (let p = a - 1; p >= 0; p--) if (out[p] != null) { prevPos = nums.indexOf(out[p]); break; }
    let nextPos = m;
    for (let q = b; q < n; q++) if (out[q] != null) { nextPos = nums.indexOf(out[q]); break; }
    const slots = nextPos - prevPos - 1;
    // 只在空位与缺口数完全一致时填（多拆/漏题的情况下数量对不上，不猜）
    if (slots === segLen && slots > 0) {
      for (let k = 0; k < segLen; k++) out[a + k] = nums[prevPos + 1 + k];
    }
    a = b;
  }
  return out;
}

module.exports = {
  normalizeText,
  bigrams,
  diceSimilarity,
  optionsKey,
  buildFingerprint,
  stemFingerprint,
  judgeDuplicate,
  findDuplicate,
  matchQuestionNumbers,
  stemPart,
};
