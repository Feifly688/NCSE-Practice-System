/**
 * 会话存储抽象层 —— 登录态的唯一读写入口。
 *
 * 【背景问题】
 * 原实现把 token / user 一律写入 localStorage。无论用户是否勾选「记住我」，
 * 关闭浏览器后登录态都保留，导致"记住我"这个开关形同虚设。
 *
 * 【本模块的约定】
 *   勾选「记住我」 → localStorage：跨浏览器会话持久化，配合服务端长有效期 token
 *   未勾选        → sessionStorage：随标签页/浏览器关闭而清除，配合服务端短有效期 token
 *
 * 读取时 sessionStorage 优先：同一浏览器若先「记住我」登录、后又取消勾选重新登录，
 * 应立即降级为会话级存储，而不是继续沿用旧的持久化 token。
 *
 * 【为什么不用 Cookie】
 * Cookie 方案（HttpOnly + SameSite=None; Secure）抗 XSS 窃取能力更强，
 * 但本项目为纯前端 SPA + Bearer token 架构，引入 Cookie 需同步改造：
 *   - 后端加 cookie 解析/下发依赖（当前无 cookie 库）
 *   - CORS 需开启 credentials
 *   - 前后端跨站部署下 SameSite=None 要求 Secure，改动面大
 * 现阶段用存储层区分 + 服务端有效期双保险，是改动最小且语义正确的方案。
 * 后续若要防 XSS 窃取，可在此模块内换成 Cookie 实现，调用方无需改动。
 */

const TOKEN_KEY = 'token';
const USER_KEY = 'user';

/** sessionStorage 不可用时（隐私模式等）降级到 localStorage */
function safeSession() {
  try {
    const s = window.sessionStorage;
    const probe = '__ncse_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function safeLocal() {
  try {
    const l = window.localStorage;
    const probe = '__ncse_probe__';
    l.setItem(probe, '1');
    l.removeItem(probe);
    return l;
  } catch {
    return null;
  }
}

/**
 * 读取 token：会话级优先于持久化。
 * @returns {string|null}
 */
export function getToken() {
  const s = safeSession();
  if (s) {
    const v = s.getItem(TOKEN_KEY);
    if (v) return v;
  }
  const l = safeLocal();
  return l ? l.getItem(TOKEN_KEY) : null;
}

/**
 * 读取用户信息。
 * @returns {object|null}
 */
export function getUser() {
  const s = safeSession();
  const raw = (s && s.getItem(USER_KEY)) || (safeLocal() && safeLocal().getItem(USER_KEY));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 当前是否处于「持久化会话」（即上次登录勾选了记住我）。
 * @returns {boolean}
 */
export function isPersistent() {
  const s = safeSession();
  if (s && s.getItem(TOKEN_KEY)) return false;
  const l = safeLocal();
  return !!(l && l.getItem(TOKEN_KEY));
}

/**
 * 写入会话信息。
 * @param {{token: string, user: object}} session
 * @param {boolean} remember true = 持久化（记住我）；false = 仅当前浏览器会话
 */
export function setSession({ token, user }, remember) {
  const s = safeSession();
  const l = safeLocal();

  // 先清空全部旧痕迹，避免两种存储之间残留互相覆盖
  clearSession();

  const target = remember ? l : (s || l);
  if (!target) return;
  target.setItem(TOKEN_KEY, token);
  target.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * 仅更新用户信息（改昵称/邮箱后调用），保持原有存储位置不变。
 * @param {object} user
 */
export function updateUser(user) {
  const s = safeSession();
  if (s && s.getItem(TOKEN_KEY)) {
    s.setItem(USER_KEY, JSON.stringify(user));
    return;
  }
  const l = safeLocal();
  if (l && l.getItem(TOKEN_KEY)) l.setItem(USER_KEY, JSON.stringify(user));
}

/** 清除全部会话痕迹（两种存储都清）。 */
export function clearSession() {
  const s = safeSession();
  const l = safeLocal();
  if (s) {
    s.removeItem(TOKEN_KEY);
    s.removeItem(USER_KEY);
  }
  if (l) {
    l.removeItem(TOKEN_KEY);
    l.removeItem(USER_KEY);
  }
}