import React, { useState, useEffect } from 'react';
import { Typography, Row, Col, Button, Space, Tag, message, Spin, Empty, Modal, Radio, Switch, Popconfirm } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, BookOutlined, StarFilled, StarOutlined, ExportOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption } from '../utils';
import Pagination from '../components/Pagination';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, SectionLabel, StatTile, MetaTag } from '../components/FenbiUI';

const { Text, Paragraph } = Typography;

/** 错题本（与收藏夹统一的粉笔式列表）。筛选、导出、重做、掌握状态逻辑保持原样。 */
export default function WrongBook() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState(null);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('0'); // 0=未掌握, 1=已掌握, ''=全部
  const [previewItem, setPreviewItem] = useState(null);
  const [autoRemove, setAutoRemove] = useState(() => localStorage.getItem('wrongbook_auto_remove') === 'true');

  useEffect(() => { loadWrongBook(); }, [page, filter]);
  useEffect(() => { localStorage.setItem('wrongbook_auto_remove', String(autoRemove)); }, [autoRemove]);

  async function loadWrongBook() {
    setLoading(true);
    try {
      const params = { page, pageSize: 15 };
      if (filter !== '') params.mastered = filter;
      const r = await api.get('/practice/wrong-book', { params });
      setItems(r.data.items);
      setTotal(r.data.total);
      setStats(r.data.stats);
    } catch (err) { message.error('加载错题本失败'); }
    finally { setLoading(false); }
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
      const r = await api.post('/practice/wrong-book/redo', { count: 10 });
      if (r.data.questions.length === 0) {
        message.info('没有需要重做的错题');
        return;
      }
      const subjectId = r.data.questions[0].subject_id || 1;
      const startRes = await api.post('/practice/start', { subject_id: subjectId, questions: r.data.questions });
      navigate('/practice?session=' + startRes.data.session_id + '&wrongredo=true');
    } catch (err) { message.error('开始重做失败'); }
  }

  // HTML 转义，防止 XSS
  function esc(str) {
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
    html += '<h1>错题本</h1><p class="no-print"><button onclick="window.print()">打印</button></p>';
    items.forEach((item, idx) => {
      const opts = parseOptions(item.options_json);
      html += '<div class="q">';
      html += '<div class="stem">' + (idx + 1) + '. [' + esc(item.qtype) + '] ' + (item.passage ? '<p style="color:#666;font-weight:normal;margin:4px 0">' + esc(item.passage) + '</p>' : '') + esc(item.stem) + '</div>';
      html += '<div class="opts">';
      opts.forEach((opt, i) => {
        const letter = options[i] || String.fromCharCode(65 + i);
        const isCorrect = letter === item.answer;
        html += '<div class="opt' + (isCorrect ? ' correct' : '') + '">' + letter + '. ' + esc(cleanOption(opt)) + (isCorrect ? ' ✓' : '') + '</div>';
      });
      html += '</div>';
      html += '<div class="explain"><strong>解析：</strong>' + esc(item.explanation) + '</div>';
      html += '</div>';
    });
    html += '</body></html>';
    const w = window.open('', '_blank');
    if (!w) { message.error('弹窗被浏览器拦截，请允许弹窗后重试'); return; }
    w.document.write(html);
    w.document.close();
  }

  const difficultyTag = (d) => (d <= 2
    ? <MetaTag tone="success">简单</MetaTag>
    : d <= 4 ? <MetaTag tone="warning">中等</MetaTag> : <MetaTag tone="error">困难</MetaTag>);

  return (
    <FenbiScope>
      <PageHead
        title="错题本"
        icon={<BookOutlined />}
        desc="集中回顾做错的题目，标记掌握状态后可自动移出。"
        extra={
          <>
            <Button icon={<ExportOutlined />} onClick={exportWrongBook}>导出</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={startRedo}>重做错题</Button>
          </>
        }
      />

      {stats && stats.byType && stats.byType.length > 0 && (
        <Panel title="涉及题型" style={{ marginBottom: 16 }} bodyStyle={{ padding: isMobile ? 14 : 18 }}>
          <Space size={[8, 8]} wrap>
            {stats.byType.map(t => <MetaTag key={t.qtype}>{t.qtype}</MetaTag>)}
          </Space>
        </Panel>
      )}

      <Panel bodyStyle={{ padding: isMobile ? 12 : 16, paddingBottom: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <Radio.Group value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}>
            <Radio.Button value="0">未掌握</Radio.Button>
            <Radio.Button value="1">已掌握</Radio.Button>
            <Radio.Button value="">全部</Radio.Button>
          </Radio.Group>
          <Space size={6}>
            <SettingOutlined style={{ color: F.textWeak }} />
            <Text type="secondary" style={{ fontSize: 13 }}>答对自动移出</Text>
            <Switch size="small" checked={autoRemove} onChange={setAutoRemove} />
          </Space>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : items.length === 0 ? (
          <Empty description={filter === '0' ? '没有未掌握的错题，继续保持！' : '暂无错题'} />
        ) : (
          items.map((item) => (
            <div key={item.id} className="fb-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div
                  style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => setPreviewItem(item)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    <MetaTag tone="primary">{item.qtype}</MetaTag>
                    {difficultyTag(item.difficulty)}
                    {(item.category_name || item.subject_name) && <MetaTag>{item.category_name || item.subject_name}</MetaTag>}
                    <MetaTag tone={item.mastered ? 'success' : 'error'}>{item.mastered ? '已掌握' : '未掌握'}</MetaTag>
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
              <Tag color="purple">{previewItem.qtype}</Tag>
              <Tag color={previewItem.difficulty <= 2 ? 'green' : previewItem.difficulty <= 4 ? 'orange' : 'red'}>
                {previewItem.difficulty <= 2 ? '简单' : previewItem.difficulty <= 4 ? '中等' : '困难'}
              </Tag>
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

            <div style={{ marginTop: 12 }}><Text type="secondary">你上次的答案：{previewItem.last_wrong_answer}</Text></div>
          </div>
        )}
      </Modal>
    </FenbiScope>
  );
}
