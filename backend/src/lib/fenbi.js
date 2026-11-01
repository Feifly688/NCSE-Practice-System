/**
 * 粉笔题库（spa.fenbi.com）真题抓取。
 *
 * 【为什么不能直接抓 HTML】
 * 粉笔题库是 SPA：页面 HTML 只有 <app-root> 空壳（实测 3.4KB），正文由 JS 渲染。
 * 题目数据来自它自己的接口，必须按它的流程走：
 *
 *   ① POST login.fenbi.com/api/users/device/sid/create
 *      → 服务端下发 device_id（Set-Cookie），后续请求必须带回去
 *   ② GET  tiku.fenbi.com/combine/exercise/getExercise?key=<key>&...
 *      → 返回套卷元信息 + staticUrl（带签名的静态地址）
 *   ③ GET  tiku.fenbi.com/combine/static/exercise?key=<request_key>&<公共参数>
 *      → 真正的题目数据（结构化 JSON：materials / questions / card）
 *   ④ GET  tiku.fenbi.com/combine/static/solution?key=<request_key>&<公共参数>
 *      → 答案与解析（**需要用户已在粉笔提交该练习**，否则返回
 *         "exercise is not submit"）
 *
 * 【踩过的坑，务必保留】
 *  1. cookie 名是 `sess` + `userid`（不是 sessionid），两者必须成对出现，缺一即 401
 *  2. device_id 必须在 **cookie 里**（Set-Cookie: domain=.fenbi.com），
 *     只放在 query 参数里会被判 453「无效 DeviceSid」
 *  3. 静态地址的 query 只有 key，后面那串公共参数是前端自己拼的，缺了就 404
 *  4. cookie 必须**按域隔离**：acw_tc 在 login / tiku 两个域的值不同，
 *     混用会被判为异常设备
 *  5. 静态接口返回的是 JSON（Content-Type 也写 json），但 format=html 的
 *     getExercise 返回的是「装着 staticUrl 的 JSON」——别当成 HTML 解析
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COMMON = { kav: '125', av: '127', hav: '125', app: 'web', apcid: '0', gav: '2' };

// 设备指纹：sid/create 要求带浏览器环境信息，服务端用一组固定值模拟
const DEVICE_BODY = {
  pf: 'web',
  startupId: Date.now(),
  extras: {
    canvas: 'hqngxm',
    webgl: 'Google Inc. (Microsoft)~ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    screen: '1920x1080x24',
    language: 'zh-CN',
    platform: 'Win32',
    cores: '8',
    memory: '8',
    touchPoints: '0',
  },
};

/**
 * 按域隔离的迷你 cookie jar。
 * acw_tc（WAF）在 login / tiku 两个域的值不同，混用会被判为异常设备。
 */
class CookieJar {
  constructor() {
    this.map = new Map(); // domain -> Map(name -> value)
  }

  absorb(res, host) {
    for (const c of [].concat(res.headers['set-cookie'] || [])) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (!m) continue;
      const dm = c.match(/Domain=([^;]+)/i);
      const domain = (dm ? dm[1] : host).replace(/^\./, '').toLowerCase();
      if (!this.map.has(domain)) this.map.set(domain, new Map());
      this.map.get(domain).set(m[1].trim(), m[2]);
    }
  }

  set(domain, name, value) {
    const d = domain.toLowerCase();
    if (!this.map.has(d)) this.map.set(d, new Map());
    this.map.get(d).set(name, value);
  }

  header(host) {
    const parts = [];
    for (const [dom, m] of this.map) {
      if (host === dom || host.endsWith('.' + dom)) {
        for (const [k, v] of m) parts.push(`${k}=${v}`);
      }
    }
    return parts.join('; ');
  }
}

/**
 * 从用户粘贴的 cookie 串里解析出需要的字段。
 * 支持两种输入：
 *   ① 完整 cookie 串：sess=xxx; userid=yyy; persistent=zzz; …
 *   ② 只给 sess 的值（长 base64 串）——此时需要另外给出 userid
 *
 * @param {string} raw
 * @param {string} [extraUserid] 单独提供的 userid
 */
function parseCookies(raw, extraUserid) {
  const text = String(raw || '').trim();
  const out = { sess: '', userid: extraUserid ? String(extraUserid).trim() : '', persistent: '', extra: {} };

  if (!text) return out;

  // 形态一：完整 cookie 串（含 =）
  if (text.includes('=')) {
    for (const part of text.split(/;\s*/)) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim().toLowerCase();
      const v = part.slice(idx + 1).trim();
      if (k === 'sess' || k === 'sessionid' || k === 'session') out.sess = v;
      else if (k === 'userid' || k === 'uid') out.userid = v;
      else if (k === 'persistent') out.persistent = v;
      else out.extra[k] = v;
    }
    return out;
  }

  // 形态二：只有一长串 token —— 认定为 sess
  out.sess = text;
  return out;
}

/** 解析粉笔套题页 URL → { key, routecs } */
function parseExerciseUrl(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/ti\/exam\/exercise\/([^/]+)/);
  if (!m) return null;
  return {
    key: decodeURIComponent(m[1]),
    routecs: u.searchParams.get('routecs') || 'xingce',
  };
}

function absUrl(src) {
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `https://fb.fbstatic.cn${src}`;
  return src;
}

/**
 * 粉笔题目内容是 HTML 片段，转成纯文本。
 * 图片保留为 [图:URL] 标记，后续由图片下载流程替换成站内路径。
 */
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // 图片不插进正文，统一由【材料图】/【题图】单独列出，避免同一张图出现两次
  s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&middot;/gi, '·');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 提取 HTML 里的图片地址（协议相对地址补全） */
function extractImgs(html) {
  const out = [];
  String(html || '').replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (m, src) => {
    out.push(absUrl(src));
    return '';
  });
  return out;
}

/**
 * 把粉笔的结构化数据转成整卷纯文本（供现有 AI 拆题流水线使用）。
 *
 * 输出顺序 = 答题卡树顺序 = 分区顺序 + 区内题序，题号连续编号；
 * 一拖五/资料分析的公共材料以【材料】标记放在该组第一题之前，只出现一次。
 */
function toPaperText(data, solutions) {
  const lines = [];
  const byGid = new Map();
  (data.questions || []).forEach((q) => byGid.set(q.globalId, q));
  const matByGid = new Map();
  (data.materials || []).forEach((m) => matByGid.set(m.globalId, m));

  let seq = 0;
  const emittedMats = new Set();

  const visit = (node) => {
    const kids = node.children || [];
    // 分区节点：nodeType=1，name 是分区名
    if (node.nodeType === 1 && node.name) {
      lines.push('');
      lines.push(`【${node.name}】`);
    }
    for (const child of kids) {
      // 题目节点：nodeType=2，key 是题目的 globalId
      if (child.nodeType === 2 && child.key) {
        const q = byGid.get(child.key);
        if (!q) continue;
        seq += 1;

        // 公共材料（一拖五 / 资料分析）：只在首次出现时输出
        for (const mk of child.materialKeys || []) {
          if (emittedMats.has(mk)) continue;
          emittedMats.add(mk);
          const mat = matByGid.get(mk);
          if (!mat) continue;
          const mt = htmlToText(mat.content);
          if (mt) lines.push(`【材料】${mt}`);
          const matImgs = extractImgs(mat.content);
          if (matImgs.length) lines.push(`【材料图】${matImgs.join(' ')}`);
        }

        lines.push(`${seq}. ${htmlToText(q.content)}`);
        const qImgs = extractImgs(q.content);
        if (qImgs.length) lines.push(`【题图】${qImgs.join(' ')}`);

        const acc = (q.accessories || []).find((a) => Array.isArray(a.options) && a.options.length);
        if (acc) {
          acc.options.forEach((o, i) => {
            lines.push(`${String.fromCharCode(65 + i)}. ${htmlToText(o)}`);
          });
        }

        const sol = solutions && solutions.get(q.globalId);
        if (sol && sol.choice) {
          lines.push(`【答案】${sol.choice}`);
          if (sol.solution) lines.push(`【解析】${htmlToText(sol.solution)}`);
        }
        continue;
      }
      visit(child);
    }
  };
  visit(data.card);
  return lines.join('\n');
}

/** 抓取粉笔套卷（题干/选项/材料/分区/题序 + 可选的官方答案） */
async function fetchFenbiPaper(url, cookieRaw, extraUserid) {
  const target = parseExerciseUrl(url);
  if (!target) {
    const e = new Error('不是粉笔套题页链接');
    e.code = 'FENBI_BAD_URL';
    throw e;
  }

  const cred = parseCookies(cookieRaw, extraUserid);
  if (!cred.sess) {
    const e = new Error('缺少粉笔登录 Cookie');
    e.code = 'FENBI_NEED_LOGIN';
    e.detail = '请粘贴浏览器里的完整 Cookie（形如 sess=xxx; userid=yyy; …），其中必须包含 sess 与 userid。';
    throw e;
  }
  if (!cred.userid) {
    const e = new Error('缺少 userid');
    e.code = 'FENBI_NEED_LOGIN';
    e.detail = '粉笔的 sess 必须与 userid 配对使用，请在浏览器里复制整行 Cookie（而不是只复制 sess）。';
    throw e;
  }

  const jar = new CookieJar();
  const base = { 'User-Agent': UA, Referer: 'https://spa.fenbi.com/', Accept: 'application/json, text/plain, */*' };

  // ① 设备凭据
  const sid = await axios.post('https://login.fenbi.com/api/users/device/sid/create', DEVICE_BODY, {
    params: { ...COMMON, deviceId: '' },
    headers: { ...base, 'Content-Type': 'application/json', Cookie: `sess=${cred.sess}; userid=${cred.userid}` },
    timeout: 20000,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
    proxy: false,
  });
  jar.absorb(sid, 'login.fenbi.com');
  const deviceId = (() => {
    try {
      const j = JSON.parse(sid.data);
      return (j && j.data && j.data.deviceId) || '';
    } catch (e) { return ''; }
  })() || (jar.map.get('fenbi.com') || new Map()).get('device_id') || '';
  if (!deviceId) {
    const e = new Error('粉笔设备凭据初始化失败');
    e.code = 'FENBI_DEVICE_FAILED';
    throw e;
  }
  jar.set('fenbi.com', 'sess', cred.sess);
  jar.set('fenbi.com', 'userid', cred.userid);
  jar.set('fenbi.com', 'device_id', deviceId);
  if (cred.persistent) jar.set('fenbi.com', 'persistent', cred.persistent);
  Object.entries(cred.extra).forEach(([k, v]) => jar.set('fenbi.com', k, v));

  // ② 套卷元信息
  const exRes = await axios.get('https://tiku.fenbi.com/combine/exercise/getExercise', {
    params: { format: 'html', key: target.key, routecs: target.routecs, ...COMMON, deviceId },
    headers: { ...base, Cookie: jar.header('tiku.fenbi.com') },
    timeout: 30000,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
    proxy: false,
  });
  jar.absorb(exRes, 'tiku.fenbi.com');
  if (exRes.status !== 200) {
    const e = new Error('粉笔拒绝了本次请求');
    e.code = 'FENBI_NEED_LOGIN';
    e.detail = exRes.status === 401 ? 'Cookie 无效或已过期，请重新登录粉笔后再复制 Cookie。'
      : exRes.status === 453 ? '设备凭据校验失败，请重试。'
      : `HTTP ${exRes.status}`;
    throw e;
  }
  let exInfo;
  try { exInfo = JSON.parse(exRes.data); } catch (e) {
    const err = new Error('粉笔返回格式异常');
    err.code = 'FENBI_BAD_RESPONSE';
    throw err;
  }
  const meta = exInfo.data || {};
  const staticUrl = meta.staticUrl && meta.staticUrl.urls && meta.staticUrl.urls[0];
  if (!staticUrl) {
    const e = new Error('粉笔未返回题目内容地址');
    e.code = 'FENBI_NO_CONTENT';
    e.detail = '该练习可能不可用（已下线或无题目）。';
    throw e;
  }

  // ③ 题目数据（staticUrl 只带 key，公共参数要自己拼）
  const buildStaticUrl = (baseUrl, type) => {
    const u = new URL(baseUrl);
    u.searchParams.set('routecs', target.routecs);
    u.searchParams.set('type', String(type));
    u.searchParams.set('kav', COMMON.kav);
    u.searchParams.set('av', COMMON.av);
    u.searchParams.set('hav', COMMON.hav);
    u.searchParams.set('app', COMMON.app);
    u.searchParams.set('apcid', COMMON.apcid);
    u.searchParams.set('deviceId', deviceId);
    u.searchParams.set('gav', COMMON.gav);
    return u.toString();
  };

  const stRes = await axios.get(buildStaticUrl(staticUrl, 1), {
    headers: { ...base, Cookie: jar.header('tiku.fenbi.com') },
    timeout: 30000,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
    proxy: false,
  });
  if (stRes.status !== 200) {
    const e = new Error('粉笔题目内容获取失败');
    e.code = 'FENBI_HTTP_ERROR';
    e.detail = `HTTP ${stRes.status}`;
    throw e;
  }
  let data;
  try { data = JSON.parse(stRes.data); } catch (e) {
    const err = new Error('粉笔题目内容解析失败');
    err.code = 'FENBI_BAD_RESPONSE';
    throw err;
  }

  // ④ 答案与解析（需要用户已在粉笔提交该练习）
  const solutions = new Map();
  let answerNote = '';
  const requestKey = new URL(staticUrl).searchParams.get('key');
  try {
    const solRes = await axios.get(buildStaticUrl(
      staticUrl.replace(/\/exercise(\?|$)/, '/solution$1'), 1), {
      headers: { ...base, Cookie: jar.header('tiku.fenbi.com') },
      timeout: 30000,
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: () => true,
      proxy: false,
    });
    if (solRes.status === 200) {
      const sj = JSON.parse(solRes.data);
      for (const s of sj.solutions || []) {
        const ca = s.correctAnswer || {};
        solutions.set(s.globalId, { choice: ca.choice || '', type: ca.type, solution: s.solution || '' });
      }
      if (solutions.size) answerNote = `已获取 ${solutions.size} 道题的官方答案与解析`;
    } else {
      answerNote = '粉笔未开放该练习的答案（需先在粉笔完成并提交）';
    }
  } catch (e) {
    const body = String((e.response && e.response.data) || '');
    if (/not submit/i.test(body)) {
      answerNote = '粉笔要求先在粉笔完成并提交这份练习，才会开放答案与解析；本次仅导入题目内容';
    } else {
      answerNote = '答案获取失败，本次仅导入题目内容';
    }
  }

  const text = toPaperText(data, solutions);
  const questions = toQuestions(data, solutions);
  return {
    title: meta.name || data.name || '粉笔真题',
    text,
    textLength: text.length,
    questions,
    questionCount: questions.length,
    materialCount: (data.materials || []).length,
    answerCount: solutions.size,
    answerNote,
    source: '粉笔题库',
  };
}

/**
 * 把粉笔数据转成系统整卷题目行（结构化直入库，不经过 AI 拆题）。
 *
 * 为什么不走 AI：粉笔返回的就是结构化数据（题干/选项/材料/分区/答案），
 * 再让模型重新拆一遍只会引入错位与缺字段 —— 那是整卷导入最常见的坑。
 *
 * @returns {Array} 题目行数组，字段与 exam_paper_question 表对齐
 */
function toQuestions(data, solutions) {
  const byGid = new Map();
  (data.questions || []).forEach((q) => byGid.set(q.globalId, q));
  const matByGid = new Map();
  (data.materials || []).forEach((m) => matByGid.set(m.globalId, m));

  const out = [];
  let seq = 0;
  const emittedMats = new Set();
  let section = '未分区';

  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.nodeType === 1 && child.name) {
        section = child.name;
        visit(child);
        continue;
      }
      if (child.nodeType === 2 && child.key) {
        const q = byGid.get(child.key);
        if (!q) continue;
        seq += 1;

        // 公共材料：组内每题都带同一份正文（前端据此把同组题归到一起）
        let passage = '';
        let materialImages = [];
        for (const mk of child.materialKeys || []) {
          const mat = matByGid.get(mk);
          if (!mat) continue;
          passage = passage || htmlToText(mat.content);
          if (!emittedMats.has(mk)) {
            emittedMats.add(mk);
            materialImages = extractImgs(mat.content);
          }
        }

        const options = [];
        const acc = (q.accessories || []).find((a) => Array.isArray(a.options) && a.options.length);
        if (acc) {
          acc.options.forEach((o) => {
            const t = htmlToText(o);
            if (t) options.push(t);
          });
        }

        const sol = solutions && solutions.get(q.globalId);
        out.push({
          seq,
          globalId: q.globalId,
          section,
          qtype: '单选题',
          difficulty: 3,
          stem: htmlToText(q.content),
          options,
          answer: sol ? sol.choice || null : null,
          explanation: sol ? htmlToText(sol.solution) : null,
          passage: passage || null,
          materialImages,
          ownImages: extractImgs(q.content),
        });
        continue;
      }
      visit(child);
    }
  };
  visit(data.card);
  return out;
}

/**
 * 下载粉笔的外链图片到本地整卷目录。
 *
 * 命名规则与前端约定一致：
 *   · 材料图 → q<组首题号>-m.png / -m-2.png（含 -m，前端按它分组）
 *   · 题图   → q<题号>-<序号>.png（不含 -m，避免被误判成材料图）
 *
 * @param {Array} questions toQuestions 的结果
 * @param {string} dir 目标目录（uploads/papers/paper-images/<paperId>）
 * @returns {Promise<Map>} 题号 → 该题的图片文件名（逗号分隔）列表
 */
async function downloadImages(questions, dir) {
  const fs = require('fs');
  const path = require('path');
  const fileMap = new Map();

  const jobs = [];
  for (const q of questions) {
    const names = [];
    if (q.materialImages && q.materialImages.length) {
      q.materialImages.forEach((url, i) => {
        names.push(`q${q.seq}-m${i ? `-${i + 1}` : ''}.png`);
        jobs.push({ url, name: names[names.length - 1] });
      });
    }
    if (q.ownImages && q.ownImages.length) {
      q.ownImages.forEach((url, i) => {
        names.push(`q${q.seq}-${i + 1}.png`);
        jobs.push({ url, name: names[names.length - 1] });
      });
    }
    if (names.length) fileMap.set(q.seq, names);
  }
  if (!jobs.length) return fileMap;

  await fs.promises.mkdir(dir, { recursive: true });
  await Promise.all(jobs.map(async (j) => {
    try {
      const r = await axios.get(j.url, {
        headers: { 'User-Agent': UA, Referer: 'https://spa.fenbi.com/' },
        timeout: 20000,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        proxy: false,
      });
      if (r.status === 200 && r.data && r.data.length) {
        await fs.promises.writeFile(path.join(dir, j.name), Buffer.from(r.data));
      }
    } catch (e) {
      console.warn('[fenbi] 图片下载失败:', j.url.slice(0, 80), e.message);
    }
  }));
  return fileMap;
}

module.exports = { fetchFenbiPaper, parseCookies, parseExerciseUrl, htmlToText, toPaperText, toQuestions, downloadImages, CookieJar };
