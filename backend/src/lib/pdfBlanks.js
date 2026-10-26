/**
 * PDF 文本重建 + 填空位标注。
 *
 * 背景一：阅读顺序
 *   `pdftotext -layout` 保留的是 PDF 的**文本流顺序**，不是视觉阅读顺序。
 *   同一页里选项块可能排在题干块之前（实测第 10 页：y=237 的提示行排在 y=114 的
 *   选项行之前），行序与页面实际排版不一致。
 *   `pdftotext -bbox-layout` 给出每个词/文字块的坐标，按 y 排序即视觉阅读顺序。
 *
 * 背景二：选词填空的「空」丢失
 *   试卷里选词填空的空是一条**矢量下划线**，文本层没有对应字符，
 *   pdftotext 只能把它变成一段空白 —— 结果题干变成「我们 ，」这样看不出是空。
 *   但下划线会在文本层留下一个**行内间隙**：bbox 会把该行拆成两个元素，
 *   两者之间是空隙。实测该卷所有空的间隙宽度统一为 23.7pt（≈2 个汉字宽），
 *   而选项列的间隙是 59~98pt —— 宽度 + 「左右都不是选项标记」两个条件足以精确判别。
 *
 * 本模块从 bbox 重建整卷文本，并在空位插入 `____`。
 */

/** 行内间隙宽度下限（pt）—— 小于此值视为普通词间距 */
const GAP_MIN = 12;
/** 行内间隙宽度上限（pt）—— 大于此值视为版面留白（选项列/表格列），不是填空 */
const GAP_MAX = 34;
/** 元素文本以选项标记开头 → 该间隙是选项列间隔，不是填空 */
const OPTION_START = /^\s*[A-D]\s*[.\uFF0E\u3001]/;
/** 一行里出现 2 个以上选项标记 → 这是选项行，整体跳过 */
const OPTION_ROW = /(^|[\s\u3000])[A-D]\s*[.\uFF0E\u3001]/g;

/** 选项标记（用于判定"这一行是选项行"） */
function countOptionMarkers(text) {
  OPTION_ROW.lastIndex = 0;
  const m = String(text || '').match(OPTION_ROW);
  return m ? m.length : 0;
}

/**
 * 把一页的 bbox 行聚合成「视觉行」（同一 y 的多个文字块属于同一视觉行）。
 * @param {object} pg parseBBox 得到的页对象
 * @returns {Array<{y:number, items:Array}>}
 */
function buildVisualRows(pg) {
  const rows = [];
  for (const l of (pg && pg.lines) || []) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - l.yMin) < 3) {
      last.items.push(l);
    } else {
      rows.push({ y: l.yMin, items: [l] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.xMin - b.xMin);
  return rows;
}

/**
 * 估算页面的平均字符宽度（用于把绝对间隙换算成"几个字宽"）。
 * 取各文字块 宽度/字符数 的中位数，避开极短的块。
 */
function estimateCharWidth(rows) {
  const samples = [];
  for (const r of rows) {
    for (const it of r.items) {
      const n = String(it.text || '').replace(/\s/g, '').length;
      if (n >= 4) samples.push((it.xMax - it.xMin) / n);
    }
  }
  if (!samples.length) return 12;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] || 12;
}

/**
 * 从 bbox 重建整卷文本，空位插入 `____`。
 *
 * @param {Array} pages parseBBox 的页数组
 * @param {object} [opts]
 * @param {boolean} [opts.markBlanks=true] 是否标注填空位
 * @returns {{text: string, blankCount: number, rowCount: number}}
 */
function rebuildTextFromBBox(pages, opts = {}) {
  const markBlanks = opts.markBlanks !== false;
  const out = [];
  let blankCount = 0;
  let rowCount = 0;

  for (const pg of pages || []) {
    const rows = buildVisualRows(pg);
    const charW = estimateCharWidth(rows);
    const lo = Math.max(GAP_MIN, charW * 1.2);
    const hi = Math.min(GAP_MAX, charW * 2.8);
    const lines = [];

    for (const r of rows) {
      rowCount++;
      const rowText = r.items.map((x) => x.text).join('');
      const isOptionRow = countOptionMarkers(rowText) >= 2;
      let s = '';
      for (let k = 0; k < r.items.length; k++) {
        if (k > 0) {
          const prev = r.items[k - 1];
          const cur = r.items[k];
          const gap = cur.xMin - prev.xMax;
          const leftIsOpt = OPTION_START.test(String(prev.text || ''));
          const rightIsOpt = OPTION_START.test(String(cur.text || ''));
          if (markBlanks && !isOptionRow && gap >= lo && gap <= hi && !leftIsOpt && !rightIsOpt) {
            s += '____';
            blankCount++;
          } else if (gap > 1.5) {
            s += ' ';
          }
        }
        s += r.items[k].text;
      }
      lines.push(s);
    }
    out.push(lines.join('\n'));
  }

  return { text: out.join('\n\n'), blankCount, rowCount };
}

module.exports = {
  buildVisualRows,
  estimateCharWidth,
  rebuildTextFromBBox,
  GAP_MIN,
  GAP_MAX,
};
