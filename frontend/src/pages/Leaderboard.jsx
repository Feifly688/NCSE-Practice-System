import React, { useState, useEffect } from 'react';
import { Typography, Table, Tag, Spin, message } from 'antd';
import { TrophyOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

const { Title } = Typography;

export default function Leaderboard() {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLeaderboard();
  }, []);

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

  function getRankTag(rank) {
    if (rank === 1) return <Tag color="gold">🥇 第1名</Tag>;
    if (rank === 2) return <Tag color="silver">🥈 第2名</Tag>;
    if (rank === 3) return <Tag color="bronze">🥉 第3名</Tag>;
    return <span>第{rank}名</span>;
  }

  const columns = [
    {
      title: '排名',
      width: 100,
      render: (_, __, index) => getRankTag(index + 1),
    },
    { title: '昵称', dataIndex: 'nickname', render: (v, r) => <span>{v} {r.id === user?.id && <Tag color="blue">我</Tag>}</span> },
    { title: '平均分', dataIndex: 'avg_score', render: v => <Tag color={v >= 80 ? 'green' : v >= 60 ? 'orange' : 'red'}>{v}</Tag>, sorter: (a, b) => a.avg_score - b.avg_score },
    { title: '答题次数', dataIndex: 'total_sessions', sorter: (a, b) => a.total_sessions - b.total_sessions },
    { title: '总题数', dataIndex: 'total_questions' },
    { title: '答对数', dataIndex: 'total_correct' },
    { title: '正确率', render: (_, r) => r.total_questions > 0 ? ((r.total_correct / r.total_questions) * 100).toFixed(1) + '%' : '-' },
  ];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Title level={3}><TrophyOutlined /> 成绩排行榜</Title>
      <Table
        dataSource={data}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        rowClassName={r => r.id === user?.id ? 'ant-table-row-selected' : ''}
        size="middle"
      />
    </div>
  );
}
