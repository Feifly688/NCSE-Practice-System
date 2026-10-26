/**
 * PDF → 文本：文本型直接提取，扫描件/图片型 PDF 走 OCR 降级。
 *
 * 提取链路（按优先级）：
 *   1. `pdftotext -layout`（poppler）——**按阅读顺序**输出。
 *      实测：pdf-parse（pdf.js）按 PDF 内容流顺序提取，而部分排版软件生成的 PDF
 *      内容流顺序 ≠ 阅读顺序（板块标题后混入其他板块内容、题号与选项行被页眉
 *      截断导致题号漏识别），因此 poppler 可用时**必须优先用 pdftotext**。
 *      同一份 27 页真题实测：pdftotext -layout 识别 130/130 题号、零断档；
 *      pdf-parse 仅 128/130（断档 77/80，选项行被页眉误删）。
 *   2. pdf-parse——服务器未安装 poppler-utils 时的兜底。
 *   3. OCR（视觉模型逐页识别）——前两者都提不到有效文本且 PDF 含图片对象时降级。
 *
 * 行为约定（调用方据此向管理员给出可读提示）：
 *   - method 字段标明实际使用的链路：pdftotext-layout / pdf-parse / ocr-vision
 *   - 提取为空/过少 + PDF 内含图片对象 → 判定为扫描件/图片型
 *       · 服务器安装 poppler-utils（pdftoppm）时：按页渲染 PNG → 视觉模型逐页识别
 *       · 未安装时：返回明确错误，说明如何补救（不静默失败）
 *   - 质量评估：字符数、中文占比、可识别题号数量，用于给出「文本质量差」警告
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { callVision } = require('./aiClient');

const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 20);
const OCR_DPI = Number(process.env.OCR_DPI || 150);

/** 统计 PDF 中的图片对象数量（扫描件通常每页都有大图） */
function countImageObjects(buffer) {
  const raw = buffer.toString('latin1');
  const m = raw.match(/\/Subtype\s*\/Image/gi);
  return m ? m.length : 0;
}

/** 文本质量评估 */
function assessTextQuality(text) {
  const cleaned = String(text || '').trim();
  const chars = cleaned.length;
  const chinese = (cleaned.match(/[\u4e00-\u9fa5]/g) || []).length;
  const cjkRatio = chars > 0 ? chinese / chars : 0;
  // 题号特征：行首「1.」「12．」「第1题」「一、」
  const markers = (cleaned.match(/(^|\n)\s*(\d{1,3}\s*[.、．])|(^|\n)\s*第\s*\d{1,3}\s*题/g) || []).length;
  return { chars, cjkRatio, markers, usable: chars >= 200 && cjkRatio > 0.15 };
}

/** 归一化：合并多余空白，保留段落结构 */
function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\u000c/g, '\n') // 分页符
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 检查 pdftoppm 是否可用 */
function hasPoppler() {
  return new Promise((resolve) => {
    execFile('pdftoppm', ['-v'], (err) => resolve(!err));
  });
}

/** execFile 的 Promise 包装（统一 maxBuffer，避免大 PDF 输出被截断） */
function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} 执行失败：${err.message}${stderr ? ' / ' + String(stderr).slice(0, 200) : ''}`));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 用 poppler 的 pdftotext 提取文本。
 *
 * 两种取文本的方式：
 *   1. `pdftotext -bbox-layout` 重建（**优先**）
 *      - 按坐标重建 = **视觉阅读顺序**。`-layout` 保留的是 PDF 文本流顺序，
 *        同一页里选项块可能排在题干块之前（实测第 10 页 y=237 的提示行
 *        排在 y=114 的选项行之前），与排版不一致。
 *      - 顺带把选词填空的**下划线空**标成 `____`：下划线在文本层没有字符，
 *        但会在行内留下一个 2 字宽的间隙（实测 23.7pt），据此可精确定位。
 *   2. `pdftotext -layout` 兜底
 *      重建结果的题号特征若明显少于 -layout（罕见），退回 -layout 保证题号不丢。
 *
 * @returns {Promise<{text: string, pages: number, method: string, blanks: number}>}
 */
async function extractByPdftotext(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eppdftxt-'));
  const pdfPath = path.join(dir, 'input.pdf');
  fs.writeFileSync(pdfPath, buffer);
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-']);
    const raw = String(stdout || '');
    const pages = (raw.match(/\f/g) || []).length;
    const layoutText = normalizeText(raw);

    // ── 尝试用 bbox 重建（视觉顺序 + 填空位标注）──────────────────
    try {
      const { stdout: bboxOut } = await execFileAsync('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', pdfPath, '-']);
      const { parseBBox } = require('./pdfRegions');
      const { rebuildTextFromBBox } = require('./pdfBlanks');
      const rb = rebuildTextFromBBox(parseBBox(String(bboxOut || '')));
      const rebuilt = normalizeText(rb.text);
      const qLayout = assessTextQuality(layoutText);
      const qRebuilt = assessTextQuality(rebuilt);
      // 题号特征明显更少时退回 -layout（题号丢失的代价远大于空位缺失）
      if (qRebuilt.markers >= Math.max(3, qLayout.markers - 2)) {
        return { text: rebuilt, pages, method: 'pdftotext-bbox', blanks: rb.blankCount };
      }
      console.warn(
        `[pdf] bbox 重建文本题号特征偏少（rebuilt=${qRebuilt.markers} layout=${qLayout.markers}），退回 -layout`
      );
    } catch (err) {
      console.warn('[pdf] bbox 重建失败，改用 -layout：' + err.message);
    }

    return { text: layoutText, pages, method: 'pdftotext-layout', blanks: 0 };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 用 pdftoppm 将指定页渲染为 PNG，返回文件路径列表 */
function renderPagesToPng(pdfPath, outPrefix, from, to, dpi) {
  return new Promise((resolve, reject) => {
    const args = ['-r', String(dpi), '-png', '-f', String(from), '-l', String(to), pdfPath, outPrefix];
    execFile('pdftoppm', args, { maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error('pdftoppm 渲染失败: ' + err.message));
      const dir = path.dirname(outPrefix);
      const base = path.basename(outPrefix);
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base) && f.endsWith('.png'))
        .sort()
        .map((f) => path.join(dir, f));
      resolve(files);
    });
  });
}

/** OCR 降级：逐页调用视觉模型识别 */
async function ocrByVision(pdfPath, pages) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epocr-'));
  const prefix = path.join(tmpDir, 'page');
  const to = Math.min(pages, OCR_MAX_PAGES);
  let files = [];
  try {
    files = await renderPagesToPng(pdfPath, prefix, 1, to, OCR_DPI);
  } catch (err) {
    throw new Error('PDF 页面渲染失败（' + err.message + '）');
  }

  const parts = [];
  let failedPages = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const b64 = fs.readFileSync(files[i]).toString('base64');
      const { content } = await callVision({
        imageBase64: b64,
        prompt:
          '请逐字识别这张试卷扫描图片中的文字内容。要求：保持原有题目编号、题干、选项（A/B/C/D）与段落顺序；' +
          '不要翻译、不要改写、不要添加解释；只输出识别到的纯文本。',
      });
      if (content && content.trim()) parts.push(`\n=== 第 ${i + 1} 页 ===\n` + content.trim());
      else failedPages++;
    } catch (err) {
      failedPages++;
      console.error('[pdf] OCR 第 ' + (i + 1) + ' 页失败: ' + err.message);
    }
  }
  // 清理临时文件
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const text = normalizeText(parts.join('\n'));
  return { text, pagesOcr: files.length, failedPages, truncated: to < pages };
}

/**
 * 提取 PDF 文本。
 * @returns {Promise<{ ok: boolean, text?: string, pages?: number, method?: string,
 *                     warning?: string, error?: string, quality?: object }>}
 */
async function extractPdfText(buffer) {
  // ── 链路 1：pdftotext -layout（阅读顺序，优先）─────────────────
  // 必须在 pdf-parse 之前：内容流顺序 ≠ 阅读顺序的 PDF（常见于排版软件导出）
  // 用 pdf-parse 会得到乱序文本，导致题号漏识别、板块材料错位。
  const poppler = await hasPoppler();
  if (poppler) {
    try {
      const { text, pages, method, blanks } = await extractByPdftotext(buffer);
      const quality = assessTextQuality(text);
      if (quality.usable && quality.markers >= 3) {
        if (quality.markers < 10) {
          return { ok: true, text, pages, method, quality, warning: '题号特征较少（' + quality.markers + ' 处），AI 拆题结果请人工核对' };
        }
        return { ok: true, text, pages, method, quality, blanks };
      }
      console.warn(`[pdf] pdftotext -layout 质量不足（chars=${quality.chars} markers=${quality.markers}），回退 pdf-parse`);
    } catch (err) {
      console.warn('[pdf] pdftotext -layout 失败，回退 pdf-parse：' + err.message);
    }
  }

  // ── 链路 2：pdf-parse（无 poppler 时的兜底）────────────────────
  let parsed = { text: '', numpages: 0 };
  try {
    const pdfParse = require('pdf-parse');
    parsed = await pdfParse(buffer);
  } catch (err) {
    console.error('[pdf] pdf-parse 失败: ' + err.message);
    return { ok: false, error: 'PDF 解析失败（文件可能损坏或加密）：' + err.message };
  }

  const pages = parsed.numpages || 0;
  let text = normalizeText(parsed.text);
  let method = 'pdf-parse';
  const quality = assessTextQuality(text);
  let warning = null;

  if (!quality.usable) {
    const images = countImageObjects(buffer);
    const isImagePdf = images > 0 && (pages === 0 || images >= pages * 0.5);
    if (!isImagePdf) {
      return {
        ok: false,
        pages,
        error:
          '未能从 PDF 提取到有效文本（提取 ' + quality.chars + ' 字，中文占比 ' +
          (quality.cjkRatio * 100).toFixed(0) + '%）。请确认上传的是文本型 PDF；' +
          '若为扫描件，系统需要 OCR 支持。',
        quality,
      };
    }

    // 图片型/扫描件 → OCR 降级（poppler 可用性已在链路 1 检测过）
    if (!poppler) {
      return {
        ok: false,
        pages,
        error:
          '该 PDF 为扫描件/图片型（含 ' + images + ' 个图片对象，无文本层）。当前服务器未安装 OCR 依赖 ' +
          '(poppler-utils)，无法自动识别。请在服务器执行 `apt-get install -y poppler-utils` 后重试，' +
          '或改上传文本型 PDF。',
        quality,
      };
    }

    const tmpPdf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eppdf-')), 'input.pdf');
    fs.writeFileSync(tmpPdf, buffer);
    try {
      const ocr = await ocrByVision(tmpPdf, pages || OCR_MAX_PAGES);
      text = ocr.text;
      method = 'ocr-vision';
      const q2 = assessTextQuality(text);
      if (ocr.truncated) warning = `OCR 仅处理前 ${OCR_MAX_PAGES} 页（共 ${pages} 页），后续页面未识别`;
      if (ocr.failedPages > 0) warning = (warning ? warning + '；' : '') + `${ocr.failedPages} 页识别失败`;
      if (!q2.usable) {
        return {
          ok: false,
          pages,
          method,
          error: 'OCR 识别后仍无有效文本（识别 ' + q2.chars + ' 字），请提高扫描清晰度或改上传文本型 PDF。',
          quality: q2,
        };
      }
      return { ok: true, text, pages, method, warning, quality: q2 };
    } catch (err) {
      return { ok: false, pages, method, error: 'OCR 处理失败：' + err.message, quality };
    } finally {
      try { fs.rmSync(path.dirname(tmpPdf), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  if (quality.markers < 3) {
    warning = '未识别到明显的题号特征（' + quality.markers + ' 处），文本质量可能较差，AI 拆题结果请人工核对';
  }

  return { ok: true, text, pages, method, warning, quality };
}

module.exports = { extractPdfText, assessTextQuality, normalizeText, countImageObjects };
