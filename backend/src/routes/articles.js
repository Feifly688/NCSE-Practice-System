const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getConnection } = require('../db');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const SOURCES = [
  { id: 'people', name: '人民日报·评论', baseUrl: 'http://opinion.people.com.cn', listUrl: 'http://opinion.people.com.cn/GB/8213/49160/index.html' },
  { id: 'xinhua', name: '新华社·时政', baseUrl: 'http://www.news.cn', listUrl: 'http://www.news.cn/politics/' },
  { id: 'people_economy', name: '人民网·经济', baseUrl: 'http://finance.people.com.cn', listUrl: 'http://finance.people.com.cn/GB/index.html' },
  { id: 'xinhua_world', name: '新华社·国际', baseUrl: 'http://www.news.cn', listUrl: 'http://www.news.cn/world/' },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Connection': 'keep-alive',
};

function makeFingerprint(source, title) {
  return crypto.createHash('md5').update(`${source}::${title}`).digest('hex');
}

function parseDate(dateStr) {
  if (!dateStr) return new Date();
  // 尝试匹配带时分秒的格式：2024年5月28日14:30 或 2024-05-28 14:30
  const fullMatch = dateStr.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})日?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (fullMatch) {
    const [_, year, month, day, hour, min, sec] = fullMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min), parseInt(sec || 0));
  }
  // 只有年月日
  const dateMatch = dateStr.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  if (dateMatch) {
    const [_, year, month, day] = dateMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }
  return new Date();
}

// Check if URL is a real article
function isArticleUrl(url, sourceId) {
  if (!url) return false;
  if (/^https?:\/\/[^\/]+\/?$/.test(url)) return false;
  if (/\/index\.html?$/.test(url)) return false;
  if (/\/default\.aspx?$/.test(url)) return false;
  if (/\/GB\/\d+\/index\.html$/.test(url)) return false;
  if (/\/list\.html$/.test(url)) return false;
  if (/\/page\/\d+\.html$/.test(url)) return false;
  
  switch (sourceId) {
    case 'people':
      return /\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html$/.test(url);
    case 'xinhua':
      return /\/politics\/\d{8}\/[a-f0-9]+\/c\.html$/.test(url);
    case 'people_economy':
      return /\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html$/.test(url);
    case 'xinhua_world':
      return /\/world\/\d{8}\/[a-f0-9]+\/c\.html$/.test(url);
    default:
      return false;
  }
}

// Check if title looks like an article
function isArticleTitle(title) {
  if (!title || title.length < 8) return false;
  const exactRejects = [
    '首页', '导航', '更多', '返回', '登录', '注册', '下载',
    '客户端', '微信', '微博', '邮箱', '联系我们',
    '关于我们', '广告服务', '版权声明', '隐私政策',
    '党网·时政', '经济·科技', '社会·法治', '文旅·体育',
    '健康·生活', '国际·军事', '观点·访谈', '理论·学术',
    '时政', '经济', '科技', '社会', '法治', '国际', '军事',
    '体育', '文娱', '健康', '教育', '观点', '访谈', '专题',
    '图片', '视频', '财经', '娱乐', '房产', '汽车', '旅游',
  ];
  if (exactRejects.includes(title)) return false;
  const shortSeparatorMatch = title.match(/^(.{1,3})[·・](.{1,3})$/);
  if (shortSeparatorMatch) return false;
  return true;
}

// Fetch articles from source
async function fetchArticlesFromSource(sourceId, count) {
  const sourceConfig = SOURCES.find(s => s.id === sourceId);
  if (!sourceConfig) return [];

  const articles = [];
  try {
    console.log('Fetching ' + sourceConfig.name + ' from ' + sourceConfig.listUrl);
    const { data } = await axios.get(sourceConfig.listUrl, {
      headers: HEADERS,
      timeout: 15000
    });
    
    const $ = cheerio.load(data);
    
    $('a').each((i, el) => {
      if (articles.length >= count) return false;
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      if (!href) return;
      if (!isArticleTitle(title)) return;
      
      let fullUrl = '';
      if (href.startsWith('http')) {
        fullUrl = href;
      } else if (href.startsWith('/')) {
        fullUrl = sourceConfig.baseUrl + href;
      } else {
        return;
      }
      
      if (!isArticleUrl(fullUrl, sourceId)) return;
      
      if (!articles.some(a => a.url === fullUrl)) {
        articles.push({
          source: sourceConfig.name,
          title,
          url: fullUrl,
          author: sourceConfig.name.split('·')[0]
        });
      }
    });
    
    console.log('Found ' + articles.length + ' articles from ' + sourceConfig.name);
  } catch (err) {
    console.error('Fetch ' + sourceConfig.name + ' error:', err.message);
  }
  return articles;
}

// Fetch article content and publish time
async function fetchArticleContent(url) {
  try {
    const { data } = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000
    });
    
    const $ = cheerio.load(data);
    
    let publishTime = null;
    const timePatterns = [
      /(\d{4}年\d{1,2}月\d{1,2}日\d{1,2}:\d{1,2})/,
      /(\d{4}年\d{1,2}月\d{1,2}日)/,
      /(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2})/,
      /(\d{4}-\d{1,2}-\d{1,2})/
    ];
    
    const bodyText = $('body').text();
    for (const pattern of timePatterns) {
      const match = bodyText.match(pattern);
      if (match) {
        publishTime = parseDate(match[1]);
        break;
      }
    }
    
    const contentSelectors = [
      'div.rm_txt_con', 'div.article_con', 'div#rwb_zw',
      'div.TRS_Editor', 'div.content', 'article',
      'div.article-content', 'div.text_con', 'div#detail',
      'div.main-aticle-detail', 'div.article_box', 'div.text'
    ];
    
    let content = '';
    for (const sel of contentSelectors) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 50) {
        content = el.text().trim();
        break;
      }
    }
    
    if (!content || content.length < 50) {
      content = bodyText.trim();
    }
    
    content = content.replace(/\s+/g, ' ').substring(0, 2000);
    
    return { content, publishTime: publishTime || new Date() };
  } catch (err) {
    console.error('Fetch content error:', err.message);
    return { content: '', publishTime: new Date() };
  }
}

// Generate candidates
async function generateCandidates(conn, sourceId, count) {
  const fetchedArticles = await fetchArticlesFromSource(sourceId, count * 2);
  const candidates = [];
  
  for (const article of fetchedArticles) {
    if (candidates.length >= count) break;
    
    const fp = makeFingerprint(article.source, article.title);
    const [existing] = await conn.query('SELECT id FROM article WHERE fingerprint = ?', [fp]);
    
    if (existing.length === 0) {
      candidates.push({
        source: article.source,
        title: article.title,
        url: article.url,
        text: '点击"确认添加"后将自动抓取文章内容...',
        fingerprint: fp,
        author: article.author
      });
    }
  }

  return candidates;
}

// POST /api/articles/preview
router.post('/preview', async (req, res) => {
  try {
    const { sources, totalCount } = req.body;
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({ error: '请选择至少一个来源' });
    }

    const conn = await getConnection();
    const result = [];
    const usedFingerprints = new Set();
    const countPerSource = Math.ceil((totalCount || 10) / sources.length);

    for (const sourceId of sources) {
      const candidates = await generateCandidates(conn, sourceId, countPerSource);
      for (const c of candidates) {
        if (!usedFingerprints.has(c.fingerprint) && result.length < (totalCount || 10)) {
          result.push({
            source: c.source,
            title: c.title,
            text: c.text,
            fingerprint: c.fingerprint,
            url: c.url,
            author: c.author
          });
          usedFingerprints.add(c.fingerprint);
        }
      }
    }

    await conn.end();
    return res.json({ candidates: result, total: result.length });
  } catch (err) {
    console.error('Preview error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/articles/confirm
router.post('/confirm', async (req, res) => {
  try {
    const { articles } = req.body;
    if (!articles || !Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: '没有要添加的文章' });
    }

    const conn = await getConnection();
    let inserted = 0;

    for (const a of articles) {
      const fp = makeFingerprint(a.source, a.title);
      const [existing] = await conn.query('SELECT id FROM article WHERE fingerprint = ?', [fp]);
      if (existing.length > 0) continue;

      console.log('Fetching content for:', a.title);
      const { content, publishTime } = await fetchArticleContent(a.url);

      await conn.query(
        'INSERT INTO article (source, title, url, publish_time, author, clean_text, fingerprint) VALUES (?,?,?,?,?,?,?)',
        [a.source, a.title, a.url || '', publishTime, a.author || a.source, content, fp]
      );
      inserted++;
    }

    await conn.end();
    return res.json({ inserted });
  } catch (err) {
    console.error('Confirm error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/articles/sources
router.get('/sources', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query('SELECT DISTINCT source, COUNT(*) AS count FROM article GROUP BY source ORDER BY count DESC');
    await conn.end();
    return res.json({ sources: rows, available: SOURCES });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/articles - with question count
router.get('/', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const offset = (page - 1) * pageSize;
    const source = req.query.source || null;
    const filterGenerated = req.query.filterGenerated === 'true';

    const conn = await getConnection();
    
    // Build query with question count
    let baseQuery = `FROM article a 
      LEFT JOIN (SELECT source_article_id, COUNT(*) as question_count FROM question GROUP BY source_article_id) q 
      ON a.id = q.source_article_id`;
    let whereClause = '';
    const params = [];

    if (source) {
      whereClause = ' WHERE a.source = ?';
      params.push(source);
    }
    
    if (filterGenerated) {
      whereClause += whereClause ? ' AND q.question_count > 0' : ' WHERE q.question_count > 0';
    }

    const countQuery = `SELECT COUNT(*) AS total ${baseQuery}${whereClause}`;
    const query = `SELECT a.id, a.source, a.title, a.url, a.publish_time, a.author, a.fingerprint, a.created_at,
      COALESCE(q.question_count, 0) as question_count
      ${baseQuery}${whereClause}
      ORDER BY a.publish_time DESC, a.id DESC LIMIT ? OFFSET ?`;

    const [countRows] = await conn.query(countQuery, params);
    const [rows] = await conn.query(query, [...params, pageSize, offset]);
    await conn.end();
    return res.json({ articles: rows, total: countRows[0].total, page, pageSize });
  } catch (err) {
    console.error('Articles list error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/articles/:id
router.get('/:id', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query('SELECT * FROM article WHERE id = ?', [req.params.id]);
    await conn.end();
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    return res.json({ article: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
