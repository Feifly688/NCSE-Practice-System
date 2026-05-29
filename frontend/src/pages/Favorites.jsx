import React, { useState, useEffect } from 'react';
import { Typography, Card, Button, Space, Tag, message, Spin, Empty, Modal, Radio } from 'antd';
import { StarFilled } from '@ant-design/icons';
import api from '../services/api';
import { parseOptions, cleanOption } from '../utils';
import Pagination from '../components/Pagination';

const { Title, Text, Paragraph } = Typography;

export default function Favorites() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [previewItem, setPreviewItem] = useState(null);

  useEffect(() => { loadFavorites(); }, [page]);

  async function loadFavorites() {
    setLoading(true);
    try {
      const r = await api.get('/practice/favorites', { params: { page, pageSize: 15 } });
      setItems(r.data.items);
      setTotal(r.data.total);
    } catch (err) { message.error('加载收藏失败'); }
    finally { setLoading(false); }
  }

  async function removeFavorite(questionId) {
    try {
      await api.delete('/practice/favorites/' + questionId);
      message.success('已取消收藏');
      loadFavorites();
    } catch (err) { message.error('操作失败'); }
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <Title level={3}><StarFilled style={{ color: '#faad14' }} /> 我的收藏</Title>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : items.length === 0 ? (
        <Empty description="还没有收藏题目" />
      ) : (
        <div>
          <Text type="secondary" style={{ marginBottom: 12, display: 'block' }}>共 {total} 道收藏题目</Text>
          {items.map(item => (
            <Card key={item.id} size="small" style={{ marginBottom: 8, borderLeft: '4px solid #faad14' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setPreviewItem(item)}>
                  <Space style={{ marginBottom: 4 }}>
                    <Tag color="purple">{item.qtype}</Tag>
                    <Tag color={item.difficulty <= 2 ? 'green' : item.difficulty <= 4 ? 'orange' : 'red'}>
                      {item.difficulty <= 2 ? '简单' : item.difficulty <= 4 ? '中等' : '困难'}
                    </Tag>
                    <Text type="secondary">正确答案：{item.answer}</Text>
                  </Space>
                  <div><Text>{item.stem}</Text></div>
                  {item.passage && <Text type="secondary" style={{ fontSize: 13 }}>{item.passage.length > 80 ? item.passage.substring(0, 80) + '...' : item.passage}</Text>}
                </div>
                <Button size="small" danger icon={<StarFilled />} onClick={() => removeFavorite(item.question_id)}>取消收藏</Button>
              </div>
            </Card>
          ))}

          <Pagination current={page} total={total} pageSize={15} onChange={setPage} />
        </div>
      )}

      <Modal title="题目详情" open={!!previewItem} onCancel={() => setPreviewItem(null)}
        footer={<Button onClick={() => setPreviewItem(null)}>关闭</Button>} width={700}>
        {previewItem && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Tag color="purple">{previewItem.qtype}</Tag>
              <Text type="secondary">正确答案：{previewItem.answer}</Text>
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
                  <div key={i} style={{ padding: '8px 12px', marginBottom: 4, borderRadius: 4, background: isCorrect ? '#f6ffed' : '#fff', border: isCorrect ? '1px solid #b7eb8f' : '1px solid #f0f0f0' }}>
                    <Text type={isCorrect ? 'success' : undefined}>{letter}. {cleanOption(opt)}{isCorrect && ' ✓'}</Text>
                  </div>
                );
              })}
            </div>
            <Card size="small" style={{ background: '#fffbe6', border: '1px solid #ffe58f' }}>
              <Paragraph style={{ margin: 0 }}><Text strong>解析：</Text>{previewItem.explanation}</Paragraph>
            </Card>
          </div>
        )}
      </Modal>
    </div>
  );
}