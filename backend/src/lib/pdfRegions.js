/**
 * 真题 PDF 图片提取：把「题干 + 选项（含图形）」所在区域裁剪成 PNG，
 * 并把资料分析「一篇材料的材料段」也截出来（材料段的统计图表只能这样取得）。
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
 * 材料段截图（资料分析的关键补充）：
 *   一篇材料（含统计表/柱状图等矢量图）只出现在篇首题号**之前**，不在任何题号区间内，
 *   只按题号切区间会永远裁不到材料段的图。因此对「题号行上方存在长数据段」的题，
 *   额外把材料段整体截一张，挂到该题号上（由上层分发到同篇所有题）。
 *
 * 依赖：服务器需安装 poppler-utils（pdftotext / pdftoppm）。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { QUESTION_MARKERS } = require('./paperText');

/** 渲染 DPI：越高越清晰，文件也越大 */
const RENDER_DPI = Number(process.env.PDF_RENDER_DPI || 150);
/** 单题最多保留几张图（跨页题） */
const MAX_IMAGES_PER_QUESTION = 2;
/** 材料段最少字数（低于此认为是题干片段而非一篇材料） */
const MATERIAL_MIN_CHARS = 80;
/** 统计型材料特征词（与 lib/paperText 的 DATA_MARKERS 保持一致） */
const DATA_MARKERS = /%|％|百分点|同比|环比|亿元|万元|万件|亿吨|万吨|万人|规模以上|增长率|占比|比重|增加值|销售额|零售额/;

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
  // bbox 的 <line> 是**文档流顺序**，不是视觉顺序（同一页里选项行可能排在题干行之后）。
  // 统一按 (y, x) 排序：后续所有"行序 = 阅读序"的假设（题号检测、视觉行聚合、
  // 区间裁剪）才成立。排序是稳定排序，同 y 的行按 x 从左到右。
  for (const pg of pages) {
    pg.lines.sort((a, b) => (a.yMin - b.yMin) || (a.xMin - b.xMin));
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
 * 检测「题号行上方的材料段」（同页内）。
 *
 * 资料分析的排版：一篇材料 → 篇首题 → 若干题。材料段位于篇首题号行**上方**、
 * 上一题（或板块标题/页顶）之间。判定：该区间非选项文字 ≥ 80 字且含数据特征词。
 *
 * @param {object} pg 页面（含 lines）
 * @param {Array} marks 本页识别出的题号（按行序）
 * @param {number} k marks 中本题号的下标
 * @returns {{xMin,xMax,yTop,yBottom}|null} 左上角原点坐标系
 */
/**
 * 从指定行**向上**收集连续的材料行（遇到选项行/页码行/问句行即停）。
 *
 * 为什么必须向上收集再遇选项行即停：选项常常跨行（"A.某公司针对一款新品……\n广，
 * 营销成本较低但收益也较低……"），续行不以 A. 开头，按「区间内所有非选项行」收集
 * 会把上一篇的选项续行也算进材料段（实测定义判断题因此误报）。
 *
 * @param {object} pg 页面
 * @param {number} fromLine 收集下界（含）
 * @param {number} toLine 收集上界（不含，从 toLine-1 开始向上）
 * @param {boolean} skipPageNo 页码行跳过（材料在页码上方时）还是终止
 */
function collectMaterialLines(pg, fromLine, toLine, skipPageNo) {
  const seg = [];
  for (let i = toLine - 1; i >= fromLine; i--) {
    const t = pg.lines[i].text.trim();
    if (!t) continue;
    if (/^\s*第\s*\d{1,4}\s*页/.test(t)) {
      if (skipPageNo) continue;
      break;
    }
    if (OPTION_LINE.test(t)) break;        // 选项行 → 材料到此为止
    if (QUESTION_MARKERS.test(t)) break;   // 题干/问句行 → 材料到此为止
    seg.unshift(pg.lines[i]);
  }
  return seg;
}

/**
 * 检测「题号行上方的材料段」（同页内）。
 *
 * 资料分析的排版：一篇材料 → 篇首题 → 若干题。材料段位于篇首题号行**上方**、
 * 上一题（或板块标题/页顶）之间。判定：向上收集到的连续文本 ≥ 80 字、含数据特征词。
 *
 * @param {object} pg 页面（含 lines）
 * @param {Array} marks 本页识别出的题号（按行序）
 * @param {number} k marks 中本题号的下标
 * @returns {{xMin,xMax,yTop,yBottom}|null} 左上角原点坐标系
 */
function detectMaterialSegment(pg, marks, k) {
  const mk = marks[k];
  const prev = k > 0 ? marks[k - 1] : null;
  const fromLine = prev ? prev.lineIndex + 1 : 0;
  // 题号独立成行（kind A）时，题号行的上一行是题干，不属于材料
  let toLine = mk.lineIndex;
  if (mk.kind === 'A' && toLine > 0 && !OPTION_LINE.test(pg.lines[toLine - 1].text)) toLine -= 1;
  if (toLine - fromLine < 1) return null;
  const seg = collectMaterialLines(pg, fromLine, toLine, false);
  if (seg.length < 1) return null;
  const text = seg.map((l) => l.text).join('');
  if (text.length < MATERIAL_MIN_CHARS) return null;
  if (!DATA_MARKERS.test(text)) return null;
  const stemY = pg.lines[toLine] ? pg.lines[toLine].yMin : pg.height;
  const yTop = Math.min(...seg.map((l) => l.yMin));
  // 下边界取篇首题干行顶部：材料文字与题干之间的空白区域可能藏着矢量图表
  if (stemY - yTop < 20) return null;
  // 材料段按整页宽裁剪：统计表/柱状图常占满版心，按文字宽度裁会把图切掉
  return { xMin: 0, xMax: pg.width, yTop, yBottom: stemY };
}

/**
 * 检测「上一页尾部的材料段」（跨页材料的前半段）。
 *
 * 一篇材料常跨页：前半段在上一页的尾部（某题之后、页码之前），
 * 后半段在下一页开头（篇首题号之前）。只截后半段会丢掉材料开头的图表。
 *
 * @param {object} pg 页面
 * @param {number} fromLine 起始行（上一页最后一个题号行之后）
 */
function detectTailMaterial(pg, fromLine) {
  // 页码行是页脚，在材料下方，收集时跳过
  const seg = collectMaterialLines(pg, fromLine, pg.lines.length, true);
  if (seg.length < 2) return null;               // 材料是多行长文本，单行多为选项续行
  const text = seg.map((l) => l.text).join('');
  if (text.length < MATERIAL_MIN_CHARS) return null;
  if (!DATA_MARKERS.test(text)) return null;
  const yTop = Math.min(...seg.map((l) => l.yMin));
  const yBottom = Math.max(...seg.map((l) => l.yMax));
  if (yBottom - yTop < 30) return null;          // 纵向跨度太小 → 不是多行材料
  // 截到材料最后一行（不再到页面底部，避免圈入页脚装饰）
  return { xMin: 0, xMax: pg.width, yTop, yBottom };
}

/**
 * 检测「下一页顶部的续接区」—— 上一题的图形/选项跨到了下一页。
 *
 * 实测（粉笔 2027 国考第 40 季 34 页卷）：
 *   第 19 页底部是 77 题的题干（y=684），它的图形在页面底部，
 *   而**选项行 "A.A B.B C.C D.D" 落在第 20 页顶部**（y=251-263）。
 *   按"题号区间到本页页底"裁剪，77 题只能截到一片空白 + 页脚，看不到任何图形。
 *
 * 判定"下一页顶部属于上一题"的条件（必须同时满足，避免把资料分析的材料误吞）：
 *   1. 该区间内几乎没有文字（图形区没有文字，< 40 字）
 *   2. 区间内有选项行（上一题的选项跨页）——这是最强的信号
 *   3. 区间纵向跨度够大（> 40pt），排除"页眉与首题之间本来就没内容"的情况
 *   4. 区间内不含数据特征词（否则那是资料分析的统计材料，交给材料段逻辑处理）
 *
 * @param {object} nextPg 下一页
 * @param {Array} nextMarks 下一页的题号列表
 * @returns {{xMin,xMax,yTop,yBottom}|null}
 */
function detectNextPageContinuation(nextPg, nextMarks) {
  if (!nextPg || !nextMarks || !nextMarks.length) return null;
  const first = nextMarks[0];
  // 首题的题干行（题号独立成行时上一行才是题干）
  let stemIdx = first.lineIndex;
  if (first.kind === 'A' && stemIdx > 0 && !OPTION_LINE.test(nextPg.lines[stemIdx - 1].text)) stemIdx -= 1;
  const stemLine = nextPg.lines[stemIdx];
  if (!stemLine) return null;
  const yBottom = stemLine.yMin;

  // 区间上界：页眉下沿（页眉固定在 y≈50-62）
  let yTop = 70;
  for (const l of nextPg.lines) {
    if (l.yMax < 80) yTop = Math.max(yTop, l.yMax + 6);
  }
  if (yBottom - yTop < 40) return null;

  const seg = nextPg.lines.filter((l) => l.yMin >= yTop - 1 && l.yMax <= yBottom + 1);
  const text = seg.map((l) => l.text).join('').trim();
  const hasOption = seg.some((l) => OPTION_LINE.test(l.text));
  // 文字多 = 那是新一篇材料/新内容，不是上一题的图形
  if (text.length > 40) return null;
  if (DATA_MARKERS.test(text)) return null;
  if (!hasOption && text.length > 0) return null; // 有文字但没有选项行 → 未必是续接
  if (!hasOption && text.length === 0) {
    // 纯图形区：允许，但要求区间足够高
    if (yBottom - yTop < 80) return null;
  }
  // 图形/选项横向排布，整页宽裁剪
  return { xMin: 0, xMax: nextPg.width, yTop, yBottom };
}

/**
 * 把一页按题号切成「题目区间」。
 * 区间上边界 = 题干行顶部；下边界 = 下一个题号行顶部（这样选项里的图形也落在区间内）。
 *
 * 坐标系说明：`pdftotext -bbox-layout` 输出的 y 是**从页面顶部往下**的
 * （与 pdftoppm 的 -y 一致，虽然 PDF 规范里原点在左下角，实测 poppler 就是这样）。
 *
 * @returns {{ regions: Map<number, Array>, materials: Map<number, Array> }}
 *   regions: 题号 → 题目区间列表；materials: 篇首题号 → 材料段区间列表（可跨页）
 */
function buildRegions(pages) {
  /** 题号 → [{ page, xMin, xMax, yTop, yBottom, graphic }]（左上角原点） */
  const regions = new Map();
  /** 篇首题号 → [{ page, xMin, xMax, yTop, yBottom, material: true }] */
  const materials = new Map();
  // 预计算每页题号（跨页材料检测要用上一页的题号分布）
  const pageMarks = pages.map((pg) => detectQuestionLines(pg.lines));

  for (let p = 0; p < pages.length; p++) {
    const pg = pages[p];
    const marks = pageMarks[p];
    const prevPage = p > 0 ? pages[p - 1] : null;
    const prevMarks = p > 0 ? pageMarks[p - 1] : [];
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
      // 下边界到页底时，剔除页脚（"第 19 页，共 34 页"）——它不属于任何一题
      if (!next && yBottom >= pg.height - 1) {
        const foot = pg.lines.filter((l) => /^\s*第\s*\d{1,4}\s*页/.test(l.text.trim()));
        if (foot.length) yBottom = Math.min(yBottom, Math.min(...foot.map((l) => l.yMin)) - 4);
      }

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
      let xMin = graphic ? 0 : Math.max(0, textMinX - 16);
      let xMax = graphic ? pg.width : Math.min(pg.width, textMaxX + 16);

      if (!regions.has(mk.num)) regions.set(mk.num, []);
      const region = {
        page: pg.page,
        pageWidth: pg.width,
        pageHeight: pg.height,
        xMin,
        xMax,
        yTop,
        yBottom,
        graphic,
      };
      regions.get(mk.num).push(region);

      // ── 跨页续接：本题是本页最后一个题号，而它的图形/选项落在下一页顶部 ──
      // 此时本页区间要整页宽裁（图形横向排布），并额外追加下一页顶部的续接区。
      if (!next && p + 1 < pages.length) {
        const cont = detectNextPageContinuation(pages[p + 1], pageMarks[p + 1]);
        if (cont) {
          region.xMin = 0;
          region.xMax = pg.width;
          region.graphic = true;
          regions.get(mk.num).push({
            page: pages[p + 1].page,
            pageWidth: pages[p + 1].width,
            pageHeight: pages[p + 1].height,
            xMin: cont.xMin,
            xMax: cont.xMax,
            yTop: cont.yTop,
            yBottom: cont.yBottom,
            graphic: true,
            continuation: true,
          });
        }
      }

      // ── 材料段：篇首题号上方的长数据段（资料分析的统计图表在这里）─────
      // 跨页材料要截两段：本篇首页内的后半段 + 上一页尾部的前半段。
      // 不能因同页命中就跳过跨页检查 —— 实测 M市材料跨 22/23 页，
      // 只截页23部分会丢掉材料开头的图表。
      const matSegs = [];
      // 跨页段（上一页尾部 = 材料开头）排在前面，同页段（材料后半）排在后面
      if (k === 0 && prevPage && prevMarks.length) {
        const lastMark = prevMarks[prevMarks.length - 1];
        const tail = detectTailMaterial(prevPage, lastMark.lineIndex + 1);
        if (tail) {
          matSegs.push({
            ...tail,
            page: prevPage.page,
            pageWidth: prevPage.width,
            pageHeight: prevPage.height,
          });
        }
      }
      const samePage = detectMaterialSegment(pg, marks, k);
      if (samePage) {
        matSegs.push({ ...samePage, page: pg.page, pageWidth: pg.width, pageHeight: pg.height });
      }
      for (const seg of matSegs) {
        if (!materials.has(mk.num)) materials.set(mk.num, []);
        materials.get(mk.num).push({ ...seg, material: true });
      }
    }
  }
  return { regions, materials };
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
 * 提取整卷的题目区域图片（含资料分析的材料段截图）。
 *
 * @param {string} pdfPath 服务器上的 PDF 路径
 * @param {string} outDir 输出目录
 * @returns {Promise<{ questions: Map<number, string[]>, materials: Map<number, string[]>, stats: object }>}
 *          questions: 题号 → 本题区域 PNG 绝对路径列表
 *          materials: 篇首题号 → 材料段 PNG 绝对路径列表（资料分析的统计图表）
 *          stats.skipped: 跳过的原因（poppler 未安装等），供上层显式报错
 */
async function extractQuestionImages(pdfPath, outDir) {
  const stats = { pages: 0, regions: 0, rendered: 0, failed: 0, materialRegions: 0, materialRendered: 0, skipped: null };
  const empty = { questions: new Map(), materials: new Map(), stats };
  if (!fs.existsSync(pdfPath)) return empty;
  if (!(await hasPoppler())) {
    // 不能静默返回：否则上传界面看不到任何提示，用户以为图片功能正常
    stats.skipped = 'poppler-missing';
    return empty;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const { stdout } = await exec('pdftotext', ['-bbox-layout', pdfPath, '-']);
  const pages = parseBBox(stdout);
  stats.pages = pages.length;
  const { regions, materials } = buildRegions(pages);
  stats.regions = regions.size;
  stats.materialRegions = materials.size;

  // 裁剪一组区域为 PNG，返回文件路径列表
  const renderGroup = async (list, namePrefix) => {
    const files = [];
    for (let i = 0; i < list.length && files.length < MAX_IMAGES_PER_QUESTION; i++) {
      const suffix = files.length ? '-' + (files.length + 1) : '';
      const outFile = path.join(outDir, `${namePrefix}${suffix}.png`);
      try {
        const p = await cropRegion(pdfPath, list[i], outFile);
        files.push(p);
      } catch (err) {
        stats.failed++;
        console.warn(`[pdfRegions] ${namePrefix} 第 ${list[i].page} 页裁剪失败：${err.message}`);
      }
    }
    return files;
  };

  const questions = new Map();
  for (const [num, list] of regions) {
    const files = await renderGroup(list, `q${num}`);
    if (files.length) {
      questions.set(num, files);
      stats.rendered += files.length;
    }
  }

  // 材料段截图（资料分析的统计表/柱状图），命名 q<题号>-m.png 与题目区间图区分
  const materialFiles = new Map();
  for (const [num, list] of materials) {
    const files = await renderGroup(list, `q${num}-m`);
    if (files.length) {
      materialFiles.set(num, files);
      stats.materialRendered += files.length;
    }
  }

  return { questions, materials: materialFiles, stats };
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
