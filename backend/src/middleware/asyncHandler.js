/**
 * 异步路由统一错误处理中间件。
 *
 * 替代各路由中重复的内联 try-catch，行为与原实现完全一致：
 *   - 业务错误（throw 时带 .status，如 400/404/409）→ 按该状态码响应；
 *   - 其余异常 → 500；
 *   - 响应体统一为 { error: message }，其中 message 取 err.message，
 *     缺失时回退 String(err)（与原 String(err.message || err) 等价）；
 *   - onError 钩子用于保留原有 console.error 日志（如 stats 路由）。
 *
 * 用法：
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 *   router.get('/y', asyncHandler(async (req, res) => { ... }, (err) => console.error(err)));
 */

const asyncHandler = (fn, onError) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((err) => {
      if (onError) onError(err);
      const status = err.status || 500;
      const message = err.message || String(err);
      res.status(status).json({ error: message });
    });
};

module.exports = { asyncHandler };
