const express = require('express');
const axios = require('axios');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { withConnection } = require('../db');
const { runConcurrent } = require('../helpers');

const router = express.Router();

const API_KEY = process.env.API_KEY;
if (!API_KEY) console.warn('WARNING: API_KEY not set in .env');
const BASE_URL = process.env.BASE_URL;
const MODEL = process.env.MODEL;

router.use(requireAuth, requireAdmin);

// 言语理解与表达 prompt
const VERBAL_SYSTEM_PROMPT = `你是一位资深国考言语理解命题专家。请严格按照以下规范命制题目。

## │ 真题范例（国考行测·言语理解）

passage: "数字技术的介入正在重塑传统手工艺的生产方式和价值评估体系。以往评价一件手工艺品，主要看其工艺复杂度、材料稀缺性和成品的精美程度，这些标准相对直观且易于达成共识。然而，当3D扫描、算法生成、数字雕刻等工具成为创作的一部分时，"原创性"和"手工感"的边界开始变得模糊。消费者对手工艺品的价值判断，也从单纯的物料与技艺崇拜，转向对创作过程独特性和背后人文故事的关注。"
stem: "这段文字意在说明："
options: [
  "数字技术正促使手工艺品的价值标准发生转变",
  "传统手工艺因数字技术介入而面临生存危机",
  "消费者更关注手工艺品的材料与工艺复杂度",
  "数字技术颠覆了手工艺品的创作与交易方式"
]
answer: "A"
explanation: "文段指出数字技术重塑了手工艺品的价值评估体系，从物料崇拜转向过程与故事关注。A项准确概括了这一转变。B项"生存危机"文中未提及，属于无中生有；C项与原文"转向对创作过程独特性的关注"相反；D项"交易方式"范围超出文段讨论的生产方式和评估体系。"

## │ 核心规则

1. **passage** — 逐字摘取原文 150-250字，必须是独立完整的逻辑段落
   · 优先选含因果、转折、递进、对比关系的段落
   · 不得摘取数据罗列、时间线叙述、背景铺垫
2. **stem** — 以冒号结尾，≤40字，问法完全参照国考真题语气
3. **options** — 每项15-25字，长度必须相近（差异≤8字）
4. **干扰项设计（关键）** — 必须让选项看起来"都对"，只有细微差别：
   · 偷换程度：把"有助于"换成"决定了"、"促进"换成"替代"
   · 偷换范围：把"部分领域"换成"所有行业"、"当前"换成"长期"
   · 偷换主体：把"政府主导"换成"市场主导"
   · 过度推断：原文"可能"→选项"必然"，原文"短期"→选项"永久"
   · 正反颠倒：把"积极作用"说成"负面影响"
5. **禁止** — 不能出现明显离谱选项、选项长度悬殊、正确选项比干扰项更详细

## │ 题型与常用 stem

| 题型 | 占比 | 常用 stem |
|------|------|-----------|
| 意图判断 | 30% | "这段文字意在强调：" / "通过这段文字作者想表达的是：" |
| 主旨概括 | 25% | "这段文字主要介绍了：" / "对这段文字概括最准确的是：" |
| 细节理解 | 20% | "下列说法与原文相符的是：" / "根据这段文字，以下哪项是正确的：" |
| 标题填入 | 15% | "最适合做这段文字标题的是：" |
| 下文推断 | 10% | "作者接下来最可能论述的是：" |

## │ difficulty 标准
- 1-2（简单）：干扰项有明显漏洞
- 3（中等）：需理解逻辑，干扰项有迷惑性
- 4-5（困难）：干扰项极接近，需仔细辨析

## │ explanation 格式（80-120字）
"文段核心是……。A项正确，原文指出'……'。B项将……偷换为……；C项……范围扩大/缩小；D项……属于过度推断。"

## │ 输出格式
{"questions":[{"passage":"摘取的150-250字原文","qtype":"意图判断","difficulty":3,"stem":"这段文字意在强调：","options":["A项15-25字","B项15-25字","C项15-25字","D项15-25字"],"answer":"A","explanation":"80-120字解析"}]}`;

// 政治板块 prompt
const POLITICS_SYSTEM_PROMPT = `你是一位资深公考政治命题专家。请严格按照以下规范命制题目。

## │ 真题范例

passage: "党的二十大报告指出，中国式现代化是人口规模巨大的现代化。我国十四亿多人口整体迈进现代化社会，规模超过现有发达国家人口的总和，艰巨性和复杂性前所未有。推进中国式现代化，必须坚持独立自主、自力更生，坚持把国家和民族发展放在自己力量的基点上，坚持把我国发展进步的命运牢牢掌握在自己手中。"
stem: "根据这段文字，下列关于中国式现代化的说法正确的是："
options: [
  "中国式现代化是人口规模巨大的现代化，艰巨性前所未有",
  "中国式现代化必须依托国际市场和国际资源来实现",
  "中国式现代化的目标是使全体人民同步实现现代化",
  "中国式现代化需要大量引进国外先进技术和管理"
]
answer: "A"
explanation: "本题考查二十大报告对中国式现代化的论述。A项正确，文中明确指出'我国十四亿多人口整体迈进现代化社会，规模超过现有发达国家人口的总和，艰巨性和复杂性前所未有'。B项与'独立自主、自力更生'的表述相悖；C项'同步实现'属过度推断，文中未提及同步性；D项与'把发展进步的命运牢牢掌握在自己手中'的表述相反。"

## │ 核心规则
1. **passage** — 从文章摘取 80-150 字原文，须包含完整的理论/政策表述
2. **stem** — 以冒号结尾，≤50字，问法模仿公考政治真题
3. **options** — 每项10-25字，长度相近（差异≤8字）
4. **干扰项** — 错误必须基于官方表述的细微偏差：
   · 把"根本保证"换成"重要条件"、"核心"换成"基础"
   · 把"部分"换成"全部"、"当前"换成"长远"
   · 把A理论的特征说成B理论（张冠李戴）
   · 使用非官方或不规范表述
5. **禁止** — 出现明显错误选项、违反官方口径、长度悬殊

## │ difficulty 标准
- 1-2：直接考查概念
- 3：需理解理论内涵
- 4-5：需综合分析辨别

## │ explanation 格式（60-100字）
"本题考查……。A项正确，文中/报告中指出'……'。B项……；C项……；D项……。"

## │ 输出格式
{"questions":[{"passage":"80-150字原文","qtype":"单选题","difficulty":3,"stem":"根据这段文字，说法正确的是：","options":["A项","B项","C项","D项"],"answer":"A","explanation":"60-100字解析"}]}`;

// 根据 subject 获取对应的 system prompt
function getSystemPrompt(subject) {
  switch (subject) {
    case 'politics':
      return POLITICS_SYSTEM_PROMPT;
    case 'verbal_comprehension':
    default:
      return VERBAL_SYSTEM_PROMPT;
  }
}

// 验证生成的题目质量
function validateQuestion(q, articleText) {
  const errors = [];

  // 1. passage 必须是原文摘取（150-250字）
  if (!q.passage || q.passage.length < 120) {
    errors.push('passage 过短（不足120字）');
  } else if (q.passage.length > 300) {
    errors.push('passage 过长（超过300字）');
  } else if (articleText && !articleText.includes(q.passage.substring(0, 20))) {
    errors.push('passage 可能不是原文摘取');
  }

  // 2. 四个选项长度检查
  if (!q.options || q.options.length !== 4) {
    errors.push('选项数量不是4个');
  } else {
    const lens = q.options.map(o => o.length);
    const maxLen = Math.max(...lens);
    const minLen = Math.min(...lens);
    if (maxLen - minLen > 8) {
      errors.push('选项长度差异过大(' + minLen + '-' + maxLen + ')');
    }
    if (lens.some(l => l < 10 || l > 30)) {
      errors.push('选项长度不在10-30字范围');
    }
  }

  // 3. stem 检查
  if (!q.stem || !q.stem.endsWith('：')) {
    errors.push('stem 不以冒号结尾');
  }

  // 4. answer 检查
  if (!['A', 'B', 'C', 'D'].includes(q.answer)) {
    errors.push('answer 无效');
  }

  return errors;
}

async function generateQuestionsWithAI(articleText, articleTitle, count, subject = 'verbal_comprehension') {
  const systemPrompt = getSystemPrompt(subject);

  let userPrompt;
  if (subject === 'politics') {
    userPrompt = `从以下文章生成${count}道政治题目：

标题：${articleTitle}
内容：${articleText}

按 system prompt 规范输出JSON（questions 数组）。`;
  } else {
    userPrompt = `从以下文章生成${count}道言语理解题目：

标题：${articleTitle}
内容：${articleText}

按 system prompt 规范输出JSON（questions 数组）。每道题的 passage 来源段落不能重叠。`;
  }

  try {
    const response = await axios.post(BASE_URL + '/chat/completions', {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7
    }, {
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 1800000 // 30 minutes per article
    });

    let content = response.data.choices[0].message.content.trim();
    // 移除 markdown 代码块标记
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    // 优先尝试直接解析整个内容为 JSON，失败则用正则提取
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('AI response does not contain valid JSON');
      result = JSON.parse(jsonMatch[0]);
    }
    return result.questions || [];
  } catch (err) {
    console.error('AI generation error:', err.message);
    throw err;
  }
}

// POST /api/generate/preview
router.post('/preview', async (req, res) => {
  try {
    const { articleIds, questionsPerArticle = 2, subject = 'verbal_comprehension' } = req.body;
    if (!articleIds || !Array.isArray(articleIds) || articleIds.length === 0) {
      return res.status(400).json({ error: '请选择至少一篇文章' });
    }

    const articles = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT id, source, title, clean_text FROM article WHERE id IN (?)', [articleIds]);
      return rows;
    });

    if (articles.length === 0) return res.status(404).json({ error: '未找到选中的文章' });

    const allQuestions = [];

    // 逐篇处理，避免超时
    for (const article of articles) {
      try {
        console.log('Generating questions for:', article.title, 'subject:', subject);
        const text = article.clean_text.substring(0, 1500);
        const questions = await generateQuestionsWithAI(text, article.title, questionsPerArticle, subject);

        for (const q of questions) {
          const errors = validateQuestion(q, text);
          if (errors.length > 0) {
            console.log('Skipping invalid question:', errors.join(', '));
            continue;
          }
          allQuestions.push({
            ...q,
            source_article_id: article.id,
            source_article_title: article.title,
            source: article.source
          });
        }
      } catch (err) {
        console.error('Failed for article ' + article.id + ':', err.message);
      }
    }

    return res.json({ questions: allQuestions, total: allQuestions.length, articlesProcessed: articles.length });
  } catch (err) {
    console.error('Preview error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/generate/confirm
router.post('/confirm', async (req, res) => {
  try {
    const { questions, subject = 'verbal_comprehension' } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: '没有要保存的题目' });
    }

    const inserted = await withConnection(async (conn) => {
      const [subjects] = await conn.query("SELECT id FROM subject WHERE slug = ?", [subject]);
      const subjectId = subjects[0]?.id || 1;
      let count = 0;
      for (const q of questions) {
        try {
          if (!q.passage || q.passage.length < 30) continue;
          await conn.query(
            'INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation, source_article_id, source_exam, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [subjectId, q.qtype || '单选题', q.difficulty || 3, q.passage, q.stem, JSON.stringify(q.options), q.answer, q.explanation, q.source_article_id || null, q.source || 'AI生成', 'pending_review']
          );
          count++;
        } catch (err) { console.error('Insert error:', err.message); }
      }
      return count;
    });
    return res.json({ inserted });
  } catch (err) {
    console.error('Confirm error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/generate/test
router.post('/test', async (req, res) => {
  try {
    const response = await axios.post(BASE_URL + '/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: '你好，请回复"连接成功"' }],
      max_tokens: 50
    }, {
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return res.json({ success: true, message: response.data.choices[0].message.content });
  } catch (err) {
    console.error('Test error:', err.message);
    return res.status(500).json({ success: false, error: err.message, details: err.response?.data });
  }
});

module.exports = router;