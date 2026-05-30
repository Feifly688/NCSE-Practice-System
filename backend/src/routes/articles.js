const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { withConnection } = require('../db');

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

const SOURCE_CONTENT_SELECTORS = {
  // 人民网系列
  people: ['div.rm_txt_con p', 'div#rwb_zw p', 'div.TRS_Editor p'],
  people_politics: ['div.rm_txt_con p', 'div.TRS_Editor p', 'div.text_con p'],
  people_economy: ['div.rm_txt_con p', 'div.TRS_Editor p', 'div.text_con p'],
  people_society: ['div.rm_txt_con p', 'div.TRS_Editor p', 'div.text_con p'],
  people_legality: ['div.rm_txt_con p', 'div.TRS_Editor p', 'div.text_con p'],
  // 新华社系列
  xinhua: ['div#detail p', 'div.article p', 'div.content p'],
  xinhua_world: ['div#detail p', 'div.article p', 'div.main-aticle-detail p'],
  xinhua_education: ['div#detail p', 'div.article p', 'div.content p'],
  xinhua_military: ['div#detail p', 'div.article p', 'div.content p'],
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

async function runConcurrent(tasks, maxConcurrent = 3) {
  const results = [];
  let index = 0;
  async function worker() { while (index < tasks.length) { const i = index++; results[i] = await tasks[i](); } }
  await Promise.all(Array(Math.min(maxConcurrent, tasks.length)).fill(null).map(() => worker()));
  return results;
}

function getSourceId(sourceName) {
  const found = SOURCES.find(s => s.name === sourceName);
  return found ? found.id : null;
}

// POST /api/articles/preview
router.post('/preview', async (req, res) => {
  try {
    const { sources, totalCount } = req.body;
    if (!sources || !Array.isArray(sources) || sources.length === 0) return res.status(400).json({ error: '请选择至少一个来源' });
    const countPerSource = Math.ceil((totalCount || 10) / sources.length);
    const result = await withConnection(async (conn) => {
      const used = new Set();
      const out = [];
      for (const sourceId of sources) {
        const fetched = await fetchArticlesFromSource(sourceId, countPerSource * 2);
        for (const a of fetched) {
          if (out.length >= (totalCount || 10)) break;
          const fp = makeFingerprint(a.source, a.title);
          if (used.has(fp)) continue;
          const [existing] = await conn.query('SELECT id FROM article WHERE fingerprint = ?', [fp]);
          if (existing.length === 0) { out.push({ ...a, text: '点击"确认添加"后将自动抓取文章内容...', fingerprint: fp }); used.add(fp); }
        }
      }
      return out;
    });
    return res.json({ candidates: result, total: result.length });
  } catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
});

// POST /api/articles/confirm
router.post('/confirm', async (req, res) => {
  try {
    const { articles } = req.body;
    if (!articles || !Array.isArray(articles) || articles.length === 0) return res.status(400).json({ error: '没有要添加的文章' });
    const result = await withConnection(async (conn) => {
      let inserted = 0, skipped = 0;
      const tasks = articles.map(a => async () => {
        const fp = makeFingerprint(a.source, a.title);
        const [existing] = await conn.query('SELECT id FROM article WHERE fingerprint = ?', [fp]);
        if (existing.length > 0) return 'duplicate';
        const { content, publishTime } = await fetchArticleContent(a.url, getSourceId(a.source));
        if (!content || content.length < 200) return 'empty';
        const safePublishTime = publishTime || null;
        await conn.query('INSERT INTO article (source, title, url, publish_time, author, clean_text, fingerprint) VALUES (?,?,?,?,?,?,?)', [a.source, a.title, a.url || '', safePublishTime, a.author || a.source, content, fp]);
        return 'inserted';
      });
      const statuses = await runConcurrent(tasks, 3);
      for (const s of statuses) { if (s === 'inserted') inserted++; else if (s === 'empty') skipped++; }
      return { inserted, skipped };
    });
    return res.json(result);
  } catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
});

// DELETE /api/articles/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: '无效的ID' });
    const affected = await withConnection(async (conn) => {
      const [r] = await conn.query('DELETE FROM article WHERE id = ?', [id]);
      return r.affectedRows;
    });
    if (affected === 0) return res.status(404).json({ error: '文章不存在' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
});

// GET /api/articles/sources
router.get('/sources', async (req, res) => {
  try {
    const rows = await withConnection(async (conn) => {
      const [r] = await conn.query('SELECT DISTINCT source, COUNT(*) AS count FROM article GROUP BY source ORDER BY count DESC');
      return r;
    });
    return res.json({ sources: rows, available: SOURCES });
  } catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
});

// GET /api/articles
router.get('/', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const offset = (page - 1) * pageSize;
    const source = req.query.source || null;
    const filterGenerated = req.query.filterGenerated === 'true';
    const ALLOWED = ['id', 'source', 'title', 'publish_time', 'created_at', 'author'];
    const sortField = ALLOWED.includes(req.query.sortField) ? req.query.sortField : 'created_at';
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const data = await withConnection(async (conn) => {
      let base = `FROM article a LEFT JOIN (SELECT source_article_id, COUNT(*) as question_count FROM question GROUP BY source_article_id) q ON a.id = q.source_article_id`;
      let where = '';
      const params = [];
      if (source) { where = ' WHERE a.source = ?'; params.push(source); }
      if (filterGenerated) { where += where ? ' AND q.question_count > 0' : ' WHERE q.question_count > 0'; }
      const [countRows] = await conn.query(`SELECT COUNT(*) AS total ${base}${where}`, params);
      const [rows] = await conn.query(`SELECT a.id, a.source, a.title, a.url, a.publish_time, a.author, a.fingerprint, a.created_at, COALESCE(q.question_count, 0) as question_count ${base}${where} ORDER BY a.${sortField} ${sortOrder} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
      return { articles: rows, total: countRows[0].total };
    });
    return res.json({ ...data, page, pageSize });
  } catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
});

// GET /api/articles/:id
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: '无效的ID' });
    const article = await withConnection(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM article WHERE id = ?', [id]);
      return rows[0] || null;
    });
    if (!article) return res.status(404).json({ error: 'not found' });
    return res.json({ article });
  } catch (err) { return res.status(500).json({ error: String(err.message || err) }); }
});

module.exports = router;
