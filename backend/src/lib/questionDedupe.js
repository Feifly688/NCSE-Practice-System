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

module.exports = {
  normalizeText,
  bigrams,
  diceSimilarity,
  optionsKey,
  buildFingerprint,
  stemFingerprint,
  judgeDuplicate,
  findDuplicate,
};
