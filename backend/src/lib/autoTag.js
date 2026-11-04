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

/**
 * 题型规则 → 二级分类 slug。
 *
 * 规则按「真题标准句式」编写 —— 真题题干是模板化的：
 *   图形推理必说「从所给的四个选项中…问号处」、定义判断必有「上述定义」、
 *   逻辑填空必有「填入画横线部分最恰当」、资料分析材料必有「同比/比重」等。
 * 旧版规则按「逻辑填空/图形推理」这类词面匹配，真题题干不含这些词，
 * 导致 90%+ 的题挂不上二级分类（专项练习里看不到题型分组）。
 * 每个模块内先匹配到先用；最后一条通常是兜底。
 */
const QTYPE_RULES = {
  'module-logic': [
    [/把下面的六个图形|图形分类|立体折叠|纸盒|剖面图|三视图|六面体/, 'logic-graphic'],
    [/从所给的四个选项中.{0,12}(选择|选出一个?)最合适.{0,8}(填入问号处|呈现一定的规律)/, 'logic-graphic'],
    [/问号处/, 'logic-graphic'],
    [/根据上述定义|属于.{0,8}定义|不符合.{0,10}定义|定义的关键信息|这一定义/, 'logic-definition'],
    [/对于.{1,12}相当于|内在逻辑关系.{0,10}(相近|相似)|词项间|与之(关系|逻辑).{0,8}(相近|相似)|(最为|最)相似的一组/, 'logic-analogy'],
    [/可以推出|无法(推出|断定)的是|哪项如果为真|如果为真|最能(削弱|加强|支持|质疑|反驳)|前提|假设|论证|真假话|逻辑错误|最能解释/, 'logic-reasoning'],
    [/以上说法|由此可以|据(此|此可以)判断/, 'logic-reasoning'],
    [/.*/, 'logic-reasoning'], // 判断推理兜底：四种题型中逻辑判断占比最高
  ],
  'module-verbal': [
    [/填入画横线|填入横线部分|依次填入|填入下面横线|最恰当的一组|填入.{0,6}最恰当/, 'verbal-fill'],
    [/重新排列|语序(最)?连贯|句子(的顺序|排序)|语句(排序|填空)|接语|上下文衔接|横线处的?语句/, 'verbal-sentence'],
    [/篇章|以下(几段|几段文字|文字)，完成|阅读以下文字/, 'verbal-passage'],
    [/意在(说明|强调)|文段|这段文字|主旨|主要(说明|介绍了|强调了)|关键词|标题|细节|作者(的态度|观点)|概括(最)?(准确|恰当)/, 'verbal-reading'],
    [/.*/, 'verbal-reading'], // 言语兜底：片段阅读占比最高
  ],
  'module-quantity': [
    [/数列/, 'quantity-number'],
    [/.*/, 'quantity-math'], // 数量关系兜底：数学运算
  ],
  'module-data': [
    [/能够(推出|得出|判断)|下列说法(正确|错误|不正确|可以|一定)/, 'data-comprehensive'],
    [/比重|占比|占.{0,10}(比例|比重)|占全部|占总/, 'data-proportion'],
    [/平均|人均|每(百|万|千|个|人|只|件)|均值/, 'data-average'],
    [/倍数|之比|倍/, 'data-ratio'],
    [/增长量|增加(了?)?[0-9一二三四五六七八九十]+.{0,4}(亿元|万元|万吨|万人|个)|多多少/, 'data-increment'],
    [/同比|环比|增长率|增长速度|增速|增幅|增长最快|增长.{0,6}%/, 'data-growth'],
    [/.*/, 'data-comprehensive'], // 资料分析兜底：综合分析
  ],
  'module-politics': [
    [/马克思主义|唯物|辩证|认识论|剩余价值|资本主|社会主义(革命|改造)/, 'politics-marxism'],
    [/毛泽东|新民主主义|毛中特|遵义会议|井冈山/, 'politics-maozhong'],
    [/新时代|中国特色社会|习近平|治国理政|中国式现代化|二十大/, 'politics-thought'],
    [/.*/, 'politics-current'], // 政治理论兜底：时事政治
  ],
  'module-common': [
    [/法律|刑法|民法|宪法|行政法|诉讼|犯罪|合同|劳动(合同|法)|监察|法制/, 'common-law'],
    [/地理|气候|地形|山(脉|川|峰)|河流|经纬|国情|省份|资源分布/, 'common-geography'],
    [/历史|朝代|战争|文化(遗产|常识)?|文学|诗人|古籍|传统(节日|习俗)/, 'common-history'],
    [/科技|物理|化学|生物|航天|病毒|基因|计算机|信息技术|科学(技术|原理)/, 'common-science'],
    [/经济|通货膨胀|货币|财政|市场调节|供给|需求|GDP|汇率/, 'common-economy'],
    [/.*/, 'common-politics'], // 常识兜底：政治常识
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
      "SELECT id, subject_id, qtype, stem, passage, section_name FROM question WHERE status = 'approved' AND (source_exam IS NULL OR source_exam NOT LIKE '%AI生成%') AND source_article_id IS NULL"
    );

    const mapRows = [];
    for (const q of questions) {
      const subjectName = (subjects.find((s) => s.id === q.subject_id) || {}).name;
      const moduleSlug = SECTION_TO_MODULE[String(q.section_name || '').trim()]
        || subjectToModule[subjectName];
      if (!moduleSlug || !bySlug.has(moduleSlug)) continue;
      mapRows.push({ catId: bySlug.get(moduleSlug).id, pool: 'question', refId: q.id });

      // 二级：按真题标准句式匹配（题干 + 材料正文 —— 资料分析的信号词多在材料里）
      const qtypeRules = QTYPE_RULES[moduleSlug] || [];
      let second = null;
      const text = `${q.stem || ''} ${q.passage || ''}`;
      for (const [re, slug] of qtypeRules) {
        if (re.test(text)) { second = slug; break; }
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
