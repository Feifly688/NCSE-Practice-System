require('dotenv').config();
const mysql = require('mysql2/promise');
const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function parseDate(dateStr) {
  if (!dateStr) return null;
  const fullMatch = dateStr.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})日?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (fullMatch) {
    return new Date(parseInt(fullMatch[1]), parseInt(fullMatch[2]) - 1, parseInt(fullMatch[3]), parseInt(fullMatch[4]), parseInt(fullMatch[5]), parseInt(fullMatch[6] || 0));
  }
  const dateMatch = dateStr.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  if (dateMatch) {
    return new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
  }
  return null;
}

async function extractPublishTime(url) {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

    // 1. 新华网 PC 端: div.header-time 包含 span.day(日期) + span.time(时分秒)
    const headerTime = $('div.header-time').first();
    if (headerTime.length) {
      const dayText = headerTime.find('span.day').text().replace(/\s/g, '');
      const timeText = headerTime.find('span.time').text().trim();
      const yearText = headerTime.find('span.year').text().trim();
      if (dayText && timeText) {
        // dayText = "05/27", timeText = "23:15:24", yearText = "2026"
        const dayMatch = dayText.match(/(\d{1,2})\/(\d{1,2})/);
        if (dayMatch) {
          const fullStr = yearText + '-' + dayMatch[1] + '-' + dayMatch[2] + ' ' + timeText;
          const d = parseDate(fullStr);
          if (d) return d;
        }
      }
      // 只有日期没有时间
      if (dayText) {
        const dayMatch = dayText.match(/(\d{1,2})\/(\d{1,2})/);
        if (dayMatch) {
          const fullStr = yearText + '-' + dayMatch[1] + '-' + dayMatch[2];
          const d = parseDate(fullStr);
          if (d) return d;
        }
      }
    }

    // 2. 新华网移动端: div.info 包含 "2026-05-27 23:15:24"
    const infoDiv = $('div.info').first();
    if (infoDiv.length) {
      const infoText = infoDiv.text().trim();
      const d = parseDate(infoText);
      if (d) return d;
    }

    // 3. 人民日报: div.rm_txt_con 前面的时间
    const rmTime = $('div.rm_txt_con').prevAll().text();
    if (rmTime) {
      const d = parseDate(rmTime);
      if (d) return d;
    }

    // 4. meta 标签（只有日期，兜底）
    const metaTime = $('meta[itemprop="datePublished"]').attr('content')
      || $('meta[property="article:published_time"]').attr('content')
      || $('meta[name="publishdate"]').attr('content')
      || $('meta[name="date"]').attr('content');
    if (metaTime) {
      const d = parseDate(metaTime);
      if (d) return d;
    }

    // 5. 通用选择器
    const timeSelectors = [
      'span.time', '.article-info .time', '.pub_date', '.pubdate',
      'time', '.date'
    ];
    for (const sel of timeSelectors) {
      const el = $(sel).first();
      if (el.length) {
        // 取父元素的完整文本（包含日期+时间）
        const parentText = el.parent().text().trim();
        const d = parseDate(parentText);
        if (d) return d;
      }
    }

    // 6. 兜底：从 body 中找
    const bodyText = $('body').text().replace(/\n/g, ' ');
    const bodyMatch = bodyText.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})\D+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (bodyMatch) {
      return new Date(parseInt(bodyMatch[1]), parseInt(bodyMatch[2]) - 1, parseInt(bodyMatch[3]), parseInt(bodyMatch[4]), parseInt(bodyMatch[5]), parseInt(bodyMatch[6] || 0));
    }

    return null;
  } catch (err) {
    console.error('Fetch error:', url, err.message);
    return null;
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'ncse-practice-system',
    charset: 'utf8mb4'
  });

  const [articles] = await conn.query('SELECT id, url, title, publish_time FROM article');
  console.log('Total articles:', articles.length);

  let updated = 0;
  let skipped = 0;

  for (const a of articles) {
    if (!a.url) { skipped++; continue; }
    const newTime = await extractPublishTime(a.url);
    if (newTime) {
      const hasTime = newTime.getHours() !== 0 || newTime.getMinutes() !== 0;
      const oldTime = new Date(a.publish_time);
      const dateChanged = newTime.toDateString() !== oldTime.toDateString();
      if (hasTime || dateChanged) {
        const timeStr = newTime.getFullYear() + '-' + String(newTime.getMonth()+1).padStart(2,'0') + '-' + String(newTime.getDate()).padStart(2,'0') + ' ' + String(newTime.getHours()).padStart(2,'0') + ':' + String(newTime.getMinutes()).padStart(2,'0') + ':' + String(newTime.getSeconds()).padStart(2,'0');
        await conn.query('UPDATE article SET publish_time = ? WHERE id = ?', [timeStr, a.id]);
        console.log('[' + a.id + '] ' + a.title.substring(0, 30) + ' => ' + timeStr);
        updated++;
      } else {
        skipped++;
      }
    } else {
      console.log('[' + a.id + '] SKIP (no time found): ' + a.title.substring(0, 30));
      skipped++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('Done. Updated: ' + updated + ', Skipped: ' + skipped);
  await conn.end();
}

main().catch(err => { console.error(err); process.exit(1); });