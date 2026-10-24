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
    漏题比多输出严重得多，宁可多保留也不要少。`;

const MODULE_NAMES = '常识判断|言语理解与表达|判断推理|数量关系|资料分析|政治理论|公共基础知识|申论|政治';

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
    const size = buf.join('\n').length;
    if (size >= target) {
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

  // 合并过小的相邻同分区片，减少调用次数
  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.section === c.section && (last.text.length + c.text.length) < target * 0.6) {
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
  // 找片段内第一个题号（行首「111.」或独立成行的「111.」都已归一化）
  const firstQuestionNo = (chunkText) => {
    const m = String(chunkText || '').match(/(?:^|\n)\s*(\d{1,3})\s*[.、．]/);
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
      module: String(q.module || '').trim() || null,
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
      module: String(q.module || '').trim() || null,
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
    module: String(q.module || '').trim() || null,
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

/**
 * 拆分单个片段（含重试与降级）。
 * @returns {Promise<{ questions: Array, error: string|null, degraded: string|null, attempts: number }>}
 */
async function parseChunk(chunk, opts = {}) {
  const depth = opts.depth || 0;
  const paperTitle = opts.paperTitle || '';
  const maxTokens = opts.maxTokens || 4000;
  const material = chunk.material || opts.material || '';

  // 片段内题号个数：给模型一个明确的「应输出题数」目标，减少漏题
  const qCount = (String(chunk.text || '').match(/(?:^|\n)\s*\d{1,3}\s*[.、．]/g) || []).length;

  const user =
    `试卷标题：${paperTitle}\n` +
    `当前模块：${chunk.section}\n` +
    (material
      ? `【本篇资料共享材料】（本篇资料的多道题共用，若题目依赖它，请填入这些题的 passage）：\n${material}\n\n`
      : '') +
    `说明：这是试卷的一个片段，请提取其中出现的全部题目。` +
    (qCount > 0 ? `片段中可见题号 ${qCount} 个，questions 数组长度应与之相等。` : '') +
    `\n\n片段正文：\n${chunk.text}`;

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
      const questions = dedupeList(normalized);

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
  dedupeList,
  parseChunk,
  runPool,
  isSectionHeading,
  matchSection,
};
