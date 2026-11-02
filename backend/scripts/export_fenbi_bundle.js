/**
 * 导出粉笔整卷数据为同步包（在服务器上运行）。
 *
 * 产出（backend/fenbi_bundle/）：
 *   papers.ndjson     —— 每行一张卷（origin='crawl' 的整卷元数据）
 *   questions.ndjson  —— 每行一道题（exam_paper_question 全字段，不含自增 id）
 *   images.tar.gz     —— 这些卷的 paper-images/{paperId}/ 目录
 *
 * 用法：node scripts/export_fenbi_bundle.js [--ids 7,9,10]
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const { execSync } = require('child_process');
const { withConnection } = require('../src/db');

const OUT_DIR = path.resolve(__dirname, '../fenbi_bundle');
const ARGS = process.argv.slice(2);
const argOf = (name) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : null;
};

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const idsArg = argOf('--ids');
  let paperIds;
  let qCount = 0;
  await withConnection(async (conn) => {
    if (idsArg) {
      paperIds = idsArg.split(',').map(Number).filter(Boolean);
    } else {
      const [rows] = await conn.query("SELECT id FROM exam_paper WHERE origin='crawl' ORDER BY id");
      paperIds = rows.map((r) => r.id);
    }
    console.log(`导出 ${paperIds.length} 张粉笔卷…`);

    const papersOut = fs.createWriteStream(path.join(OUT_DIR, 'papers.ndjson'));
    const questionsOut = fs.createWriteStream(path.join(OUT_DIR, 'questions.ndjson'));
    const CHUNK = 200;
    for (let i = 0; i < paperIds.length; i += CHUNK) {
      const chunk = paperIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const [ps] = await conn.query(
        `SELECT id, title, year, source, source_url, origin, raw_text, parse_status, parsed_count,
                exam_level, region, paper_type, difficulty, created_at
           FROM exam_paper WHERE id IN (${ph}) ORDER BY id`, chunk);
      ps.forEach((p) => papersOut.write(JSON.stringify(p) + '\n'));
      const [qs] = await conn.query(
        `SELECT exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json,
                answer, explanation, image_url
           FROM exam_paper_question WHERE exam_paper_id IN (${ph}) ORDER BY exam_paper_id, seq`, chunk);
      qs.forEach((q) => { questionsOut.write(JSON.stringify(q) + '\n'); qCount++; });
      process.stdout.write(`\r  进度 ${Math.min(i + CHUNK, paperIds.length)}/${paperIds.length}（题 ${qCount}）`);
      papersOut.closeSync && null; // no-op
    }
    console.log('');
    await new Promise((res) => { papersOut.end(res); });
    await new Promise((res) => { questionsOut.end(res); });
  });

  // 打包图片（只打有图的卷）
  const IMG_ROOT = path.resolve(__dirname, '../uploads/papers/paper-images');
  const withImages = paperIds.filter((id) => fs.existsSync(path.join(IMG_ROOT, String(id))));
  if (withImages.length) {
    console.log(`打包 ${withImages.length} 个卷的图片目录…`);
    execSync(`tar czf "${path.join(OUT_DIR, 'images.tar.gz')}" -C "${IMG_ROOT}" ${withImages.join(' ')}`, { stdio: 'inherit' });
  } else {
    console.log('没有图片目录');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
    exportedAt: new Date().toISOString(),
    papers: paperIds.length,
    questions: qCount,
    papersWithImages: withImages.length,
  }, null, 1));
  console.log('完成 →', OUT_DIR);
  console.log(JSON.stringify({ papers: paperIds.length, questions: qCount, papersWithImages: withImages.length }));
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
