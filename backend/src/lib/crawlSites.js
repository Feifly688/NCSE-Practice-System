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
const { fetchFenbiPaper, parseExerciseUrl } = require('./fenbi');

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

/**
 * 粉笔套题页适配器。
 *
 * 实现细节见 lib/fenbi.js（那里记录了 cookie 命名、device_id 下发、
 * 静态地址参数拼接等一系列踩坑点）。这里只负责识别与转发。
 */
function matchFenbiExercise(url) {
  const host = url.hostname;
  if (host !== 'spa.fenbi.com' && host !== 'tiku.fenbi.com' && host !== 'www.fenbi.com') return null;
  return parseExerciseUrl(url) ? { site: 'fenbi' } : null;
}

async function fetchFenbiExercise(info, cookie, extraUserid) {
  const res = await fetchFenbiPaper(info.url, cookie, extraUserid);
  return { html: res.text, meta: res };
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
    cookieHint: '粉笔题目需要登录。请在浏览器登录粉笔后按 F12 → Network → 任选一个 fenbi 请求 → Request Headers → 复制整行 cookie: 的值粘贴到下面（必须包含 sess 与 userid）。',
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
    const res = await ad.fetch({ ...info, url: url.toString() }, opts.cookie, opts.userid);
    return { html: res.html, site: ad.name, info, meta: res.meta };
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
