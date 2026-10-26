/**
 * 重新从原 PDF 提取文本并写回 exam_paper.raw_text。
 *
 * 用途：提取链路升级（如选词填空空格恢复、视觉顺序重建）后，
 * 已入库的试卷 raw_text 仍是旧版产物，需要用新链路重提一次再重跑拆题。
 *
 * 用法：node scripts/reextract-paper.js <试卷ID>
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { withConnection } = require('../src/db');
const { extractPdfText } = require('../src/lib/pdfText');

async function main() {
  const id = Number(process.argv[2]);
  if (!id) {
    console.error('用法: node scripts/reextract-paper.js <试卷ID>');
    process.exit(1);
  }
  const paper = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, title, file_name, CHAR_LENGTH(raw_text) len FROM exam_paper WHERE id = ?', [id]);
    return rows[0] || null;
  });
  if (!paper) { console.error('试卷不存在: id=' + id); process.exit(1); }

  const pdfPath = path.resolve(__dirname, '../uploads/papers', `${id}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    console.error('找不到原 PDF: ' + pdfPath);
    process.exit(1);
  }
  console.log(`试卷 #${id} 「${paper.title}」 旧 raw_text=${paper.len} 字`);
  console.log('重新提取中...');

  const buffer = fs.readFileSync(pdfPath);
  const res = await extractPdfText(buffer);
  if (!res.ok) {
    console.error('提取失败: ' + (res.error || '未知错误'));
    process.exit(1);
  }
  console.log(`提取完成: method=${res.method} 页数=${res.pages} 字数=${res.text.length} 空格标注=${res.blanks || 0} 处`);

  await withConnection(async (conn) => {
    await conn.query('UPDATE exam_paper SET raw_text = ? WHERE id = ?', [res.text, id]);
  });
  console.log('已写回 raw_text');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
