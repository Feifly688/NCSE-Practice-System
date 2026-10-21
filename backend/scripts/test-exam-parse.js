/**
 * 真题拆题改造的验证脚本（可重复运行，不写库）。
 *   node scripts/test-exam-parse.js          基础用例（离线）
 *   node scripts/test-exam-parse.js --live   追加一次真实 AI 调用（验证 prompt 与输出上限）
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { extractJson, salvageTruncated } = require('../src/lib/aiClient');
const { splitIntoChunks, normalizeQuestion, normalizeAnswer, splitHalf, dedupeList, parseChunk } = require('../src/lib/paperParser');
const { diceSimilarity, judgeDuplicate, buildFingerprint } = require('../src/lib/questionDedupe');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('=== 1. AI 输出解析（含截断抢救）===');
{
  // 完整但被 ```json 包裹
  const fenced = '```json\n{"questions":[{"stem":"题干1","options":["A","B"],"answer":"A"}]}\n```';
  const r1 = extractJson(fenced);
  check('代码块包裹的完整 JSON 可解析', r1.ok && r1.data.questions.length === 1, JSON.stringify(r1).slice(0, 120));

  // 真实失败样本：输出在第 4 题处被截断（glm-4-flash completion 打满 1024）
  const truncated = '```json\n{"questions":[' +
    '{"module":"政治理论","qtype":"单选题","difficulty":3,"stem":"题干1","options":["A1","B1","C1","D1"],"answer":"A"},' +
    '{"module":"政治理论","qtype":"多选题","difficulty":3,"stem":"题干2","options":["A2","B2","C2","D2"],"answer":"AB"},' +
    '{"module":"常识判断","qtype":"单选题","difficulty":2,"stem":"题干3","options":["A3","B3","C3","D3"],"answer":"C"},' +
    '{"module":"常识判断","qtype":"单选题","difficulty":2,"stem":"题干4（被截断","options":["A4","B4"';
  const r2 = extractJson(truncated);
  check('截断输出可抢救出已完整的题目', r2.ok && r2.data.questions.length === 3,
    JSON.stringify(r2).slice(0, 160));
  check('截断抢救被标记为 salvaged', r2.salvaged === true);

  // 带前言说明文字
  const withPreamble = '好的，以下是拆分结果：\n{"questions":[{"stem":"x","options":["a","b"],"answer":"A"}]}';
  const r3 = extractJson(withPreamble);
  check('带前言文字可解析', r3.ok && r3.data.questions.length === 1);

  // 尾部逗号
  const trailing = '{"questions":[{"stem":"x","options":["a","b"],"answer":"A"},]}';
  const r4 = extractJson(trailing);
  check('尾部逗号可修复', r4.ok);

  // 纯垃圾
  const r5 = extractJson('抱歉，我无法处理');
  check('非 JSON 内容被识别为失败', !r5.ok);
}

console.log('=== 2. 整卷切片 ===');
{
  const file = path.resolve(__dirname, 'paper_decoded.txt');
  if (fs.existsSync(file)) {
    // 样本由 mysql CLI 批量模式导出，换行被转义为字面量 \n，这里还原
    const text = fs.readFileSync(file, 'utf8').replace(/\\n/g, '\n');
    const chunks = splitIntoChunks(text);
    const avg = Math.round(chunks.reduce((s, c) => s + c.text.length, 0) / Math.max(1, chunks.length));
    const maxLen = Math.max(...chunks.map((c) => c.text.length));
    console.log(`  文本 ${text.length} 字 -> ${chunks.length} 片，平均 ${avg} 字，最长 ${maxLen} 字`);
    console.log('  分区识别: ' + Array.from(new Set(chunks.map((c) => c.section))).join(' / '));
    check('切片数量合理（每片控制在 ~2400 字）', chunks.length >= 4 && chunks.length <= 40, 'chunks=' + chunks.length);
    check('单片不超过 4000 字（避免打满输出上限）', maxLen <= 4000, 'max=' + maxLen);
    check('切片内容覆盖原文（无大面积丢失）',
      chunks.reduce((s, c) => s + c.text.length, 0) >= text.length * 0.9);
  } else {
    console.log('  (缺少 paper_decoded.txt，跳过切片用例)');
  }
}

console.log('=== 3. 题目清洗 ===');
{
  const q = normalizeQuestion({ stem: '题干', options: ['A. 选项一', 'B、选项二'], answer: '答案A', difficulty: 9, qtype: '' });
  check('选项前缀被剥离', q && q.options[0] === '选项一' && q.options[1] === '选项二', JSON.stringify(q && q.options));
  check('答案提取为字母', q && q.answer === 'A', q && q.answer);
  check('越界难度被归正', q && q.difficulty === 3, q && q.difficulty);
  check('题型兜底', q && q.qtype === '单选题');
  check('无效题被过滤', normalizeQuestion({ stem: '', options: ['a'] }) === null);
  check('多选题答案合并', normalizeAnswer('AB', 4) === 'AB');
}

console.log('=== 4. 去重（文本相似度 + 特征）===');
{
  const a = { qtype: '单选题', stem: '下列关于基础研究的表述正确的是：', options: ['选项甲', '选项乙', '选项丙', '选项丁'], answer: 'A' };
  const bSame = { qtype: '单选题', stem: '下列关于基础研究的表述正确的是：', options: ['选项甲', '选项乙', '选项丙', '选项丁'], answer: 'A' };
  const bPunct = { qtype: '单选题', stem: '下列关于基础研究的表述正确的是', options: ['选项甲', '选项乙', '选项丙', '选项丁'], answer: 'A' };
  const bDiff = { qtype: '单选题', stem: '关于我国能源结构调整的主要方向，下列说法正确的是', options: ['甲', '乙', '丙', '丁'], answer: 'B' };

  console.log('  相似度(同题不同标点) =', diceSimilarity(a.stem, bPunct.stem).toFixed(3));
  console.log('  相似度(不同题) =', diceSimilarity(a.stem, bDiff.stem).toFixed(3));
  check('完全一致的题判重', judgeDuplicate(a, bSame).dup === true);
  check('仅标点/空格差异判重', judgeDuplicate(a, bPunct).dup === true);
  check('不同题目不判重', judgeDuplicate(a, bDiff).dup === false);
  check('指纹一致', buildFingerprint(a) === buildFingerprint(bSame));

  const list = dedupeList([a, bPunct, bDiff]);
  check('片内去重生效（3 题 -> 2 题）', list.length === 2, 'len=' + list.length);
}

(async () => {
  if (process.argv.includes('--live')) {
    console.log('=== 5. 真实 AI 调用（抽取第 1 片）===');
    const file = path.resolve(__dirname, 'paper_decoded.txt');
    if (!fs.existsSync(file)) { console.log('  缺少文本，跳过'); return finish(); }
    // 样本由 mysql CLI 批量模式导出，换行被转义为字面量 \n，这里还原
    const text = fs.readFileSync(file, 'utf8').replace(/\\n/g, '\n');
    const chunks = splitIntoChunks(text);
    // 第 1 片通常是封面/注意事项（无题目），取第一个有模块的片段
    const idx = Math.max(0, chunks.findIndex((c) => c.section && c.section !== '未分区'));
    const target = chunks[idx];
    console.log(`  选取第 ${idx + 1}/${chunks.length} 片（分区：${target.section}，${target.text.length} 字）`);
    const r = await parseChunk(target, { paperTitle: '粉笔39季模考' });
    console.log('  结果: 题目=' + r.questions.length + ' 降级=' + r.degraded + ' 尝试=' + r.attempts);
    if (r.error) console.log('  错误: ' + r.error);
    r.questions.slice(0, 3).forEach((q, i) => {
      console.log(`  [${i + 1}] (${q.module || '-'}/${q.qtype}) ${q.stem.slice(0, 40)}… 答案=${q.answer} 选项数=${q.options.length}`);
    });
    check('真实调用能产出题目', r.questions.length > 0, 'questions=' + r.questions.length);
    check('真实调用无明显错误', !r.error || r.degraded === 'salvaged', r.error || '');
  }
  finish();
})();

function finish() {
  console.log(`\n结果: 通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
}
