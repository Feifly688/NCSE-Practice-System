/**
 * SSRF 防护：抓取外部 URL 时的统一出口。
 *
 * 为什么不能只校验 hostname 字符串：
 *   1. 域名可以解析到内网 IP（含攻击者控制的 DNS）；
 *   2. DNS rebinding —— 校验时解析到公网，真正建连时解析到内网；
 *   3. IP 有多种写法（十进制 2130706433、IPv4-mapped ::ffff:127.0.0.1）；
 *   4. 30x 重定向可以跳到内网，而 axios 默认跟随重定向。
 *
 * 因此这里做三层：
 *   ① URL 层：只允许 http/https，hostname 不能是明显的内网字面量
 *   ② 解析层：接管 DNS（axios 的 lookup 选项），用**实际用于建连的 IP**做判定，
 *      覆盖 rebinding 与各种 IP 写法
 *   ③ 传输层：禁用重定向跟随，避免 302 跳进内网
 *
 * 云厂商的元数据地址 169.254.169.254 落在 169.254.0.0/16（链路本地），
 * 一旦被访问就会泄露实例临时凭证，必须拦截。
 */
const dns = require('dns');
const net = require('net');
const axios = require('axios');

/** 需要拦截的 IPv4 CIDR 列表 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],          // 本网络
  ['10.0.0.0', 8],         // 私有
  ['100.64.0.0', 10],      // 运营商级 NAT
  ['127.0.0.0', 8],        // 回环（整段，不止 127.0.0.1）
  ['169.254.0.0', 16],     // 链路本地 —— 含 169.254.169.254 云元数据
  ['172.16.0.0', 12],      // 私有
  ['192.0.0.0', 24],       // IETF 协议分配
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 中继
  ['192.168.0.0', 16],     // 私有
  ['198.18.0.0', 15],      // 基准测试
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // 组播
  ['240.0.0.0', 4],        // 保留（含 255.255.255.255）
];

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/**
 * 判断 IP 是否属于内网 / 保留 / 特殊用途地址段。
 * @param {string} ip IPv4 或 IPv6 字面量
 */
function isBlockedIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;

  if (net.isIPv4(s)) {
    const n = ipv4ToInt(s);
    for (const [base, bits] of BLOCKED_V4) {
      const bn = ipv4ToInt(base);
      const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
      if ((n & mask) === (bn & mask)) return true;
    }
    return false;
  }

  // ── IPv6 ──────────────────────────────────────────────
  if (s === '::' || s === '::1') return true;
  // IPv4-mapped（::ffff:127.0.0.1）与 IPv4-compatible：取出内嵌 IPv4 再判
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  if (s.startsWith('::ffff:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;   // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;   // fe80::/10 链路本地
  if (/^ff[0-9a-f]{2}:/.test(s)) return true;      // ff00::/8 组播
  if (s.startsWith('64:ff9b:')) return true;       // NAT64
  return false;
}

/**
 * 接管 DNS 解析的 lookup 函数，交给 http/https agent 使用。
 * 判定的 address 就是真正用于建连的 IP，因此能挡住 DNS rebinding。
 */
function createSafeLookup() {
  return function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      // options.all = true 时 address 是 [{address, family}]
      const list = Array.isArray(address) ? address : [{ address, family }];
      for (const item of list) {
        if (isBlockedIp(item.address)) {
          const e = new Error(`SSRF 拦截：${hostname} 解析到内网/保留地址 ${item.address}`);
          e.isSsrfBlock = true;
          return callback(e);
        }
      }
      return callback(null, address, family);
    });
  };
}

/** URL 层快速校验：协议 + hostname 字面量 */
function assertPublicUrl(urlStr, allowHosts) {
  let u;
  try {
    u = new URL(String(urlStr));
  } catch {
    throw new Error('URL 格式不正确');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('仅支持 http/https 协议');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 直接拿 IP 当 host 的，先按 IP 段判一次（不必等 DNS）
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new Error('不允许访问内网或保留地址');
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('不允许访问内网域名');
  }
  // 域名白名单（可选）：命中白名单才放行
  if (Array.isArray(allowHosts) && allowHosts.length > 0) {
    const ok = allowHosts.some((h) => host === h || host.endsWith('.' + h));
    if (!ok) throw new Error('该域名不在允许抓取的白名单内');
  }
  return u;
}

/**
 * 受保护的 GET：协议校验 + 解析层拦截 + 禁用重定向。
 * @param {string} url
 * @param {object} opts axios 选项（timeout / headers 等）；maxRedirects 与 lookup 会被强制覆盖
 */
async function safeGet(url, opts = {}) {
  assertPublicUrl(url, opts.allowHosts);
  const { allowHosts, ...rest } = opts;
  return axios.get(url, {
    ...rest,
    lookup: createSafeLookup(),
    // 不跟随重定向：否则外部站点可 302 把请求带进内网
    maxRedirects: 0,
    // 不代理，避免绕过本地判定
    proxy: false,
  });
}

module.exports = { isBlockedIp, createSafeLookup, assertPublicUrl, safeGet };
