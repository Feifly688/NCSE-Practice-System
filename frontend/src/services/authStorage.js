/**
 * 会话存储抽象层 —— 登录态在前端的唯一读写入口。
 *
 * 【为什么这里不再存 token】
 * 原实现把 token 写进 localStorage / sessionStorage。只要页面里存在任意一处 XSS，
 * 攻击者就能把 token 读走并冒用用户身份 —— 这是 localStorage 存 token 的固有代价。
 *
 * 现在改为：token 只存在于**服务端下发的 httpOnly Cookie** 里，JS 读不到，
 * XSS 也偷不走。前端只保存非敏感的展示信息（昵称、角色、到期时间）。
 *
 * 【配合的请求约定】
 *   · axios 设 withCredentials: true，浏览器自动带上 Cookie
 *   · 后端从 Cookie 解析凭据，同时保留 Authorization 头通道给 API 客户端
 *   · 后端对「凭据来自 Cookie」的状态变更请求做 CSRF 校验（Origin + Sec-Fetch-Site）
 *
 * 【记住我的语义】
 *   勾选   → 服务端下发带 maxAge 的 Cookie（长有效期），关浏览器也在
 *   未勾选 → 服务端下发会话 Cookie（无 maxAge），关浏览器即失效
 *   持久化与否由服务端 Cookie 属性决定，前端只记录一个标记用于界面提示。
 */

const USER_KEY = 'user';
const EXPIRY_KEY = 'token_expires_at';
const PERSISTENT_KEY = 'session_persistent';

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

/** 写入位置：勾选「记住我」→ localStorage，否则 sessionStorage（均不可用则退 localStorage） */
function targetStore(remember) {
  if (remember) return safeLocal();
  return safeSession() || safeLocal();
}

/**
 * 读取 token。
 *
 * 现在恒为 null —— token 不再交给前端，保留这个导出是为了让既有调用点
 * （如图片 URL 拼接、过期时间计算）自然降级而不是抛错。
 *
 * @deprecated token 已移入 httpOnly Cookie
 * @returns {null}
 */
export function getToken() {
  return null;
}

/**
 * 读取用户信息（仅展示用，非凭据）。
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
  const l = safeLocal();
  const v = (s && s.getItem(PERSISTENT_KEY)) || (l && l.getItem(PERSISTENT_KEY));
  return v === 'true';
}

/**
 * 记录 token 的到期时间戳。
 *
 * 之前是从 JWT payload 里解 exp；现在 token 在 Cookie 里读不到，
 * 改为登录/注册时由服务端返回 session.ms，前端落盘一个到期时间。
 *
 * @param {number|null} expiresAt 毫秒时间戳
 */
export function setSessionExpiry(expiresAt) {
  const s = safeSession();
  const l = safeLocal();
  const value = expiresAt ? String(expiresAt) : '';
  for (const store of [s, l]) {
    if (!store) continue;
    if (value) store.setItem(EXPIRY_KEY, value);
    else store.removeItem(EXPIRY_KEY);
  }
}

/**
 * 读取 token 到期时间戳。
 * @returns {number|null} 毫秒时间戳
 */
export function getSessionExpiry() {
  const s = safeSession();
  const l = safeLocal();
  const raw = (s && s.getItem(EXPIRY_KEY)) || (l && l.getItem(EXPIRY_KEY));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 写入会话信息。
 * @param {{ user: object, session?: { ms?: number } }} data
 * @param {boolean} remember true = 持久化（记住我）；false = 仅当前浏览器会话
 */
export function setSession({ user, session }, remember) {
  // 先清空全部旧痕迹，避免两种存储之间残留互相覆盖
  clearSession();

  const target = targetStore(remember);
  if (!target) return;

  target.setItem(USER_KEY, JSON.stringify(user));
  target.setItem(PERSISTENT_KEY, remember ? 'true' : 'false');

  // 到期时间记在本地（token 本体在 Cookie 里读不到）
  const ms = Number(session?.ms);
  if (Number.isFinite(ms) && ms > 0) {
    const expiresAt = Date.now() + ms;
    target.setItem(EXPIRY_KEY, String(expiresAt));
    const l = safeLocal();
    // 同时写一份到 localStorage：刷新页面后若存储位置判断变化也不丢到期时间
    if (l && l !== target) l.setItem(EXPIRY_KEY, String(expiresAt));
  }
}

/**
 * 仅更新用户信息（改昵称/邮箱后调用），保持原有存储位置不变。
 * @param {object} user
 */
export function updateUser(user) {
  const s = safeSession();
  const l = safeLocal();
  const stores = [];
  if (s && s.getItem(USER_KEY)) stores.push(s);
  if (l && l.getItem(USER_KEY)) stores.push(l);
  for (const store of stores) store.setItem(USER_KEY, JSON.stringify(user));
}

/** 清除全部会话痕迹（两种存储都清）。 */
export function clearSession() {
  for (const store of [safeSession(), safeLocal()]) {
    if (!store) continue;
    store.removeItem(USER_KEY);
    store.removeItem(EXPIRY_KEY);
    store.removeItem(PERSISTENT_KEY);
  }
}
