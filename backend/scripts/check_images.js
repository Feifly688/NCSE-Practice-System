/**
 * 真题截图链路核对 + 测试数据清理。
 * 用法：node scripts/check_images.js [--clean]
 */
require('dotenv').config({ path: '/root/ncse/.env' });
const fs = require('fs');
const path = require('path');
const { withConnection, closePool } = require('../src/db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4000';
const UPLOAD_DIR = path.resolve(__dirname, '../uploads/papers');

async function main() {
  const clean = process.argv.includes('--clean');
  await withConnection(async (conn) => {
    const [papers] = await conn.query('SELECT id, title, parse_status, parsed_count FROM exam_paper ORDER BY id');
    console.log('=== 试卷列表 ===');
    for (const p of papers) console.log(`  #${p.id} ${p.title} | ${p.parse_status} | ${p.parsed_count} 题`);

    const [qs] = await conn.query(
      'SELECT exam_paper_id, seq, section, stem, image_url FROM exam_paper_question ORDER BY exam_paper_id, seq'
    );
    console.log('\n=== 题目与截图挂载 ===');
    const byPaper = new Map();
    for (const q of qs) {
      if (!byPaper.has(q.exam_paper_id)) byPaper.set(q.exam_paper_id, []);
      byPaper.get(q.exam_paper_id).push(q);
    }
    for (const [pid, list] of byPaper) {
      const withImg = list.filter((q) => q.image_url);
      console.log(`  paper#${pid}: ${list.length} 题，带截图 ${withImg.length} 题`);
      for (const q of list) {
        console.log(`    seq=${q.seq} img=${q.image_url || '(无)'} | ${String(q.stem).slice(0, 30)}`);
      }
    }

    // 文件是否落盘
    const imgRoot = path.join(UPLOAD_DIR, 'paper-images');
    if (fs.existsSync(imgRoot)) {
      for (const d of fs.readdirSync(imgRoot)) {
        const files = fs.readdirSync(path.join(imgRoot, d));
        console.log(`\n  截图目录 paper-images/${d}: ${files.length} 个文件 → ${files.join(', ')}`);
      }
    }

    if (clean) {
      // 清理测试卷（标题含 E2E）与临时账号
      const [testPapers] = await conn.query("SELECT id FROM exam_paper WHERE title LIKE '%E2E%'");
      for (const p of testPapers) {
        await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [p.id]);
        await conn.query('DELETE FROM exam_paper WHERE id = ?', [p.id]);
        const dir = path.join(UPLOAD_DIR, 'paper-images', String(p.id));
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        const pdf = path.join(UPLOAD_DIR, `${p.id}.pdf`);
        if (fs.existsSync(pdf)) fs.rmSync(pdf, { force: true });
        console.log(`\n  已清理测试卷 #${p.id}`);
      }
      const [tmpUsers] = await conn.query("SELECT id, username FROM `user` WHERE username LIKE 'e2e%'");
      for (const u of tmpUsers) {
        await conn.query('DELETE FROM `user` WHERE id = ?', [u.id]);
        console.log(`  已清理临时账号 ${u.username}`);
      }
    }
  });
  await closePool();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
