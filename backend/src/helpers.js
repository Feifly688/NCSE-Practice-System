// 并发控制：限制同时执行的任务数
async function runConcurrent(tasks, maxConcurrent = 3) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(
    Array(Math.min(maxConcurrent, tasks.length))
      .fill(null)
      .map(() => worker())
  );
  return results;
}

/** 批量操作默认的 id 数量上限 */
const DEFAULT_MAX_BATCH_IDS = 1000;

/**
 * 校验并规范化批量操作的 id 列表。
 *
 * 之前各处直接把客户端给的 ids 塞进 `WHERE id IN (?)`：
 *   - 不校验类型 → 可以塞字符串、对象、负数
 *   - 不限制长度 → 传 10 万个 id 会拼出一条巨型 SQL，占满连接并拖垮数据库
 * 统一收口在这里，各路由只管用返回值。
 *
 * @param {*} value 客户端传入的 ids
 * @param {object} [opts] { max: 数量上限, field: 错误提示里的字段名 }
 * @returns {{ ids: number[] } | { error: string }}
 */
function parseIdList(value, opts = {}) {
  const max = opts.max || DEFAULT_MAX_BATCH_IDS;
  const field = opts.field || 'ID 列表';
  if (!Array.isArray(value)) return { error: `${field}格式不正确` };
  if (value.length === 0) return { error: `${field}不能为空` };
  if (value.length > max) return { error: `一次最多处理 ${max} 条，当前 ${value.length} 条` };

  const ids = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { error: `${field}包含非法值` };
    ids.push(n);
  }
  return { ids };
}

/**
 * 解析查询字符串里的 id 列表（`?ids=1,2,3`）。
 * 非法项直接丢弃而不是报错 —— 这类接口是「按 id 批量查询展示」，
 * 前端拼错一个值不该让整个请求失败。
 */
function parseIdsQuery(raw, opts = {}) {
  const max = opts.max || DEFAULT_MAX_BATCH_IDS;
  const ids = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, max);
}

module.exports = { runConcurrent, parseIdList, parseIdsQuery };
