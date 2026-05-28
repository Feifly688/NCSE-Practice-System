const express = require('express');
const axios = require('axios');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getConnection } = require('../db');

const router = express.Router();

const MIMO_API_KEY = process.env.MIMO_API_KEY;
if (!MIMO_API_KEY) console.warn('WARNING: MIMO_API_KEY not set in .env');
const MIMO_BASE_URL = process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
const MIMO_MODEL = 'mimo-v2.5-pro';

router.use(requireAuth, requireAdmin);

const SYSTEM_PROMPT = `你是一个专业的公务员考试命题专家，拥有15年国考和省考言语理解与表达命题经验。

## 命题任务
根据提供的新闻文章，从中摘取有意义的片段，命制符合国考/省考标准的言语理解题目。

## 题型分布（优先按此顺序出题）
1. **意图判断题**（最常考）：问作者写这段文字想表达什么、意在说明/强调什么
2. **主旨概括题**：问这段文字的主旨、核心观点、主要介绍的是什么
3. **细节理解题**：根据文段判断哪个选项正确/不正确
4. **标题填入题**：为这段文字选一个最合适的标题
5. **下文推断题**：作者接下来最可能论述什么

## passage 摘取规范
- 从文章中摘取一个完整的、有独立含义的片段
- 长度控制在50-150字，必须包含完整的句子
- 片段应包含明确的观点、因果关系或论述逻辑
- 不要摘取纯数据罗列、背景介绍或事实堆砌的段落
- 保留原文，不做任何修改
- 片段必须能独立构成一道题，不能依赖文章其他部分才能理解

## stem 命题规范
使用真题标准问法，以下是各题型的常见stem变体：

**意图判断（高频）：**
- 这段文字意在说明：
- 这段文字意在强调：
- 这段文字想要表达的是：
- 这段文字旨在说明：
- 通过这段文字，作者想告诉我们：

**主旨概括：**
- 这段文字主要介绍的是：
- 这段文字的主旨是：
- 这段文字主要谈论的是：
- 对这段文字概括最准确的是：
- 这段文字的核心观点是：

**细节理解：**
- 根据这段文字，以下说法正确的是：
- 下列说法与原文相符的是：
- 下列说法与原文不符的是：
- 根据这段文字，以下理解错误的是：

**标题填入：**
- 最适合做这段文字标题的是：
- 这段文字最适合的标题是：

**下文推断：**
- 作者接下来最可能讲述的是：
- 这段文字是一篇文章的引言，文章接下来最可能讨论的是：

stem 必须简洁，不超过40字，以冒号结尾。

## 选项设计规范
- 4个选项长度相近（15-30字），避免正确选项明显更长或更短
- 正确选项必须有原文依据，不能主观推断
- 选项之间不能有包含关系或明显重复

**干扰项设置技巧（必须使用以下至少2种）：**
1. **偷换概念**：把原文关键词换成近义词但改变含义（如"经济发展"换成"社会进步"）
2. **过度推断**：超出原文范围的引申（如原文说"有利于"，选项说"决定性作用"）
3. **以偏概全**：用局部信息代替整体（如原文说"部分城市"，选项说"全国"）
4. **无中生有**：原文完全没有提及的内容
5. **因果倒置**：把原因和结果互换
6. **时态混淆**：把将来/过去说成现在

## difficulty 难度标准
- 1-2（简单）：答案在原文中直接对应，干扰项容易排除
- 3（中等）：需要理解文段逻辑才能选出答案，干扰项有一定迷惑性
- 4-5（困难）：干扰项迷惑性强，需要仔细辨析才能选出正确答案

## explanation 解析规范
格式要求：
1. 第一句：指出文段的核心意思（15-20字）
2. 第二句：说明正确选项为什么对（引用原文关键词）
3. 第三句起：逐个说明错误选项错在哪里
总字数控制在80-120字。

示例：
"文段强调了技术创新对产业升级的关键作用。A项准确概括了这一含义，原文指出'技术创新是产业升级的核心动力'。B项将'产业升级'偷换为'经济增长'；C项'决定性作用'属于过度推断；D项'传统产业'在原文中未提及。"

## 输出格式
严格按JSON格式输出，不要输出其他内容：
{
  "questions": [
    {
      "passage": "从文章摘取的50-150字片段原文",
      "qtype": "意图判断",
      "difficulty": 3,
      "stem": "这段文字意在说明：",
      "options": ["A选项内容", "B选项内容", "C选项内容", "D选项内容"],
      "answer": "A",
      "explanation": "文段强调了……。A项准确概括了这一含义。B项偷换了概念；C项过度推断；D项无中生有。"
    }
  ]
}`;

async function generateQuestionsWithAI(articleText, articleTitle, count) {
  const userPrompt = '请根据以下文章生成' + count + '道言语理解题目。\n\n文章标题：' + articleTitle + '\n文章内容：\n' + articleText + '\n\n要求：\n1. 每道题的 passage 必须是从文章中摘取的不同片段，50-150字\n2. 题型尽量不重复\n3. 严格按照JSON格式输出';

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
      timeout: 180000
    });

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI response does not contain valid JSON');
    
    const result = JSON.parse(jsonMatch[0]);
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

    const conn = await getConnection();
    const [articles] = await conn.query(
      'SELECT id, source, title, clean_text FROM article WHERE id IN (?)',
      [articleIds]
    );
    await conn.end();

    if (articles.length === 0) return res.status(404).json({ error: '未找到选中的文章' });

    const allQuestions = [];
    
    for (const article of articles) {
      try {
        console.log('Generating questions for:', article.title);
        const text = article.clean_text.substring(0, 2000);
        const questions = await generateQuestionsWithAI(text, article.title, questionsPerArticle);
        
        for (const q of questions) {
          if (!q.passage || q.passage.length < 50) {
            console.log('Skipping question without valid passage');
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

    const conn = await getConnection();
    const [subjects] = await conn.query("SELECT id FROM subject WHERE slug = 'verbal_comprehension'");
    const subjectId = subjects[0]?.id || 1;
    
    let inserted = 0;
    
    for (const q of questions) {
      try {
        if (!q.passage || q.passage.length < 50) continue;
        
        await conn.query(
          'INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation, source_article_id, source_exam, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [
            subjectId,
            q.qtype || '意图判断',
            q.difficulty || 3,
            q.passage,
            q.stem,
            JSON.stringify(q.options),
            q.answer,
            q.explanation,
            q.source_article_id || null,
            q.source || 'AI生成',
            'pending_review'
          ]
        );
        inserted++;
      } catch (err) {
        console.error('Insert error:', err.message);
      }
    }

    await conn.end();
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