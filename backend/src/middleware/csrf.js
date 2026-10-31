/**
 * CSRF 防护中间件。
 *
 * 【为什么必须做】
 * token 改用 Cookie 后，浏览器会自动带上 Cookie —— 这正是 Cookie 的便利之处，
 * 也正是 CSRF 的来源：攻击者在自己站点发一个跨站表单，浏览器会自动带上
 * 用户的 Cookie 完成操作。跨站部署时 cookie 是 SameSite=None（否则浏览器根本
 * 不会带上），所以这个风险是真实存在的。
 *
 * 【防护策略】
 *   只对「会改状态的方法」做校验：POST / PUT / PATCH / DELETE
 *
 *   1. 请求带 Authorization: Bearer 头 → 豁免。
 *      攻击者能让浏览器自动带 Cookie，但没法让浏览器伪造一个自定义请求头
 *      （自定义头会触发 CORS 预检，攻击者的站点过不了预检）。
 *      这条豁免同时保证了 API 客户端 / curl / 脚本不受影响。
 *
 *   2. 其余请求校验来源：
 *      · 有 Origin → 必须精确等于白名单之一或请求自身的源
 *      · 无 Origin → 看 Sec-Fetch-Site（同源/同站放行，跨站拒绝）
 *
 * 【为什么不加双提交 token】
 * 双提交 CSRF token 需要前端每次请求都带自定义头，本项目是纯 SPA，
 * 加上之后每个请求都要改一层。相比之下 Origin + Sec-Fetch-Site 在现代浏览器
 * （Chrome 51+ / Firefox 64+ / Safari 16.4+）上覆盖度足够，且少一个易错点。
 */
const { isTrustedOrigin } = require('../lib/corsConfig');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 登录/注册接口的特殊处理。
 *
 * 这两个接口拿 token 之前还没有任何凭据，**无法用 Bearer 头豁免**。
 * 如果一刀切要求 Origin，curl / Postman / 脚本这些非浏览器客户端就彻底登不上了。
 *
 * 折中规则：
 *   · 带 Origin → 严格校验（挡掉浏览器发起的跨站登录 CSRF：诱导受害者登录到攻击者账号）
 *   · 不带 Origin → 放行（非浏览器客户端不会发 Origin，说明不是浏览器表单提交）
 *
 * 登录 CSRF 本身的危害也有限：最多让受害者误登到别人的账号，
 * 不会造成数据泄露或越权，比其他接口的 CSRF 轻得多。
 */
const AUTH_ENTRY_PATTERN = /\/(auth\/login|auth\/register)$/;

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Bearer 凭据不受 CSRF 影响（浏览器无法伪造该头）
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return next();

  // 查询参数通道（?t=）只用于 GET 图片资源，状态变更接口不接受
  if (req.query && typeof req.query.t === 'string' && req.query.t.length > 10) {
    return res.status(403).json({ error: '该接口不接受 URL 传参的凭据' });
  }

  if (isTrustedOrigin(req)) return next();

  // 登录/注册：无 Origin 时放行，保证脚本与 API 客户端可用
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!req.headers.origin && AUTH_ENTRY_PATTERN.test(path)) return next();

  return res.status(403).json({
    error: '请求来源校验失败，请刷新页面后重试',
    detail: `origin=${req.headers.origin || '(none)'} site=${req.headers['sec-fetch-site'] || '(none)'}`,
  });
}

module.exports = { csrfGuard };
