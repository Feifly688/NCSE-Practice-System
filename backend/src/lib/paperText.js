/**
 * 试卷文本预处理：把 PDF/网页抽取出来的"脏"文本整理成可稳定切题的结构。
 *
 * 背景（基于真实粉笔模考 PDF 的实测）：
 *   1. 页眉页脚噪声：每页都有「第 N 页，共 M 页」和重复的试卷标题，
 *      28 页就是 56 行噪声，还会把一道题的题干和选项拦腰截断。
 *   2. 题号有两种排版：
 *        格式 A：题号独立成行 —— "106."
 *        格式 B：题号跟在题干行尾 —— "……以下哪类产品一定不由己负责？106."
 *      格式 B 占 44/126，规则若只认行首题号，会漏掉三分之一。
 *   3. 选项挤在一行："A.3045B.3145C.3200D.3255"（PDF 文本层的典型产物），
 *      模型需要自行拆分，拆错就整题作废。
 *
 * 预处理做四件事：去页眉页脚 → 题号归一化 → 选项拆行 → 识别分区与板块材料。
 */

/** 页码行：「第 12 页，共 28 页」 */
const PAGE_NOISE = /^\s*第\s*\d{1,4}\s*页\s*[,，]?\s*共\s*\d{1,4}\s*页\s*$/;
/** 空白占位行（PDF 文本层常用全角空格表示图片区域） */
const BLANK_LINE = /^[　\s]*$/;
/** 独立成行的题号 */
const STANDALONE_NUM = /^\s*(\d{1,3})\s*[.、．]\s*$/;
/** 行尾题号：数字前不能紧跟字母/数字；前置标点不再强制（类比推理题如「堤溃蚁孔：薪尽火灭96.」无标点） */
const TRAILING_NUM = /(\d{1,3})\s*([.、．])?\s*$/;
/** 以选项标记开头的行 —— 这类行的行尾数字属于选项内容，不能当题号 */
const OPTION_LINE = /^\s*[A-D]\s*[.．、]/;
/** 行内选项标记：A. / A． / A、 */
const OPTION_MARK = /([A-D])\s*[.．、]\s*/g;

/**
 * 删除页眉页脚噪声。
 *
 * 页眉识别不能只靠调用方传标题（上传时的文件名往往是「粉笔39季模考」，
 * 而页眉上的真实标题是「2027年国考第三十九季行测模考大赛（行政执法类）」），
 * 漏删的页眉会插在「题号行」和「选项行」之间，让题号识别失效。
 *
 * 判定方式：**页眉总是紧挨着页码行**。因此先定位所有「第N页，共M页」，
 * 再把这些行前后 2 行内、且全文重复出现 ≥3 次的短行判为页眉。
 * 不能简单地把「全文重复 ≥3 次的行」都删掉 —— 试卷里
 * 「从所给的四个选项中，选择最合适的一个填入问号处……」这类题干本来就重复十几次。
 *
 * @param {string} text
 * @param {string[]} extraTitles 额外指定的标题片段
 */
function stripPageNoise(text, extraTitles = []) {
  const titles = extraTitles.filter((t) => t && t.length >= 6);
  const rawLines = String(text || '').split('\n');

  const counter = new Map();
  for (const l of rawLines) {
    const t = l.trim();
    if (!t || t.length > 60) continue;
    counter.set(t, (counter.get(t) || 0) + 1);
  }
  const isRepeated = (t) => {
    if (!t || t.length > 60) return false;
    if ((counter.get(t) || 0) >= 3) return true;
    return titles.some((x) => t.includes(x) || x.includes(t));
  };

  // 页码行之后出现的重复短行 = 页眉
  // 只看页码行「之后」：PDF 文本流里页眉排在页码之后（"第 14 页，共 28 页" → 试卷标题），
  // 而页码之前紧邻的往往是上一题的题干（如图形推理题那十几次重复的题干），
  // 一起删会把题干删掉，导致题号行后面不再是选项行、题号反而识别不到。
  const headerLines = new Set();
  rawLines.forEach((l, i) => {
    if (!PAGE_NOISE.test(l.trim())) return;
    for (let k = i + 1; k <= Math.min(rawLines.length - 1, i + 2); k++) {
      if (PAGE_NOISE.test(rawLines[k].trim())) continue;
      if (isRepeated(rawLines[k].trim())) headerLines.add(k);
    }
  });

  const kept = [];
  rawLines.forEach((raw, i) => {
    const line = raw.trim();
    if (PAGE_NOISE.test(line)) return;
    if (headerLines.has(i)) return;
    if (BLANK_LINE.test(line)) { kept.push(''); return; }
    kept.push(raw);
  });

  // 压缩连续空行
  const out = [];
  for (const l of kept) {
    if (l === '' && out.length && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.join('\n');
}

/**
 * 题号归一化：把行尾题号拆成独立成行，让下游（切片、计数、去重）只面对一种格式。
 * 同时返回原文出现的题号列表，供题数对账使用。
 *
 * 关键约束：题号行的**下一行必须是以 A./B./C./D. 开头的选项行**。
 * 没有这条约束，「负者需交出4枚硬币」这种跨行断句会把行尾的「4」误判成题号，
 * 导致题号计数虚高、分区归属错乱。
 */
function normalizeQuestionNumbers(text) {
  const lines = String(text || '').split('\n');
  const isOptionLine = (l) => !!l && OPTION_LINE.test(l);
  // 题号行与选项行之间可能夹着空行（PDF 文本层常见），需跳过空行再判断
  const nextOptionLine = (from) => {
    for (let k = from; k < Math.min(lines.length, from + 3); k++) {
      if (!lines[k].trim()) continue;
      return isOptionLine(lines[k]);
    }
    return false;
  };

  const out = [];
  const numbers = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const standalone = line.match(STANDALONE_NUM);
    if (standalone) {
      const n = Number(standalone[1]);
      numbers.push(n);
      out.push(`${n}.`);
      continue;
    }
    // 行尾题号：以选项标记开头的行不参与判定（其行尾数字属于选项内容）
    if (!OPTION_LINE.test(line)) {
      const m = line.match(TRAILING_NUM);
      if (m) {
        const n = Number(m[1]);
        const head = line.slice(0, line.length - m[0].length).trim();
        const before = head.slice(-1);
        const okPrefix = before === '' || !/[0-9A-Za-z]/.test(before);
        // 结构约束：下一行（可跳过空行）必须是选项行
        const nextIsOption = nextOptionLine(i + 1);
        if (n >= 1 && n <= 300 && okPrefix && nextIsOption && (head.length > 0 || m[2])) {
          numbers.push(n);
          if (head) out.push(head);
          out.push(`${n}.`);
          continue;
        }
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), numbers };
}

/**
 * 选项拆行：把 "A.xxxB.xxxC.xxxD.xxx" 拆成 4 行。
 *
 * 判定依据是「行内出现 2 个及以上选项标记，且标记后紧跟内容」；
 * 只拆 A/B/C/D 这四个字母，避免误伤选项正文里的 "13周岁" 这类数字。
 */
function splitMergedOptions(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^[A-D]\s*[.．、]/.test(trimmed)) { out.push(line); continue; }
    // 收集行内选项标记位置
    const marks = [];
    OPTION_MARK.lastIndex = 0;
    let m;
    while ((m = OPTION_MARK.exec(trimmed)) !== null) {
      // 标记后必须还有内容才算一个完整选项
      if (m.index + m[0].length < trimmed.length) marks.push({ letter: m[1], start: m.index, end: m.index + m[0].length });
      if (OPTION_MARK.lastIndex === m.index) OPTION_MARK.lastIndex++;
    }
    if (marks.length < 2) { out.push(line); continue; }
    for (let i = 0; i < marks.length; i++) {
      const content = trimmed.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : trimmed.length).trim();
      out.push(`${marks[i].letter}. ${content}`);
    }
  }
  return out.join('\n');
}

/**
 * 识别分区标题与板块共享材料。
 *
 * 资料分析/逻辑判断这类板块，材料（长段落）只出现在板块开头、第一个题号之前，
 * 后续题目在原文里没有材料 —— 模型无从关联。这里把材料提取出来，随分片下发给模型。
 *
 * @returns {Array<{name: string, material: string, line: number}>}
 */
function extractSections(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  const isHeading = (l) => {
    const t = l.trim();
    if (!t || t.length > 80) return false;
    if (/^第\s*[一二三四五六七八九十百\d]+\s*部分/.test(t)) return true;
    const m = t.match(/^[一二三四五六七八九十]+\s*[、.．]\s*(.{2,12})/);
    return !!m;
  };
  const nameOf = (l) => {
    const t = l.trim();
    const m1 = t.match(/^第\s*[一二三四五六七八九十百\d]+\s*部分\s*[:：、.．]?\s*([\u4e00-\u9fa5]{2,12})/);
    if (m1) return m1[1];
    const m2 = t.match(/^[一二三四五六七八九十]+\s*[、.．]\s*([\u4e00-\u9fa5]{2,12})/);
    if (m2) return m2[1];
    return t.replace(/^第.*部分\s*[:：]?\s*/, '').split(/[：:]/)[0].slice(0, 12);
  };

  let cur = null;
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeading(line)) {
      if (cur && !cur.materialLocked) { cur.material = pending.join('\n').trim(); cur.materialLocked = true; }
      pending.length = 0;
      cur = { name: nameOf(line), material: '', line: i, heading: line.trim(), materialLocked: false };
      sections.push(cur);
      continue;
    }
    if (cur) {
      // 题号行出现 → 板块材料到此为止（只锁定一次，后续题号不再覆盖）
      if (!cur.materialLocked && STANDALONE_NUM.test(line)) {
        cur.material = pending.join('\n').trim();
        cur.materialLocked = true;
        pending.length = 0;
        continue;
      }
      const t = line.trim();
      if (t && !cur.materialLocked) pending.push(t);
    }
  }
  if (cur && !cur.materialLocked) cur.material = pending.join('\n').trim();
  return sections;
}

/**
 * 判断一段文本是否是「纯材料」（不含疑问句式）。
 *
 * 资料分析板块的材料是数据描述（"……同比增长7.1%，较上年同期提高0.3个百分点。"），
 * 而第一题自己的题干一定带问句（"下列说法正确的是（ ）。"）。
 * 用疑问特征词把两者区分开，避免把某题的题干误当成板块共享材料回填给同板块所有题。
 */
const QUESTION_MARKERS = /下列|以下|哪项|哪一|哪类|哪几|不正确|不属于|不符合|最恰当|错误的是|正确的是|不正确的是/;

/** 是否是「题干行」（含问号、答题空位或疑问特征词） */
function isStemLine(line) {
  const t = String(line || '').trim();
  if (/[（(]\s*[)）]/.test(t)) return true;
  if (/[？?]/.test(t)) return true;
  if (QUESTION_MARKERS.test(t)) return true;
  return false;
}

/** 统计型材料的特征词（资料分析/数据类板块） */
const DATA_MARKERS = /%|％|百分点|同比|环比|亿元|万元|万件|亿|万亿|规模以上|增长率|占比|比重/;

/**
 * 从「板块标题行 → 该板块首题号行」区间中提取板块共享材料。
 *
 * 资料分析的写法是：标题 → 一整段数据材料 → 第 1 题题干 → 题号 → 选项，
 * 后续题目不再重复材料。若只按「首题前置段落」取，会把第 1 题自己的题干也带进来；
 * 若只按「首行到首个题号」取，又会混入上一板块的残留。
 *
 * 判定条件（三条同时满足才认定为共享材料）：
 *   1. 剥掉末尾连续的题干行后，长度 ≥ 60；
 *   2. 剩余部分不含疑问特征词（否则那是某题的题干/引言，不是共享材料）；
 *   3. 剩余部分含统计型材料特征（数据密集），排除常识判断/数量关系那类
 *      "一段引言 + 一道题"的写法 —— 那些引言只属于该板块第一题。
 */
function extractMaterial(segLines) {
  const lines = (segLines || []).filter((l) => l.trim() && !OPTION_LINE.test(l));
  let end = lines.length;
  while (end > 0 && isStemLine(lines[end - 1])) end--;
  const mat = lines.slice(0, end).join('\n').trim();
  if (mat.length < 60) return '';
  if (QUESTION_MARKERS.test(mat)) return '';
  if (!DATA_MARKERS.test(mat)) return '';
  return mat;
}

/**
 * 建立「题号索引」：每个题号在文本中的行号、所属分区、前置段落。
 *
 * 前置段落 = 上一题号行之后到本题号行之前的非选项行内容。
 */
function buildQuestionIndex(text, sections = []) {
  const lines = String(text || '').split('\n');
  const numAt = [];
  lines.forEach((l, i) => {
    const m = l.match(STANDALONE_NUM);
    if (m) numAt.push({ num: Number(m[1]), line: i });
  });

  const sectionAt = (line) => {
    let s = null;
    for (const sec of sections) { if (sec.line <= line) s = sec; else break; }
    return s;
  };

  const byNumber = new Map();
  for (let k = 0; k < numAt.length; k++) {
    const start = k > 0 ? numAt[k - 1].line + 1 : 0;
    const end = k + 1 < numAt.length ? numAt[k + 1].line : lines.length;
    const pre = lines
      .slice(start, numAt[k].line)
      .filter((l) => l.trim() && !OPTION_LINE.test(l))
      .join('\n')
      .trim();
    // 本题的完整文本块（题干 + 选项），用于把 AI 拆出的题与原文题号对齐
    const blockText = lines.slice(start, end).join(' ').trim();
    const sec = sectionAt(numAt[k].line);
    byNumber.set(numAt[k].num, {
      num: numAt[k].num,
      line: numAt[k].line,
      pre,
      blockText,
      section: sec ? sec.name : '未分区',
    });
  }

  // 板块共享材料 = 标题行之后、该板块首题号行之前的材料段
  for (const sec of sections) {
    const first = numAt.find((q) => q.line > sec.line);
    sec.firstQuestionNo = first ? first.num : null;
    sec.material = first ? extractMaterial(lines.slice(sec.line + 1, first.line)) : '';
    sec.materialFromQuestion = sec.firstQuestionNo;
  }

  return { numbers: [...byNumber.keys()].sort((a, b) => a - b), byNumber, numAt };
}

/**
 * 完整预处理。
 * @param {string} text
 * @returns {{text: string, questionCount: number, numbers: number[], sections: Array, index: object}}
 */
function preprocessPaperText(text, opts = {}) {
  let t = String(text || '');
  const titles = opts.titles || [];
  t = stripPageNoise(t, titles);
  const norm = normalizeQuestionNumbers(t);
  t = splitMergedOptions(norm.text);
  const sections = extractSections(t);
  const index = buildQuestionIndex(t, sections);
  const numbers = index.numbers;
  return {
    text: t,
    questionCount: numbers.length,
    maxQuestionNo: numbers.length ? Math.max(...numbers) : 0,
    numbers,
    sections,
    index,
  };
}

module.exports = {
  preprocessPaperText,
  stripPageNoise,
  normalizeQuestionNumbers,
  splitMergedOptions,
  extractSections,
  buildQuestionIndex,
};
