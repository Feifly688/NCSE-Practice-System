/**
 * 在服务器上直接重跑某套试卷的 AI 拆题（运维入口）。
 *
 * 用法：node scripts/reparse-paper.js <试卷ID> [--force]
 *   --force 忽略当前 parsing 状态，强制重跑
 *
 * 说明：与后台 /:id/reparse 接口走同一套 runParseJob 逻辑，
 * 完成后可查 exam_paper 的 parse_status / parsed_count / parse_error。
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { withConnection } = require('../src/db');
const { runParseJob } = require('../src/routes/exampaper');

async function main() {
  const id = Number(process.argv[2]);
  const force = process.argv.includes('--force');
  if (!id) {
    console.error('用法: node scripts/reparse-paper.js <试卷ID> [--force]');
    process.exit(1);
  }

  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT id, title, parse_status, parsed_count FROM exam_paper WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  });

  if (!paper) {
    console.error('试卷不存在: id=' + id);
    process.exit(1);
  }

  console.log(`试卷 #${paper.id} 「${paper.title}」 当前状态=${paper.parse_status} 已拆=${paper.parsed_count} 题`);
  if (paper.parse_status === 'parsing' && !force) {
    console.log('正在拆题中，如需强制重跑请加 --force');
    process.exit(0);
  }

  const t0 = Date.now();
  await runParseJob(id);

  const after = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT parse_status, parsed_count, parse_error FROM exam_paper WHERE id = ?',
      [id]
    );
    const [secs] = await conn.query(
      'SELECT section AS name, COUNT(*) AS count FROM exam_paper_question WHERE exam_paper_id = ? GROUP BY section ORDER BY MIN(seq)',
      [id]
    );
    return { paper: rows[0], sections: secs };
  });

  console.log('完成:', JSON.stringify(after.paper));
  console.log('分区:', after.sections.map((s) => `${s.name}=${s.count}`).join(' / ') || '（无）');
  console.log('耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exit(0);
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});