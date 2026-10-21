/**
 * 本地时区日期/时间工具。
 *
 * 背景：MySQL 服务端时区为 UTC，NOW()/CURDATE()/DATE() 均按 UTC 语义，
 * 而用户处于东八区（Asia/Shanghai），凌晨 0-8 点的记录会被算到前一天
 * （曾导致"20 号答的题统计到 19 号"）。
 *
 * 方案：以 Node 进程时区（生产为 Asia/Shanghai）为唯一事实源——
 * 写入侧传本地时间串参数，读取侧传本地日期参数，
 * SQL 不再使用 NOW()/CURDATE()/DATE_SUB()。
 * 注意：schema 中 updated_at 等列的 DEFAULT CURRENT_TIMESTAMP 仍为
 * UTC 语义，涉及当日判断的路径（如 site_stats.today_visits）已在
 * JS 侧用本地时间解析，不受影响。
 */

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期串 'YYYY-MM-DD' */
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地日期时间串 'YYYY-MM-DD HH:mm:ss'（写入 DATETIME 列用） */
function localDateTimeStr(d = new Date()) {
  return `${localDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对今天平移 days 天后的本地日期串（days 可为负） */
function shiftDateStr(days, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

/** 今天 00:00:00 的本地时间串（用于 started_at >= ? 的开区间查询） */
function todayStartStr(from = new Date()) {
  return `${localDateStr(from)} 00:00:00`;
}

module.exports = { localDateStr, localDateTimeStr, shiftDateStr, todayStartStr };
