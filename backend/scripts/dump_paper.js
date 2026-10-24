/**
 * 导出真题原文与拆题结果到本地分析（一次性排查用）。
 * 用法：node scripts/dump_paper.js <paper_id>
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { withConnection, closePool } = require('../src/db');

async function main() {
  const paperId = Number(process.argv[2] || 1);
  await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT id, title, raw_text, parse_status, parse_error FROM exam_paper WHERE id = ?', [paperId]);
    if (!rows.length) { console.log('paper not found'); return; }
    const p = rows[0];
    const outDir = process.env.DUMP_DIR || path.resolve(process.cwd(), 'tmp-paper-analysis');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `paper${paperId}_raw.txt`), p.raw_text || '', 'utf8');
    console.log('raw_text written, len =', (p.raw_text || '').length, '->', outDir);

    const [qs] = await conn.query(
      'SELECT seq, section, qtype, stem, options_json, answer, passage, explanation, fingerprint FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq',
      [paperId]
    );
    const lines = qs.map((q) => {
      const opts = (() => { try { return typeof q.options_json === 'string' ? JSON.parse(q.options_json) : q.options_json; } catch (e) { return q.options_json; } })();
      return [
        `### seq=${q.seq} section=${q.section} qtype=${q.qtype} answer=${q.answer}`,
        `PASSAGE: ${q.passage || '(空)'}`,
        `STEM: ${q.stem || '(空)'}`,
        `OPTIONS: ${JSON.stringify(opts)}`,
        `EXPL: ${q.explanation || '(空)'}`,
        '',
      ].join('\n');
    });
    fs.writeFileSync(path.join(outDir, `paper${paperId}_questions.txt`), lines.join('\n'), 'utf8');
    console.log('questions written, count =', qs.length);
  });
  await closePool();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
