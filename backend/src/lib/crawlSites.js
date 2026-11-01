/**
 * 站点适配器：把「用户粘贴的链接」变成「能直接取到题目正文」的请求。
 *
 * 【为什么需要它】
 * 通用 HTML 抓取只能对付服务端渲染的静态页面。粉笔这类题库站是 SPA：
 * 页面 HTML 里只有一个 <app-root> 空壳（实测仅 3.4KB），正文由 JS 渲染，
 * 题目数据来自它自己的接口 —— 直接抓 HTML 必然是空（表现为
 * 「抓取到的正文为空或过短」）。
 * 这里为这类站点单独实现：走它的数据接口取回题目 HTML，
 * 再复用通用的正文提取逻辑（lib/examHtml.js）。
 *
 * 【安全边界】
 * 适配器只对**内置的固定域名**生效，用户只能影响 query 参数，
 * 无法指定请求主机 —— 因此不存在 SSRF 面。请求仍走 ssrf.js 的
 * DNS 解析层拦截作为纵深防御。
 *
 * 【关于 Cookie】
 * 粉笔的题目接口需要登录态（未登录返回 401 / 453）。
 * 管理员可粘贴自己账号的 Cookie，服务端仅在本次请求内使用，
 * 不落库、不写日志。
 */
const axios = require('axios');
const { safePost } = require('./ssrf');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 粉笔接口的公共参数：照抄其网页端请求，避免参数不匹配被拒
const FENBI_COMMON = { kav: '125', av: '127', hav: '125', app: 'web', apcid: '0', gav: '2' };

// 设备指纹：sid/create 要求带浏览器环境信息，服务端用一组固定值模拟
const FENBI_DEVICE_EXTRAS = {
  canvas: 'hqngxm',
  webgl: 'Google Inc. (Microsoft)~ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  screen: '1920x1080x24',
  language: 'zh-CN',
  platform: 'Win32',
  cores: '8',
  memory: '8',
  touchPoints: '0',
};

/** 粉笔套题页：https://spa.fenbi.com/ti/exam/exercise/<key>?routecs=xingce&examcatid=... */
function matchFenbiExercise(url) {
  const host = url.hostname;
  if (host !== 'spa.fenbi.com' && host !== 'tiku.fenbi.com') return null;
  const m = url.pathname.match(/\/ti\/exam\/exercise\/([^/]+)/);
  if (!m) return null;
  return {
    site: 'fenbi',
    key: decodeURIComponent(m[1]),
    routecs: url.searchParams.get('routecs') || 'xingce',
  };
}

/**
 * 取粉笔题目接口的设备 id。
 * 接口会忽略传入的 deviceId，返回服务端自己分配的一个。
 */
async function fenbiDeviceId() {
  const res = await safePost(
    'https://login.fenbi.com/api/users/device/sid/create',
    { pf: 'web', startupId: Date.now(), extras: FENBI_DEVICE_EXTRAS },
    {
      params: { ...FENBI_COMMON, deviceId: '' },
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Referer: 'https://spa.fenbi.com/',
      },
      timeout: 20000,
      // 设备接口偶尔返回风控 JSON，禁用自动重试避免放大请求
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );
  const deviceId = res.data && res.data.data && res.data.data.deviceId;
  if (!deviceId) {
    const err = new Error('粉笔设备初始化失败');
    err.code = 'FENBI_DEVICE_FAILED';
    err.detail = res.data && res.data.msg ? String(res.data.msg) : '';
    throw err;
  }
  return deviceId;
}

/**
 * 调用粉笔题目接口，取回题目 HTML。
 *
 * @param {object} info matchFenbiExercise 的结果
 * @param {string} cookie 管理员提供的粉笔登录 Cookie（可为空）
 * @returns {Promise<{html: string}>}
 */
async function fetchFenbiExercise(info, cookie) {
  if (!cookie || !String(cookie).trim()) {
    const err = new Error('粉笔题目接口需要登录');
    err.code = 'FENBI_NEED_LOGIN';
    err.detail = '该页面的题目数据来自需要登录的接口，未提供 Cookie 时只能拿到 401/453。';
    throw err;
  }

  const deviceId = await fenbiDeviceId();

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://spa.fenbi.com/',
  };
  // Cookie 是用户自己的登录凭据，只在本次请求内使用
  const raw = String(cookie).trim();
  headers.Cookie = raw.startsWith('cookie:') ? raw.slice(7).trim() : raw;

  const res = await axios.get('https://tiku.fenbi.com/combine/exercise/getExercise', {
    params: {
      format: 'html',
      key: info.key,
      routecs: info.routecs,
      ...FENBI_COMMON,
      deviceId,
    },
    headers,
    timeout: 30000,
    // 成功时返回的是 HTML 片段（接口用 format 参数控制 body 格式），
    // 但 Content-Type 仍是 application/json —— 必须按文本取，否则解析会失败
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 500,
    proxy: false,
  });

  const body = String(res.data || '');
  if (res.status === 401 || res.status === 453) {
    const err = new Error('粉笔拒绝了本次请求');
    err.code = 'FENBI_NEED_LOGIN';
    // 453 是「无效 DeviceSid」：粉笔先校验设备凭据再校验登录态，
    // 带 Cookie 时也可能先撞上 453 —— 两种情况都指向 Cookie 不可用
    err.detail = res.status === 453
      ? '粉笔未认可本次设备凭据，通常是 Cookie 无效或已过期。请在浏览器重新登录粉笔后重新复制 Cookie。'
      : '未登录或 Cookie 已失效，请在浏览器重新登录粉笔后再复制 Cookie。';
    throw err;
  }
  if (res.status >= 400) {
    const err = new Error('粉笔题目接口返回异常');
    err.code = 'FENBI_HTTP_ERROR';
    err.detail = `HTTP ${res.status}`;
    throw err;
  }
  if (!body.trim()) {
    const err = new Error('粉笔返回了空内容');
    err.code = 'FENBI_EMPTY';
    throw err;
  }
  // 接口偶尔用 JSON 包裹一段错误说明
  if (/^\s*\{/.test(body) && /"message"/.test(body.slice(0, 200))) {
    const err = new Error('粉笔返回了错误信息');
    err.code = 'FENBI_HTTP_ERROR';
    err.detail = body.slice(0, 200);
    throw err;
  }
  return { html: body };
}

/**
 * 站点适配器表：命中则走专用抓取，否则回退到通用 HTML 抓取。
 */
const ADAPTERS = [
  {
    name: 'fenbi',
    match: matchFenbiExercise,
    fetch: fetchFenbiExercise,
    // 管理员需要在表单里额外提供 Cookie
    needsCookie: true,
    cookieHint: '粉笔题目需要登录。请在浏览器登录粉笔后按 F12 → Network → 任选一个 fenbi 请求 → Request Headers → 复制整行 cookie: 的值粘贴到下面。',
  },
];

/**
 * 尝试用站点适配器抓取。
 * @returns {Promise<{html: string, site: string, title?: string}|null>} 未命中适配器返回 null
 */
async function fetchByAdapter(url, opts = {}) {
  for (const ad of ADAPTERS) {
    const info = ad.match(url);
    if (!info) continue;
    const res = await ad.fetch(info, opts.cookie);
    return { html: res.html, site: ad.name, info };
  }
  return null;
}

/** 列出需要 Cookie 的站点提示，供前端展示 */
function adapterHints(url) {
  for (const ad of ADAPTERS) {
    if (ad.match(url) && ad.needsCookie) {
      return { site: ad.name, needsCookie: true, cookieHint: ad.cookieHint };
    }
  }
  return null;
}

module.exports = { fetchByAdapter, adapterHints, ADAPTERS };
