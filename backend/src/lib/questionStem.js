/**
 * 题干清理：把「粘在题干里的选项行」剥离出来。
 *
 * 规则兜底构题（buildQuestionFromBlock）在两类情况下会把整坨原文塞进 stem：
 *   A. 选项已正确拆出，但 stem 尾部还留着同一批 A./B./C./D. 行
 *      → 页面上是「题干里读一遍选项、下面又渲染一遍」，纯重复
 *   B. 选项没拆出来（全被填成「（图片选项）」占位），真实选项文字就埋在 stem 里
 *      → 用户看到四个无意义的占位符，反而答不了题
 *
 * 两种情况用同一个判据处理：先把 stem 里的选项序列解析出来，再与已存的
 * options 对照 —— 对得上就只剥 stem；对不上且已存的是占位符，就把解析结果
 * 补为正式选项。以上都是纯文本操作，不涉及模型调用。
 */
const { diceSimilarity } = require('./questionDedupe');

const IMG_PLACEHOLDER = '\uFF08\u56FE\u7247\u9009\u9879\uFF09'; // （图片选项）

/**
 * 从一段文字里切出 A/B/C/D 连续选项序列。
 * @returns {{stem: string, options: string[]}}
 */
function splitOptionSequence(text) {
  const s = String(text || '');
  const hits = [];
  const re = /([A-D])\s*[.\uFF0E\u3001]/g;
  let m;
  while ((m = re.exec(s))) {
    // 前一个字符必须是空白或开括号，避免把「维生素A.」这类词里的字母当选项
    if (m.index > 0 && !/[\s\n\uFF08(\uFF08]/.test(s[m.index - 1])) continue;
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
    // 选项内容为空、或只有单个字母 —— 原文里这些位置是图形
    if (options.every((o) => !o || /^[A-Da-d]$/.test(o))) {
      return { stem: s.slice(0, seq[0].at), options: [IMG_PLACEHOLDER, IMG_PLACEHOLDER, IMG_PLACEHOLDER, IMG_PLACEHOLDER] };
    }
    return { stem: s.slice(0, seq[0].at), options };
  }
  return { stem: s, options: [] };
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[，。；、,.;]/g, '').trim();

function looksSame(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return diceSimilarity(x, y) >= 0.6;
}

const isPlaceholder = (o) => {
  const s = String(o || '').trim();
  return !s || s === IMG_PLACEHOLDER || /^[A-Da-d]$/.test(s);
};

/**
 * @param {object} q {stem, options}
 * @returns {{stem: string, options: string[], changed: boolean, reason: string}}
 */
function normalizeQuestionStem(q) {
  const stem = String((q && q.stem) || '');
  const known = Array.isArray(q && q.options) ? q.options.slice() : [];
  const { stem: head, options: parsed } = splitOptionSequence(stem);

  // stem 里没有可识别的选项序列 → 无需处理
  if (!parsed.length || head === stem) {
    return { stem, options: known, changed: false, reason: 'no-embedded-options' };
  }

  const cleanHead = head.replace(/[\s\n]+$/, '');
  if (cleanHead.length < 5) {
    return { stem, options: known, changed: false, reason: 'head-too-short' };
  }

  const realKnown = known.filter((o) => !isPlaceholder(o));

  // 情况 B：已存选项全是占位符，但 stem 里能解析出真实选项 → 补为正式选项
  if (realKnown.length === 0 && parsed.filter((o) => !isPlaceholder(o)).length >= 2) {
    return { stem: cleanHead, options: parsed, changed: true, reason: 'recovered-options' };
  }

  // 情况 C：两边都是占位符（图形推理的 `A. A B. B C. C D. D` —— 选项只是图形标号，
  // 文字层面没有任何信息），尾部的选项行纯粹是噪音，直接剥掉。
  if (realKnown.length === 0 && parsed.length && parsed.every((o) => isPlaceholder(o))) {
    return { stem: cleanHead, options: known, changed: true, reason: 'stripped-figure-marks' };
  }

  // 情况 A：解析出的选项与已存选项对得上 → 只剥 stem
  if (realKnown.length >= 2) {
    let hit = 0;
    for (let i = 0; i < Math.min(realKnown.length, parsed.length); i++) {
      if (looksSame(realKnown[i], parsed[i])) hit++;
    }
    if (hit >= Math.ceil(Math.min(realKnown.length, parsed.length) * 0.6)) {
      return { stem: cleanHead, options: known, changed: true, reason: 'stripped-duplicate' };
    }
  }

  return { stem, options: known, changed: false, reason: 'mismatch' };
}

module.exports = { splitOptionSequence, normalizeQuestionStem };
