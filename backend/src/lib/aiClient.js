/**
 * AI 客户端：统一封装 chat / vision / image 调用，内置多供应商路由、
 * 并发闸门、限流退避重试与「AI 输出 → JSON」的健壮解析。
 *
 * ── 为什么改成多供应商 ────────────────────────────────────────────
 * 实测两个服务特性完全不同：
 *   · 智谱 glm-4-flash：并发 3 稳定，但单次响应慢（整卷拆题单片 45-100s）
 *   · Agnes  agnes-3.0-flash：单次快得多（同一片段 15s），但免费额度对**瞬时并发**
 *     很敏感（并发 5 成功 3/5、并发 10 成功 1/10、并发 20 全部 429）
 * 所以策略是：**Agnes 当主力 + 智谱兜底**，并且用「并发闸门」把每个供应商的
 * 实际在途请求数压到它能承受的范围 —— 429 随之消失，而不是靠事后重试硬扛。
 *
 * ── 视觉模型说明 ──────────────────────────────────────────────────
 * · 智谱 glm-4v-flash：视觉理解
 * · Agnes agnes-3.0-flash：也支持 image_url 输入，实测 16s 准确读出图形题内容，
 *   可作 OCR 主力
 * · Agnes agnes-image-2.5-flash：**图像生成**模型（服务端会拒绝 image_url 理解
 *   请求，要求走 /v1/images/generations），与"看图"是两回事，不能当视觉模型用
 */
const axios = require('axios');

const CHAT_TIMEOUT_MS = Number(process.env.AI_CHAT_TIMEOUT_MS || 90000);

/** 供应商配置：每个供应商有自己的 baseUrl / key / 模型 / 并发上限 */
function buildProviders() {
  const list = [];
  const agnesKey = process.env.AGNES_API_KEY;
  if (agnesKey) {
    list.push({
      name: 'agnes',
      baseUrl: (process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, ''),
      apiKey: agnesKey,
      model: process.env.AGNES_MODEL || 'agnes-3.0-flash',
      imageModel: process.env.AGNES_IMAGE_MODEL || 'agnes-image-2.5-flash',
      // agnes-3.0-flash 官方支持 image_url 输入，可作视觉模型（实测 16s 读图准确）
      supportsVision: true,
      limit: Math.max(1, Number(process.env.AGNES_CONCURRENCY || 3)),
    });
  }
  if (process.env.API_KEY && process.env.BASE_URL) {
    list.push({
      name: 'bigmodel',
      baseUrl: process.env.BASE_URL.replace(/\/+$/, ''),
      apiKey: process.env.API_KEY,
      model: process.env.MODEL || 'glm-4-flash',
      visionModel: process.env.VISION_MODEL || 'glm-4v-flash',
      supportsVision: true,
      limit: Math.max(1, Number(process.env.BIGMODEL_CONCURRENCY || 2)),
    });
  }
  return list;
}

const PROVIDERS = buildProviders();
const PROVIDER_ORDER = (process.env.AI_PROVIDER_ORDER || 'agnes,bigmodel')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** 并发闸门：把在途请求数限制在供应商能承受的范围（避免 429 的根本手段） */
function createGate(limit) {
  let active = 0;
  const waiters = [];
  const run = async (fn) => {
    if (active >= limit) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
  run.limit = limit;
  run.isFree = () => active < limit;
  run.active = () => active;
  return run;
}

const gates = new Map();
for (const p of PROVIDERS) gates.set(p.name, createGate(p.limit));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getProvider(name) {
  const p = PROVIDERS.find((x) => x.name === name);
  if (!p) throw new Error(`未知的 AI 供应商：${name}`);
  return p;
}

function ensureConfigured() {
  if (!PROVIDERS.length) throw new Error('AI 服务未配置（AGNES_API_KEY 或 API_KEY / BASE_URL）');
}

/** 429（限流）与 5xx 值得重试；4xx 其他错误直接失败 */
function isRetryable(status) {
  return !status || status >= 500 || status === 429;
}

/**
 * 对单个供应商发一次请求。
 * @returns {{content: string, finishReason: string|null, usage: object, truncated: boolean}}
 */
async function requestOnce(provider, { model, messages, maxTokens, temperature, timeout }) {
  const res = await axios.post(
    provider.baseUrl + '/chat/completions',
    {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    },
    {
      headers: { Authorization: 'Bearer ' + provider.apiKey, 'Content-Type': 'application/json' },
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
    // length = 打满 max_tokens，说明输出不完整
    truncated: finishReason === 'length',
    provider: provider.name,
    model,
  };
}

/**
 * 选一个「当前有空位」的供应商。
 * 不能只按固定顺序取第一个 —— 主力供应商（Agnes）并发满时，固定顺序会让请求
 * 全部堵在它的闸门里，而闲置的智谱闲着。这里按「谁有空位用谁」，全忙时才排队。
 */
function pickProvider(chain) {
  for (const p of chain) {
    if (gates.get(p.name).isFree()) return p;
  }
  return chain[0];
}

/**
 * 调用 chat 接口（多供应商路由 + 限流退避）。
 *
 * @param {object} p
 * @param {string} [p.provider] 指定供应商；不传则按 AI_PROVIDER_ORDER 依次尝试
 * @param {number} [p.retries] 单个供应商内的重试次数（429 退避）
 * @returns {{content: string, finishReason: string|null, usage: object, truncated: boolean, provider: string}}
 */
async function callChat({ system, user, maxTokens = 4000, temperature = 0.2, timeout = CHAT_TIMEOUT_MS, retries = 2, provider }) {
  ensureConfigured();
  const chain = provider
    ? [getProvider(provider)]
    : (PROVIDER_ORDER.length ? PROVIDER_ORDER.map(getProvider) : PROVIDERS);

  let lastErr = null;
  const tried = new Set();
  // 每个供应商最多尝试 retries+1 次；某个供应商彻底失败（重试用尽）才换下一个
  for (let round = 0; round < chain.length; round++) {
    const p = pickProvider(chain.filter((x) => !tried.has(x.name)));
    if (!p) break;
    const gate = gates.get(p.name);
    let attempt = 0;
    let failed = false;
    while (attempt <= retries) {
      try {
        const out = await gate(() => requestOnce(p, {
          model: p.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          maxTokens,
          temperature,
          timeout,
        }));
        if (attempt > 0) console.log(`[ai] ${p.name} 重试第 ${attempt} 次成功`);
        return out;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        const retryable = isRetryable(status);
        const detail = err.response?.data?.error?.message || err.message || '';
        console.error(
          `[ai] ${p.name} 调用失败(第 ${attempt + 1}/${retries + 1} 次): ${String(detail).slice(0, 120)}` +
          (status ? ` status=${status}` : '')
        );
        if (!retryable || attempt === retries) { failed = true; break; }
        // 限流退避：1s → 2s → 4s（Agnes 免费额度对瞬时并发敏感，退避比硬撞更快恢复）
        await sleep(700 * Math.pow(2, attempt) + Math.floor(Math.random() * 400));
        attempt++;
      }
    }
    if (failed) tried.add(p.name);
  }
  const status = lastErr?.response?.status;
  const detail = lastErr?.response?.data
    ? JSON.stringify(lastErr.response.data).slice(0, 200)
    : lastErr?.message;
  throw new Error(`AI 调用失败${status ? '(HTTP ' + status + ')' : ''}: ${detail}`);
}

/**
 * 视觉模型识别（用于扫描件/图片型 PDF 的 OCR 降级、图形题内容识别）。
 *
 * @param {string} imageBase64 PNG 图片的 base64
 * @param {string} [p.provider] 指定供应商
 */
async function callVision({ imageBase64, prompt, maxTokens = 4000, timeout = 180000, provider, retries = 2 }) {
  ensureConfigured();
  const all = provider
    ? [getProvider(provider)]
    : (PROVIDER_ORDER.length ? PROVIDER_ORDER.map(getProvider) : PROVIDERS);
  const chain = all.filter((p) => p.supportsVision);
  if (!chain.length) throw new Error('没有可用的视觉模型供应商');

  let lastErr = null;
  const tried = new Set();
  for (let round = 0; round < chain.length; round++) {
    const p = pickProvider(chain.filter((x) => !tried.has(x.name)));
    if (!p) break;
    const model = p.visionModel || p.model; // Agnes 无独立视觉模型，文本模型即可看图
    const gate = gates.get(p.name);
    let attempt = 0;
    let failed = false;
    while (attempt <= retries) {
      try {
        const out = await gate(() => requestOnce(p, {
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
              { type: 'text', text: prompt },
            ],
          }],
          maxTokens,
          temperature: 0.1,
          timeout,
        }));
        return out;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        console.error(
          `[ai] ${p.name} 视觉调用失败(第 ${attempt + 1}/${retries + 1} 次): ` +
          String(err.response?.data?.error?.message || err.message).slice(0, 120)
        );
        if (!isRetryable(status) || attempt === retries) { failed = true; break; }
        await sleep(700 * Math.pow(2, attempt) + Math.floor(Math.random() * 400));
        attempt++;
      }
    }
    if (failed) tried.add(p.name);
  }
  const status = lastErr?.response?.status;
  throw new Error(
    `视觉调用失败${status ? '(HTTP ' + status + ')' : ''}: ` +
    String(lastErr?.response?.data?.error?.message || lastErr?.message || '').slice(0, 200)
  );
}

/**
 * 图像生成（agnes-image-2.5-flash 等）。
 *
 * 注意：这是**生成**模型，不是"看图"模型 —— 不能用于识别/OCR。
 * 端点为 /v1/images/generations，返回图片 URL。
 *
 * @returns {{url: string, revisedPrompt: string}}
 */
async function generateImage({ prompt, size, model, provider = 'agnes', timeout = 120000, retries = 1 }) {
  const p = getProvider(provider);
  const imageModel = model || p.imageModel;
  if (!imageModel) throw new Error(`供应商 ${provider} 未配置图像模型`);
  const gate = gates.get(p.name);
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const body = { model: imageModel, prompt, n: 1 };
      if (size) body.size = size;
      const res = await axios.post(p.baseUrl + '/images/generations', body, {
        headers: { Authorization: 'Bearer ' + p.apiKey, 'Content-Type': 'application/json' },
        timeout,
      });
      const item = (res.data && res.data.data && res.data.data[0]) || {};
      const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
      if (!url) throw new Error('图像生成返回为空');
      return { url, revisedPrompt: item.revised_prompt || '' };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      console.error(`[ai] ${p.name} 图像生成失败(第 ${attempt + 1} 次): ` +
        String(err.response?.data?.error?.message || err.message).slice(0, 120));
      if (!isRetryable(status) || attempt === retries) break;
      await sleep(800 * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw new Error('图像生成失败: ' + String(lastErr?.response?.data?.error?.message || lastErr?.message).slice(0, 200));
}

/** 供应商健康信息（管理端可见） */
function listProviders() {
  return PROVIDERS.map((p) => ({
    name: p.name,
    model: p.model,
    visionModel: p.visionModel || p.model,
    imageModel: p.imageModel || null,
    concurrency: p.limit,
  }));
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

module.exports = {
  callChat,
  callVision,
  generateImage,
  listProviders,
  extractJson,
  stripFences,
  salvageTruncated,
};
