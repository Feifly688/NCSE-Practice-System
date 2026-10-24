/**
 * 真题识别质量诊断脚本（一次性排查用）。
 * 用法：node scripts/diagnose_paper.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { withConnection, closePool } = require('../src/db');
const { preprocessPaperText } = require('../src/lib/paperText');

function markers(text) {
  const nums = [];
  const re = /^\s*(\d{1,3})\s*[.、．]\s*/gm;
  let m;
  while ((m = re.exec(String(text || '')))) nums.push(Number(m[1]));
  return nums;
}

async function main() {
  await withConnection(async (conn) => {
    const [papers] = await conn.query(
      'SELECT id, title, year, source, file_name, origin, parse_status, parse_error, parsed_count, question_count, LENGTH(raw_text) AS raw_len, created_at FROM exam_paper ORDER BY id DESC'
    );
    console.log('===== exam_paper 列表 (' + papers.length + ') =====');
    for (const p of papers) {
      console.log(
        `[paper#${p.id}] ${p.title} | origin=${p.origin} | file=${p.file_name || '-'} | source=${p.source || '-'}\n` +
        `   parse_status=${p.parse_status} parsed_count=${p.parsed_count} question_count=${p.question_count} raw_len=${p.raw_len}\n` +
        `   parse_error=${p.parse_error || '-'}`
      );
    }

    for (const p of papers) {
      const [rows] = await conn.query(
        'SELECT id, seq, section, qtype, stem, options_json, answer, passage, fingerprint FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq',
        [p.id]
      );
      const [rawRows] = await conn.query('SELECT raw_text FROM exam_paper WHERE id = ?', [p.id]);
      const raw = rawRows[0]?.raw_text || '';

      const textNums = markers(raw);
      const uniqTextNums = [...new Set(textNums)].sort((a, b) => a - b);
      const gotSeqs = rows.map((r) => r.seq);
      const gotSet = new Set(gotSeqs);
      const missingFromText = uniqTextNums.filter((n) => !gotSet.has(n));

      console.log('\n===== paper#' + p.id + ' ' + p.title + ' =====');
      console.log('原文题号标记出现次数: ' + textNums.length + '，去重后题号数: ' + uniqTextNums.length);
      console.log('原文题号序列: ' + uniqTextNums.join(','));
      // 预处理后的真实题号（走与拆题同一套逻辑）
      const pre = preprocessPaperText(raw, { titles: [p.title] });
      const preMiss = [];
      for (let i = 1; i <= pre.maxQuestionNo; i++) if (!pre.numbers.includes(i)) preMiss.push(i);
      console.log('★ 预处理后题号数: ' + pre.questionCount + '（最大 ' + pre.maxQuestionNo + '，缺失 ' + (preMiss.join(',') || '无') + '）');
      console.log('★ 预处理后各分区题量: ' + JSON.stringify(pre.sections.map((s2) => s2.name + ':' + (pre.index.byNumber.size && [...pre.index.byNumber.values()].filter((q) => q.section === s2.name).length))).replace(/,/g, ' '));
      console.log('实际拆出题数: ' + rows.length);
      console.log('拆出 seq 序列: ' + gotSeqs.join(','));
      console.log('>> 原文有、拆出没有的题号(' + missingFromText.length + '): ' + missingFromText.join(','));

      // 分区分布
      const bySection = {};
      for (const r of rows) bySection[r.section || '(null)'] = (bySection[r.section || '(null)'] || 0) + 1;
      console.log('分区分布: ' + JSON.stringify(bySection));

      // 数据质量
      const noAnswer = rows.filter((r) => !r.answer);
      const noOptions = rows.filter((r) => {
        try {
          const o = typeof r.options_json === 'string' ? JSON.parse(r.options_json) : r.options_json;
          return !Array.isArray(o) || o.length < 2;
        } catch (e) { return true; }
      });
      const noPassage = rows.filter((r) => !r.passage || !String(r.passage).trim());
      console.log('缺答案: ' + noAnswer.length + '，选项异常: ' + noOptions.length + '，无材料: ' + noPassage.length);
      if (noAnswer.length) console.log('  缺答案 seq: ' + noAnswer.map((r) => r.seq).join(','));

      // 原文中的图片/图表线索
      const imgHits = (raw.match(/(如图|见图|下图|图表|图片|示意图|\[图\]|图\d|附图)/g) || []);
      console.log('原文图片线索词出现次数: ' + imgHits.length);
      const imgQ = rows.filter((r) => /(如图|见图|下图|图表|图片|示意图|\[图\]|图\d)/.test(r.stem || ''));
      console.log('  含图片线索的题目数: ' + imgQ.length + (imgQ.length ? ' seq: ' + imgQ.map((r) => r.seq).join(',') : ''));

      // 题干长度异常（题干缺失）
      const shortStem = rows.filter((r) => String(r.stem || '').trim().length < 12);
      console.log('题干过短(<12字): ' + shortStem.length + (shortStem.length ? ' seq: ' + shortStem.map((r) => r.seq).join(',') : ''));

      // 抽样 3 条
      for (const r of rows.slice(0, 3)) {
        console.log('  样例 seq=' + r.seq + ' [' + r.section + '] stem=' + JSON.stringify(String(r.stem || '').slice(0, 50)) + ' ans=' + r.answer + ' passage=' + JSON.stringify(String(r.passage || '').slice(0, 40)));
      }
    }
  });
  await closePool();
}

main().catch((e) => { console.error('ERR', e.message, e.stack); process.exit(1); });
