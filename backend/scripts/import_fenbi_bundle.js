/**
 * 导入粉笔同步包到本地库（在本地运行）。
 *
 * 输入（backend/fenbi_bundle/）：papers.ndjson / questions.ndjson / images.tar.gz
 *
 * 规则：
 *   · exam_paper 按**服务器原始 id** 写入（本地这些 id 必须为空或同卷，
 *     冲突的本地卷会被删除重建 —— 图片路径与服务器保持一致，目录原样解包）。
 *   · 不动 question / 分类映射：导入完跑一次 `node src/lib/autoTag.js`
 *     完成回流（指纹去重）与打标。
 *
 * 用法：node scripts/import_fenbi_bundle.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');

const BUNDLE = path.resolve(__dirname, '../fenbi_bundle');
const IMG_ROOT = path.resolve(__dirname, '../uploads/papers/paper-images');

async function* ndjson(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t) yield JSON.parse(t);
  }
}

(async () => {
  const papersFile = path.join(BUNDLE, 'papers.ndjson');
  const questionsFile = path.join(BUNDLE, 'questions.ndjson');
  if (!fs.existsSync(papersFile) || !fs.existsSync(questionsFile)) {
    console.error('同步包不完整，缺 papers.ndjson / questions.ndjson');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    multipleStatements: false,
  });

  // ── ① 导入试卷（保留服务器 id）──
  let papers = 0;
  for await (const p of ndjson(papersFile)) {
    // 冲突处理：本地同 id 的旧卷先删（正常应为空库）
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [p.id]);
    await conn.query('DELETE FROM exam_paper_category WHERE exam_paper_id = ?', [p.id]);
    await conn.query('DELETE FROM exam_paper WHERE id = ?', [p.id]);
    await conn.query(
      `INSERT INTO exam_paper (id, title, year, source, source_url, origin, raw_text, parse_status, parsed_count, exam_level, region, paper_type, difficulty)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, p.title, p.year, p.source || '粉笔题库', p.source_url || null, 'crawl', p.raw_text || null,
        p.parse_status || 'success', p.parsed_count || null, p.exam_level || null, p.region || null, p.paper_type || null, p.difficulty || null]);
    papers++;
    if (papers % 200 === 0) process.stdout.write(`\r  卷 ${papers}`);
  }
  console.log(`\r卷导入完成: ${papers}                    `);

  // ── ② 导入题目（逐卷插入，材料图挂组首）──
  const byQ = new Map(); // paperId -> rows
  for await (const q of ndjson(questionsFile)) {
    if (!byQ.has(q.exam_paper_id)) byQ.set(q.exam_paper_id, []);
    byQ.get(q.exam_paper_id).push(q);
  }
  let questions = 0;
  for (const [paperId, rows] of byQ) {
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [paperId]);
    for (const q of rows) {
      await conn.query(
        `INSERT INTO exam_paper_question
         (exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json, answer, explanation, image_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [paperId, q.seq, q.section, q.qtype, q.difficulty, q.passage, q.stem, q.options_json,
          q.answer, q.explanation, q.image_url || null]);
      questions++;
    }
  }
  console.log(`题目导入完成: ${questions}`);

  // ── ③ 解包图片 ──
  const tar = path.join(BUNDLE, 'images.tar.gz');
  if (fs.existsSync(tar)) {
    fs.mkdirSync(IMG_ROOT, { recursive: true });
    // Windows 的 tar 会把 "D:" 当成远程主机，必须用相对路径 + cwd
    execSync(`tar xzf images.tar.gz`, { cwd: BUNDLE, stdio: 'inherit' });
    // 包内是 paper-images/<id>/ 结构？导出时 -C IMG_ROOT，所以包内直接是 <id>/ 目录
    // 解到临时目录后搬进 IMG_ROOT
    for (const dir of fs.readdirSync(BUNDLE)) {
      if (/^\d+$/.test(dir)) {
        const dest = path.join(IMG_ROOT, dir);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(path.join(BUNDLE, dir), dest);
      }
    }
    console.log('图片解包完成');
  }

  const [chk] = await conn.query('SELECT COUNT(*) n FROM exam_paper');
  const [chk2] = await conn.query('SELECT COUNT(*) n FROM exam_paper_question');
  console.log(`本地校验: exam_paper=${chk[0].n} exam_paper_question=${chk2[0].n}`);
  console.log('下一步：node src/lib/autoTag.js（回流 + 打标）');
  await conn.end();
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
