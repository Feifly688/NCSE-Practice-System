/**
 * 整卷题回流到 question 表。
 *
 * 为什么要回流：practice_answer / wrong_book / favorites 三张表都带
 * 外键指向 question.id。整卷题若只留在 exam_paper_question 里，
 * 就无法进入错题本、收藏与练习会话 —— 那等于整卷题只能看不能练。
 *
 * 回流后：
 *   · 所有练习统一基于 question 表，分类树也只需维护一份映射
 *   · source_paper_id / source_paper_seq 保留「来自哪张卷第几题」的溯源
 *   · section_name 保留整卷分区名（一级分类的依据）
 *
 * 去重：question.fingerprint 唯一索引（题型+题干+选项+答案的哈希），
 * 同一道题在多张卷里出现时只留一条，其余卷靠 source_paper_id 区分不了，
 * 因此额外用 (source_paper_id, source_paper_seq) 判断是否已回流过。
 */
const path = require('path');
if (!process.env.MYSQL_HOST) {
  try { require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') }); } catch (e) { /* 忽略 */ }
}
const { withConnection } = require('../db');
const { buildFingerprint } = require('./questionDedupe');

/** 整卷分区名 → subject.slug */
const SECTION_TO_SUBJECT = {
  政治理论: 'politics_theory',
  常识判断: 'common_knowledge',
  常识: 'common_knowledge',
  言语理解与表达: 'verbal_comprehension',
  言语理解: 'verbal_comprehension',
  数量关系: 'quantity_relation',
  判断推理: 'logic_reasoning',
  资料分析: 'data_analysis',
};

/**
 * 把某张整卷的题目回流到 question 表。
 *
 * @param {number} paperId 整卷 id
 * @param {Object} opts
 * @param {boolean} opts.overwriteDuplicates 同 fingerprint 已存在时是否仍插入
 *   （false = 跳过重复，保留首条；true = 同题不同卷各存一条）
 * @returns {Promise<Object>} 统计
 */
async function reflowPaperToQuestions(paperId, opts = {}) {
  return withConnection(async (conn) => {
    const [papers] = await conn.query(
      "SELECT id, title, year, source FROM exam_paper WHERE id = ? AND parse_status IN ('success','partial')",
      [paperId]
    );
    if (!papers.length) {
      return { paperId, inserted: 0, skipped: 0, reason: '试卷不存在或未解析完成' };
    }
    const paper = papers[0];

    const [rows] = await conn.query(
      `SELECT id, seq, section, qtype, difficulty, passage, stem, options_json, answer, explanation
         FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq`,
      [paperId]
    );

    // subject id 映射
    const [subjects] = await conn.query('SELECT id, slug FROM subject');
    const subjectBySlug = new Map(subjects.map((s) => [s.slug, s.id]));

    // 该卷是否已回流过（避免重复执行产生重复行）
    const [existing] = await conn.query(
      'SELECT COUNT(*) AS c FROM question WHERE source_paper_id = ?',
      [paperId]
    );
    if (Number(existing[0].c) > 0 && !opts.force) {
      return { paperId, inserted: 0, skipped: rows.length, reason: '该卷已回���过', duplicated: true };
    }

    let inserted = 0;
    let skipped = 0;

    for (const q of rows) {
      const slug = SECTION_TO_SUBJECT[String(q.section || '').trim()] || 'verbal_comprehension';
      const subjectId = subjectBySlug.get(slug);
      if (!subjectId) { skipped += 1; continue; }

      const options = safeParse(q.options_json);
      const fingerprint = buildFingerprint({
        qtype: q.qtype,
        stem: q.stem,
        options,
        answer: q.answer,
      });
      if (!fingerprint) { skipped += 1; continue; }

      // fingerprint 已存在 → 跳过（除非强制保留重复）
      if (!opts.overwriteDuplicates) {
        const [dup] = await conn.query(
          'SELECT id FROM question WHERE fingerprint = ? LIMIT 1',
          [fingerprint]
        );
        if (dup.length) { skipped += 1; continue; }
      }

      await conn.query(
        `INSERT INTO question
           (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation,
            status, source_exam, exam_paper_id, source_paper_id, source_paper_seq, section_name, fingerprint)
         VALUES (?,?,?,?,?,?,?,?, 'approved', ?,?,?,?,?,?)`,
        [
          subjectId,
          q.qtype || '单选题',
          q.difficulty || 3,
          q.passage || null,
          q.stem,
          JSON.stringify(options),
          q.answer || '',
          q.explanation || '',
          paper.source ? `${paper.source}·${paper.title}` : paper.title,
          paperId,
          paperId,
          q.seq,
          q.section || null,
          fingerprint,
        ]
      );
      inserted += 1;
    }

    return { paperId, title: paper.title, inserted, skipped, total: rows.length };
  });
}

/** 回流全部已解析完成的整卷 */
async function reflowAllPapers(opts = {}) {
  const { withConnection: wc } = require('../db');
  const papers = await wc(async (conn) => {
    const [rows] = await conn.query(
      "SELECT id, title FROM exam_paper WHERE parse_status IN ('success','partial') ORDER BY id"
    );
    return rows;
  });
  const results = [];
  for (const p of papers) {
    results.push(await reflowPaperToQuestions(p.id, opts));
  }
  return results;
}

function safeParse(text) {
  if (!text) return [];
  if (Array.isArray(text)) return text;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

module.exports = { reflowPaperToQuestions, reflowAllPapers, SECTION_TO_SUBJECT };

if (require.main === module) {
  (async () => {
    const results = await reflowAllQuestions();
    results.forEach((r) => console.log(JSON.stringify(r)));
    process.exit(0);
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}

async function reflowAllQuestions() {
  return reflowAllPapers();
}
