/**
 * 跨域来源白名单 —— CORS 与 CSRF 校验共用同一份来源列表。
 *
 * 两者必须一致，否则会出现「CORS 放行了但 CSRF 拒绝」或反过来的诡异状态。
 * 集中在这里定义，避免两处各写一份、改了一处忘了另一处。
 */

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * 允许的跨域来源列表。
 * 生产环境只认 CORS_ORIGIN（未配置则视为不许任何跨域来源，行为与 CORS 一致）；
 * 开发环境额外放行 Vite 开发服务器。
 */
function getAllowedOrigins() {
  const isProd = process.env.NODE_ENV === 'production';
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (isProd) return configured;
  return [...new Set([...configured, ...DEV_ORIGINS])];
}

/**
 * 判断请求来源是否可信（用于 CSRF 校验）。
 *
 * 判定顺序：
 *   1. 有 Origin 头 → 必须精确等于白名单之一，或等于请求自身的源（同源）
 *   2. 无 Origin 头 → 退到 Sec-Fetch-Site（同源/同站放行，跨站拒绝）
 *   3. 两者都没有 → 判定为不可信（非浏览器客户端）
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isTrustedOrigin(req) {
  const origin = req.headers.origin;

  if (origin) {
    // 同源：前端与后端部署在同一域名下时 Origin 就是自己
    const selfOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin === selfOrigin) return true;
    return getAllowedOrigins().includes(origin);
  }

  // 没有 Origin：看浏览器是否声明了这是同站请求
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'same-site') return true;

  // 显式放行开关：给那些不发送 Origin / Sec-Fetch-Site 的老浏览器或内网客户端用。
  // 默认关闭 —— 宁可在异常环境里要求用户重试，也不要默认信任来源。
  if (process.env.CSRF_TRUST_MISSING_ORIGIN === 'true') return true;

  return false;
}

module.exports = { getAllowedOrigins, isTrustedOrigin, DEV_ORIGINS };
