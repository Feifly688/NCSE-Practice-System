/**
 * 判断题目的原卷截图是不是「必须显示」。
 *
 * 背景：拆题流水线会给**每一题**都裁一张原卷区域截图（q<seq>.png）。
 * 对图形推理、含表资料分析这类题，没有图就没法作答，图是必需的；
 * 但对纯文本题，这张图只是把题干原文重新拍了一遍 —— 前端已经用文本渲染了
 * 同样的内容，再显示一张 100KB 的图既冗余又拖慢加载，还会让人误以为漏了图形。
 *
 * 这里的判定只影响**显示**，不删除任何资源：被判为「不需要」的题，
 * 前端仍可通过折叠入口查看原卷截图，避免规则误判导致信息丢失。
 */

/** 选项是「图片占位符」或单个字母 —— 图形推理/立体/语句排序等纯图形选项 */
const IMG_OPTION = /^\s*[\uFF08(]\u56FE\u7247\u9009\u9879[\uFF09)]\s*$|^\s*[A-Da-d]\s*$/;

/** 题干明确引用了图形或表格 */
const STEM_REFERS_FIGURE = new RegExp([
  '\u5982\u56FE',    // 如图
  '\u4E0A\u56FE',    // 上图
  '\u4E0B\u56FE',    // 下图
  '\u56FE\u4E2D',    // 图中
  '\u6B64\u56FE',    // 此图
  '\u56FE\u793A',    // 图示
  '\u793A\u610F\u56FE', // 示意图
  '\u56FE\u5F62',    // 图形
  '\u8868\u4E2D',    // 表中
  '\u4E0B\u8868',    // 下表
  '\u4E0A\u8868',    // 上表
  '\u8868\u683C',    // 表格
  '\u7EDF\u8BA1\u56FE', // 统计图
  '\u7EDF\u8BA1\u8868', // 统计表
  '\u6298\u7EBF\u56FE', // 折线图
  '\u67F1\u72B6\u56FE', // 柱状图
  '\u67F1\u5F62\u56FE', // 柱形图
  '\u997C\u72B6\u56FE', // 饼状图
  '\u6247\u5F62\u56FE', // 扇形图
  '\u6761\u5F62\u56FE', // 条形图
].join('|'));

/** 标准图形题题干句式（图形推理/立体折纸/分类）—— 复用 paperParser 的白名单 */
const STANDARD_FIGURE_STEM = /从所给的四个选项|选择最合适的一个|填入问号|使之呈现一定的规律性|使之成为排列|把下面的六个图形分为两类|分类正确的一项是|从四个图形中选出|立体图形|截面图/;

/**
 * @param {object} q 题目行（需 section / stem / options 或 options_json / passage）
 * @param {string[]} [files] 该题已挂载的截图文件名；含 `-m` / `-m-2` 之类后缀的视为共享材料图
 * @returns {{needed: boolean, reason: string}}
 */
function classifyImageNeed(q, files = []) {
  const section = String(q.section || '');
  const stem = String(q.stem || '');
  const passage = String(q.passage || '');

  let options = q.options;
  if (!Array.isArray(options) && q.options_json) {
    try {
      options = Array.isArray(q.options_json) ? q.options_json : JSON.parse(q.options_json);
    } catch {
      options = [];
    }
  }
  if (!Array.isArray(options)) options = [];

  // 1) 选项本身是图形（占位符/单字母）→ 不看图做不了
  if (options.length && options.some((o) => IMG_OPTION.test(String(o)))) {
    return { needed: true, reason: 'image-options' };
  }

  // 2) 挂载了共享材料图（统计图表常年是材料段截图）
  if (files.some((f) => /-m(-\d+)?\./.test(f))) {
    return { needed: true, reason: 'material-figure' };
  }

  // 3) 标准图形题句式
  if (STANDARD_FIGURE_STEM.test(stem)) {
    return { needed: true, reason: 'figure-stem' };
  }

  // 4) 题干或材料段提到图/表
  if (STEM_REFERS_FIGURE.test(stem) || STEM_REFERS_FIGURE.test(passage)) {
    return { needed: true, reason: 'refers-figure' };
  }

  // 5) 资料分析：材料里几乎必有图表，题干却可能只写「以下说法正确的是」。
  //    这类题的文本即使完整，原图能大幅降低阅读成本，默认给图。
  if (/\u8D44\u6599\u5206\u6790/.test(section)) {
    return { needed: true, reason: 'data-section' };
  }

  return { needed: false, reason: 'text-only' };
}

module.exports = { classifyImageNeed };
