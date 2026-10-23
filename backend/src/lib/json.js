/**
 * 存储为 JSON/TEXT 的字段（如 question.options_json）统一解析入口。
 *
 * 坑点：mysql2 对 JSON 类型的列会直接返回已解析的数组/对象，对 TEXT 列才返回字符串。
 * 直接 JSON.parse(数组) 会把数组 String() 成 "a,b,c" 再解析，必然抛
 * "Unexpected token ... is not valid JSON"，导致整条请求 500。
 * 因此这里兼容四种形态：数组 / 对象 / JSON 字符串 / 空值。
 *
 * @param {*} v 数据库取出的原始值
 * @param {*} fallback 解析失败或取值为空时的回退值
 */
function safeJson(v, fallback) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return v;
  if (v === null || v === undefined || v === '') return fallback;
  try {
    const p = JSON.parse(v);
    return p ?? fallback;
  } catch {
    return fallback;
  }
}

/** 取选项数组：无论底层如何存储，都保证返回数组，便于 map 渲染。 */
function safeOptions(v) {
  const parsed = safeJson(v, []);
  return Array.isArray(parsed) ? parsed : [];
}

module.exports = { safeJson, safeOptions };
