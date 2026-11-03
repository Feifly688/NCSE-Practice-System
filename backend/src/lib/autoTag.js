/**
 * 题目自动打标签：把题目挂到分类树上。
 *
 * 规则（对照粉笔专项练习的分类维度）：
 *   整卷题（exam_paper_question）：
 *     · section 决定一级模块（政治理论/常识判断/…）
 *     · 模块下按「题型」二级分类：判断推理 → 图形推理/定义判断/类比推理/逻辑判断
 *     · 言语理解 → 逻辑填空/片段阅读/…
 *   单题（question）：
 *     · subject_id → 一级模块
 *     · qtype → 二级分类
 *
 * 幂等：同一 (pool, ref_id, category_id) 只写一次。
 */
const path = require('path');
// 允许直接 `node src/lib/autoTag.js` 运行（脚本场景自载 .env）
if (!process.env.MYSQL_HOST) {
  try { require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') }); } catch (e) { /* 忽略 */ }
}
const { withConnection } = require('../db');

/** 整卷分区名 → 一级模块 slug */
const SECTION_TO_MODULE = {
  政治理论: 'module-politics',
  常识判断: 'module-common',
  常识: 'module-common',
  言语理解与表达: 'module-verbal',
  言语理解: 'module-verbal',
  数量关系: 'module-quantity',
  判断推理: 'module-logic',
  资料分析: 'module-data',
};

/** 题型关键词 → 二级分类 slug（按模块区分） */
const QTYPE_RULES = {
  'module-logic': [
    [/图形|空间重构|立体/, 'logic-graphic'],
    [/定义/, 'logic-definition'],
    [/类比|逻辑关系/, 'logic-analogy'],
    [/逻辑|推理|判断/, 'logic-reasoning'],
  ],
  'module-verbal': [
    [/逻辑填空|填空/, 'verbal-fill'],
    [/片段|阅读理解|主旨|意图|细节|标题|词句/, 'verbal-reading'],
    [/语句|排序|衔接/, 'verbal-sentence'],
    [/篇章/, 'verbal-passage'],
  ],
  'module-quantity': [
    [/数学运算|计算/, 'quantity-math'],
    [/数字推理|数列/, 'quantity-number'],
  ],
};

/** 题型关键词 → 一级模块（单题池没有 section 时用） */
const QTYPE_TO_MODULE = [
  [/政治|理论|党史|毛中特|马原|思修|时政/, 'module-politics'],
  [/常识|法律|经济|科技|人文|历史|地理|国情/, 'module-common'],
  [/言语|阅读|填空|片段|语句|篇章/, 'module-verbal'],
  [/数量|数学|运算|数字推理/, 'module-quantity'],
  [/图形|定义|类比|逻辑判断|推理/, 'module-logic'],
  [/资料|增长率|比重|平均数|倍数/, 'module-data'],
];

/** 关键词 → 主题类二级分类（资料分析/常识判断等按主题分） */
const TOPIC_RULES = {
  'module-data': [
    [/增长率|增长量|基期|现期|年均增长/, 'data-growth'],
    [/比重|占比/, 'data-proportion'],
    [/平均数|均值/, 'data-average'],
    [/倍数|比值/, 'data-ratio'],
    [/综合分析/, 'data-comprehensive'],
  ],
  'module-common': [
    [/政治|宪法|党的|政府/, 'common-politics'],
    [/法律|民法|刑法|宪法|法/, 'common-law'],
    [/经济|GDP|货币|财政|市场/, 'common-economy'],
    [/科技|物理|化学|生物|技术/, 'common-science'],
    [/历史|古代|朝代|文学/, 'common-history'],
    [/地理|气候|地形|资源/, 'common-geography'],
  ],
  'module-politics': [
    [/马克思|哲学|辩证|唯物|资本/, 'politics-marxism'],
    [/习近平|新思想|二十大|中国特色社会主义/, 'politics-thought'],
    [/时政|时事|当年|本月/, 'politics-current'],
    [/毛中特|毛泽东|邓小平/, 'politics-maozhong'],
  ],
};

/**
 * 用题干关键词猜主题类二级分类。
 * 用于题目没有明确题型/分区信息的情况（如整卷题统一按「单选题」入库）。
 */
function guessByText(text) {
  const t = String(text || '');
  const out = [];
  for (const [moduleSlug, rules] of Object.entries(TOPIC_RULES)) {
    for (const [re, slug] of rules) {
      if (re.test(t)) out.push({ moduleSlug, slug });
    }
  }
  return out;
}

/**
 * 给所有整卷题打标签。
 * @returns {Promise<Object>} 统计
 */
async function tagExamPaperQuestions() {
  return withConnection(async (conn) => {
    // 分类 id 映射
    const [cats] = await conn.query('SELECT id, slug, level, parent_id FROM question_category');
    const bySlug = new Map(cats.map((c) => [c.slug, c]));
    const parentSlug = new Map(cats.map((c) => [c.id, c.parent_id]));

    const [papers] = await conn.query(
      `SELECT q.id, q.exam_paper_id, q.section, q.qtype, q.stem, q.passage,
              p.title, p.year, p.exam_level, p.region, p.paper_type
         FROM exam_paper_question q
         JOIN exam_paper p ON p.id = q.exam_paper_id
        WHERE p.parse_status IN ('success','partial')`
    );

    const mapRows = [];
    let tagged = 0;

    for (const q of papers) {
      const moduleSlug = SECTION_TO_MODULE[String(q.section || '').trim()];
      if (!moduleSlug) continue;
      const moduleCat = bySlug.get(moduleSlug);
      if (!moduleCat) continue;

      // 一级模块
      mapRows.push({ catId: moduleCat.id, pool: 'exam_paper_question', refId: q.id });

      // 二级：优先按题型规则，其次按文本关键词
      let second = null;
      const rules = QTYPE_RULES[moduleSlug] || [];
      const qt = String(q.qtype || '');
      for (const [re, slug] of rules) {
        if (re.test(qt)) { second = slug; break; }
      }
      if (!second) {
        for (const [re, slug] of rules) {
          if (re.test(String(q.stem || ''))) { second = slug; break; }
        }
      }
      if (!second) {
        const guessed = guessByText(q.stem);
        const g = guessed.find((x) => x.moduleSlug === moduleSlug);
        if (g) second = g.slug;
      }
      if (second && bySlug.has(second)) {
        mapRows.push({ catId: bySlug.get(second).id, pool: 'exam_paper_question', refId: q.id });
      }
      tagged += 1;
    }

    // 批量写入（去重）
    if (mapRows.length) {
      const values = mapRows.map(() => '(?,?,?)').join(',');
      const params = [];
      mapRows.forEach((r) => params.push(r.catId, r.pool, r.refId));
      await conn.query(
        `INSERT IGNORE INTO question_category_map (category_id, pool, ref_id) VALUES ${values}`,
        params
      );
    }

    // 试卷分类：按标题推断 exam_level / region / paper_type
    const paperCatRows = [];
    const seenPapers = new Set();
    for (const q of papers) {
      if (seenPapers.has(q.exam_paper_id)) continue;
      seenPapers.add(q.exam_paper_id);
      const title = String(q.title || '');

      // 考试级别
      let examLevel = q.exam_level || '';
      if (!examLevel) {
        if (/政法干警/.test(title)) examLevel = '政法干警';
        else if (/省考|省公务员|各省/.test(title)) examLevel = '省考';
        else if (/事业单位/.test(title)) examLevel = '事业单位';
        else if (/选调|遴选/.test(title)) examLevel = '选调生';
        else if (/国家公务|国考/.test(title)) examLevel = '国考';
      }
      if (examLevel) {
        const dictVal = { 国考: 'national', 省考: 'provincial', 事业单位: '事业单位', 选调生: '选调生' }[examLevel] || examLevel;
        paperCatRows.push({ paperId: q.exam_paper_id, dim: 'exam_level', value: dictVal });
      }

      // 地区
      let region = q.region || '';
      if (!region) {
        const provinces = ['安徽', '北京', '福建', '甘肃', '广东', '广西', '贵州', '海南', '河北', '河南',
          '黑龙江', '湖北', '湖南', '吉林', '江苏', '江西', '辽宁', '内蒙古', '宁夏', '青海', '山东',
          '山西', '陕西', '上海', '四川', '天津', '西藏', '新疆', '云南', '浙江', '重庆'];
        const found = provinces.find((p) => title.includes(p));
        if (found) region = found;
        else if (/深圳市|深圳/.test(title)) region = '深圳市考';
        else if (/广州市|广州/.test(title)) region = '广州市考';
        else if (/政法干警/.test(title)) region = '政法干警';
      }
      if (region) {
        paperCatRows.push({ paperId: q.exam_paper_id, dim: 'region', value: region });
      }

      // 试卷类型
      let paperType = q.paper_type || '';
      if (!paperType) {
        if (/模考|模拟|预测/.test(title)) paperType = '模拟题';
        else if (/真题|笔试|录用考试|选调|政法干警|基层工作考试/.test(title)) paperType = '历年真题';
        else paperType = '历年真题';
      }
      paperCatRows.push({ paperId: q.exam_paper_id, dim: 'paper_type', value: paperType });
    }

    if (paperCatRows.length) {
      const values = paperCatRows.map(() => '(?,?,?)').join(',');
      const params = [];
      paperCatRows.forEach((r) => params.push(r.paperId, r.dim, r.value));
      await conn.query(
        `INSERT IGNORE INTO exam_paper_category (exam_paper_id, dim, value) VALUES ${values}`,
        params
      );
    }

    // 同步 exam_paper 的直列（列表页筛选用）
    await conn.query(
      `UPDATE exam_paper p
         LEFT JOIN (
           SELECT exam_paper_id,
                  MAX(CASE WHEN dim = 'exam_level' THEN value END) AS exam_level,
                  MAX(CASE WHEN dim = 'region' THEN value END) AS region,
                  MAX(CASE WHEN dim = 'paper_type' THEN value END) AS paper_type
             FROM exam_paper_category GROUP BY exam_paper_id
         ) c ON c.exam_paper_id = p.id
          SET p.exam_level = COALESCE(p.exam_level, c.exam_level),
              p.region = COALESCE(p.region, c.region),
              p.paper_type = COALESCE(p.paper_type, c.paper_type)`
    );

    // 统计每个分类下的题数
    const [stats] = await conn.query(
      `SELECT c.slug, c.name, c.level, COUNT(m.id) AS cnt
         FROM question_category c
         LEFT JOIN question_category_map m ON m.category_id = c.id AND m.pool = 'exam_paper_question'
        GROUP BY c.id ORDER BY c.level, c.sort_order`
    );

    return {
      papers: seenPapers.size,
      taggedQuestions: tagged,
      mapRows: mapRows.length,
      paperCategories: paperCatRows.length,
      stats,
    };
  });
}

/**
 * 给题库（question 表）打标签。
 *
 * 一级模块：优先用 section_name（整卷分区，回流后保留），
 *           没有则用 subject_id 对应的科目。
 * 二级分类：先按题型规则匹配，不中则按题干关键词匹配主题类分类。
 */
async function tagSingleQuestions() {
  return withConnection(async (conn) => {
    const [cats] = await conn.query('SELECT id, slug, level, parent_id FROM question_category');
    const bySlug = new Map(cats.map((c) => [c.slug, c]));

    const [subjects] = await conn.query('SELECT id, name, slug FROM subject');
    const subjectToModule = {
      政治理论: 'module-politics',
      政治: 'module-politics',
      常识判断: 'module-common',
      言语理解与表达: 'module-verbal',
      言语理解: 'module-verbal',
      数量关系: 'module-quantity',
      判断推理: 'module-logic',
      资料分析: 'module-data',
    };

    const [questions] = await conn.query(
      "SELECT id, subject_id, qtype, stem, section_name FROM question WHERE status = 'approved'"
    );

    const mapRows = [];
    for (const q of questions) {
      const subjectName = (subjects.find((s) => s.id === q.subject_id) || {}).name;
      const moduleSlug = SECTION_TO_MODULE[String(q.section_name || '').trim()]
        || subjectToModule[subjectName];
      if (!moduleSlug || !bySlug.has(moduleSlug)) continue;
      mapRows.push({ catId: bySlug.get(moduleSlug).id, pool: 'question', refId: q.id });

      // 二级：题型规则优先
      const qtypeRules = QTYPE_RULES[moduleSlug] || [];
      let second = null;
      for (const [re, slug] of qtypeRules) {
        if (re.test(String(q.qtype || ''))) { second = slug; break; }
      }
      // 再按题干关键词
      if (!second) {
        const text = `${q.stem || ''} ${q.section_name || ''}`;
        for (const [re, slug] of qtypeRules) {
          if (re.test(text)) { second = slug; break; }
        }
      }
      if (!second) {
        const guessed = guessByText(text_for(q));
        const g = guessed.find((x) => x.moduleSlug === moduleSlug);
        if (g) second = g.slug;
      }
      if (second && bySlug.has(second)) {
        mapRows.push({ catId: bySlug.get(second).id, pool: 'question', refId: q.id });
      }
    }

    if (mapRows.length) {
      const values = mapRows.map(() => '(?,?,?)').join(',');
      const params = [];
      mapRows.forEach((r) => params.push(r.catId, r.pool, r.refId));
      await conn.query(
        `INSERT IGNORE INTO question_category_map (category_id, pool, ref_id) VALUES ${values}`,
        params
      );
    }
    return { tagged: mapRows.length, questions: questions.length };
  });
}

/** 题目文本（题干 + 分区名），供关键词匹配 */
function text_for(q) {
  return `${q.stem || ''} ${q.section_name || ''} ${q.qtype || ''}`;
}

module.exports = { tagExamPaperQuestions, tagSingleQuestions, SECTION_TO_MODULE };

if (require.main === module) {
  (async () => {
    // ① 先把整卷题回流进题库（错题本/收藏/练习会话都依赖 question 表）
    const { reflowAllPapers } = require('./paperReflow');
    const reflowed = await reflowAllPapers();
    console.log('=== 整卷题回流 ===');
    reflowed.forEach((r) => console.log('  ' + JSON.stringify(r)));

    // ② 试卷分类标签（exam_level / region / paper_type）
    const r1 = await tagExamPaperQuestions();
    console.log('\n=== 试卷分类 ===');
    console.log('  ' + JSON.stringify({
      papers: r1.papers, paperCategories: r1.paperCategories,
    }));

    // ③ 题目分类标签（统一在 question 表上）
    const r2 = await tagSingleQuestions();
    console.log('\n=== 题目分类 ===');
    console.log('  ' + JSON.stringify(r2));

    // ④ 各分类题数
    const { withConnection: wc } = require('../db');
    const stats = await wc(async (conn) => {
      const [rows] = await conn.query(
        `SELECT c.level, c.name, c.slug, COUNT(m.id) AS cnt
           FROM question_category c
           LEFT JOIN question_category_map m ON m.category_id = c.id AND m.pool = 'question'
          GROUP BY c.id ORDER BY c.level, c.sort_order`
      );
      return rows;
    });
    console.log('\n=== 分类题数 ===');
    stats.forEach((s) => {
      if (s.cnt) console.log(`  ${'  '.repeat(s.level - 1)}${s.name}: ${s.cnt}`);
    });
    process.exit(0);
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
