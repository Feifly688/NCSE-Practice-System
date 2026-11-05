import React, { useState, useEffect } from 'react';
import { Typography, Button, Space, Tag, message, Spin, Empty, Modal } from 'antd';
import { StarFilled, EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption } from '../utils';
import Pagination from '../components/Pagination';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, SectionLabel, MetaTag } from '../components/FenbiUI';

const { Text, Paragraph } = Typography;

/** 收藏夹：与错题本保持同一套列表/详情风格，数据与交互逻辑不变。 */
export default function Favorites() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
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

  const difficultyTag = (d) => (d <= 2
    ? <MetaTag tone="success">简单</MetaTag>
    : d <= 4 ? <MetaTag tone="warning">中等</MetaTag> : <MetaTag tone="error">困难</MetaTag>);

  return (
    <FenbiScope>
      <PageHead
        title="我的收藏"
        icon={<StarFilled />}
        desc="收藏的题目可以随时回看题干、选项与解析。"
        extra={<Button icon={<EditOutlined />} onClick={() => navigate('/practice')}>去题库</Button>}
      />

      <SectionLabel title="收藏列表" extra={<span className="fb-meta">共 {total} 道</span>} />
      <Panel bodyStyle={{ padding: isMobile ? 12 : 16, paddingBottom: 4 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : items.length === 0 ? (
          <Empty description="还没有收藏题目" />
        ) : (
          items.map(item => (
            <div key={item.id} className="fb-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setPreviewItem(item)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    <MetaTag tone="primary">{item.qtype}</MetaTag>
                    {difficultyTag(item.difficulty)}
                    {(item.category_name || item.subject_name) && <MetaTag>{item.category_name || item.subject_name}</MetaTag>}
                    <MetaTag tone="warning"><StarFilled style={{ marginRight: 4 }} />已收藏</MetaTag>
                    <span className="fb-meta">正确答案 {item.answer}</span>
                  </div>
                  <div className="fb-row-title">{item.stem}</div>
                  {item.passage && (
                    <div className="fb-meta" style={{ marginTop: 6 }}>
                      {item.passage.length > 80 ? item.passage.substring(0, 80) + '...' : item.passage}
                    </div>
                  )}
                </div>
                <Button size="small" danger icon={<StarFilled />} onClick={() => removeFavorite(item.question_id)}>取消收藏</Button>
              </div>
            </div>
          ))
        )}
        <div style={{ marginTop: 8 }}><Pagination current={page} total={total} pageSize={15} onChange={setPage} /></div>
      </Panel>

      <Modal
        className="fenbi-portal"
        title="题目详情"
        open={!!previewItem}
        onCancel={() => setPreviewItem(null)}
        footer={<Button onClick={() => setPreviewItem(null)}>关闭</Button>}
        width={700}
      >
        {previewItem && (
          <div>
            <Space size={[6, 6]} wrap style={{ marginBottom: 12 }}>
              <Tag color="purple">{previewItem.qtype}</Tag>
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
