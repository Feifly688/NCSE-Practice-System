/**
 * 拆题结果体检：材料回填情况 + 修正 parse_status/parse_error（对账信息）。
 * 用法：node scripts/verify_paper.js <paperId>
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { withConnection, closePool } = require('../src/db');
const { preprocessPaperText } = require('../src/lib/paperText');

async function main() {
  const id = Number(process.argv[2] || 1);
  await withConnection(async (conn) => {
    const [papers] = await conn.query('SELECT id, title, raw_text, parse_status, parsed_count FROM exam_paper WHERE id = ?', [id]);
    if (!papers.length) { console.log('paper not found'); return; }
    const p = papers[0];
    const [qs] = await conn.query(
      'SELECT seq, section, stem, options_json, answer, passage FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq',
      [id]
    );
    const pre = preprocessPaperText(p.raw_text || '', { titles: [p.title] });

    console.log('=== 对账 ===');
    console.log('原文题号数(预处理后):', pre.questionCount, '| 实际拆出:', qs.length);
    const gap = pre.questionCount - qs.length;

    const bySec = {};
    for (const q of qs) bySec[q.section || '(null)'] = (bySec[q.section || '(null)'] || 0) + 1;
    console.log('拆出分区题量:', JSON.stringify(bySec));

    console.log('\n=== 各分区材料(passage)情况 ===');
    const matSec = pre.sections.filter((s) => s.material).map((s) => s.name);
    for (const s of pre.sections) {
      const list = qs.filter((q) => q.section === s.name);
      const withMat = list.filter((q) => q.passage && q.passage.trim().length > 20);
      console.log(
        `  ${s.name}: ${list.length} 题，带材料 ${withMat.length} 题` +
        (matSec.includes(s.name) ? '（该板块有共享材料 ' + s.material.length + ' 字）' : '')
      );
    }

    console.log('\n=== 资料分析样例 ===');
    qs.filter((q) => q.section === '资料分析').slice(0, 3).forEach((q) => {
      console.log(`  seq=${q.seq} stem=${JSON.stringify(String(q.stem).slice(0, 42))}`);
      console.log(`    passage(${String(q.passage || '').length}字)=${JSON.stringify(String(q.passage || '').slice(0, 70))}`);
    });

    console.log('\n=== 选项为图片占位符的题 ===');
    const imgQ = qs.filter((q) => {
      let o = q.options_json;
      try { o = typeof o === 'string' ? JSON.parse(o) : o; } catch (e) {}
      return Array.isArray(o) && o.every((x) => /图片选项/.test(String(x)));
    });
    console.log('  共', imgQ.length, '题，seq:', imgQ.map((q) => q.seq).join(',') || '无');

    // 修正状态与对账信息
    const notes = [];
    if (gap > 0) notes.push(`原文题号 ${pre.questionCount} 个，实际拆出 ${qs.length} 题，差 ${gap} 题`);
    else if (gap < 0) notes.push(`原文题号 ${pre.questionCount} 个，实际拆出 ${qs.length} 题，多出 ${-gap} 题`);
    else notes.push(`原文题号 ${pre.questionCount} 个，实际拆出 ${qs.length} 题，数量一致`);
    const noAns = qs.filter((q) => !q.answer).length;
    if (noAns) notes.push(`${noAns} 题缺答案待补`);
    if (imgQ.length) notes.push(`${imgQ.length} 题选项为图片（原试卷中为图形，需人工补图）`);
    const status = gap === 0 && noAns === 0 ? 'success' : 'partial';
    await conn.query(
      'UPDATE exam_paper SET parse_status = ?, parse_error = ?, parsed_count = ?, last_parse_at = NOW() WHERE id = ?',
      [status, notes.join('；'), qs.length, id]
    );
    console.log('\n=== 已更新状态 ===');
    console.log('parse_status =', status, '| parse_error =', notes.join('；'));
  });
  await closePool();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
