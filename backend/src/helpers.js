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

module.exports = { runConcurrent };
