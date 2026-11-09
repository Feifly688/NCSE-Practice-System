/**
 * 练习记录命名（参照粉笔「练习历史」）。
 *
 * 粉笔的每条记录是「练习类型 + 内容范围」的名称，配时间、成绩、正确率展示，
 * 不展示自增编号。本模块把命名规则集中在服务端，/practice/history 直接下发
 * title，历史页与题库页历史卡片共用同一口径；老数据按科目 + 题量降级，
 * 任何情况下都不再暴露 practice_session.id。
 */
'use strict';

const KIND_LABEL = {
  quick: '快速练习',
  special: '专项练习',
  custom: '自定义练习',
  weak: '薄弱点专练',
  ai: 'AI 生成题',
  redo: '错题重做',
};

const YEAR_LABEL = { near3: '近3年', near5: '近5年', near10: '近10年' };
const SOURCE_LABEL = { national: '国考', local: '地方' };
const VALID_KINDS = Object.keys(KIND_LABEL);

function safeText(v, max = 40) {
  if (typeof v !== 'string') return '';
  // 去掉控制字符与尖括号：title 虽由 React 文本节点渲染，仍避免脏数据流入展示层
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

/** meta_json 可能是对象（mysql2 自动解析）、JSON 字符串或空值 */
function parseSessionMeta(v) {
  if (!v) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}

/** 清洗 /practice/start 传来的练习配置：只保留白名单字段，防注入与超长存储 */
function normalizePractice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!VALID_KINDS.includes(raw.kind)) return null;
  const n = Number(raw.count);
  return {
    kind: raw.kind,
    count: Number.isFinite(n) ? Math.max(0, Math.min(200, Math.floor(n))) : 0,
    categoryName: safeText(raw.categoryName, 40),
    subjectName: safeText(raw.subjectName, 40),
    yearMode: Object.prototype.hasOwnProperty.call(YEAR_LABEL, raw.yearMode) ? raw.yearMode : '',
    sourceType: Object.prototype.hasOwnProperty.call(SOURCE_LABEL, raw.sourceType) ? raw.sourceType : '',
  };
}

/** 由一行 practice_session（含 subject_name）生成展示名称 */
function buildSessionTitle(row) {
  const meta = parseSessionMeta(row && row.meta_json);
  const count = Number(row && row.total) || Number(meta.practice && meta.practice.count) || 0;

  // 整卷：优先用落库时的卷名（真题卷名 / 智能组卷名），不再回退到编号
  if (row && (row.mode === 'exam_paper' || meta.exam)) {
    return safeText(meta.paper_title, 80) || `整卷练习 · ${count}题`;
  }

  // 兼容早期可能手写过 title 的记录
  if (typeof meta.title === 'string' && meta.title.trim()) return safeText(meta.title, 80);

  const p = meta.practice;
  if (p && KIND_LABEL[p.kind]) {
    const parts = [KIND_LABEL[p.kind]];
    if (p.kind === 'special' && p.categoryName) parts.push(p.categoryName);
    if (p.kind === 'ai' && p.subjectName) parts.push(p.subjectName);
    if (p.kind === 'custom') {
      if (YEAR_LABEL[p.yearMode]) parts.push(YEAR_LABEL[p.yearMode]);
      if (SOURCE_LABEL[p.sourceType]) parts.push(SOURCE_LABEL[p.sourceType]);
    }
    parts.push(`${count}题`);
    return parts.join(' · ');
  }

  // 老数据（迁移前创建的会话没有 practice）：按科目 + 题量命名
  const subject = safeText(row && row.subject_name, 20);
  return `${subject ? subject + '练习' : '综合练习'} · ${count}题`;
}

module.exports = { normalizePractice, buildSessionTitle, parseSessionMeta, KIND_LABEL };
