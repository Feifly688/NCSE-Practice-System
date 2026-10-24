/**
 * AI 客户端：统一封装 chat / vision 调用，内置重试、超时与「AI 输出 → JSON」的健壮解析。
 *
 * 背景：拆题曾稳定失败，根因是整卷一次性输出超过模型输出上限（glm-4-flash
 * completion_tokens 打满 1024）导致 JSON 被截断，且返回被 ```json 代码块包裹，
 * JSON.parse 直接失败、正则兜底也失败。因此这里提供：
 *   - 显式 max_tokens，避免静默打满上限
 *   - finish_reason 检测（length = 被截断），交由上层降级处理（缩小批次重试）
 *   - extractJson：剥离代码块、剔除前后说明文字、平衡扫描「挽救」被截断的
 *     JSON（保留已完整输出的题目），而不是整批丢弃
 *   - 网络/5xx/429 自动重试（指数退避）
 */
const axios = require('axios');

const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.BASE_URL;
const MODEL = process.env.MODEL;
const VISION_MODEL = process.env.VISION_MODEL || 'glm-4v-flash';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureConfigured() {
  if (!API_KEY || !BASE_URL) throw new Error('AI 服务未配置（API_KEY / BASE_URL）');
}

/**
 * 调用 chat 接口。
 * @returns {{ content: string, finishReason: string|null, usage: object, truncated: boolean }}
 */
async function callChat({ system, user, maxTokens = 4000, temperature = 0.2, timeout = 300000, retries = 2 }) {
  ensureConfigured();
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        BASE_URL + '/chat/completions',
        {
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
          timeout,
        }
      );
      const choice = (res.data && res.data.choices && res.data.choices[0]) || {};
      const content = String((choice.message && choice.message.content) || '');
      const finishReason = choice.finish_reason || null;
      return {
        content,
        finishReason,
        usage: res.data.usage || {},
        // length/tool_calls 都说明输出不完整（多数模型 length = 打满 max_tokens）
        truncated: finishReason === 'length',
      };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status >= 500 || status === 429;
      console.error(`[ai] chat 调用失败(第 ${attempt + 1} 次): ${err.message}${status ? ' status=' + status : ''}`);
      if (!retryable || attempt === retries) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  const status = lastErr?.response?.status;
  const detail = lastErr?.response?.data
    ? JSON.stringify(lastErr.response.data).slice(0, 200)
    : lastErr?.message;
  throw new Error(`AI 调用失败${status ? '(HTTP ' + status + ')' : ''}: ${detail}`);
}

/**
 * 视觉模型识别（用于扫描件/图片型 PDF 的 OCR 降级）。
 * @param {string} imageBase64 PNG 图片的 base64
 */
async function callVision({ imageBase64, prompt, maxTokens = 4000, timeout = 180000 }) {
  ensureConfigured();
  const res = await axios.post(
    BASE_URL + '/chat/completions',
    {
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    },
    {
      headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      timeout,
    }
  );
  const choice = (res.data && res.data.choices && res.data.choices[0]) || {};
  return {
    content: String((choice.message && choice.message.content) || ''),
    truncated: choice.finish_reason === 'length',
  };
}

/** 剥离 ```json 代码块与前后说明文字 */
function stripFences(raw) {
  let s = String(raw || '').trim();
  // 开头 ```json / ```JSON / ```
  s = s.replace(/^```(?:json|JSON|jsonc)?\s*/, '');
  // 结尾 ```
  s = s.replace(/```\s*$/, '');
  s = s.trim();
  // 去掉 JSON 之前的说明文字（取第一个 { 或 [ 起始）
  const start = s.search(/[{\[]/);
  if (start > 0) s = s.slice(start);
  return s;
}

/**
 * 平衡扫描：从被截断的 JSON 中「挽救」已完整输出的部分。
 *
 * 对 {"questions":[{...},{...},{..(截断)} 这类内容，找到最后一个完整闭合的
 * 题目对象（深度回到数组层级），补齐 "]}" 从而保留已生成的部分结果。
 */
function salvageTruncated(s) {
  const rootIsArray = s[0] === '[';
  // 题目对象所在深度：根对象 { -> 1, questions 数组 [ -> 2, 题目对象 { -> 3
  // 根数组：[ -> 1, 题目对象 { -> 2
  const elemDepth = rootIsArray ? 2 : 3;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastComplete = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      // 从 elemDepth 回到 elemDepth-1 说明一个题目对象完整闭合
      if (depth === elemDepth - 1) lastComplete = i;
    }
  }

  if (lastComplete < 0) return null;
  let candidate = s.slice(0, lastComplete + 1);
  if (rootIsArray) candidate += ']';
  else candidate += ']}';
  // 修补尾部逗号（如 {..},]} 中多余的逗号）
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');
  return candidate;
}

/**
 * 从 AI 输出中解析 JSON。
 * @returns {{ ok: boolean, data: any, salvaged: boolean, error?: string }}
 *   salvaged=true 表示内容曾被截断，返回的是抢救出的部分结果
 */
function extractJson(raw) {
  const s = stripFences(raw);
  if (!s) return { ok: false, data: null, salvaged: false, error: 'AI 返回内容为空' };

  try {
    return { ok: true, data: JSON.parse(s), salvaged: false };
  } catch (e1) {
    // 尝试修补：尾部逗号 / 末尾多余逗号
    const repaired = s.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]/g, ' ');
    try {
      return { ok: true, data: JSON.parse(repaired), salvaged: true };
    } catch (e2) {
      const salvaged = salvageTruncated(s);
      if (salvaged) {
        try {
          return { ok: true, data: JSON.parse(salvaged), salvaged: true };
        } catch (e3) {
          return { ok: false, data: null, salvaged: false, error: 'JSON 解析失败: ' + e3.message.slice(0, 120) };
        }
      }
      return { ok: false, data: null, salvaged: false, error: 'JSON 解析失败: ' + e2.message.slice(0, 120) };
    }
  }
}

module.exports = { callChat, callVision, extractJson, stripFences, salvageTruncated };
