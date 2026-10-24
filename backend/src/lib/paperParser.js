/**
 * 整卷 → 结构化题目：分批拆题 + 输出校验 + 重试 + 降级。
 *
 * 为什么必须分批：整卷（行测约 100-130 题、2-4 万字）一次性交给模型输出，
 * 会直接打满模型输出上限（实测 glm-4-flash completion_tokens 打满 1024），
 * JSON 在第 4 题处被截断，导致解析失败、整卷拆题崩掉。这里改为按段落切片，
 * 每片控制在约 2400 字（约 6-8 题），逐片调用并在片内做输出校验与重试。
 *
 * 降级链（单片）：
 *   正常解析 → 输出被截断/解析失败 → 切片减半递归重试（最多 2 层）
 *   → 仍失败则用「平衡扫描抢救」保留已完整生成的题目（部分成功）
 *   → 全片失败则记录原因，不影响其他片
 */
const { callChat, extractJson } = require('./aiClient');
const { buildFingerprint, findDuplicate } = require('./questionDedupe');
const { QUESTION_MARKERS } = require('./paperText');

const SYSTEM_PROMPT = `你是公考真题数字化专家，负责把试卷文本切分为结构化题目。

## 任务
从给定的试卷片段中逐题提取，不要遗漏，也不要凭空编造原文没有的题目。

## 字段
每道题输出：
- module：模块/分区名（如 常识判断 / 言语理解与表达 / 判断推理 / 数量关系 / 资料分析 / 政治理论）
- qtype：题型（单选题 / 多选题 / 判断题；无法判断时用 单选题）
- difficulty：1-5 的整数
- passage：本题材料段落（没有材料则填空字符串 ""）
- stem：题干（含问句，保留原文表述）
- options：选项数组，按 A/B/C/D 顺序
- answer：答案字母（单选如 "A"，多选如 "AB"）
- explanation：解析，60-150 字

## 硬性要求
1. **只输出 JSON**，不要输出任何解释文字，不要用 \`\`\` 代码块包裹
2. JSON 结构必须且只能是：{"questions":[ ... ]}
3. 选项必须与原文一致。**本试卷文本通常不含答案**，无法确定答案时 answer 填空字符串 ""，
   但**题目必须全部输出，一道都不能少** —— 漏题是严重错误，无答案的题由后续人工补充，
   绝不允许因为找不到答案就跳过整道题
4. 材料段落（passage）归到所属题目，不要重复出现在多道题中
5. 考试说明、注意事项、页眉页脚、答案卡说明等非题目内容不要输出

## 特别注意（真题 PDF 的常见坑）
6. 题号可能单独成行（"106."），也可能跟在题干末尾（"……最恰当的一项是：106."），
   两种都要识别；题号之后紧跟的是该题的 A/B/C/D 选项。
7. 如果某题的选项在原文里只有 "A." "B." "C." "D." 而没有文字内容，
   说明选项是图片（图形推理、几何图、统计图等）：
   仍然要输出这道题，options 填 ["（图片选项）","（图片选项）","（图片选项）","（图片选项）"]，
   stem 保留原文题干，**不要因为选项没有文字就丢掉这道题**。
8. 如果片段开头给出了【本篇资料共享材料】，而题目（尤其是资料分析题）依赖这段材料，
   请把该材料原文填入这些题的 passage；不依赖材料的题 passage 留空。
9. 材料/题干中出现的换行请保留为 "\\n"，不要合并成一段。
10. **输出前先数一遍片段正文里的题号个数，questions 数组长度必须与之相等**；
    漏题比多输出严重得多，宁可多保留也不要少。
11. **一道题只能输出一次，不要在中间拆开**：政治理论的组合表述题写法是
    「长题干 + ①②③④编号行 + A.①②③ / B.②③④ 选项」，编号行与选项行都属于**同一道题**，
    编号行不是新题的开始；不要把一道长题拆成多道输出，也不要把相邻两道题合并成一道。`;

const MODULE_NAMES = '常识判断|言语理解与表达|判断推理|数量关系|资料分析|政治理论|公共基础知识|申论|政治';

/** 标准行测模块名（module 归一化的目标集） */
const STANDARD_MODULES = ['常识判断', '言语理解与表达', '判断推理', '数量关系', '资料分析', '政治理论'];

/**
 * 模块名归一化。
 *
 * 模型输出的 module 不稳定：同一份「判断推理」板块，有时输出"判断推理"、
 * 有时输出"逻辑判断"/"图形推理"（国考大纲里这四个是判断推理的子类），
 * 还有"判断推理-逻辑判断"这类带后缀的写法。不归一化会让答题卡分区
 * 裂成多行（实测"判断推理 25 题 + 逻辑判断 7 题"）。
 *
 * @param {string} raw 模型输出的模块名
 * @returns {string|null} 归一化后的模块名；无法识别时保留原样
 */
function normalizeModule(raw) {
  const t = String(raw || '')
    .trim()
    .replace(/[（(][^)）]*[)）]/g, '')   // 去掉括号注释：「判断推理（逻辑判断）」→「判断推理」
    .replace(/[-—:：].*$/, '')          // 去掉连字符后缀：「判断推理-逻辑判断」→「判断推理」
    .trim();
  if (!t) return null;
  if (STANDARD_MODULES.includes(t)) return t;
  // 子类型 → 父类（判断推理的四个子类最常见）
  if (/逻辑判断|图形推理|定义判断|类比推理|科学推理/.test(t)) return '判断推理';
  if (/言语|阅读|片段|篇章|语句表达/.test(t)) return '言语理解与表达';
  if (/政治|思想/.test(t)) return '政治理论';
  if (/常识/.test(t)) return '常识判断';
  if (/数量|数学运算|数字推理/.test(t)) return '数量关系';
  if (/资料|数据/.test(t)) return '资料分析';
  return t;
}

/**
 * 识别分区标题并提取模块名。
 * 真实试卷的标题行常与说明文字同行，例如
 *   "一. 政治理论：根据题目要求，在四个选项中选出一个最恰当的答案。"
 * 因此按前缀匹配并截取模块名，而不是整行比对。
 * @returns {string|null} 模块名，如 政治理论
 */
function matchSection(line) {
  const l = String(line || '').trim();
  if (!l || l.length > 60) return null;

  // "第二部分 言语理解与表达：…" / "第 2 部分 常识判断"
  let m = l.match(/^第\s*[一二三四五六七八九十百\d]+\s*部分\s*[:：、.．]?\s*([\u4e00-\u9fa5]{2,12})/);
  if (m) return m[1];

  // "一. 政治理论：…" / "二、常识判断"
  m = l.match(/^[一二三四五六七八九十]+\s*[、.．]\s*([\u4e00-\u9fa5]{2,12})/);
  if (m) return m[1];

  // 直接以模块名开头
  m = l.match(new RegExp('^(' + MODULE_NAMES + ')\\s*[:：]'));
  if (m) return m[1];

  return null;
}

/** 判断一行是否为分区标题（兼容旧调用） */
function isSectionHeading(line) {
  return matchSection(line) !== null;
}

/**
 * 按段落切片：优先在分区标题与题号边界处切分，避免把一道题拆成两半。
 *
 * 之前这里只在「累计字数到阈值」时直接 flush，注释里写的「向后找最近的下一题起始行」
 * 并没有实现 —— 结果一道题会被从中间劈开，模型拿到半截题目，
 * 要么输出不成结构、要么直接丢弃，这正是「130 题只识别出 110 题」的主要成因。
 * 现在真正按题号边界收尾：到达阈值后向后找下一个题号行，把中间内容并入本片。
 *
 * @param {string} text 整卷文本（应已由 lib/paperText 预处理，题号已归一化为独立成行）
 * @param {object} opts { target, max, sections, byNumber }
 *   byNumber：lib/paperText 的题号索引（含 passage/passageShared），用于**题号级**材料下发。
 *   资料分析的每篇材料只出现在篇首题号前，切片后可能与该篇的题目不在同一片，
 *   因此每片要带上「本片第一个题号所属的那篇材料」。
 * @returns {Array<{ section: string, text: string, index: number, material?: string }>}
 */
function splitIntoChunks(text, opts = {}) {
  const target = opts.target || 1900;
  const max = opts.max || 2800;
  const byNumber = opts.byNumber || null;
  // 分区级切片目标：资料分析的题输出时要带回本篇 passage（材料可达 500 字），
  // 输出 token 消耗远大于其他板块——实测 glm-4-flash 上限约 1900 tokens，
  // 一片 11 题（含 passage 回填）输出约 2000 tokens 必被截断（片 17 丢 6 题）。
  // 因此资料分析用 800 字/片（约 4-5 题，输出约 900 tokens，远离上限）。
  const sectionTargets = opts.sectionTargets || { 资料分析: 800 };
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const isQuestionStart = (l) => /^\d{1,3}\s*[.、．]\s*$/.test(l);

  const chunks = [];
  let section = '未分区';
  let buf = [];

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({ section, text: buf.join('\n'), index: chunks.length });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sec = matchSection(line);
    if (sec) {
      flush();
      section = sec;
      // 标题行保留在文本中，为模型提供该模块的说明上下文
      buf.push(line);
      continue;
    }
    buf.push(line);
    const curTarget = sectionTargets[section] || target;
    const size = buf.join('\n').length;
    if (size >= curTarget) {
      // 向后找最近的题号起始行，把当前题的剩余部分并入本片后再切
      let nextQ = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (isQuestionStart(lines[k])) { nextQ = k; break; }
        if (k - i > 80) break; // 连续 80 行没有题号，多半是超长材料，直接切
      }
      if (nextQ > i) {
        for (let k = i + 1; k < nextQ; k++) buf.push(lines[k]);
        i = nextQ - 1;
      }
      flush();
    } else if (size >= max) {
      flush();
    }
  }
  flush();

  // 合并过小的相邻同分区片，减少调用次数（阈值按该分区的目标算）
  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    const lastTarget = sectionTargets[c.section] || target;
    if (last && last.section === c.section && (last.text.length + c.text.length) < lastTarget * 0.6) {
      last.text += '\n' + c.text;
    } else {
      merged.push({ ...c });
    }
  }
  // 附带该分片的共享材料：
  //   1) 题号级优先 —— 本片第一个题号所属的那篇材料（资料分析多篇材料的正确来源）；
  //   2) 板块级兜底 —— 分区标题后提取的板块材料（老逻辑，覆盖无题号索引的场景）。
  // 只下发 passageShared=true 的材料，避免把某题的独立引言当成板块材料污染同片其他题。
  const sectionMaterials = new Map();
  for (const s of opts.sections || []) {
    if (s && s.name && s.material) sectionMaterials.set(s.name, s.material);
  }
  // 找片段内第一个题号。
  // 题号后必须跟「空格 + 内容」（kind C：题号与题干同行）或是行尾（kind A：题号独立成行）。
  // 不能只匹配「数字 + 点」——资料分析材料里「同比增加42.4万张」这类行首数字
  // 会被误判成题号 42，导致该片挂错材料篇（实测片 19 回退到板块材料）。
  const firstQuestionNo = (chunkText) => {
    const m = String(chunkText || '').match(/(?:^|\n)\s*(\d{1,3})\s*[.、．](?:\s+\S|\s*$)/);
    return m ? Number(m[1]) : null;
  };
  return merged.map((c, i) => {
    let material = '';
    if (byNumber && byNumber.size) {
      const no = firstQuestionNo(c.text);
      const q = no != null ? byNumber.get(no) : null;
      if (q && q.passageShared && q.passage) material = q.passage;
    }
    if (!material) material = sectionMaterials.get(c.section) || '';
    return { ...c, index: i, material };
  });
}

/** 规范答案：从 "A"、"A."、"答案A"、"AB" 中提取字母 */
function normalizeAnswer(v, optionCount) {
  const letters = String(v || '').toUpperCase().match(/[A-D]/g) || [];
  if (letters.length === 0) return null;
  const valid = letters.filter((l) => {
    const idx = l.charCodeAt(0) - 65;
    return optionCount ? idx < optionCount : true;
  });
  return valid.length > 0 ? valid.join('') : letters[0];
}

/**
 * 清洗模型输出的一道题。
 *
 * @param {object} q 模型输出
 * @param {object} opts { keepIncomplete }
 *   keepIncomplete=true（拆题阶段）：选项是图片、答案无法确定时**保留题目**并打标记，
 *   避免整题在入库前就被丢掉 —— 这是真题「识别率不足」的另一大来源。
 *   keepIncomplete=false（确认入库阶段）：题目表 answer 为 NOT NULL，无答案的题直接跳过。
 */
function normalizeQuestion(q, opts = {}) {
  const keepIncomplete = !!opts.keepIncomplete;
  if (!q || !q.stem) return null;
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => String(o).replace(/^[A-D][.、．)\s]*/i, '').trim())
    .filter((o) => o.length > 0);

  const answer = normalizeAnswer(q.answer, options.length);

  if (options.length < 2) {
    // 选项在原文中是图片（图形推理/几何图/统计图）：保留题目，选项用占位符
    if (!keepIncomplete) return null;
    return {
      module: normalizeModule(q.module),
      qtype: String(q.qtype || '').trim() || '单选题',
      difficulty: 3,
      passage: String(q.passage || '').trim() || null,
      stem: String(q.stem).trim().slice(0, 2000),
      options: ['（图片选项）', '（图片选项）', '（图片选项）', '（图片选项）'],
      answer: answer || null,
      explanation: String(q.explanation || '').trim().slice(0, 1000) || null,
      hasImageOptions: true,
      needAnswer: !answer,
    };
  }

  if (!answer) {
    // 模型没能给出答案：拆题阶段保留（待人工补答案），入库阶段丢弃
    if (!keepIncomplete) return null;
    return {
      module: normalizeModule(q.module),
      qtype: String(q.qtype || '').trim() || '单选题',
      difficulty: 3,
      passage: String(q.passage || '').trim() || null,
      stem: String(q.stem).trim().slice(0, 2000),
      options: options.slice(0, 6),
      answer: null,
      explanation: String(q.explanation || '').trim().slice(0, 1000) || null,
      needAnswer: true,
    };
  }

  let difficulty = Number(q.difficulty);
  if (!Number.isFinite(difficulty) || difficulty < 1 || difficulty > 5) difficulty = 3;
  difficulty = Math.round(difficulty);

  return {
    module: normalizeModule(q.module),
    qtype: String(q.qtype || '').trim() || '单选题',
    difficulty,
    passage: String(q.passage || '').trim() || null,
    stem: String(q.stem).trim().slice(0, 2000),
    options: options.slice(0, 6),
    answer,
    explanation: String(q.explanation || '').trim().slice(0, 1000) || null,
  };
}

/** 片内去重（题干指纹 + 相似度） */
function dedupeList(list) {
  const out = [];
  for (const q of list) {
    const fp = buildFingerprint(q);
    const dup = findDuplicate({ ...q, fingerprint: fp }, out.map((o) => ({ ...o, id: o._tmpId })), { threshold: 0.92 });
    if (dup) continue;
    out.push({ ...q, fingerprint: fp });
  }
  return out;
}

/** 选项是否是「组合编号」形式（①②③ / ②③④），政治理论组合表述题的典型选项 */
function isCombinationOptions(options) {
  const opts = Array.isArray(options) ? options : [];
  return opts.length >= 2 && opts.every((o) => /^[①②③④⑤⑥⑦⑧⑨⑩]{2,}$/.test(String(o).trim()));
}

/** 选项是否全是「图片占位」（选项内容在原卷里是图形，文本层只剩 A./B./C./D.） */
function isImagePlaceholderOptions(options) {
  const opts = Array.isArray(options) ? options : [];
  return opts.length >= 2 && opts.every((o) => String(o).trim() === '（图片选项）');
}

/**
 * 标准题干白名单：这些句式本身**不含问句**（无问号、无疑问特征词），
 * 但它们是完整的真题题干（图形推理/类比推理/分类题），绝不是残片。
 * 合并残片时必须排除，否则会把整道图形推理题并进上一题。
 */
const STANDARD_STEM = /从所给的四个选项|选择最合适的一个|填入问号|使之呈现一定的规律性|使之成为排列|把下面的六个图形分为两类|分类正确的一项是|从四个图形中选出|以下图形|下列图形|右边哪项|哪项不可能是|立体图形|截面图|每道题呈现一段表述数字关系/;

/**
 * 合并被模型拆散的题残片。
 *
 * 小模型（glm-4-flash）有两种典型的"拆散"行为：
 *   A. 组合表述题（政治理论）：长题干 + ①②③④编号行 + A.①②③ 选项，
 *      编号行之后、问句之前的部分被当成新题——残片无问句、选项是组合编号；
 *   B. 长选项题：某题的选项跨多行（B./C./D. 各占一两行），模型把选项的
 *      后续行当成新题的题干——残片无问句、选项只剩图片占位
 *      （实测 #8 的选项 B/C/D 被当成 seq9）。
 *   prompt 约束不住这两种行为（重跑仍复现），必须代码层兜底。
 *
 * 判据（同时满足才合并，误判率低）：
 *   1. 残片题干**不含问句**（无 ？/? 与疑问特征词）
 *   2. 残片题干**不是标准题干句式**（STANDARD_STEM 白名单，保护图形推理等）
 *   3. 残片选项是**组合编号**或**图片占位**（两种拆散形态各自的选项特征）
 *   4. 前一题题干**含问句**（问句在前半段）
 *   5. 两题**同一模块**（切片边界两侧的题也要能合并，但不同模块不合并）
 * 合并时残片题干并入前一题（剥掉混入的选项行）；若残片选项是组合编号而前一题是
 * 图片占位，用残片选项替换（恢复真实选项内容）。
 *
 * 调用点有两处：parseChunk 内（片内相邻）+ runParseJob 汇总（跨片相邻——
 * 题干与残片被切到不同片时只有汇总层能合上，实测 #15 就是这种情况）。
 */
function mergeFragments(list) {
  const out = [];
  for (const q of list) {
    const prev = out[out.length - 1];
    const qNoQuestion = !QUESTION_MARKERS.test(q.stem) && !/[？?]/.test(String(q.stem || ''));
    const prevHasQuestion = prev && (QUESTION_MARKERS.test(prev.stem) || /[？?]/.test(String(prev.stem || '')));
    const sameModule = prev && q.module && prev.module && String(q.module) === String(prev.module);
    const notStandardStem = !STANDARD_STEM.test(String(q.stem || ''));
    const fragOptions = isCombinationOptions(q.options) || isImagePlaceholderOptions(q.options);
    if (prev && qNoQuestion && notStandardStem && fragOptions && prevHasQuestion && sameModule) {
      // 残片题干里常混入选项行（"A. ①②③"），合并前剥掉，避免 stem 冗余
      const fragStem = String(q.stem || '')
        .replace(/(?:^|\n)\s*[A-D]\s*[.．、]\s*[①②③④⑤⑥⑦⑧⑨⑩]+/g, '')
        .trim();
      if (fragStem) prev.stem = (prev.stem + '\n' + fragStem).slice(0, 2000);
      if (isCombinationOptions(q.options) && !isCombinationOptions(prev.options)) {
        prev.options = q.options;
      }
      continue;
    }
    out.push({ ...q });
  }
  return out;
}

/**
 * 拆分单个片段（含重试与降级）。
 * @returns {Promise<{ questions: Array, error: string|null, degraded: string|null, attempts: number }>}
 */
async function parseChunk(chunk, opts = {}) {
  const depth = opts.depth || 0;
  const paperTitle = opts.paperTitle || '';
  const maxTokens = opts.maxTokens || 4000;
  const material = chunk.material || opts.material || '';

  // 不给模型「应输出题数」的具体数字：题号计数正则会把材料里的数字行误计
  // （实测资料分析片 14 题误计为 15），误导模型反而多输出/少输出。
  // 「自己数题号、一道不落」的要求放在 SYSTEM_PROMPT 第 10 条。
  const user =
    `试卷标题：${paperTitle}\n` +
    `当前模块：${chunk.section}\n` +
    (material
      ? `【本篇资料共享材料】（本篇资料的多道题共用，若题目依赖它，请填入这些题的 passage）：\n${material}\n\n`
      : '') +
    `说明：这是试卷的一个片段，请提取其中出现的全部题目，一道都不要遗漏。\n\n` +
    `片段正文：\n${chunk.text}`;

  let attempts = 0;
  let lastError = null;

  for (attempts = 1; attempts <= 2; attempts++) {
    let res;
    try {
      res = await callChat({ system: SYSTEM_PROMPT, user, maxTokens, timeout: opts.timeout });
    } catch (err) {
      lastError = 'AI 调用失败：' + err.message;
      console.warn(`[paperParser] 片段调用失败（${err.message}），第 ${attempts} 次`);
      continue;
    }

    if (res.truncated) {
      console.warn(
        `[paperParser] 输出被截断：片段 ${chunk.text.length} 字，usage=${JSON.stringify(res.usage)}，` +
        '将降级重试（切片减半）'
      );
    }

    const parsed = extractJson(res.content);

    if (parsed.ok) {
      const raw = Array.isArray(parsed.data) ? parsed.data : parsed.data.questions;
      if (!Array.isArray(raw)) {
        lastError = 'AI 输出 JSON 结构异常（缺少 questions 数组）';
        continue;
      }
      // 拆题阶段保留不完整的题目（图片选项 / 缺答案），只跳过完全无效的输出
      const normalized = raw
        .map((q) => normalizeQuestion(q, { keepIncomplete: true }))
        .filter(Boolean)
        // 材料回填：模型没填 passage 时，用该分片的板块共享材料补上
        // （资料分析的材料只在板块开头出现一次，模型在同一片里未必能关联上）
        .map((q) => (q.passage && q.passage.trim() ? q : { ...q, passage: material || null }));
      // 先合并被拆散的组合表述题残片，再去重（残片会干扰指纹与相似度判定）
      const questions = dedupeList(mergeFragments(normalized));

      // 输出被截断：切片减半递归，尽量覆盖被丢掉的题目
      if (res.truncated && depth < 2 && chunk.text.length > 1200) {
        const halves = splitHalf(chunk.text);
        const collected = [];
        const errors = [];
        for (let i = 0; i < halves.length; i++) {
          const r = await parseChunk({ section: chunk.section, text: halves[i], material }, { ...opts, depth: depth + 1 });
          collected.push(...r.questions);
          if (r.error) errors.push(r.error);
        }
        if (collected.length >= questions.length) {
          return { questions: dedupeList(collected), error: errors[0] || null, degraded: 'split-retry', attempts };
        }
        // 递归没拿到更多题目，保留抢救出的部分结果
        return {
          questions,
          error: '输出被截断，已保留已识别的部分题目',
          degraded: 'salvaged',
          attempts,
        };
      }

      if (res.truncated) {
        return { questions, error: '输出被截断，已保留已识别的部分题目', degraded: 'salvaged', attempts };
      }
      return { questions, error: null, degraded: parsed.salvaged ? 'salvaged' : null, attempts };
    }

    // 解析失败：先重试一次；仍失败则切片减半递归
    lastError = parsed.error || 'AI 输出解析失败';
    if (attempts < 2) continue;
    if (depth < 2 && chunk.text.length > 1200) {
      const halves = splitHalf(chunk.text);
      const collected = [];
      const errors = [];
      for (const h of halves) {
        const r = await parseChunk({ section: chunk.section, text: h, material }, { ...opts, depth: depth + 1 });
        collected.push(...r.questions);
        if (r.error) errors.push(r.error);
      }
      if (collected.length > 0) {
        return { questions: dedupeList(collected), error: errors[0] || null, degraded: 'split-retry', attempts };
      }
      return { questions: [], error: lastError, degraded: 'split-failed', attempts };
    }
  }

  // 走到这里说明整片都没成功（AI 调用超时 / 输出解析失败）。
  // 必须走切片减半递归：一次超时会让整片题目（实测 13 题）全部丢失，
  // 而拆题的超时往往是"片太大"造成的，减半后单片更小、更快。
  if (depth < 2 && chunk.text.length > 800) {
    const halves = splitHalf(chunk.text);
    const collected = [];
    const errors = [];
    for (const h of halves) {
      const r = await parseChunk({ section: chunk.section, text: h, material }, { ...opts, depth: depth + 1 });
      collected.push(...r.questions);
      if (r.error) errors.push(r.error);
    }
    if (collected.length > 0) {
      return {
        questions: dedupeList(collected),
        error: (errors[0] || lastError || '整片失败，已通过切片减半抢救') + '（已通过切片减半抢救部分题目）',
        degraded: 'split-retry',
        attempts,
      };
    }
    return { questions: [], error: lastError, degraded: 'split-failed', attempts };
  }

  return { questions: [], error: lastError, degraded: 'failed', attempts };
}

/** 从中间（就近题号边界）把文本切成两半 */
function splitHalf(text) {
  const lines = String(text || '').split('\n');
  if (lines.length < 2) return [text];
  const mid = Math.floor(lines.length / 2);
  // 从 mid 向两侧找最近的题号起始行作为切点，避免切断题目
  const isQuestionStart = (l) => /^\s*\d{1,3}\s*[.、．]/.test(l);
  let cut = mid;
  for (let d = 0; d < Math.min(mid, lines.length - mid); d++) {
    if (isQuestionStart(lines[mid - d])) { cut = mid - d; break; }
    if (mid + d < lines.length && isQuestionStart(lines[mid + d])) { cut = mid + d; break; }
  }
  return [lines.slice(0, cut).join('\n'), lines.slice(cut).join('\n')].filter((t) => t.trim().length > 0);
}

/** 并发控制：简单任务池 */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = { questions: [], error: err.message, degraded: 'failed', attempts: 0 };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  SYSTEM_PROMPT,
  splitIntoChunks,
  splitHalf,
  normalizeQuestion,
  normalizeAnswer,
  normalizeModule,
  isCombinationOptions,
  mergeFragments,
  dedupeList,
  parseChunk,
  runPool,
  isSectionHeading,
  matchSection,
};
