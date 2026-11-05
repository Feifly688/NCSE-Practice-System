import React, { useState, useEffect } from 'react';
import { Table, Spin, message, Row, Col } from 'antd';
import { TrophyOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, SectionLabel, MetaTag } from '../components/FenbiUI';

/** 成绩排行榜：前三名概览 + 完整榜单，排序与「我」的高亮逻辑保持原样。 */
export default function Leaderboard() {
  const { user } = useAuth();
  const { isMobile } = useResponsive();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadLeaderboard(); }, []);

  async function loadLeaderboard() {
    try {
      const r = await api.get('/practice/leaderboard');
      setData(r.data.leaderboard);
    } catch (err) {
      message.error('加载排行榜失败');
    } finally {
      setLoading(false);
    }
  }

  const rankMeta = (rank) => {
    if (rank === 1) return <MetaTag tone="warning">🥇 第 1 名</MetaTag>;
    if (rank === 2) return <MetaTag tone="warning">🥈 第 2 名</MetaTag>;
    if (rank === 3) return <MetaTag tone="warning">🥉 第 3 名</MetaTag>;
    return <span className="fb-meta">第 {rank} 名</span>;
  };

  const columns = [
    { title: '排名', width: 100, render: (_, __, index) => rankMeta(index + 1) },
    {
      title: '昵称', dataIndex: 'nickname',
      render: (v, r) => <span>{v} {r.id === user?.id && <MetaTag tone="primary">我</MetaTag>}</span>,
    },
    { title: '平均分', dataIndex: 'avg_score', render: v => <MetaTag tone={v >= 80 ? 'success' : v >= 60 ? 'primary' : 'error'}>{v}</MetaTag>, sorter: (a, b) => a.avg_score - b.avg_score },
    { title: '答题次数', dataIndex: 'total_sessions', sorter: (a, b) => a.total_sessions - b.total_sessions },
    { title: '总题数', dataIndex: 'total_questions' },
    { title: '答对数', dataIndex: 'total_correct' },
    { title: '正确率', render: (_, r) => r.total_questions > 0 ? ((r.total_correct / r.total_questions) * 100).toFixed(1) + '%' : '-' },
  ];

  const podium = data.slice(0, 3);

  return (
    <FenbiScope>
      <PageHead
        title="成绩排行榜"
        icon={<TrophyOutlined />}
        desc="按平均分排序，数据来自全站真实练习记录。"
      />

      {podium.length > 0 && (
        <>
          <SectionLabel title="榜单前三" />
          <Row gutter={[isMobile ? 8 : 16, isMobile ? 8 : 16]} style={{ marginBottom: isMobile ? 16 : 24 }}>
            {podium.map((p, i) => (
              <Col key={p.id || i} xs={24} md={8}>
                <div className="fb-stat" style={{ borderColor: i === 0 ? F.selectedBorder : F.border, background: i === 0 ? '#FFFCF9' : F.cardBg }}>
                  <div className="fb-stat-icon" style={{ color: F.primary, background: F.primaryLight }}>
                    <TrophyOutlined />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="fb-stat-label">{rankMeta(i + 1)}</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: F.text, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.nickname}{p.id === user?.id && <span style={{ color: F.primary, fontSize: 12, marginLeft: 6 }}>（我）</span>}
                    </div>
                    <div className="fb-meta" style={{ marginTop: 4 }}>平均分 {p.avg_score} · 答题 {p.total_sessions} 次</div>
                  </div>
                </div>
              </Col>
            ))}
          </Row>
        </>
      )}

      <SectionLabel title="完整榜单" extra={<span className="fb-meta">共 {data.length} 人</span>} />
      <Panel bodyStyle={{ padding: isMobile ? 12 : 16 }}>
        <Table
          dataSource={data}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={false}
          rowClassName={r => r.id === user?.id ? 'ant-table-row-selected' : ''}
          size="middle"
          scroll={isMobile ? { x: 700 } : undefined}
          locale={{ emptyText: loading ? <Spin /> : '暂无排行数据' }}
        />
      </Panel>
    </FenbiScope>
  );
}
