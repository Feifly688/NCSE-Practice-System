const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { withConnection } = require('../db');
const { runConcurrent, parseIdList } = require('../helpers');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const SOURCES = [
  // 人民日报系列
  { id: 'people', name: '人民日报·评论', baseUrl: 'http://opinion.people.com.cn', listUrl: 'http://opinion.people.com.cn/GB/8213/49160/index.html' },
  { id: 'people_politics', name: '人民日报·时政', baseUrl: 'http://politics.people.com.cn', listUrl: 'http://politics.people.com.cn/GB/index.html' },
  { id: 'people_economy', name: '人民网·经济', baseUrl: 'http://finance.people.com.cn', listUrl: 'http://finance.people.com.cn/GB/index.html' },
  { id: 'people_society', name: '人民网·社会', baseUrl: 'http://society.people.com.cn', listUrl: 'http://society.people.com.cn/GB/index.html' },
  { id: 'people_legality', name: '人民网·法治', baseUrl: 'http://legal.people.com.cn', listUrl: 'http://legal.people.com.cn/GB/index.html' },

  // 新华社系列
  { id: 'xinhua', name: '新华社·时政', baseUrl: 'http://www.news.cn', listUrl: 'http://www.news.cn/politics/' },
  { id: 'xinhua_world', name: '新华社·国际', baseUrl: 'http://www.news.cn', listUrl: 'http://www.news.cn/world/' },
  { id: 'xinhua_education', name: '新华社·教育', baseUrl: 'http://www.news.cn', listUrl: 'http://www.news.cn/edu/' },
  { id: 'xinhua_military', name: '新华社·军事', baseUrl: 'http://www.news.cn', listUrl: 'http://www.news.cn/mil/' },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function makeFingerprint(source, title) {
  return crypto.createHash('md5').update(`${source}::${title}`).digest('hex');
}

function isArticleUrl(url, sourceId) {
  if (!url) return false;
  if (/^https?:\/\/[^\/]+\/?$/.test(url)) return false;
  if (/\/index\.html?$/.test(url)) return false;
  if (/\/default\.aspx?$/.test(url)) return false;
  if (/\/GB\/\d+\/index\.html$/.test(url)) return false;
  if (/\/list\.html$/.test(url)) return false;
  if (/\/page\/\d+\.html$/.test(url)) return false;

  // 人民网系列（politics, society, legality 等）使用相同的 URL 格式
  const peoplePatterns = ['people', 'people_politics', 'people_economy', 'people_society', 'people_legality'];
  if (peoplePatterns.includes(sourceId)) {
    return /\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html$/.test(url);
  }

  // 新华社系列使用相同的 URL 格式
  const xinhuaPatterns = ['xinhua', 'xinhua_world', 'xinhua_education', 'xinhua_military'];
  if (xinhuaPatterns.includes(sourceId)) {
    return /\/\d{8}\/[a-f0-9]+\/c\.html$/.test(url);
  }

  return false;
}

function isArticleTitle(title) {
  if (!title || title.length < 8) return false;
  const exactRejects = ['首页', '导航', '更多', '返回', '登录', '注册', '下载', '客户端', '微信', '微博', '邮箱', '联系我们', '关于我们', '广告服务', '版权声明', '隐私政策', '时政', '经济', '科技', '社会', '法治', '国际', '军事', '体育', '文娱', '健康', '教育', '观点', '访谈', '专题', '图片', '视频', '财经', '娱乐', '房产', '汽车', '旅游'];
  if (exactRejects.includes(title)) return false;
  if (/^(.{1,3})[·・](.{1,3})$/.test(title)) return false;
  return true;
}

async function fetchArticlesFromSource(sourceId, count) {
  const sourceConfig = SOURCES.find(s => s.id === sourceId);
  if (!sourceConfig) return [];
  const articles = [];
  try {
    const { data } = await axios.get(sourceConfig.listUrl, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    $('a').each((i, el) => {
      if (articles.length >= count) return false;
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      if (!href || !isArticleTitle(title)) return;
      const fullUrl = href.startsWith('http') ? href : href.startsWith('/') ? sourceConfig.baseUrl + href : '';
      if (!fullUrl || !isArticleUrl(fullUrl, sourceId)) return;
      if (!articles.some(a => a.url === fullUrl)) {
        articles.push({ source: sourceConfig.name, title, url: fullUrl, author: sourceConfig.name.split('·')[0] });
      }
    });
  } catch (err) { console.error('Fetch ' + sourceConfig.name + ' error:', err.message); }
  return articles;
}

// 人民网系列共用选择器
const PEOPLE_SELECTORS = ['div.rm_txt_con p', 'div.TRS_Editor p', 'div.text_con p'];
// 新华社系列共用选择器
const XINHUA_SELECTORS = ['div#detail p', 'div.article p', 'div.content p'];

const SOURCE_CONTENT_SELECTORS = {
  // 人民网系列（统一使用人民网选择器）
  people: ['div.rm_txt_con p', 'div#rwb_zw p', ...PEOPLE_SELECTORS],
  // 以下来源共用 PEOPLE_SELECTORS
  ...Object.fromEntries(['people_politics', 'people_economy', 'people_society', 'people_legality'].map(id => [id, PEOPLE_SELECTORS])),
  // 新华社系列（统一使用新华社选择器，xinhua_world 除外）
  xinhua: XINHUA_SELECTORS,
  xinhua_world: ['div#detail p', 'div.article p', 'div.main-aticle-detail p'],
  ...Object.fromEntries(['xinhua_education', 'xinhua_military'].map(id => [id, XINHUA_SELECTORS])),
};
const FALLBACK_CONTENT_SELECTORS = ['div.rm_txt_con p', 'div#detail p', 'div.TRS_Editor p', 'article p', 'div.content p', 'div.article-content p'];

function extractPublishTime($) {
  const patterns = [
    /(\d{4})\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/,
    /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})日?\s*(\d{1,2}):(\d{1,2}):(\d{1,2})/,
    /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})日?\s*(\d{1,2}):(\d{1,2})/,
    /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/,
  ];
  const sources = [$('.header-time').text(), $('b#newstime').text(), $('time').attr('datetime'), $('meta[property="article:published_time"]').attr('content'), $('meta[name="publishdate"]').attr('content'), $('meta[name="date"]').attr('content'), $('.time').text(), $('.date').text(), $('body').text()].filter(Boolean);
  for (const src of sources) {
    for (const p of patterns) {
      const m = src.match(p);
      if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4] || 0), parseInt(m[5] || 0), parseInt(m[6] || 0));
    }
  }
  return null;
}

// 智能提取文章正文
function extractContent($, sourceId) {
  // 1. 先移除明显无关的元素
  $('script, style, nav, header, footer, iframe, noscript, .ad, .comment, .related, .recommend, .editor, .share, .bottom, .copyright').remove();

  // 2. 尝试用来源特定的选择器提取
  const selectors = SOURCE_CONTENT_SELECTORS[sourceId] || FALLBACK_CONTENT_SELECTORS;
  for (const sel of selectors) {
    const paragraphs = $(sel).map((_, p) => $(p).text().trim()).get()
      .filter(t => t.length > 10);
    if (paragraphs.length >= 2) {
      return filterAndCleanContent(paragraphs);
    }
  }

  // 3. 备用方案：提取所有 <p> 标签
  const allP = $('body p').map((_, p) => $(p).text().trim()).get()
    .filter(t => t.length > 10);
  return allP.length >= 2 ? filterAndCleanContent(allP) : '';
}

// 智能过滤和清洗内容
function filterAndCleanContent(paragraphs) {
  // 定义无关内容的特征
  const noisePatterns = [
    /责任编辑/,
    /编辑：/,
    /来源：/,
    /【编辑.*?】/,
    /原标题/,
    /分享到：/,
    /微信分享/,
    /微博分享/,
    /\d{4}年\d{1,2}月\d{1,2}日/,
    /^\d+$/,
    /^[，。、；：！？]+$/,
  ];

  // 定义版权信息的关键词（出现即丢弃该段）
  const copyrightKeywords = [
    '人民日报', '人民网', '版权所有', 'Copyright', '举报',
    '许可证', '备案号', 'ICP', '公网安备', '违法和不良信息',
  ];

  const cleaned = paragraphs.filter(p => {
    // 跳过太短的段落
    if (p.length < 8) return false;
    // 跳过匹配噪音模式的段落
    if (noisePatterns.some(pattern => pattern.test(p))) return false;
    // 跳过包含版权关键词的段落
    if (copyrightKeywords.some(keyword => p.includes(keyword))) return false;
    return true;
  });

  // 合并连续短句（可能是一句话被拆成多个 <p>）
  const merged = [];
  let buffer = '';
  for (const p of cleaned) {
    if (buffer.length + p.length < 50 && !p.endsWith('。') && !p.endsWith('！') && !p.endsWith('？')) {
      buffer += p;
    } else {
      if (buffer) merged.push(buffer);
      buffer = p;
    }
  }
  if (buffer) merged.push(buffer);

  return merged.join('\n');
}

// SSRF 防护：只允许抓取白名单中的域名
const ALLOWED_HOSTS = [
  'opinion.people.com.cn',
  'politics.people.com.cn',
  'finance.people.com.cn',
  'society.people.com.cn',
  'legal.people.com.cn',
  'www.news.cn',
];

function isAllowedUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return ALLOWED_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host));
  } catch {
    return false;
  }
}

async function fetchArticleContent(url, sourceId, retries = 2) {
  if (!isAllowedUrl(url)) {
    return { content: '', publishTime: null };
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);
      const publishTime = extractPublishTime($);
      return { content: extractContent($, sourceId), publishTime: publishTime || null };
    } catch (err) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
      return { content: '', publishTime: null };
    }
  }
}

// 通过文章内容自动分类：verbal-言语理解, politics-政治, both-通用
// 政治类强关键词（出现即高度疑似政治文章）
const POLITICS_STRONG_KEYWORDS = [
  '习近平', '总书记', '党中央', '中国特色社会主义', '从严治党',
  '党的建设', '人大', '政协', '党代会', '政治局', '国务院',
  '马克思主义', '科学发展观', '治国理政', '新时代中国',
  '中央委员会', '中央纪委', '中纪委', '全国人大', '全国政协',
  '政府工作报告', '十四五', '二十大', '人大代表', '政协委员',
];

// 政治类弱关键词（累计较多才判定为政治）
const POLITICS_WEAK_KEYWORDS = [
  '改革', '治理', '脱贫', '小康', '振兴', '民主', '法治',
  '廉政', '纪律', '监督', '巡视', '党组织', '党员', '干部',
  '基层', '信访', '扶贫', '攻坚', '现代化', '创新', '和谐',
  '社会主义核心价值观', '不忘初心', '牢记使命', '四个意识',
  '四个自信', '两个维护', '政治站位', '政治责任',
];

function classifyArticleContent(text) {
  if (!text || text.length < 50) return 'both';

  let strongCount = 0;
  let weakCount = 0;

  for (const kw of POLITICS_STRONG_KEYWORDS) {
    if (text.includes(kw)) strongCount++;
  }
  for (const kw of POLITICS_WEAK_KEYWORDS) {
    if (text.includes(kw)) weakCount++;
  }

  // 政治判定逻辑
  if (strongCount >= 2) return 'politics';
  if (strongCount >= 1 && weakCount >= 3) return 'politics';
  if (weakCount >= 6) return 'politics';

  // 不包含政治关键词的归为言语理解
  if (strongCount === 0 && weakCount === 0) return 'verbal';

  return 'both';
}

function getSourceId(sourceName) {
  const found = SOURCES.find(s => s.name === sourceName);
  return found ? found.id : null;
}

// POST /api/articles/preview
// 返回候选文章 + 各来源抓取统计（fetched=0 表示该源未抓到，前端可提示）
router.post('/preview', asyncHandler(async (req, res) => {
  const { sources, totalCount } = req.body;
  if (!sources || !Array.isArray(sources) || sources.length === 0) return res.status(400).json({ error: '请选择至少一个来源' });
  const countPerSource = Math.ceil((totalCount || 10) / sources.length);
  const result = await withConnection(async (conn) => {
    const used = new Set();
    const out = [];
    const tasks = sources.map(sourceId => async () => {
      // 单个来源失败不能让整批预览挂掉：Promise.all 只要有一个 reject
      // 就全部丢失，用户看到的是整个页面报错而不是「某个源没抓到」
      try {
        const fetched = await fetchArticlesFromSource(sourceId, countPerSource * 2);
        const filtered = [];
        for (const a of fetched) {
          if (out.length >= (totalCount || 10)) break;
          const fp = makeFingerprint(a.source, a.title);
          if (used.has(fp)) continue;
          const [existing] = await conn.query('SELECT id FROM article WHERE fingerprint = ?', [fp]);
          if (existing.length === 0) {
            filtered.push({ ...a, text: '点击"确认添加"后将自动抓取文章内容...', fingerprint: fp });
            used.add(fp);
          }
        }
        return { sourceId, fetchedCount: fetched.length, items: filtered };
      } catch (err) {
        console.error('[articles] 预览来源 ' + sourceId + ' 失败:', err.message);
        return { sourceId, fetchedCount: 0, items: [] };
      }
    });
    const results = await runConcurrent(tasks, 3);
    for (const r of results) {
      out.push(...r.items);
      if (out.length >= (totalCount || 10)) break;
    }
    return {
      candidates: out.slice(0, totalCount || 10),
      sourceStats: results.map(r => ({ sourceId: r.sourceId, fetched: r.fetchedCount })),
    };
  });
  return res.json({
    candidates: result.candidates,
    total: result.candidates.length,
    sourceStats: result.sourceStats,
  });
}));

/** 单次确认添加的文章数上限（每篇都要抓一次网页，超时 15s） */
const MAX_CONFIRM_ARTICLES = 50;

// POST /api/articles/confirm
//
// 三个关键改动：
//   1. 网络抓取与数据库操作分离 —— 原来在 withConnection 里并发抓网页，
//      每篇最长 15s，20 篇就占着连接 5 分钟，连接池很快被耗光。
//      现在先在连接外并发抓取，再一次性批量入库。
//   2. 判重改成一次 IN 查询，替代原来每篇一次 SELECT。
//   3. 单篇抓取失败不再拖垮整批（原来任一 task 抛错会让 Promise.all 整体 reject，
//      前面已经插入的文章也拿不到计数）。
router.post('/confirm', asyncHandler(async (req, res) => {
  const { articles, category = 'both' } = req.body;
  if (!articles || !Array.isArray(articles) || articles.length === 0) return res.status(400).json({ error: '没有要添加的文章' });
  if (articles.length > MAX_CONFIRM_ARTICLES) {
    return res.status(400).json({ error: `一次最多添加 ${MAX_CONFIRM_ARTICLES} 篇文章` });
  }

  // ── 1. 批量判重：一次 IN 查询拿回所有已存在的指纹 ──────────────
  const fingerprints = articles.map((a) => makeFingerprint(a.source, a.title));
  const existingSet = await withConnection(async (conn) => {
    const [rows] = await conn.query(
      'SELECT fingerprint FROM article WHERE fingerprint IN (?)', [fingerprints]
    );
    return new Set(rows.map((r) => r.fingerprint));
  });

  const duplicated = fingerprints.filter((fp) => existingSet.has(fp)).length;
  const todo = articles.filter((a) => !existingSet.has(makeFingerprint(a.source, a.title)));

  // ── 2. 并发抓取正文（不占用数据库连接）────────────────────────
  const fetched = await runConcurrent(
    todo.map((a) => async () => {
      try {
        const { content, publishTime } = await fetchArticleContent(a.url, getSourceId(a.source));
        return { a, content, publishTime };
      } catch (err) {
        console.error('[articles] 抓取失败 ' + a.title + ':', err.message);
        return { a, content: '', publishTime: null };
      }
    }),
    3
  );

  // ── 3. 批量入库（短事务，连接占用从「分钟级」降到「毫秒级」）────
  const result = await withConnection(async (conn) => {
    let inserted = 0, skipped = 0;
    const rows = [];
    const params = [];
    for (const f of fetched) {
      if (!f.content || f.content.length < 200) { skipped++; continue; }
      const autoCategory = classifyArticleContent(f.content);
      // 自动分类不确定（both）时才回退到前端选择的默认分类
      const finalCategory = autoCategory === 'both' ? category : autoCategory;
      rows.push('(?,?,?,?,?,?,?,?)');
      params.push(
        f.a.source, f.a.title, f.a.url || '', f.publishTime || null,
        f.a.author || f.a.source, f.content,
        makeFingerprint(f.a.source, f.a.title), finalCategory
      );
      inserted++;
    }

    if (rows.length > 0) {
      await conn.query(
        `INSERT INTO article (source, title, url, publish_time, author, clean_text, fingerprint, category)
         VALUES ${rows.join(',')}`,
        params
      );
    }
    return { inserted, skipped, duplicated };
  });

  return res.json(result);
}));

// PUT /api/articles/batch/category - 批量修改文章分类
//
// 必须定义在 /:id/category **之前**：Express 按注册顺序匹配，
// 「/batch/category」同样满足「/:id/category」（:id 会取到字符串 'batch'），
// 一旦被前者先命中，Number('batch') 得到 NaN，直接返回「无效的ID」——
// 批量改分类这个功能是彻底走不到的。
router.put('/batch/category', asyncHandler(async (req, res) => {
  const { ids, category } = req.body;
  const parsed = parseIdList(ids, { field: '文章列表' });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!['verbal', 'politics', 'both'].includes(category)) {
    return res.status(400).json({ error: '无效的分类' });
  }
  const affected = await withConnection(async (conn) => {
    const [r] = await conn.query('UPDATE article SET category = ? WHERE id IN (?)', [category, parsed.ids]);
    return r.affectedRows;
  });
  return res.json({ success: true, affected });
}));

// PUT /api/articles/:id/category - 修改单篇文章分类
router.put('/:id/category', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { category } = req.body;
  if (!id || isNaN(id)) return res.status(400).json({ error: '无效的ID' });
  if (!['verbal', 'politics', 'both'].includes(category)) {
    return res.status(400).json({ error: '无效的分类，可选值：verbal, politics, both' });
  }
  const affected = await withConnection(async (conn) => {
    const [r] = await conn.query('UPDATE article SET category = ? WHERE id = ?', [category, id]);
    return r.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '文章不存在' });
  return res.json({ success: true });
}));

// DELETE /api/articles/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: '无效的ID' });
  const affected = await withConnection(async (conn) => {
    const [r] = await conn.query('DELETE FROM article WHERE id = ?', [id]);
    return r.affectedRows;
  });
  if (affected === 0) return res.status(404).json({ error: '文章不存在' });
  return res.json({ success: true });
}));

// GET /api/articles/sources
router.get('/sources', asyncHandler(async (req, res) => {
  const rows = await withConnection(async (conn) => {
    const [r] = await conn.query('SELECT DISTINCT source, COUNT(*) AS count FROM article GROUP BY source ORDER BY count DESC');
    return r;
  });
  return res.json({ sources: rows, available: SOURCES });
}));

// GET /api/articles
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
  const offset = (page - 1) * pageSize;
  const source = req.query.source || null;
  const category = req.query.category || null;
  const filterGenerated = req.query.filterGenerated === 'true';
  const ALLOWED = ['id', 'source', 'title', 'publish_time', 'created_at', 'author', 'category'];
  const sortField = ALLOWED.includes(req.query.sortField) ? req.query.sortField : 'created_at';
  const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const data = await withConnection(async (conn) => {
    let base = `FROM article a LEFT JOIN (SELECT source_article_id, COUNT(*) as question_count FROM question GROUP BY source_article_id) q ON a.id = q.source_article_id`;
    let where = '';
    const params = [];
    if (source) { where = ' WHERE a.source = ?'; params.push(source); }
    if (category) {
      // 筛选分类时，同时匹配指定分类和 'both'（通用）文章
      where += where ? ' AND (a.category = ? OR a.category = ?)' : ' WHERE (a.category = ? OR a.category = ?)';
      params.push(category, 'both');
    }
    if (filterGenerated) { where += where ? ' AND q.question_count > 0' : ' WHERE q.question_count > 0'; }
    const [countRows] = await conn.query(`SELECT COUNT(*) AS total ${base}${where}`, params);
    const [rows] = await conn.query(`SELECT a.id, a.source, a.title, a.url, a.publish_time, a.author, a.fingerprint, a.category, a.created_at, COALESCE(q.question_count, 0) as question_count ${base}${where} ORDER BY a.${sortField} ${sortOrder} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    return { articles: rows, total: countRows[0].total };
  });
  return res.json({ ...data, page, pageSize });
}));

// GET /api/articles/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: '无效的ID' });
  const article = await withConnection(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM article WHERE id = ?', [id]);
    return rows[0] || null;
  });
  if (!article) return res.status(404).json({ error: 'not found' });
  return res.json({ article });
}));

module.exports = router;
