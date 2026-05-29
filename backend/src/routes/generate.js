const express = require('express');
const axios = require('axios');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { withConnection } = require('../db');

const router = express.Router();

const MIMO_API_KEY = process.env.MIMO_API_KEY;
if (!MIMO_API_KEY) console.warn('WARNING: MIMO_API_KEY not set in .env');
const MIMO_BASE_URL = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
const MIMO_MODEL = 'mimo-v2.5-pro';

router.use(requireAuth, requireAdmin);

const SYSTEM_PROMPT = `你是一个专业的公务员考试命题专家，拥有15年国考和省考言语理解与表达命题经验。你的任务是从新闻文章中摘取原文片段，命制与真题风格完全一致的题目。

## 核心原则
1. passage 必须是从文章中逐字摘取的原文，不得修改任何一个字
2. 每道题的 passage 必须来自文章中不同的段落，不能重叠
3. 选项必须看起来都"有道理"，错误选项的错误要微妙，不能一眼看出

## 题型分布（按真题比例）
- 意图判断：30%（问作者意在说明/强调什么）
- 主旨概括：25%（问文段主旨/核心观点）
- 细节理解：20%（根据文段判断正误）
- 标题填入：15%（为文段选标题）
- 下文推断：10%（作者接下来最可能论述什么）

## passage 摘取规范（参照国考/省考真题标准）
- 逐字摘取原文，150-250字，必须是完整的句子群（真题标准区间）
- 优先摘取包含观点、因果、转折、递进、对比关系的段落
- 片段应包含 2-4 个完整的句子，有明确的论述逻辑链
- 不摘取纯数据罗列、时间线叙述、背景铺垫、引言导语段落
- 片段必须能独立构成一道题，不依赖文章其他部分
- 如果文章段落不足150字，可以合并相邻的逻辑连贯段落

## stem 命题规范（以冒号结尾，不超过40字）
意图判断："这段文字意在强调：" / "这段文字意在说明：" / "通过这段文字，作者想表达的是："
主旨概括："这段文字主要介绍的是：" / "对这段文字概括最准确的是：" / "这段文字的核心观点是："
细节理解："根据这段文字，以下说法正确的是：" / "下列说法与原文不符的是："
标题填入："最适合做这段文字标题的是："
下文推断："作者接下来最可能讲述的是："

## 选项设计规范（最关键）
1. 四个选项长度必须相近，每个选项 15-25 字
2. 正确选项是对 passage 的合理概括或推断，必须有原文依据
3. 错误选项必须"看起来也对"，但存在以下细微问题：

**干扰项技巧（每道题至少用3种）：**
- 偷换关键词：把"促进"换成"决定"、"有助于"换成"确保了"
- 扩大/缩小范围：把"部分"换成"全部"、"当前"换成"长期"
- 偷换主体：把"政府"换成"企业"、"技术"换成"制度"
- 过度推断：原文说"可能"，选项说"必然"
- 因果倒置：把原因说成结果
- 张冠李戴：把A的特征说成B的

**错误示范（不要这样出）：**
- 错误选项明显离谱、与 passage 无关
- 四个选项长度差异很大
- 正确选项明显比其他选项更详细

## difficulty 难度标准
- 1-2（简单）：正确选项直接对应原文，干扰项有明显漏洞
- 3（中等）：需要理解文段逻辑，干扰项有一定迷惑性
- 4-5（困难）：干扰项非常接近正确答案，需要仔细辨析

## explanation 解析规范（80-120字）
格式：先点明文段核心 → 说明正确选项为什么对（引用原文） → 逐个排除错误选项（指出具体错误）

示例："文段强调了数字技术对传统产业的赋能作用。A项准确概括了这一含义，原文指出'数字技术正在重塑传统产业的生产方式'。B项将'赋能'偷换为'替代'，改变了原意；C项'全面转型'扩大了范围，原文仅涉及生产环节；D项'传统产业消亡'属于过度推断。"

## 输出格式
严格按JSON格式输出，不要输出其他内容：
{
  "questions": [
    {
      "passage": "从文章逐字摘取的150-250字原文片段（参照国考真题标准）",
      "qtype": "意图判断",
      "difficulty": 3,
      "stem": "这段文字意在强调：",
      "options": ["A选项内容（15-25字）", "B选项内容（15-25字）", "C选项内容（15-25字）", "D选项内容（15-25字）"],
      "answer": "A",
      "explanation": "文段核心是……。A项正确，原文'……'。B项偷换了……；C项扩大了……；D项属于……。"
    }
  ]
}`;

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
    if (maxLen - minLen > 15) {
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

async function generateQuestionsWithAI(articleText, articleTitle, count) {
  const userPrompt = `请根据以下文章生成${count}道言语理解题目。

文章标题：${articleTitle}
文章内容：
${articleText}

严格要求：
1. passage 必须是从文章中逐字摘取的原文（150-250字，参照国考真题标准），不得修改任何一个字
2. 每道题的 passage 必须来自文章中不同的段落，不能重叠
3. 题型尽量不重复，按意图判断>主旨概括>细节理解>标题填入>下文推断的优先级
4. 四个选项长度必须相近（15-25字），错误选项要"看起来也对"但有细微错误
5. 解析要引用原文关键词，逐个说明每个错误选项的具体问题
6. 严格按照JSON格式输出`;

  try {
    const response = await axios.post(MIMO_BASE_URL + '/chat/completions', {
      model: MIMO_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': 'Bearer ' + MIMO_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 300000 // 5 minutes per article
    });

    const content = response.data.choices[0].message.content.trim();
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
    const { articleIds, questionsPerArticle = 2 } = req.body;
    if (!articleIds || !Array.isArray(articleIds) || articleIds.length === 0) {
      return res.status(400).json({ error: '请选择至少一篇文章' });
    }

    const articles = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT id, source, title, clean_text FROM article WHERE id IN (?)', [articleIds]);
      return rows;
    });

    if (articles.length === 0) return res.status(404).json({ error: '未找到选中的文章' });

    const allQuestions = [];
    
    for (const article of articles) {
      try {
        console.log('Generating questions for:', article.title);
        const text = article.clean_text.substring(0, 2000);
        const questions = await generateQuestionsWithAI(text, article.title, questionsPerArticle);
        
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
    const { questions } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: '没有要保存的题目' });
    }

    const inserted = await withConnection(async (conn) => {
      const [subjects] = await conn.query("SELECT id FROM subject WHERE slug = 'verbal_comprehension'");
      const subjectId = subjects[0]?.id || 1;
      let count = 0;
      for (const q of questions) {
        try {
          if (!q.passage || q.passage.length < 50) continue;
          await conn.query(
            'INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation, source_article_id, source_exam, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [subjectId, q.qtype || '意图判断', q.difficulty || 3, q.passage, q.stem, JSON.stringify(q.options), q.answer, q.explanation, q.source_article_id || null, q.source || 'AI生成', 'pending_review']
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
    const response = await axios.post(MIMO_BASE_URL + '/chat/completions', {
      model: MIMO_MODEL,
      messages: [{ role: 'user', content: '你好，请回复"连接成功"' }],
      max_tokens: 50
    }, {
      headers: {
        'Authorization': 'Bearer ' + MIMO_API_KEY,
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