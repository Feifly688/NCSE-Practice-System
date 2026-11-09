import React, { useState, useEffect } from 'react';
import { Typography, Button, Space, Tag, message, Spin, Empty, Modal, Radio, Switch, Popconfirm, Select, Segmented, Badge } from 'antd';
import { ReloadOutlined, BookOutlined, StarFilled, StarOutlined, ExportOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption } from '../utils';
import Pagination from '../components/Pagination';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, MetaTag } from '../components/FenbiUI';

const { Text, Paragraph } = Typography;

// 错因标签：value 与后端 wrong_book.reason_tag 一致；NULL / '' 表示「未标注」。
const REASON_TAGS = [
  { value: 'concept', label: '概念不清' },
  { value: 'calculation', label: '计算失误' },
  { value: 'reading', label: '审题不清' },
  { value: 'time', label: '时间不够' },
  { value: 'other', label: '其他' },
];
const REASON_LABEL = REASON_TAGS.reduce((acc, r) => { acc[r.value] = r.label; return acc; }, {});
// 每道题的点选控件：未标注用 '' 承载，提交时转成 null（清除）。
const REASON_EDIT_OPTIONS = [{ value: '', label: '未标注' }, ...REASON_TAGS];
// 顶部筛选：unlabeled 是后端约定的「reason_tag IS NULL」查询值，与编辑用的 '' 区分开。
const REASON_FILTER_OPTIONS = [
  { value: '', label: '全部错因' },
  ...REASON_TAGS,
  { value: 'unlabeled', label: '未标注' },
];
// 错次分档复用 wrong_count：>=3 高频 / 2 中频 / 1 低频。
// FenbiScope 会把 antd 的 blue/orange 覆写成品牌橙，故用 red/gold/green 保持三色可区分。
const FREQ_BANDS = {
  high: { label: '高频', color: 'red' },
  mid: { label: '中频', color: 'gold' },
  low: { label: '低频', color: 'green' },
};
const FREQ_FILTER_OPTIONS = [
  { value: '', label: '全部频次' },
  { value: 'high', label: '高频（≥3 次）' },
  { value: 'mid', label: '中频（2 次）' },
  { value: 'low', label: '低频（1 次）' },
];
function freqOf(count) {
  const n = Number(count) || 0;
  if (n >= 3) return 'high';
  if (n === 2) return 'mid';
  return 'low'; // 1 次及异常兜底都归低频
}
function reasonLabel(tag) {
  return REASON_LABEL[tag] || '未标注';
}
// 复习等级：优先用后端下发的 review_level，未下发时按 wrong_count 兜底（与错次分档同口径）。
function reviewLevelOf(item) {
  return FREQ_BANDS[item.review_level] || FREQ_BANDS[freqOf(item.wrong_count)];
}
// 下次复习日期：为空显示「待复习」；DATETIME / ISO 串统一截成 MM-DD。
function reviewDateLabel(v) {
  if (!v) return '待复习';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : '待复习';
}

/** 让可点击的非按钮元素支持键盘激活：Enter / Space 触发同一逻辑，Space 阻止页面滚动；
 *  事件来自内部表单控件/按钮时不接管，避免破坏其原生键盘交互。 */
function activateOnKey(e, action) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    action();
  }
}

/**
 * 错题本（粉笔式列表，按一级模块分类存放）。
 * - 模块导航来自 /practice/wrong-book 返回的 modules，选中后列表与重做都限定在该模块
 * - 默认开启「答对自动移出」：只有显式关闭才在 localStorage 存 'false'
 * - 重做走 /practice/do?session=...&wrongredo=true（答题页），旧版误跳 /practice 导致功能不可用
 */
export default function WrongBook() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState(null);
  const [modules, setModules] = useState([]);
  const [moduleId, setModuleId] = useState(''); // '' = 全部模块；'0' = 未分类；其余为一级分类 id
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('0'); // 0=未掌握, 1=已掌握, ''=全部
  const [reasonFilter, setReasonFilter] = useState(''); // ''=全部；5 类错因值或 'unlabeled'
  const [freqFilter, setFreqFilter] = useState(''); // ''=全部；high/mid/low
  const [review, setReview] = useState('due'); // 默认「今日待复习」；'all' = 全部错题
  const [dueCount, setDueCount] = useState(0); // 当前筛选下到期错题数（徽标）
  const [savingReasonId, setSavingReasonId] = useState(null); // 正在保存错因的错题 id，禁用控件防重复提交
  const [previewItem, setPreviewItem] = useState(null);
  const [autoRemove, setAutoRemove] = useState(() => localStorage.getItem('wrongbook_auto_remove') !== 'false');

  useEffect(() => { loadWrongBook(); }, [page, filter, moduleId, reasonFilter, freqFilter, review]);
  useEffect(() => { localStorage.setItem('wrongbook_auto_remove', String(autoRemove)); }, [autoRemove]);

  const activeModule = modules.find(m => String(m.module_id) === String(moduleId));

  async function loadWrongBook() {
    setLoading(true);
    try {
      const params = { page, pageSize: 15, withModules: '1', review };
      if (filter !== '') params.mastered = filter;
      if (moduleId !== '') params.categoryId = moduleId;
      if (reasonFilter !== '') params.reason = reasonFilter;
      if (freqFilter !== '') params.freq = freqFilter;
      const r = await api.get('/practice/wrong-book', { params });
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
      setStats(r.data.stats || null);
      setModules(r.data.modules || []);
      setDueCount(Number(r.data.dueCount) || 0);
    } catch (err) { message.error('加载错题本失败'); }
    finally { setLoading(false); }
  }

  // 点选错因：只局部更新对应题目的 reason_tag，不整页刷新，保留当前筛选与滚动位置。
  async function updateReason(item, value) {
    if (savingReasonId === item.id) return;
    const reason = value === '' ? null : value; // 未标注 -> null（清除）
    setSavingReasonId(item.id);
    try {
      await api.put('/practice/wrong-book/by-question/' + item.question_id + '/reason', { reason });
      setItems(prev => prev.map(x => (x.id === item.id ? { ...x, reason_tag: reason } : x)));
      setPreviewItem(prev => (prev && prev.id === item.id ? { ...prev, reason_tag: reason } : prev));
      message.success('错因已更新');
    } catch (err) {
      message.error('错因更新失败');
    } finally {
      setSavingReasonId(null);
    }
  }

  async function toggleMastered(item) {
    try {
      await api.put('/practice/wrong-book/' + item.id + '/mastered', { mastered: !item.mastered });
      message.success(item.mastered ? '已标为未掌握' : '已标为已掌握');
      loadWrongBook();
    } catch (err) { message.error('操作失败'); }
  }

  async function removeWrongItem(item) {
    try {
      await api.delete('/practice/wrong-book/' + item.id);
      message.success('已移出错题本');
      loadWrongBook();
    } catch (err) { message.error('移出失败'); }
  }

  async function startRedo() {
    try {
      const payload = { count: 10, review };
      if (moduleId !== '') payload.categoryId = moduleId;
      const r = await api.post('/practice/wrong-book/redo', payload);
      const questions = r.data.questions || [];
      if (questions.length === 0) {
        message.info(moduleId === '' ? '没有需要重做的错题' : '该模块下没有需要重做的错题');
        return;
      }
      const subjectId = questions[0].subject_id || 1;
      const startRes = await api.post('/practice/start', {
        subject_id: subjectId,
        questions,
        practice: { kind: 'redo', count: questions.length },
      });
      // 答题页路由是 /practice/do；跳 /practice 只会停在题库页，重做永远打不开
      navigate('/practice/do?session=' + startRes.data.session_id + '&wrongredo=true');
    } catch (err) { message.error('开始重做失败'); }
  }

  // HTML 转义，防止 XSS（& < > " ' 全部转义）
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function exportWrongBook() {
    if (items.length === 0) { message.info('暂无错题可导出'); return; }
    const options = ['A', 'B', 'C', 'D'];
    let html = '<html><head><meta charset="utf-8"><title>错题本导出</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px}h1{font-size:22px}.q{margin-bottom:24px;padding:16px;border:1px solid #eee;border-radius:8px}.stem{font-weight:bold;margin-bottom:8px}.opts{margin:8px 0}.opt{padding:4px 0}.correct{color:#35b879;font-weight:bold}.explain{margin-top:8px;padding:8px;background:#f0faf4;border-radius:4px;font-size:13px}@media print{.no-print{display:none}}</style></head><body>';
    html += '<h1>错题本' + (activeModule ? ' · ' + escapeHtml(activeModule.module_name) : '') + '</h1><p class="no-print" id="print-bar"></p>';
    items.forEach((item, idx) => {
      const opts = parseOptions(item.options_json);
      html += '<div class="q">';
      html += '<div class="stem">' + (idx + 1) + '. [' + escapeHtml(item.qtype) + '] ' + (item.module_name ? '[' + escapeHtml(item.module_name) + '] ' : '') + (item.passage ? '<p style="color:#666;font-weight:normal;margin:4px 0">' + escapeHtml(item.passage) + '</p>' : '') + escapeHtml(item.stem) + '</div>';
      html += '<div class="opts">';
      opts.forEach((opt, i) => {
        const letter = options[i] || String.fromCharCode(65 + i);
        const isCorrect = letter === item.answer;
        html += '<div class="opt' + (isCorrect ? ' correct' : '') + '">' + letter + '. ' + escapeHtml(cleanOption(opt)) + (isCorrect ? ' ✓' : '') + '</div>';
      });
      html += '</div>';
      html += '<div class="explain"><strong>解析：</strong>' + escapeHtml(item.explanation) + '</div>';
      html += '</div>';
    });
    html += '</body></html>';
    const w = window.open('', '_blank');
    if (!w) { message.error('弹窗被浏览器拦截，请允许弹窗后重试'); return; }
    w.document.write(html);
    w.document.close();
    // 打印按钮改用 DOM API 构建并绑定事件，避免在 HTML 字符串里写内联 onclick
    const bar = w.document.getElementById('print-bar');
    if (bar) {
      const btn = w.document.createElement('button');
      btn.type = 'button';
      btn.textContent = '打印';
      btn.addEventListener('click', () => w.print());
      bar.appendChild(btn);
    }
  }

  const difficultyTag = (d) => (d <= 2
    ? <MetaTag tone="success">简单</MetaTag>
    : d <= 4 ? <MetaTag tone="warning">中等</MetaTag> : <MetaTag tone="error">困难</MetaTag>);

  const moduleTabs = [{ module_id: '', module_name: '全部模块' }, ...modules];

  return (
    <FenbiScope>
      <PageHead
        title="错题本"
        icon={<BookOutlined />}
        desc="按模块分类回顾错题，可只重做某个模块；重做时答对默认自动移出。"
        extra={
          <>
            <Button icon={<ExportOutlined />} onClick={exportWrongBook}>导出</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={startRedo}>
              {moduleId === '' ? '重做全部错题' : `重做「${activeModule?.module_name || '所选模块'}」错题`}
            </Button>
          </>
        }
      />

      {/* 按模块分类存放：一级模块导航，选中后列表与重做都限定在该模块 */}
      <Panel title="按模块分类" style={{ marginBottom: 12 }} bodyStyle={{ padding: isMobile ? 12 : 16 }}>
        <div className="hide-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
          {moduleTabs.map(m => {
            const on = String(m.module_id) === String(moduleId);
            return (
              <button
                key={String(m.module_id)}
                type="button"
                onClick={() => { setModuleId(m.module_id === '' ? '' : String(m.module_id)); setPage(1); }}
                style={{
                  flexShrink: 0, cursor: 'pointer', padding: '7px 14px', borderRadius: 6, fontSize: 13,
                  border: `1px solid ${on ? F.primary : F.border}`,
                  background: on ? F.primaryLight : F.cardBg,
                  color: on ? F.primary : F.textSub,
                  fontWeight: on ? 600 : 400,
                }}
              >
                {m.module_name}
              </button>
            );
          })}
        </div>
      </Panel>

      {stats && stats.byType && stats.byType.length > 0 && (
        <Panel title="涉及题型" style={{ marginBottom: 16 }} bodyStyle={{ padding: isMobile ? 14 : 18 }}>
          <Space size={[8, 8]} wrap>
            {stats.byType.map(t => <MetaTag key={t.qtype}>{t.qtype}</MetaTag>)}
          </Space>
        </Panel>
      )}

      <Panel bodyStyle={{ padding: isMobile ? 12 : 16, paddingBottom: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <Space size={8} wrap>
            <Segmented
              value={review}
              onChange={v => { setReview(v); setPage(1); }}
              options={[
                { label: <span>今日待复习 <Badge count={dueCount} showZero color={F.primary} overflowCount={999} style={{ marginLeft: 2 }} /></span>, value: 'due' },
                { label: '全部错题', value: 'all' },
              ]}
            />
            <Radio.Group value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}>
              <Radio.Button value="0">未掌握</Radio.Button>
              <Radio.Button value="1">已掌握</Radio.Button>
              <Radio.Button value="">全部</Radio.Button>
            </Radio.Group>
            <Text type="secondary" style={{ fontSize: 13 }}>错因</Text>
            <Select
              value={reasonFilter}
              onChange={v => { setReasonFilter(v); setPage(1); }}
              options={REASON_FILTER_OPTIONS}
              style={{ width: 128 }}
              aria-label="按错因筛选"
            />
            <Text type="secondary" style={{ fontSize: 13 }}>频次</Text>
            <Select
              value={freqFilter}
              onChange={v => { setFreqFilter(v); setPage(1); }}
              options={FREQ_FILTER_OPTIONS}
              style={{ width: 146 }}
              aria-label="按错次频次筛选"
            />
          </Space>
          <Space size={6}>
            <SettingOutlined style={{ color: F.textWeak }} />
            <Text type="secondary" style={{ fontSize: 13 }}>答对自动移出</Text>
            <Switch size="small" checked={autoRemove} onChange={setAutoRemove} />
          </Space>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : items.length === 0 ? (
          <Empty description={review === 'due' ? '今日暂无待复习错题' : (moduleId !== '' ? '该模块下暂无错题' : (filter === '0' ? '没有未掌握的错题，继续保持！' : '暂无错题'))} />
        ) : (
          items.map((item) => (
            <div key={item.id} className="fb-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`查看错题详情：${item.stem}`}
                  style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => setPreviewItem(item)}
                  onKeyDown={(e) => activateOnKey(e, () => setPreviewItem(item))}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {item.module_name && <MetaTag tone="primary">{item.module_name}</MetaTag>}
                    <MetaTag>{item.qtype}</MetaTag>
                    {difficultyTag(item.difficulty)}
                    <MetaTag tone={item.mastered ? 'success' : 'error'}>{item.mastered ? '已掌握' : '未掌握'}</MetaTag>
                    <Tag color={FREQ_BANDS[freqOf(item.wrong_count)].color}>
                      {FREQ_BANDS[freqOf(item.wrong_count)].label} · 错 {Number(item.wrong_count) || 1} 次
                    </Tag>
                    <Tag color={reviewLevelOf(item).color}>复习 {reviewLevelOf(item).label}</Tag>
                    <MetaTag tone={item.due ? 'warning' : 'neutral'}>下次 {reviewDateLabel(item.next_review_at)}</MetaTag>
                    {/* 错因：只读标签展示 + 点选修改控件；阻止冒泡，避免点控件误开详情弹窗 */}
                    <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <MetaTag tone={item.reason_tag ? 'primary' : 'neutral'}>错因：{reasonLabel(item.reason_tag)}</MetaTag>
                      <Select
                        size="small"
                        value={item.reason_tag || ''}
                        onChange={v => updateReason(item, v)}
                        options={REASON_EDIT_OPTIONS}
                        disabled={savingReasonId === item.id}
                        style={{ width: 112 }}
                        aria-label="修改错因"
                      />
                    </span>
                    <span className="fb-meta">正确答案 {item.answer}</span>
                  </div>
                  <div className="fb-row-title">{item.stem}</div>
                  {item.passage && (
                    <div className="fb-meta" style={{ marginTop: 6 }}>
                      {item.passage.length > 80 ? item.passage.substring(0, 80) + '...' : item.passage}
                    </div>
                  )}
                </div>
                <Space size={8} wrap>
                  <Popconfirm title="确定将此题移出错题本？" onConfirm={() => removeWrongItem(item)} okText="确定" cancelText="取消">
                    <Button size="small" danger icon={<DeleteOutlined />}>移出</Button>
                  </Popconfirm>
                  <Button
                    size="small"
                    type={item.mastered ? 'default' : 'primary'}
                    icon={item.mastered ? <StarFilled /> : <StarOutlined />}
                    onClick={() => toggleMastered(item)}
                  >
                    {item.mastered ? '已掌握' : '标为掌握'}
                  </Button>
                </Space>
              </div>
            </div>
          ))
        )}
        <div style={{ marginTop: 8 }}><Pagination current={page} total={total} pageSize={15} onChange={setPage} /></div>
      </Panel>

      {/* 详情弹窗 */}
      <Modal
        className="fenbi-portal"
        title="错题详情"
        open={!!previewItem}
        onCancel={() => setPreviewItem(null)}
        footer={<Button onClick={() => setPreviewItem(null)}>关闭</Button>}
        width={700}
      >
        {previewItem && (
          <div>
            <Space size={[6, 6]} wrap style={{ marginBottom: 12 }}>
              {previewItem.module_name && <MetaTag tone="primary">{previewItem.module_name}</MetaTag>}
              <Tag color="purple">{previewItem.qtype}</Tag>
              <Tag color={previewItem.difficulty <= 2 ? 'green' : previewItem.difficulty <= 4 ? 'orange' : 'red'}>
                {previewItem.difficulty <= 2 ? '简单' : previewItem.difficulty <= 4 ? '中等' : '困难'}
              </Tag>
              <Tag color={FREQ_BANDS[freqOf(previewItem.wrong_count)].color}>
                {FREQ_BANDS[freqOf(previewItem.wrong_count)].label} · 错 {Number(previewItem.wrong_count) || 1} 次
              </Tag>
              <Tag color={reviewLevelOf(previewItem).color}>复习 {reviewLevelOf(previewItem).label}</Tag>
              <MetaTag tone={previewItem.due ? 'warning' : 'neutral'}>下次 {reviewDateLabel(previewItem.next_review_at)}</MetaTag>
              <MetaTag tone={previewItem.reason_tag ? 'primary' : 'neutral'}>错因：{reasonLabel(previewItem.reason_tag)}</MetaTag>
              <Text type="secondary">正确答案：{previewItem.answer}</Text>
            </Space>

            {previewItem.passage && (
              <div style={{ marginBottom: 12, padding: 12, background: '#F7F8FA', borderRadius: 8 }}>
                <Paragraph style={{ margin: 0 }}>{previewItem.passage}</Paragraph>
              </div>
            )}

            <div style={{ fontSize: 16, lineHeight: 1.8, fontWeight: 600, marginBottom: 14 }}>{previewItem.stem}</div>

            <div style={{ marginBottom: 14 }}>
              {parseOptions(previewItem.options_json).map((opt, i) => {
                const letter = String.fromCharCode(65 + i);
                const isCorrect = letter === previewItem.answer;
                return (
                  <div key={i} style={{
                    padding: '9px 12px', marginBottom: 8, borderRadius: 6,
                    background: isCorrect ? '#F0FAF4' : '#FFFFFF',
                    border: isCorrect ? '1px solid #B5E5CC' : `1px solid ${F.border}`,
                    color: isCorrect ? F.success : F.text,
                    lineHeight: 1.7,
                  }}>
                    {letter}. {cleanOption(opt)}{isCorrect && ' ✓'}
                  </div>
                );
              })}
            </div>

            <div style={{ padding: 14, background: F.primaryLight, border: `1px solid ${F.selectedBorder}`, borderRadius: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: F.text }}>题目解析</div>
              <Paragraph style={{ margin: 0, lineHeight: 1.8 }}>{previewItem.explanation || '暂无解析'}</Paragraph>
            </div>
          </div>
        )}
      </Modal>
    </FenbiScope>
  );
}
