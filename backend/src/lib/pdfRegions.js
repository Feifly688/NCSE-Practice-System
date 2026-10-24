/**
 * 真题 PDF 图片提取：把「题干 + 选项（含图形）」所在区域裁剪成 PNG。
 *
 * 为什么必须裁剪而不是直接贴原文：
 *   图形推理、几何图、统计图表在 PDF 里是矢量或位图对象，文本层只有 "A." "B." "C." "D."，
 *   不把图像抠出来，整卷答题时这些题根本没法作答。
 *
 * 实现思路（poppler-utils）：
 *   1. `pdftotext -bbox-layout` 拿到每行文字的坐标（PDF 用户空间，原点在左下角）
 *   2. 用与 lib/paperText 相同的规则识别题号行，按题号把页面切成若干「题目区间」
 *   3. 区间 = 该题题干行顶部 → 下一个题号行顶部（这样选项里的图形也会落在区间内）
 *   4. `pdftoppm -x/-y/-W/-H` 按像素坐标裁剪渲染成 PNG
 *
 * 依赖：服务器需安装 poppler-utils（pdftotext / pdftoppm）。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 渲染 DPI：越高越清晰，文件也越大 */
const RENDER_DPI = Number(process.env.PDF_RENDER_DPI || 150);
/** 单题最多保留几张图（跨页题） */
const MAX_IMAGES_PER_QUESTION = 2;

const STANDALONE_NUM = /^\s*(\d{1,3})\s*[.、．]\s*$/;
const TRAILING_NUM = /(\d{1,3})\s*([.、．])?\s*$/;
/** 行首题号 + 正文（"101. According to ..."），PDF 里常见的第三种排版 */
const LEADING_NUM = /^\s*(\d{1,3})\s*[.、．]\s+\S/;
const OPTION_LINE = /^\s*[A-D]\s*[.．、]/;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} 执行失败：${err.message}${stderr ? ' / ' + stderr : ''}`));
      resolve({ stdout, stderr });
    });
  });
}

/** 检查 poppler 工具是否可用 */
function hasPoppler() {
  return new Promise((resolve) => {
    execFile('pdftoppm', ['-v'], (err) => resolve(!err));
  });
}

/**
 * 解析 `pdftotext -bbox-layout` 的 XHTML 输出。
 * @returns {Array<{page: number, width: number, height: number, lines: Array<{text,xMin,yMin,xMax,yMax}>}>}
 */
function parseBBox(xml) {
  const pages = [];
  const pageRe = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"\s*>([\s\S]*?)<\/page>/g;
  let pm;
  let pageNo = 0;
  while ((pm = pageRe.exec(xml)) !== null) {
    pageNo++;
    const width = Number(pm[1]);
    const height = Number(pm[2]);
    const body = pm[3];
    const lines = [];
    const lineRe = /<line\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)"\s*>([\s\S]*?)<\/line>/g;
    let lm;
    while ((lm = lineRe.exec(body)) !== null) {
      const words = [];
      const wordRe = /<word[^>]*>([\s\S]*?)<\/word>/g;
      let wm;
      while ((wm = wordRe.exec(lm[5])) !== null) {
        words.push(decodeXml(wm[1]));
      }
      // word 之间补空格，否则 "101. According" 会粘成 "101.According" 导致题号识别失败
      const text = words.join(' ');
      if (!text.trim()) continue;
      lines.push({
        text,
        xMin: Number(lm[1]),
        yMin: Number(lm[2]),
        xMax: Number(lm[3]),
        yMax: Number(lm[4]),
      });
    }
    pages.push({ page: pageNo, width, height, lines });
  }
  return pages;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * 从一页的各行里识别题号行。
 * 返回 [{ num, lineIndex, kind }]，kind: 'A'=题号独立成行，'B'=题号在行尾
 */
function detectQuestionLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    const standalone = text.match(STANDALONE_NUM);
    if (standalone) {
      out.push({ num: Number(standalone[1]), lineIndex: i, kind: 'A' });
      continue;
    }
    if (OPTION_LINE.test(text)) continue;
    // 行首题号 + 正文："101. According to the table..."
    const leading = text.match(LEADING_NUM);
    if (leading) {
      out.push({ num: Number(leading[1]), lineIndex: i, kind: 'C' });
      continue;
    }
    const m = text.match(TRAILING_NUM);
    if (!m) continue;
    const head = text.slice(0, text.length - m[0].length).trim();
    const before = head.slice(-1);
    if (before && /[0-9A-Za-z]/.test(before)) continue;
    const n = Number(m[1]);
    if (n < 1 || n > 300) continue;
    if (!head && !m[2]) continue;
    out.push({ num: n, lineIndex: i, kind: 'B' });
  }
  return out;
}

/**
 * 把一页按题号切成「题目区间」。
 * 区间上边界 = 题干行顶部；下边界 = 下一个题号行顶部（这样选项里的图形也落在区间内）。
 *
 * 坐标系说明：`pdftotext -bbox-layout` 输出的 y 是**从页面顶部往下**的
 * （与 pdftoppm 的 -y 一致，虽然 PDF 规范里原点在左下角，实测 poppler 就是这样）。
 */
function buildRegions(pages) {
  /** 题号 → [{ page, xMin, xMax, yTop, yBottom, graphic }]（左上角原点） */
  const regions = new Map();
  for (const pg of pages) {
    const marks = detectQuestionLines(pg.lines);
    for (let k = 0; k < marks.length; k++) {
      const mk = marks[k];
      const next = marks[k + 1];
      // 题干行：格式 A（题号独立成行）时上一行是题干；格式 B/C 时题号行本身含题干
      let stemIdx = mk.lineIndex;
      if (mk.kind === 'A' && mk.lineIndex > 0 && !OPTION_LINE.test(pg.lines[mk.lineIndex - 1].text)) {
        stemIdx = mk.lineIndex - 1;
      }
      const yTop = pg.lines[stemIdx].yMin;
      // 下边界：下一题的题干行顶部；没有下一题则到本页底部
      let yBottom = pg.height;
      if (next) {
        let nIdx = next.lineIndex;
        if (next.kind === 'A' && nIdx > 0 && !OPTION_LINE.test(pg.lines[nIdx - 1].text)) nIdx = nIdx - 1;
        yBottom = Math.min(pg.lines[nIdx].yMin, pg.height);
      }
      if (yBottom - yTop < 4) yBottom = Math.min(yTop + 40, pg.height);

      // 本题区间内的行
      const segLines = pg.lines.filter((l) => l.yMin >= yTop - 1 && l.yMax <= yBottom + 1);
      const textMinX = segLines.length ? Math.min(...segLines.map((l) => l.xMin)) : 0;
      const textMaxX = segLines.length ? Math.max(...segLines.map((l) => l.xMax)) : pg.width;
      // 图形题判定：选项行去掉 "A." 标记后几乎没有文字 —— 说明选项本身是图
      const optLines = segLines.filter((l) => OPTION_LINE.test(l.text));
      const optTexts = optLines.map((l) => l.text.replace(/^\s*[A-D]\s*[.．、]\s*/, '').trim());
      const graphic = optTexts.length > 0 && optTexts.every((t) => t.length <= 3);

      // 普通题按文字范围裁剪（紧凑）；图形题强制整页宽 —— 图形推理的选项图
      // 横向排在文字右侧，只按文字宽度裁会把图切掉
      const xMin = graphic ? 0 : Math.max(0, textMinX - 16);
      const xMax = graphic ? pg.width : Math.min(pg.width, textMaxX + 16);

      if (!regions.has(mk.num)) regions.set(mk.num, []);
      regions.get(mk.num).push({
        page: pg.page,
        pageWidth: pg.width,
        pageHeight: pg.height,
        xMin,
        xMax,
        yTop,
        yBottom,
        graphic,
      });
    }
  }
  return regions;
}

/**
 * 把区域换算成 pdftoppm 的像素裁剪参数。
 * poppler 的 bbox 与 pdftoppm 裁剪参数都以上角为原点，可直接线性换算。
 */
function toCropRect(region, dpi) {
  const scale = dpi / 72;
  const x = Math.max(0, Math.floor(region.xMin * scale));
  const y = Math.max(0, Math.floor(region.yTop * scale));
  const w = Math.max(8, Math.min(Math.ceil((region.xMax - region.xMin) * scale), Math.ceil(region.pageWidth * scale) - x));
  const h = Math.max(8, Math.min(Math.ceil((region.yBottom - region.yTop) * scale), Math.ceil(region.pageHeight * scale) - y));
  return { x, y, w, h };
}

/**
 * 裁剪渲染一个区域为 PNG。
 */
function cropRegion(pdfPath, region, outFile, dpi = RENDER_DPI) {
  const rect = toCropRect(region, dpi);
  const prefix = outFile.replace(/\.png$/, '');
  return exec('pdftoppm', [
    '-f', String(region.page),
    '-l', String(region.page),
    '-r', String(dpi),
    '-x', String(rect.x),
    '-y', String(rect.y),
    '-W', String(rect.w),
    '-H', String(rect.h),
    '-png',
    '-singlefile',
    pdfPath, prefix,
  ]).then(() => {
    if (!fs.existsSync(prefix + '.png')) throw new Error('裁剪未生成图片：' + prefix + '.png');
    return prefix + '.png';
  });
}

/**
 * 提取整卷的题目区域图片。
 *
 * @param {string} pdfPath 服务器上的 PDF 路径
 * @param {string} outDir 输出目录
 * @returns {Promise<{ questions: Map<number, string[]>, stats: object }>}
 *          questions: 题号 → 生成的 PNG 绝对路径列表
 */
async function extractQuestionImages(pdfPath, outDir) {
  const stats = { pages: 0, regions: 0, rendered: 0, failed: 0 };
  if (!fs.existsSync(pdfPath)) return { questions: new Map(), stats };
  if (!(await hasPoppler())) return { questions: new Map(), stats };

  fs.mkdirSync(outDir, { recursive: true });
  const { stdout } = await exec('pdftotext', ['-bbox-layout', pdfPath, '-']);
  const pages = parseBBox(stdout);
  stats.pages = pages.length;
  const regions = buildRegions(pages);
  stats.regions = regions.size;

  const questions = new Map();
  for (const [num, list] of regions) {
    const files = [];
    // 同一题跨页时，每页各裁一张，最多保留 MAX_IMAGES_PER_QUESTION 张
    for (let i = 0; i < list.length && files.length < MAX_IMAGES_PER_QUESTION; i++) {
      const outFile = path.join(outDir, `q${num}${files.length ? '-' + (files.length + 1) : ''}.png`);
      try {
        const p = await cropRegion(pdfPath, list[i], outFile);
        files.push(p);
        stats.rendered++;
      } catch (err) {
        stats.failed++;
        console.warn(`[pdfRegions] 题号 ${num} 第 ${list[i].page} 页裁剪失败：${err.message}`);
      }
    }
    if (files.length) questions.set(num, files);
  }
  return { questions, stats };
}

module.exports = {
  parseBBox,
  detectQuestionLines,
  buildRegions,
  toCropRect,
  cropRegion,
  extractQuestionImages,
  hasPoppler,
};
