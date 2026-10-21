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
3. 选项必须与原文一致，答案必须明确；无法确定答案的题直接跳过不输出
4. 材料段落（passage）归到所属题目，不要重复出现在多道题中
5. 考试说明、注意事项、页眉页脚、答案卡说明等非题目内容不要输出`;

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
 * @param {string} text 整卷文本
 * @param {object} opts { target, max }
 * @returns {Array<{ section: string, text: string, index: number }>}
 */
function splitIntoChunks(text, opts = {}) {
  const target = opts.target || 2400;
  const max = opts.max || 3400;
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

  const chunks = [];
  let section = '未分区';
  let buf = [];

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({ section, text: buf.join('\n'), index: chunks.length });
    buf = [];
  };

  for (const line of lines) {
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
      // 尽量在题号边界收尾：向后找最近的下一题起始行
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
  return merged.map((c, i) => ({ ...c, index: i }));
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

/** 清洗模型输出的一道题 */
function normalizeQuestion(q) {
  if (!q || !q.stem) return null;
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => String(o).replace(/^[A-D][.、．)\s]*/i, '').trim())
    .filter((o) => o.length > 0);
  if (options.length < 2) return null;

  const answer = normalizeAnswer(q.answer, options.length);
  if (!answer) return null;

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

  const user =
    `试卷标题：${paperTitle}\n` +
    `当前模块：${chunk.section}\n` +
    `说明：这是试卷的一个片段，请提取其中出现的全部题目。\n\n` +
    `片段正文：\n${chunk.text}`;

  let attempts = 0;
  let lastError = null;

  for (attempts = 1; attempts <= 2; attempts++) {
    let res;
    try {
      res = await callChat({ system: SYSTEM_PROMPT, user, maxTokens });
    } catch (err) {
      lastError = 'AI 调用失败：' + err.message;
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
      const questions = dedupeList(raw.map(normalizeQuestion).filter(Boolean));

      // 输出被截断：切片减半递归，尽量覆盖被丢掉的题目
      if (res.truncated && depth < 2 && chunk.text.length > 1200) {
        const halves = splitHalf(chunk.text);
        const collected = [];
        const errors = [];
        for (let i = 0; i < halves.length; i++) {
          const r = await parseChunk({ section: chunk.section, text: halves[i] }, { ...opts, depth: depth + 1 });
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
        const r = await parseChunk({ section: chunk.section, text: h }, { ...opts, depth: depth + 1 });
        collected.push(...r.questions);
        if (r.error) errors.push(r.error);
      }
      if (collected.length > 0) {
        return { questions: dedupeList(collected), error: errors[0] || null, degraded: 'split-retry', attempts };
      }
      return { questions: [], error: lastError, degraded: 'split-failed', attempts };
    }
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
