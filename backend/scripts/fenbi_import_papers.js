/**
 * 粉笔「历年试卷」批量导入（服务端运行）。
 *
 * 流程（每张卷）：
 *   1. papers/v2 分页列出全部试卷（按标签）
 *   2. 跳过库里已有的（按 exercise key 或标题判重）
 *   3. 无练习的先创建（POST /api/xingce/exercises）→ 直接返回 exercise key
 *   4. 空卷提交（POST /combine/exercise/submit）—— 提交后 getSolution 才有官方答案
 *   5. 复用 lib/fenbi.js 的 fetchFenbiPaper 拉结构化题目（题干/选项/材料/答案/解析）
 *   6. 图片落盘 + 整卷/整题入库（与 /crawl 接口的粉笔分支同构）
 *
 * 断点续跑：以数据库状态为准，重跑自动跳过已导入的卷。
 * 分类打标不用这里管 —— 导完跑一次 `node src/lib/autoTag.js` 即可（按标题推断）。
 *
 * 用法（服务器）：
 *   FB_SESSION=<sess> FB_UID=<userid> node scripts/fenbi_import_papers.js \
 *     [--labels 1,2039,3588,2972,2906] [--limit N] [--dry-run]
 *
 * 标签：1=国考真题 2039=政法干警 3588=选调 2972=国考模拟题 2906=省考模拟题
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const axios = require('axios');
const fs = require('fs');
const fenbi = require('../src/lib/fenbi');
const { withConnection } = require('../src/db');

const SESS = process.env.FB_SESSION || '';
const UID = process.env.FB_UID || '';
if (!SESS || !UID) {
  console.error('缺少 FB_SESSION / FB_UID 环境变量');
  process.exit(1);
}
const EXAMCAT = Number(process.env.FB_EXAMCAT || 1000183);
const ARGS = process.argv.slice(2);
const argOf = (name, def) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : def;
};
const LABELS = (argOf('--labels', '1,2039,3588,2972,2906')).split(',').map(Number).filter(Boolean);
const LIMIT = Number(argOf('--limit', '0')) || 0; // 0 = 不限
const DRY_RUN = ARGS.includes('--dry-run');

const LABEL_NAMES = { 1: '国考真题', 2039: '政法干警', 3588: '选调', 2972: '国考模拟题', 2906: '省考模拟题' };
const PAPER_FILES_DIR = path.resolve(__dirname, '../uploads/papers');
const PAPER_IMAGE_SUBDIR = 'paper-images';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 粉笔 API 客户端：设备凭据初始化一次，全程复用 ── */
const COMMON = { kav: '125', av: '127', hav: '125', app: 'web', apcid: '0', gav: '2' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_HEADERS = { 'User-Agent': UA, Referer: 'https://www.fenbi.com/', Accept: 'application/json, text/plain, */*' };

let DEVICE_ID = '';
let cookieHeader = '';

async function initDevice() {
  const sid = await axios.post('https://login.fenbi.com/api/users/device/sid/create', {
    pf: 'web',
    startupId: Date.now(),
    extras: {
      canvas: 'hqngxm',
      webgl: 'Google Inc. (Microsoft)~ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      screen: '1920x1080x24', language: 'zh-CN', platform: 'Win32', cores: '8', memory: '8', touchPoints: '0',
    },
  }, {
    params: { ...COMMON, deviceId: '' },
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', Cookie: `sess=${SESS}; userid=${UID}` },
    timeout: 20000, responseType: 'text', transformResponse: [(d) => d], validateStatus: () => true, proxy: false,
  });
  if (sid.status !== 200) throw new Error('设备凭据初始化失败 HTTP ' + sid.status);
  DEVICE_ID = JSON.parse(sid.data).data.deviceId;
  cookieHeader = `sess=${SESS}; userid=${UID}; device_id=${DEVICE_ID}`;
}

/** 带设备重试的 GET/POST；403「频率过高」抛 RATE_LIMITED */
async function fbRequest(method, url, params, data, formType) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await axios({ method, url, params: { ...COMMON, deviceId: DEVICE_ID, ...params }, data,
      headers: { ...BASE_HEADERS, ...(formType ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : { 'Content-Type': 'application/json' }), Cookie: cookieHeader },
      timeout: 30000, responseType: 'text', transformResponse: [(d) => d], validateStatus: () => true, proxy: false });
    if (r.status === 453 && attempt === 0) {
      console.log('   [453] 设备凭据失效，重新初始化…');
      await initDevice();
      await sleep(1500);
      continue;
    }
    if (r.status === 403 && /频率过高|频繁/.test(String(r.data))) {
      const e = new Error('创建练习频率过高');
      e.code = 'RATE_LIMITED';
      throw e;
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}: ${String(r.data).slice(0, 80)}`);
    return JSON.parse(r.data);
  }
}

/** 某标签下全部试卷（分页） */
async function listPapers(labelId) {
  const all = [];
  let toPage = 0;
  while (true) {
    const d = await fbRequest('get', 'https://tiku.fenbi.com/api/xingce/papers/v2',
      { labelId, toPage, pageSize: 50, examcatid: EXAMCAT });
    const list = d.list || [];
    all.push(...list.map((p) => ({
      id: p.id,
      name: p.name,
      date: p.date || '',
      key: p.exercise && p.exercise.key ? p.exercise.key : null,
      difficulty: p.paperMeta ? p.paperMeta.difficulty : null,
    })));
    if (list.length < 50 || toPage > 60) break;
    toPage++;
    await sleep(400);
  }
  return all;
}

/** 库里是否已有该卷（按 exercise key 或标题） */
async function findExisting(conn, key, title) {
  if (key) {
    const [rows] = await conn.query(
      "SELECT id FROM exam_paper WHERE origin='crawl' AND source_url LIKE ? LIMIT 1",
      [`%/ti/exam/%${key}%`]);
    if (rows.length) return rows[0].id;
  }
  const [byTitle] = await conn.query(
    "SELECT id FROM exam_paper WHERE title = ? LIMIT 1", [title]);
  return byTitle.length ? byTitle[0].id : null;
}

/** 导入单张卷；触发限流时按递增等待重试 */
async function importPaper(paper) {
  // ① 建练习（已有练习的卷直接用现有 key）；限流时退避重试
  let key = paper.key;
  if (!key) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const created = await fbRequest('post', 'https://tiku.fenbi.com/api/xingce/exercises',
          {}, `type=1&paperId=${paper.id}&exerciseTimeMode=2`, true);
        key = created.key;
        break;
      } catch (e) {
        if (e.code !== 'RATE_LIMITED') throw e;
        const wait = Math.min(30000 * attempt, 90000);
        console.log(`   [限流] 等待 ${Math.round(wait / 1000)}s 后重试（第 ${attempt} 次）…`);
        await sleep(wait);
      }
    }
    if (!key) throw new Error('创建练习未返回 key（限流重试耗尽）');
    await sleep(2500);
  }

  // ② 空卷提交（提交后 getSolution 才带官方答案；已提交的卷这一步报错无妨）
  try {
    await fbRequest('post', 'https://tiku.fenbi.com/combine/exercise/submit',
      { key, routecs: 'xingce' }, {});
    await sleep(500);
  } catch (e) {
    if (e.code === 'RATE_LIMITED') { await sleep(30000); }
    /* 其他错误（已提交/幂等失败）都忽略 */
  }

  // ③ 拉结构化数据（fetchFenbiPaper 内部先 getSolution 后 getExercise）
  const url = `https://spa.fenbi.com/ti/exam/solution/${key}?routecs=xingce`;
  const crawled = await fenbi.fetchFenbiPaper(url, `sess=${SESS}; userid=${UID}`, UID);
  const rows = crawled.questions || [];
  if (!rows.length) throw new Error('未取到题目');
  const answered = rows.filter((q) => q.answer).length;
  if (DRY_RUN) return { dryRun: true, questions: rows.length, answered };

  // ④ 入库（与 /crawl 的粉笔分支同构）
  const yearMatch = String(paper.name).match(/(\d{4})年/);
  const year = yearMatch ? Number(yearMatch[1]) : (paper.date ? Number(String(paper.date).slice(0, 4)) : null);
  const paperText = crawled.text || '';

  return withConnection(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO exam_paper (title, year, source, source_url, origin, raw_text, parse_status, parsed_count)
       VALUES (?,?, '粉笔题库', ?, 'crawl', ?, 'success', ?)`,
      [paper.name, year, url, paperText, rows.length]);
    const paperId = r.insertId;

    // 图片落盘
    let fileMap = new Map();
    try {
      fileMap = await fenbi.downloadImages(rows, path.join(PAPER_FILES_DIR, PAPER_IMAGE_SUBDIR, String(paperId)));
    } catch (err) {
      console.log(`   [图片] 下载失败: ${err.message}`);
    }

    for (const q of rows) {
      const names = fileMap.get(q.seq) || [];
      const isGroupHead = names.some((n) => /-m(-\d+)?\.png$/.test(n));
      const own = names.filter((n) => !/-m(-\d+)?\.png$/.test(n));
      const material = names.filter((n) => /-m(-\d+)?\.png$/.test(n));
      await conn.query(
        `INSERT INTO exam_paper_question
         (exam_paper_id, seq, section, qtype, difficulty, passage, stem, options_json, answer, explanation, image_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [paperId, q.seq, q.section, q.qtype, q.difficulty, q.passage, q.stem,
          JSON.stringify(q.options), q.answer, q.explanation,
          [...(isGroupHead ? material : []), ...own].join(',') || null]);
    }
    return { paperId, questions: rows.length, answered };
  });
}

(async () => {
  console.log(`== 粉笔历年试卷批量导入 == 标签: ${LABELS.map((l) => LABEL_NAMES[l] || l).join(', ')}${LIMIT ? `（限 ${LIMIT} 张）` : ''}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  await initDevice();
  console.log('设备凭据 OK:', DEVICE_ID);

  // 收集全部待导试卷
  const queue = [];
  for (const labelId of LABELS) {
    const papers = await listPapers(labelId);
    console.log(`${LABEL_NAMES[labelId] || labelId}: ${papers.length} 套`);
    papers.forEach((p) => { p.label = labelId; });
    queue.push(...papers);
    await sleep(600);
  }
  console.log(`共收集 ${queue.length} 套，开始逐张导入…\n`);

  let done = 0, imported = 0, skipped = 0, failed = 0;
  const failures = [];
  for (const paper of queue) {
    if (LIMIT && imported >= LIMIT) break;
    done++;
    const tag = `[${done}/${queue.length}]`;
    try {
      const existing = await withConnection((conn) => findExisting(conn, paper.key, paper.name));
      if (existing) { skipped++; continue; }
      const res = await importPaper(paper);
      if (res.dryRun) {
        console.log(`${tag} [试跑] ${paper.name} → ${res.questions} 题（${res.answered} 答案）`);
      } else {
        console.log(`${tag} ✔ ${paper.name} → paper ${res.paperId}，${res.questions} 题（${res.answered} 答案）`);
      }
      imported++;
    } catch (e) {
      failed++;
      failures.push({ name: paper.name, msg: (e.code ? e.code + ' ' : '') + e.message });
      console.log(`${tag} ✘ ${paper.name} → ${(e.code ? e.code + ' ' : '') + e.message}`);
      // 登录态失效就没必要继续了
      if (e.code === 'FENBI_NEED_LOGIN') { console.log('Cookie 失效，终止。'); break; }
    }
    await sleep(1500);
  }

  console.log(`\n== 完成 == 导入 ${imported}，跳过 ${skipped}，失败 ${failed}`);
  if (failures.length) {
    console.log('失败清单：');
    failures.slice(0, 30).forEach((f) => console.log('  ' + f.name + ' → ' + f.msg));
    fs.writeFileSync(path.resolve(__dirname, 'fenbi_import_failures.json'), JSON.stringify(failures, null, 1));
    console.log('完整失败清单已写入 scripts/fenbi_import_failures.json');
  }
  process.exit(0);
})().catch((e) => { console.error('致命错误:', e.message); process.exit(1); });
