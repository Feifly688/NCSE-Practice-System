import React, { useState, useEffect } from 'react';
import { Typography, Card, Button, Space, Tag, message, Spin, Empty, Modal, Radio, Divider, Switch, Popconfirm } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, BookOutlined, StarFilled, StarOutlined, ExportOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption } from '../utils';

const { Title, Text, Paragraph } = Typography;

export default function WrongBook() {
  const navigate = useNavigate();
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
      // 按题型统计已在 stats.byType 中
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
      // 创建答题会话（取第一道题的科目）
      const subjectId = r.data.questions[0].subject_id || 1;
      const startRes = await api.post('/practice/start', { subject_id: subjectId, questions: r.data.questions });
      navigate('/practice?session=' + startRes.data.session_id + '&wrongredo=true');
    } catch (err) { message.error('开始重做失败'); }
  }

  function exportWrongBook() {
    if (items.length === 0) { message.info('暂无错题可导出'); return; }
    const options = ['A', 'B', 'C', 'D'];
    let html = '<html><head><meta charset="utf-8"><title>错题本导出</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px}h1{font-size:22px}.q{margin-bottom:24px;padding:16px;border:1px solid #e8e8e8;border-radius:8px}.stem{font-weight:bold;margin-bottom:8px}.opts{margin:8px 0}.opt{padding:4px 0}.correct{color:green;font-weight:bold}.explain{margin-top:8px;padding:8px;background:#f6ffed;border-radius:4px;font-size:13px}@media print{.no-print{display:none}}</style></head><body>';
    html += '<h1>错题本</h1><p class="no-print"><button onclick="window.print()">打印</button></p>';
    items.forEach((item, idx) => {
      const opts = parseOptions(item.options_json);
      html += '<div class="q">';
      html += '<div class="stem">' + (idx + 1) + '. [' + item.qtype + '] ' + (item.passage ? '<p style="color:#666;font-weight:normal;margin:4px 0">' + item.passage + '</p>' : '') + item.stem + '</div>';
      html += '<div class="opts">';
      opts.forEach((opt, i) => {
        const letter = options[i] || String.fromCharCode(65 + i);
        const isCorrect = letter === item.answer;
        html += '<div class="opt' + (isCorrect ? ' correct' : '') + '">' + letter + '. ' + cleanOption(opt) + (isCorrect ? ' ✓' : '') + '</div>';
      });
      html += '</div>';
      html += '<div class="explain"><strong>解析：</strong>' + item.explanation + '</div>';
      html += '</div>';
    });
    html += '</body></html>';
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}><BookOutlined /> 错题本</Title>
        <Space>
          <Button icon={<ExportOutlined />} onClick={exportWrongBook}>导出</Button>
          <Button type="primary" icon={<ReloadOutlined />} onClick={startRedo}>重做错题</Button>
        </Space>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <Space size="middle" style={{ marginBottom: 16 }}>
          <Tag color="red" style={{ fontSize: 14, padding: '4px 12px' }}>未掌握 {stats.active || 0}</Tag>
          <Tag color="green" style={{ fontSize: 14, padding: '4px 12px' }}>已掌握 {stats.mastered || 0}</Tag>
          <Tag color="orange" style={{ fontSize: 14, padding: '4px 12px' }}>累计错 {stats.total_wrongs || 0} 次</Tag>
        </Space>
      )}

      {/* 按题型统计 */}
      {stats && stats.byType && stats.byType.length > 0 && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Text strong style={{ marginBottom: 8, display: 'block' }}>按题型错误分布</Text>
          <Space wrap>
            {stats.byType.map(t => (
              <Tag key={t.qtype} color="orange">{t.qtype}：错 {t.count} 次</Tag>
            ))}
          </Space>
        </Card>
      )}

      {/* 筛选 & 设置 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Radio.Group value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}>
          <Radio.Button value="0">未掌握</Radio.Button>
          <Radio.Button value="1">已掌握</Radio.Button>
          <Radio.Button value="">全部</Radio.Button>
        </Radio.Group>
        <Space>
          <SettingOutlined />
          <Text type="secondary">答对自动移出：</Text>
          <Switch size="small" checked={autoRemove} onChange={setAutoRemove} />
        </Space>
      </div>

      {/* 列表 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : items.length === 0 ? (
        <Empty description={filter === '0' ? '没有未掌握的错题，继续保持！' : '暂无错题'} />
      ) : (
        <div>
          {items.map((item, idx) => (
            <Card key={item.id} size="small" style={{ marginBottom: 8, borderLeft: '4px solid ' + (item.mastered ? '#52c41a' : '#ff4d4f') }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setPreviewItem(item)}>
                  <Space style={{ marginBottom: 4 }}>
                    <Tag color="purple">{item.qtype}</Tag>
                    <Tag color={item.difficulty <= 2 ? 'green' : item.difficulty <= 4 ? 'orange' : 'red'}>
                      {item.difficulty <= 2 ? '简单' : item.difficulty <= 4 ? '中等' : '困难'}
                    </Tag>
                    <Text type="secondary">错 {item.wrong_count} 次</Text>
                    <Text type="secondary"> | 正确答案：{item.answer}</Text>
                  </Space>
                  <div style={{ marginBottom: 4 }}>
                    <Text>{item.stem}</Text>
                  </div>
                  {item.passage && (
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      {item.passage.length > 80 ? item.passage.substring(0, 80) + '...' : item.passage}
                    </Text>
                  )}
                </div>
                <Space>
                  <Popconfirm title="确定将此题移出错题本？" onConfirm={() => removeWrongItem(item)} okText="确定" cancelText="取消">
                    <Button size="small" danger icon={<DeleteOutlined />}>移出</Button>
                  </Popconfirm>
                  <Button size="small" type={item.mastered ? 'default' : 'primary'}
                    icon={item.mastered ? <StarFilled style={{ color: '#52c41a' }} /> : <StarOutlined />}
                    onClick={() => toggleMastered(item)}>
                    {item.mastered ? '已掌握' : '标为掌握'}
                  </Button>
                </Space>
              </div>
            </Card>
          ))}

          {total > 15 && (
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <Space>
                <Button size="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
                <Text type="secondary">第 {page} 页 / 共 {Math.ceil(total / 15)} 页</Text>
                <Button size="small" disabled={page * 15 >= total} onClick={() => setPage(page + 1)}>下一页</Button>
              </Space>
            </div>
          )}
        </div>
      )}

      {/* 详情弹窗 */}
      <Modal title="错题详情" open={!!previewItem} onCancel={() => setPreviewItem(null)}
        footer={<Button onClick={() => setPreviewItem(null)}>关闭</Button>} width={700}>
        {previewItem && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Tag color="purple">{previewItem.qtype}</Tag>
              <Tag color={previewItem.difficulty <= 2 ? 'green' : previewItem.difficulty <= 4 ? 'orange' : 'red'}>
                {previewItem.difficulty <= 2 ? '简单' : previewItem.difficulty <= 4 ? '中等' : '困难'}
              </Tag>
              <Text type="secondary">错误次数：{previewItem.wrong_count}</Text>
              <Text type="secondary"> | 正确答案：{previewItem.answer}</Text>
            </Space>

            {previewItem.passage && (
              <Card size="small" style={{ marginBottom: 12, background: '#f6f6f6' }}>
                <Paragraph style={{ margin: 0 }}>{previewItem.passage}</Paragraph>
              </Card>
            )}

            <Card size="small" style={{ marginBottom: 12 }}>
              <Text strong>{previewItem.stem}</Text>
            </Card>

            <div style={{ marginBottom: 12 }}>
              {parseOptions(previewItem.options_json).map((opt, i) => {
                const letter = String.fromCharCode(65 + i);
                const isCorrect = letter === previewItem.answer;
                return (
                  <div key={i} style={{
                    padding: '8px 12px', marginBottom: 4, borderRadius: 4,
                    background: isCorrect ? '#f6ffed' : '#fff',
                    border: isCorrect ? '1px solid #b7eb8f' : '1px solid #f0f0f0'
                  }}>
                    <Text type={isCorrect ? 'success' : undefined}>
                      {letter}. {cleanOption(opt)}{isCorrect && ' ✓'}
                    </Text>
                  </div>
                );
              })}
            </div>

            <Card size="small" style={{ background: '#fffbe6', border: '1px solid #ffe58f' }}>
              <Paragraph style={{ margin: 0 }}><Text strong>解析：</Text>{previewItem.explanation}</Paragraph>
            </Card>

            <div style={{ marginTop: 12 }}>
              <Text type="secondary">你上次的答案：{previewItem.last_wrong_answer}</Text>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}