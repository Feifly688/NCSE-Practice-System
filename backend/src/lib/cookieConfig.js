/**
 * Cookie 策略配置。
 *
 * 【为什么改用 Cookie】
 * token 存 localStorage 时，任何一处 XSS 都能把 token 读走并冒用用户身份。
 * httpOnly Cookie 让 JS 读不到，XSS 也偷不走。
 *
 * 【跨站部署的坑】
 * 前后端不同域（Cloudflare Pages + 独立后端）时，浏览器把这种请求视为跨站，
 * cookie 默认 SameSite=Lax 不会被带上，只能用 SameSite=None。
 * 而 SameSite=None 又强制要求 Secure（HTTPS）。
 * 因此这里默认：
 *   · 同源部署 → SameSite=Lax（最严格，浏览器默认行为）
 *   · 跨站部署 → 由 COOKIE_SAMESITE=none + COOKIE_SECURE=true 显式开启
 * 运维改 env 即可切换，不需要改代码。
 */

/** 承载 JWT 的 cookie 名（httpOnly，前端 JS 读不到） */
const COOKIE_TOKEN = 'ncse_token';

/**
 * 解析 Cookie 属性。
 * @param {number} maxAgeMs cookie 有效期（毫秒）；不传则为会话 cookie（关闭浏览器即失效）
 */
function resolveCookieOptions(maxAgeMs) {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSiteRaw = String(process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  const sameSite = ['lax', 'strict', 'none'].includes(sameSiteRaw) ? sameSiteRaw : 'lax';

  // Secure 默认随生产环境开启；SameSite=None 时浏览器强制要求 Secure
  let secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd;
  if (sameSite === 'none') secure = true;

  const options = {
    httpOnly: true,   // JS 不可读，防 XSS 窃取
    secure,            // 只走 HTTPS
    sameSite,          // lax / strict / none
    path: '/',
  };
  if (maxAgeMs && maxAgeMs > 0) options.maxAge = Math.floor(maxAgeMs);
  return options;
}

/** 清除 cookie 用的属性（必须与设置时一致，否则浏览器删不掉） */
function clearCookieOptions() {
  const { maxAge, ...rest } = resolveCookieOptions(0);
  return rest;
}

module.exports = { COOKIE_TOKEN, resolveCookieOptions, clearCookieOptions };
