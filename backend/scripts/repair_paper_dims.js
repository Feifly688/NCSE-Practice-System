/**
 * 修复存量粉笔卷的分类（exam_level / paper_type）。
 *
 * 背景：批量导入初期入库的卷没有写分类直列，autoTag 的旧规则也漏掉了
 * 政法干警/选调，且「国考模拟题」这个值命名不准（省考模拟也会进来）。
 * 本脚本按标题重推一遍，并清掉旧标签让 autoTag 重打。
 *
 * 用法：node scripts/repair_paper_dims.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { withConnection } = require('../src/db');

function inferDims(title) {
  const t = String(title || '');
  let exam_level = null;
  let paper_type = null;
  if (/政法干警/.test(t)) { exam_level = '政法干警'; paper_type = '历年真题'; }
  else if (/选调|遴选/.test(t)) { exam_level = '选调生'; paper_type = '历年真题'; }
  else if (/模考大赛|模拟|预测/.test(t)) { exam_level = /国家公务|国考/.test(t) ? 'national' : null; paper_type = '模拟题'; }
  else if (/国家公务|国考/.test(t)) { exam_level = 'national'; paper_type = '历年真题'; }
  else {
    const provinces = ['安徽', '北京', '福建', '甘肃', '广东', '广西', '贵州', '海南', '河北', '河南',
      '黑龙江', '湖北', '湖南', '吉林', '江苏', '江西', '辽宁', '内蒙古', '宁夏', '青海', '山东',
      '山西', '陕西', '上海', '四川', '天津', '西藏', '新疆', '云南', '浙江', '重庆'];
    const p = provinces.find((x) => t.includes(x));
    if (p) { exam_level = 'provincial'; paper_type = '历年真题'; }
  }
  return { exam_level, paper_type };
}

(async () => {
  await withConnection(async (conn) => {
    const [rows] = await conn.query("SELECT id, title FROM exam_paper WHERE origin='crawl'");
    console.log(`存量粉笔卷 ${rows.length} 张`);
    let fixed = 0;
    const ids = [];
    for (const r of rows) {
      const d = inferDims(r.title);
      if (!d.exam_level && !d.paper_type) continue;
      await conn.query(
        'UPDATE exam_paper SET exam_level = COALESCE(exam_level, ?), paper_type = COALESCE(paper_type, ?) WHERE id = ?',
        [d.exam_level, d.paper_type, r.id]);
      ids.push(r.id);
      fixed++;
    }
    // 旧标签清掉（含命名不规范的「国考模拟题」与兜底的「推荐」），autoTag 会重打
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await conn.query(
        `DELETE FROM exam_paper_category WHERE exam_paper_id IN (${ph}) AND dim IN ('exam_level','paper_type')`,
        ids);
      // 「国考模拟题」统一改成「模拟题」
      await conn.query("UPDATE exam_paper SET paper_type = '模拟题' WHERE origin='crawl' AND paper_type = '国考模拟题'");
    }
    console.log(`已修复 ${fixed} 张，并清理旧标签`);
  });
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
