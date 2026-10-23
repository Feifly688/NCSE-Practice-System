/**
 * 登录会话（JWT）有效期策略 —— 前后端唯一数据源。
 *
 * 设计要点：
 * 1. 惰性读取 process.env：避免 require 顺序问题（dotenv 尚未加载时读到 undefined），
 *    同时保证 pm2 restart 后改 env 立即生效，无需重启改代码。
 * 2. 单位解析仅支持 jsonwebtoken 支持的格式：s / m / h / d / w。
 * 3. describeExpiresIn 同时给出「原始值 / 毫秒数 / 中文文案」，
 *    前端通过 GET /api/auth/session-config 拉取后渲染提示语，
 *    避免前端硬编码「7 天」而运维改了 env 后文案说谎。
 */

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const DEFAULT_LONG = '7d';
const DEFAULT_SHORT = '2h';

/** 勾选「记住我」时使用的长有效期 */
function longExpiresIn() {
  return process.env.JWT_EXPIRES_IN || DEFAULT_LONG;
}

/** 未勾选「记住我」时使用的短有效期（公共设备场景收敛风险） */
function shortExpiresIn() {
  return process.env.JWT_EXPIRES_SHORT || DEFAULT_SHORT;
}

/**
 * 依据 remember 解析出实际生效的 expiresIn 字符串。
 * 约定：只有显式传 remember === false 才走短有效期；
 * 传 undefined（老客户端）时按长有效期处理，保持向后兼容。
 */
function resolveExpiresIn(options = {}) {
  return options.remember === false ? shortExpiresIn() : longExpiresIn();
}

/** 把 '7d' / '12h' / '30m' 解析为毫秒数；无法解析时返回 null */
function parseExpiresIn(value) {
  const matched = /^(\d+)\s*([smhdw])$/i.exec(String(value || '').trim());
  if (!matched) return null;
  const amount = Number(matched[1]);
  const unit = UNIT_MS[matched[2].toLowerCase()];
  if (!Number.isFinite(amount) || !unit) return null;
  return amount * unit;
}

/** 把 expiresIn 转换为便于展示的中文文案（优先「天」，其次「小时」/「分钟」） */
function humanizeDuration(ms) {
  if (!ms || ms <= 0) return '';
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d} 天`;
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h} 小时`;
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m} 分钟`;
  return `${Math.floor(ms / 1000)} 秒`;
}

/**
 * 结构化描述一个有效期，供接口回显。
 * @returns {{ expiresIn: string, ms: number|null, label: string }}
 */
function describeExpiresIn(value) {
  const expiresIn = String(value || '');
  const ms = parseExpiresIn(expiresIn);
  return {
    expiresIn,
    ms,
    label: ms ? humanizeDuration(ms) : expiresIn,
  };
}

module.exports = {
  longExpiresIn,
  shortExpiresIn,
  resolveExpiresIn,
  parseExpiresIn,
  humanizeDuration,
  describeExpiresIn,
};
