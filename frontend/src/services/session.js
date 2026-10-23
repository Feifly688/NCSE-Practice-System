/**
 * 前端会话（登录态）相关工具。
 *
 * 设计要点：
 * 1. 时长文案不在前端硬编码，而是从后端 GET /api/auth/session-policy 拉取，
 *    保证「运维改 env → 前端提示同步变化」，不会出现文案说谎。
 * 2. JWT payload 解码需要处理 base64url 的 '-'/'_' 字符与缺失的 '=' padding，
 *    且 payload 为 UTF-8 字节，需用 TextDecoder 还原中文，避免直接 atob 乱码。
 */

const SESSION_POLICY_URL = '/auth/session-policy';

/** 拉取失败时的兜底文案（与后端默认值一致，仅在接口不可用时使用） */
const FALLBACK_POLICY = {
  long: { expiresIn: '7d', ms: 7 * 24 * 3600 * 1000, label: '7 天' },
  short: { expiresIn: '2h', ms: 2 * 3600 * 1000, label: '2 小时' },
};

let policyPromise = null;

/**
 * 获取会话有效期策略，结果缓存（策略在进程生命周期内不会变）。
 * @param {import('axios').AxiosInstance} api
 */
export function fetchSessionPolicy(api) {
  if (!policyPromise) {
    policyPromise = api
      .get(SESSION_POLICY_URL)
      .then(({ data }) => ({
        long: normalizePolicyItem(data?.long, FALLBACK_POLICY.long),
        short: normalizePolicyItem(data?.short, FALLBACK_POLICY.short),
      }))
      .catch(() => FALLBACK_POLICY);
  }
  return policyPromise;
}

function normalizePolicyItem(item, fallback) {
  if (!item || typeof item !== 'object') return fallback;
  const ms = Number(item.ms);
  return {
    expiresIn: String(item.expiresIn || fallback.expiresIn),
    ms: Number.isFinite(ms) && ms > 0 ? ms : fallback.ms,
    label: String(item.label || fallback.label),
  };
}

/**
 * 解码 JWT payload。
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // 补齐 padding：base64url 省略了 '='，atob 需要长度为 4 的倍数
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const json = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 从 token 中解析到期时间戳。
 * @returns {number|null} 毫秒时间戳
 */
export function getTokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return null;
  return payload.exp * 1000;
}

/**
 * 把剩余时长格式化为「约 X 后失效」。
 * @param {number|null} expiryAt 毫秒时间戳
 * @returns {string}
 */
export function describeRemaining(expiryAt) {
  if (!expiryAt) return '-';
  const diff = expiryAt - Date.now();
  if (diff <= 0) return '已过期，请重新登录';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '即将失效，请重新登录';
  if (minutes < 60) return `约 ${minutes} 分钟后失效`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `约 ${hours} 小时 ${restMinutes} 分钟后失效` : `约 ${hours} 小时后失效`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `约 ${days} 天 ${restHours} 小时后失效` : `约 ${days} 天后失效`;
}
